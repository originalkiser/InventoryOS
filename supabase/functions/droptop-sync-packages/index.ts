// Droptop Packages sync.
// Reads all core.locations with droptop_operation_id set, pulls the
// configured package menu from Droptop's get-packages endpoint (one call
// per operation — get-packages is per-operation and NOT paginated), and
// upserts into inventory.droptop_packages / droptop_package_casual_items.
// Same conventions as droptop-sync-purchase-orders (dual auth, sig-signed
// requests, data_connection_sync_log entry) — see that function's own
// header comment for the full rationale.
//
// The point of this sync (vs. the order-line-item data droptop-sync-orders
// already captures) is the *configured* package: its per-shop price and
// the casual_items (shop supply fee, credit-card fee, discount, oil
// inflation surcharge, …) that ride along with it, so "which shops have
// package X, and what does each charge" is answerable without walking
// order history.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY,
// DROPTOP_SYNC_SECRET. (SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY are injected.)
//
// POST body: { mode?, locationId?, locationIds? }
//   mode        — 'sync' (default) | 'probe' (read-only: fetches one
//                 operation's raw response and writes nothing)
//   locationId  — sync a single location
//   locationIds — sync a specific batch (client-side chunking, same as
//                 runDroptopPackageSync in droptopService.ts). Neither set =
//                 every location with a droptop_operation_id.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── Droptop auth sig — identical to droptop-sync-purchase-orders' own copy ──
// sig = base64(base64(AES-256-ECB(PKCS7pad(publicKey|METHOD|unixTimestamp), privateKey)))
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
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const PLATFORM_RETRY_AFTER_MS_RE = /retry after (\d+)\s*ms/i

async function callDroptop(
  endpoint: string, params: Record<string, string>, publicKey: string, privateKey: string, maxRetries = 5,
): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const sig = await buildSig(publicKey, 'GET', privateKey)
    const qs = new URLSearchParams({ sig, ...params })
    const url = `https://main.api-droptop.com/api/v2/${endpoint}?${qs}`

    let res: Response
    try {
      res = await fetch(url, { headers: { 'x-api-key': publicKey.trim() }, redirect: 'follow' })
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
      if (attempt < maxRetries) {
        const platformWaitMatch = message.match(PLATFORM_RETRY_AFTER_MS_RE)
        const waitMs = platformWaitMatch ? Number(platformWaitMatch[1]) : 2000 * 2 ** attempt
        console.warn(`[droptop-sync-packages] ${endpoint} fetch threw (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${message}`)
        await sleep(waitMs)
        continue
      }
      console.error(`[droptop-sync-packages] ${endpoint} fetch threw, retries exhausted: ${message}`)
      throw fetchErr
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2000 * 2 ** attempt
      const body = await res.text().catch(() => '')
      console.warn(`[droptop-sync-packages] ${endpoint} returned ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${body}`)
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      console.error(`[droptop-sync-packages] ${endpoint} failed with ${res.status}, retries exhausted or non-retryable: ${text}`)
      throw new Error(`Droptop ${res.status}: ${text}`)
    }
    return text ? JSON.parse(text) : null
  }
}

