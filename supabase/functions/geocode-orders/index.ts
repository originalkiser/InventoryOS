// Address-level geocoding for Customer Heatmap — resolves each order's
// actual street address to real lat/lng via the US Census Bureau's free
// Geocoding Services API (https://geocoding.geo.census.gov/geocoder/ —
// no API key, no cost, US addresses only). An OPTIONAL alternative to the
// existing zip-centroid approach (inventory.zip_centroids), not a
// replacement — see CustomerHeatmapPage.tsx's own geocoding toggle.
//
// Same dual-auth pattern as every other droptop-sync-* function (shared
// x-sync-token secret OR a real user JWT) — not re-explained here.
//
// Processes ORDERS_PER_RUN orders per invocation (a client-side loop
// calls this repeatedly until `remaining` is 0, same pattern as the
// Droptop syncs) rather than trying to geocode everything in one call —
// Census's batch endpoint can be slow for large submissions, and this
// keeps each invocation comfortably inside an edge function's execution
// time limit.
//
// Caching: inventory.geocoded_addresses is keyed by a normalized address
// string (address|city|region|zip, uppercased/trimmed) — a repeat
// customer's address only ever costs one real Census lookup, not one per
// order. geocode_status on droptop_orders tracks 'matched'/'no_match' so
// a genuinely non-matching address (typo, PO box, new construction)
// isn't retried every run — same reasoning as this app's other sync
// tables advancing only on a definite outcome.
//
// POST body: { limit? } — orders to consider this invocation, default
// ORDERS_PER_RUN.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

const ORDERS_PER_RUN = 200

function addressKey(address: string | null, city: string | null, region: string | null, zip: string | null): string {
  return [address, city, region, zip].map((v) => (v ?? '').trim().toUpperCase()).join('|')
}

// Minimal RFC4180-ish CSV line splitter — handles double-quoted fields
// (which may contain commas or escaped "" quotes), which Census's own
// batch response actually uses (e.g. a matched address with a comma in
// it). Good enough for this one well-defined response shape; not a
// general-purpose CSV parser.
function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else cur += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out
}

