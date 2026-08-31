// Droptop Customers sync.
// Reads all core.locations with droptop_operation_id set, pulls that shop's
// active customers from Droptop's get-customers endpoint, and upserts into
// inventory.droptop_customers. Feeds the Customer Heatmap (marketing module)
// and is one of the tables the read-only Power BI role can query directly.
// Same conventions as droptop-sync-usage/droptop-sync-purchase-orders (dual
// auth, sig-signed requests, data_connection_sync_log entry) — see those
// functions' own header comments for the full rationale; not re-explained
// here.
//
// Grain is (company_id, location_id, customer_id): get-customers is filtered
// by operation_ids but the customer object it returns doesn't say which
// operation matched, so this calls it once per location (like the PO sync)
// and tags each row with the location_id it was pulled under. A customer
// who's visited more than one shop gets one row per shop.
//
// lat/lng are resolved from inventory.zip_centroids by zip, not from Droptop
// (which doesn't provide coordinates) — a customer whose zip isn't in that
// table yet gets null lat/lng and is excluded from the heatmap rather than
// mis-plotted; it self-heals once that zip is added.
//
// No date-range filter here (unlike the PO sync's daysBack) — get-customers
// has no "createdAfter" param, so every run re-pulls the full active
// customer list for each location. Chunk locations client-side
// (runDroptopCustomerSync in droptopService.ts) the same way the PO sync
// does to keep any one invocation's wall-clock time bounded.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, locationId?, locationIds? }
//   mode        — 'sync' (default) | 'inspect' (read-only raw-shape peek,
//                 never writes anything)
//   locationId  — sync a single location
//   locationIds — sync a specific batch of locations (client-side chunking).
//                 Ignored if locationId is also set. Neither set = every
//                 location with a droptop_operation_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── Droptop auth sig — identical to droptop-sync-usage's own copy ──────────
async function parseKey(key: string): Promise<Uint8Array> {
  const k = key.trim()
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    const bytes = new Uint8Array(32)
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(k.slice(i * 2, i * 2 + 2), 16)
    return bytes
  }
  const rawBytes = new TextEncoder().encode(k)
  if (rawBytes.length === 16 || rawBytes.length === 24 || rawBytes.length === 32) return rawBytes
  const hashBuffer = await crypto.subtle.digest('SHA-256', rawBytes)
  return new Uint8Array(hashBuffer)
}