// get-packages "Returns Array if found and null if not" — but the other
// Droptop endpoints in this codebase all nest an extra { data: ... } level
// below their documented shape at least some of the time, so don't trust
// the bare-array shape either.
function unwrapPackages(res: any): any[] {
  if (Array.isArray(res)) return res
  if (Array.isArray(res?.data)) return res.data
  if (Array.isArray(res?.data?.data)) return res.data.data
  return []
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const int = (v: unknown): number | null => {
  const n = num(v)
  return n == null ? null : Math.trunc(n)
}

async function withRetry<T>(
  fn: () => Promise<{ data: T; error: { message: string } | null }>,
): Promise<{ data: T | null; error: string | null }> {
  let lastErr: string | null = null
  for (let attempt = 0; attempt <= 2; attempt++) {
    const { data, error } = await fn()
    if (!error) return { data, error: null }
    lastErr = error.message
    if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
  }
  return { data: null, error: lastErr }
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
    const mode: 'sync' | 'probe' = body.mode === 'probe' ? 'probe' : 'sync'
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

    if (mode === 'probe') {
      const opId = locations[0].droptop_operation_id
      const raw = await callDroptop('get-packages', { operation_ids: opId }, publicKey, privateKey)
      const parsed = unwrapPackages(raw)
      return ok({
        success: true,
        operation_id: opId,
        package_count: parsed.length,
        raw_response: raw,
        parsed_sample: parsed.slice(0, 3),
      })
    }

    const opToLocation = new Map<string, string>(locations.map((l: any) => [l.droptop_operation_id, l.id]))
    const warnings: string[] = []
    const headerRows: any[] = []
    const casualByPkgKey = new Map<string, any[]>() // `${operation_id}|${package_id}` -> casual items

    for (const loc of locations) {
      const opId = loc.droptop_operation_id
      try {
        const raw = await callDroptop('get-packages', { operation_ids: opId }, publicKey, privateKey)
        const pkgs = unwrapPackages(raw)
        for (const p of pkgs) {
          const packageId = String(p.package_id ?? '')
          if (!packageId) continue
          headerRows.push({
            company_id: companyId,
            location_id: opToLocation.get(opId) ?? null,
            operation_id: opId,
            package_id: packageId,
            name: p.name ?? null,
            internal_name: p.internal_name ?? null,
            description: p.description ?? null,
            price: num(p.price),
            package_tax_exempt: p.extras?.package_tax_exempt ?? null,
            package_mileage_interval: int(p.package_mileage_interval),
            package_time_interval: int(p.package_time_interval),
            services: p.services ?? [],
            created_timestamp: int(p.created_timestamp),
            updated_timestamp: int(p.updated_timestamp),
            raw_data: p,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          casualByPkgKey.set(`${opId}|${packageId}`, Array.isArray(p.casual_items) ? p.casual_items : [])
        }
      } catch (e) {
        warnings.push(`location ${loc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    let packagesUpserted = 0
    let casualItemsWritten = 0
    const BATCH = 500
    const idByKey = new Map<string, string>() // `${operation_id}|${package_id}` -> row id

    for (let i = 0; i < headerRows.length; i += BATCH) {
      const slice = headerRows.slice(i, i + BATCH)
      const { data: saved, error: upErr } = await withRetry(() =>
        (admin as any).schema('inventory').from('droptop_packages')
          .upsert(slice, { onConflict: 'company_id,operation_id,package_id' })
          .select('id, operation_id, package_id'),
      )
      if (upErr) { warnings.push(`Package batch ${i}: ${upErr}`); continue }
      for (const row of (saved ?? []) as { id: string; operation_id: string; package_id: string }[]) {
        idByKey.set(`${row.operation_id}|${row.package_id}`, row.id)
      }
      packagesUpserted += saved?.length ?? 0
    }

    const savedIds = [...idByKey.values()]
    if (savedIds.length) {
      for (let i = 0; i < savedIds.length; i += BATCH) {
        const { error: delErr } = await withRetry(() =>
          (admin as any).schema('inventory').from('droptop_package_casual_items')
            .delete().in('package_row_id', savedIds.slice(i, i + BATCH)),
        )
        if (delErr) warnings.push(`Casual-item delete batch ${i}: ${delErr}`)
      }

      const allCasual: any[] = []
      for (const [key, items] of casualByPkgKey) {
        const rowId = idByKey.get(key)
        if (!rowId) continue
        const [opId] = key.split('|')
        for (const ci of items) {
          allCasual.push({
            package_row_id: rowId,
            company_id: companyId,
            location_id: opToLocation.get(opId) ?? null,
            name: ci.name ?? null,
            name_french: ci.name_french ?? null,
            amount: num(ci.amount),
            quantity: num(ci.quantity),
            tax_exempt: ci.tax_exempt ?? null,
            hidden_on_order: ci.hidden_on_order ?? null,
          })
        }
      }
      for (let i = 0; i < allCasual.length; i += BATCH) {
        const slice = allCasual.slice(i, i + BATCH)
        const { error: ciErr } = await withRetry(() =>
          (admin as any).schema('inventory').from('droptop_package_casual_items').insert(slice),
        )
        if (ciErr) warnings.push(`Casual-item insert batch ${i}: ${ciErr}`)
        else casualItemsWritten += slice.length
      }
    }

    const status = warnings.length ? (packagesUpserted > 0 ? 'partial' : 'error') : 'success'
    await (admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId,
      connection: 'droptop_packages',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      items_updated: packagesUpserted,
      items_unchanged: 0,
      items_inserted: casualItemsWritten,
      status,
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({
      success: status !== 'error',
      locations_synced: locations.length,
      packages_upserted: packagesUpserted,
      casual_items_written: casualItemsWritten,
      warnings,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