function csvField(v: string): string {
  const s = (v ?? '').replace(/"/g, '""')
  return /[",\n]/.test(s) ? `"${s}"` : s
}

interface GeocodeResult { lat: number | null; lng: number | null; matchedAddress: string | null; status: 'matched' | 'no_match' }

// Submits up to a few hundred addresses to Census's batch geocoder in one
// multipart/form-data POST and parses the (headerless) CSV it returns.
// Returns a map from OUR row index (the id column we send Census, since
// address_key itself isn't a safe CSV/form value) to the result.
async function geocodeBatch(addresses: { idx: number; street: string; city: string; state: string; zip: string }[]): Promise<Map<number, GeocodeResult>> {
  const results = new Map<number, GeocodeResult>()
  if (!addresses.length) return results

  const csvLines = addresses.map((a) => [String(a.idx), a.street, a.city, a.state, a.zip].map(csvField).join(','))
  const csvBody = csvLines.join('\n') + '\n'

  const form = new FormData()
  form.append('addressFile', new Blob([csvBody], { type: 'text/csv' }), 'addresses.csv')
  form.append('benchmark', 'Public_AR_Current')

  const res = await fetch('https://geocoding.geo.census.gov/geocoder/locations/addressbatch', { method: 'POST', body: form })
  const text = await res.text()
  if (!res.ok) throw new Error(`Census geocoder ${res.status}: ${text.slice(0, 500)}`)

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const cols = splitCsvLine(line)
    // id, input address, match status, match type, matched address, coordinates, tiger line id, side
    const idx = Number(cols[0])
    if (!Number.isFinite(idx)) continue
    const matchStatus = (cols[2] ?? '').trim()
    if (matchStatus === 'Match') {
      const coords = (cols[5] ?? '').split(',')
      const lng = Number(coords[0])
      const lat = Number(coords[1])
      results.set(idx, {
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        matchedAddress: cols[4] || null,
        status: Number.isFinite(lat) && Number.isFinite(lng) ? 'matched' : 'no_match',
      })
    } else {
      results.set(idx, { lat: null, lng: null, matchedAddress: null, status: 'no_match' })
    }
  }
  return results
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
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
    const limit = Math.min(500, Math.max(1, Number(body.limit) || ORDERS_PER_RUN))

    const { data: orderRows, error: fetchErr } = await (admin as any)
      .schema('inventory').from('droptop_orders')
      .select('id, address, city, region, zip')
      .eq('company_id', companyId)
      .is('geocode_status', null)
      .not('address', 'is', null)
      .limit(limit)
    if (fetchErr) return ok({ error: fetchErr.message })

    const orders = (orderRows ?? []) as { id: string; address: string | null; city: string | null; region: string | null; zip: string | null }[]
    if (!orders.length) {
      return ok({ success: true, processed: 0, matched: 0, no_match: 0, cached_hits: 0, remaining: 0 })
    }

    // address_key -> the order ids that share it (usually 1, but a repeat
    // customer or a shared address across customers collapses to one key).
    const ordersByKey = new Map<string, string[]>()
    for (const o of orders) {
      const key = addressKey(o.address, o.city, o.region, o.zip)
      const arr = ordersByKey.get(key) ?? []
      arr.push(o.id)
      ordersByKey.set(key, arr)
    }
    const uniqueKeys = [...ordersByKey.keys()]

    // Check the cache first — only genuinely new addresses go to Census.
    const { data: cacheRows, error: cacheErr } = await (admin as any)
      .schema('inventory').from('geocoded_addresses')
      .select('address_key, lat, lng, matched_address, status')
      .in('address_key', uniqueKeys)
    if (cacheErr) return ok({ error: cacheErr.message })

    const resultByKey = new Map<string, GeocodeResult>()
    let cachedHits = 0
    for (const r of (cacheRows ?? []) as { address_key: string; lat: number | null; lng: number | null; matched_address: string | null; status: string }[]) {
      resultByKey.set(r.address_key, { lat: r.lat, lng: r.lng, matchedAddress: r.matched_address, status: r.status as 'matched' | 'no_match' })
      cachedHits += ordersByKey.get(r.address_key)?.length ?? 0
    }

    const keysToGeocode = uniqueKeys.filter((k) => !resultByKey.has(k))
    if (keysToGeocode.length) {
      // Reconstruct one representative order's address fields per key —
      // any order sharing the key has the same address components by
      // construction.
      const repByKey = new Map<string, { address: string; city: string; region: string; zip: string }>()
      for (const o of orders) {
        const key = addressKey(o.address, o.city, o.region, o.zip)
        if (!repByKey.has(key)) repByKey.set(key, { address: o.address ?? '', city: o.city ?? '', region: o.region ?? '', zip: o.zip ?? '' })
      }
      const toGeocode = keysToGeocode.map((key, idx) => ({ idx, key, ...repByKey.get(key)! }))
      const censusResults = await geocodeBatch(toGeocode.map((t) => ({ idx: t.idx, street: t.address, city: t.city, state: t.region, zip: t.zip })))

      const nowIso = new Date().toISOString()
      const cacheUpserts: { address_key: string; lat: number | null; lng: number | null; matched_address: string | null; status: string; geocoded_at: string }[] = []
      for (const t of toGeocode) {
        const r = censusResults.get(t.idx) ?? { lat: null, lng: null, matchedAddress: null, status: 'no_match' as const }
        resultByKey.set(t.key, r)
        cacheUpserts.push({ address_key: t.key, lat: r.lat, lng: r.lng, matched_address: r.matchedAddress, status: r.status, geocoded_at: nowIso })
      }
      const { error: upsertErr } = await (admin as any)
        .schema('inventory').from('geocoded_addresses')
        .upsert(cacheUpserts, { onConflict: 'address_key' })
      if (upsertErr) return ok({ error: `cache upsert: ${upsertErr.message}` })
    }

    // Write results back onto the actual order rows — one UPDATE per
    // order (simple, matches this app's existing sequential-update
    // convention elsewhere; ORDERS_PER_RUN keeps this bounded).
    const nowIso = new Date().toISOString()
    let matched = 0
    let noMatch = 0
    const warnings: string[] = []
    for (const o of orders) {
      const key = addressKey(o.address, o.city, o.region, o.zip)
      const r = resultByKey.get(key) ?? { lat: null, lng: null, matchedAddress: null, status: 'no_match' as const }
      if (r.status === 'matched') matched++; else noMatch++
      const { error: updErr } = await (admin as any)
        .schema('inventory').from('droptop_orders')
        .update({ geocoded_lat: r.lat, geocoded_lng: r.lng, geocode_status: r.status, geocoded_at: nowIso })
        .eq('id', o.id)
      if (updErr) warnings.push(`order ${o.id}: ${updErr.message}`)
    }

    const { count: remaining } = await (admin as any)
      .schema('inventory').from('droptop_orders')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .is('geocode_status', null)
      .not('address', 'is', null)

    return ok({
      success: true,
      processed: orders.length,
      matched,
      no_match: noMatch,
      cached_hits: cachedHits,
      remaining: remaining ?? 0,
      duration_ms: Date.now() - startedAt,
      warnings: warnings.length ? warnings : undefined,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