async function buildSig(publicKey: string, method: string, privateKey: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000)
  const message = `${publicKey.trim()}|${method.toUpperCase()}|${timestamp}`
  const msgBytes = new TextEncoder().encode(message)
  const padLen = 16 - (msgBytes.length % 16)
  const padded = new Uint8Array(msgBytes.length + padLen)
  padded.set(msgBytes)
  padded.fill(padLen, msgBytes.length)
  const keyBytes = await parseKey(privateKey)
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt'])
  const zeroIV = new Uint8Array(16)
  const encrypted = new Uint8Array(padded.length)
  for (let i = 0; i < padded.length; i += 16) {
    const enc = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: zeroIV }, cryptoKey, padded.slice(i, i + 16))
    encrypted.set(new Uint8Array(enc).slice(0, 16), i)
  }
  return btoa(btoa(String.fromCharCode(...encrypted)))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function callDroptop(
  endpoint: string, params: Record<string, string>, publicKey: string, privateKey: string, maxRetries = 5,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const sig = await buildSig(publicKey, 'GET', privateKey)
    const qs = new URLSearchParams({ sig, ...params })
    const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`
    const res = await fetch(url, { headers: { 'x-api-key': publicKey.trim() }, redirect: 'follow' })
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2000 * 2 ** attempt
      await res.text().catch(() => {})
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) throw new Error(`Droptop ${res.status}: ${text}`)
    return JSON.parse(text)
  }
}

// Fetches every active customer for one operation, paginating via
// startingAfter until Droptop says more_available: false.
async function fetchCustomers(operationId: string, pub: string, priv: string): Promise<any[]> {
  const all: any[] = []
  let cursor: string | null = null
  while (true) {
    const params: Record<string, string> = { operation_ids: operationId, limit: '250' }
    if (cursor) params.startingAfter = cursor
    const res = await callDroptop('get-customers', params, pub, priv)
    // Defensive unwrap — other Droptop endpoints in this codebase nested one
    // level deeper than their own docs show (get-inventory-changes,
    // get-purchase-orders); don't assume this one's documented top-level
    // shape (more_available/next_cursor/data) is exactly what comes back.
    const inner = res?.data && !Array.isArray(res.data) && 'data' in res.data ? res.data : res
    const customers: any[] = Array.isArray(inner?.data) ? inner.data : []
    all.push(...customers)
    if (!inner?.more_available || !inner?.next_cursor) break
    cursor = inner.next_cursor
  }
  return all
}

function tsToIso(unix: unknown): string | null {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const publicKey = Deno.env.get('DROPTOP_PUBLIC_KEY')
    const privateKey = Deno.env.get('DROPTOP_PRIVATE_KEY')
    if (!publicKey || !privateKey) return ok({ error: 'credentials_not_configured' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    // Same dual-auth shape as droptop-sync-usage/droptop-sync-purchase-orders.
    const syncSecret = Deno.env.get('DROPTOP_SYNC_SECRET')
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    const secretAuthed = !!syncSecret && suppliedSecret === syncSecret

    let companyId: string | null = null
    if (secretAuthed) {
      const { data: anyLoc } = await (admin as any).schema('core').from('locations').select('company_id').limit(1).maybeSingle()
      companyId = anyLoc?.company_id ?? null
    } else {
      const authHeader = req.headers.get('Authorization') ?? ''
      const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: who, error: whoErr } = await caller.auth.getUser()
      if (whoErr || !who.user) return ok({ error: 'Not authenticated' })
      const { data: me } = await (caller as any).schema('platform').from('user_profiles').select('company_id').eq('id', who.user.id).single()
      companyId = me?.company_id ?? null
    }
    if (!companyId) return ok({ error: 'Unable to resolve company' })

    const body = await req.json().catch(() => ({}))
    const mode: 'sync' | 'inspect' = body.mode === 'inspect' ? 'inspect' : 'sync'
    const locationId: string | undefined = body.locationId
    const locationIds: string[] = Array.isArray(body.locationIds) ? body.locationIds : []

    let locQuery = (admin as any).schema('core').from('locations')
      .select('id, droptop_operation_id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
    if (locationId) locQuery = locQuery.eq('id', locationId)
    else if (locationIds.length) locQuery = locQuery.in('id', locationIds)
    const { data: locs, error: locErr } = await locQuery
    if (locErr) return ok({ error: `Locations query failed: ${locErr.message}` })
    const locations = (locs ?? []).filter((l: any) => l.droptop_operation_id)
    if (!locations.length) {
      return ok({ error: 'No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.' })
    }

    if (mode === 'inspect') {
      const opId = locations[0].droptop_operation_id
      const raw = await callDroptop('get-customers', { operation_ids: opId, limit: '5' }, publicKey, privateKey)
      return ok({ success: true, operation_id: opId, raw_response: raw })
    }

    let customersUpserted = 0
    const warnings: string[] = []
    // Keyed by "location_id|customer_id", not pushed to an array — matches
    // the real unique constraint, and guards the same "same id visible under
    // more than one call" surprise the PO sync hit with po_id.
    const customersByKey = new Map<string, { c: any; locationId: string }>()
    for (const loc of locations) {
      try {
        const customers = await fetchCustomers(loc.droptop_operation_id, publicKey, privateKey)
        for (const c of customers) customersByKey.set(`${loc.id}|${c.customer_id}`, { c, locationId: loc.id })
      } catch (e) {
        warnings.push(`location ${loc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    const allCustomers = [...customersByKey.values()]

    // Resolve lat/lng by zip — only the zips actually present in this batch,
    // not the whole zip_centroids table (which can run tens of thousands of
    // rows; see inventory.zip_centroids's own migration comment).
    const zips = [...new Set(allCustomers.map(({ c }) => String(c.zip ?? '').trim()).filter(Boolean))]
    const zipToLatLng = new Map<string, { lat: number; lng: number }>()
    const ZIP_BATCH = 500
    for (let i = 0; i < zips.length; i += ZIP_BATCH) {
      const slice = zips.slice(i, i + ZIP_BATCH)
      const { data: rows, error } = await (admin as any)
        .schema('inventory').from('zip_centroids').select('zip, lat, lng').in('zip', slice)
      if (error) { warnings.push(`zip_centroids lookup: ${error.message}`); break }
      for (const r of (rows ?? []) as { zip: string; lat: number; lng: number }[]) zipToLatLng.set(r.zip, { lat: r.lat, lng: r.lng })
    }

    const nowIso = new Date().toISOString()
    const rows = allCustomers.map(({ c, locationId: locId }) => {
      const zip = String(c.zip ?? '').trim() || null
      const coords = zip ? zipToLatLng.get(zip) : undefined
      return {
        company_id: companyId,
        location_id: locId,
        customer_id: c.customer_id,
        first_name: c.first_name ?? null,
        last_name: c.last_name ?? null,
        email: c.email ?? null,
        phone_number: c.phone_number ?? null,
        address: c.address ?? null,
        city: c.city ?? null,
        region: c.region ?? null,
        zip,
        country: c.country ?? null,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        tags: c.tags ?? [],
        meta_data: c.meta_data ?? {},
        active: c.active !== false,
        created_timestamp: tsToIso(c.created_timestamp),
        synced_at: nowIso,
        last_change_source: 'droptop',
        updated_at: nowIso,
      }
    })

    const BATCH = 500
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH)
      const { error: upsertErr } = await (admin as any)
        .schema('inventory').from('droptop_customers')
        .upsert(slice, { onConflict: 'company_id,location_id,customer_id' })
      if (upsertErr) { warnings.push(`Customer batch ${i}-${i + slice.length}: ${upsertErr.message}`); continue }
      customersUpserted += slice.length
    }

    const withCoords = rows.filter((r) => r.lat != null).length
    const status = warnings.length ? (customersUpserted > 0 ? 'partial' : 'error') : 'success'
    await (admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId,
      connection: 'droptop_customers',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      items_updated: customersUpserted,
      items_unchanged: 0,
      items_inserted: 0,
      status,
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({
      success: status !== 'error',
      locations_synced: locations.length,
      customers_upserted: customersUpserted,
      customers_with_coordinates: withCoords,
      customers_missing_zip_match: customersUpserted - withCoords,
      warnings,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
