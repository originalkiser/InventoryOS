// VIN decode for the Droptop Vehicles page's Trim/Engine columns — Droptop
// itself never sends Trim or Engine (confirmed against live raw_data AND
// against Droptop's own API spec: the vehicles array only ever carries
// vin/license_plate/mileage/vin_vehicle_year/_make/_model). This fills that
// gap via NHTSA's free vPIC VIN-decode API
// (https://vpic.nhtsa.dot.gov/api/ — no key, no cost, US-market VINs).
//
// Same dual-auth pattern as every other droptop-sync-* function (shared
// x-sync-token secret OR a real user JWT) — not re-explained here.
//
// Caching: inventory.vin_decoded is keyed by VIN alone (no company_id — a
// VIN's factory spec doesn't depend on which company serviced it, same
// "global reference data" shape as inventory.zip_centroids). A VIN NHTSA
// can't decode still gets a row (decode_status 'not_found'/'error') so a
// genuinely bad VIN isn't retried on every future click, same "advance
// past a definite outcome" rule geocode_status uses on droptop_orders.
//
// Two ways to call it:
//  - Manual, on-demand: POST body { vins: string[] } — the Droptop
//    Vehicles page's "Decode Engine/Trim" button sends exactly the VINs
//    currently in view. Caller should chunk large lists itself (see
//    vinDecodeService.ts) — this processes the whole list it's given in
//    one invocation.
//  - Scheduled/automatic: POST body {} (no vins) — auto-discovers up to
//    AUTO_MAX_VINS undecoded VINs via the get_undecoded_vins RPC (anything
//    already synced into inventory.droptop_order_vehicles with no
//    inventory.vin_decoded row yet) and decodes those instead. Wired into
//    data-connection-dispatcher/index.ts under connection_key
//    'vin_decode' — same dual-auth (shared secret) as every other
//    scheduled sync. A single run doesn't try to drain the whole backlog
//    (209,614 distinct VINs as of 2026-09-03) — it makes bounded progress
//    each time it's due, same "steady incremental catch-up" precedent as
//    droptop_orders' own incremental sync.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Standard VIN shape — 17 alphanumeric chars, no I/O/Q (never used in real
// VINs, avoids confusion with 1/0). Anything else can't be a real VIN, so
// skip it rather than spending an NHTSA call finding that out.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i

// NHTSA's batch endpoint has no documented hard cap, but real-world use
// keeps requests well under a few hundred VINs to stay fast/reliable —
// chunk conservatively.
const NHTSA_BATCH_SIZE = 50
const NHTSA_CONCURRENCY = 3
// Auto-discover mode's ceiling per invocation — bounds execution time (at
// concurrency 3 / 50 per NHTSA request, 5000 VINs is ~100 sequential
// rounds of requests, comfortably inside the platform's execution limit).
// A backlog bigger than this just takes multiple scheduled runs to fully
// catch up — same "steady incremental progress" precedent as this app's
// other backlog-catch-up jobs (droptop_orders' incremental sync, etc.),
// not something one invocation needs to fully drain.
const AUTO_MAX_VINS = 5000

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  async function worker() {
    while (next < items.length) {
      const item = items[next++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

interface DecodedVin {
  vin: string
  trim: string | null
  engine: string | null
  engine_cylinders: string | null
  displacement_l: string | null
  fuel_type: string | null
  decode_status: 'decoded' | 'not_found' | 'error'
  raw_response: unknown
}

// Builds the human-readable "engine" summary from vPIC's own fields —
// e.g. "3.5L V6 Gas". Falls back gracefully as fields are missing (not
// every VIN decodes every field).
function buildEngineSummary(r: Record<string, unknown>): string | null {
  const parts: string[] = []
  const disp = String(r.DisplacementL ?? '').trim()
  if (disp && disp !== '0') parts.push(`${disp}L`)
  const cyl = String(r.EngineCylinders ?? '').trim()
  const config = String(r.EngineConfiguration ?? '').trim() // e.g. "V", "Inline"
  if (cyl) parts.push(config ? `${config}${cyl}` : `${cyl}-cyl`)
  const fuel = String(r.FuelTypePrimary ?? '').trim()
  if (fuel) parts.push(fuel)
  return parts.length ? parts.join(' ') : null
}

// One NHTSA DecodeVINValuesBatch call — up to NHTSA_BATCH_SIZE VINs per
// request, semicolon-separated (optionally "VIN,ModelYear" per the docs;
// omitted here since we don't reliably know it ahead of decode).
async function decodeBatch(vins: string[]): Promise<Map<string, DecodedVin>> {
  const results = new Map<string, DecodedVin>()
  if (!vins.length) return results

  const form = new URLSearchParams()
  form.set('format', 'json')
  form.set('data', vins.join(';'))

  const res = await fetch('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVINValuesBatch/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`NHTSA ${res.status}: ${text.slice(0, 500)}`)
  const json = JSON.parse(text)
  const rows: Record<string, unknown>[] = Array.isArray(json?.Results) ? json.Results : []

  // NHTSA returns one row per VIN, in the same order submitted, but keys
  // by its own echoed VIN field rather than guaranteeing order — match by
  // that field instead of position.
  for (const r of rows) {
    const vin = String(r.VIN ?? '').toUpperCase()
    if (!vin) continue
    // ErrorCode "0" = clean decode. Non-zero can still carry a partial
    // decode (NHTSA's own convention) — treat any row with a make/model as
    // usable even if some other field triggered a non-zero code, only
    // marking not_found when NHTSA truly has nothing.
    const hasAnything = String(r.Make ?? '').trim() || String(r.Model ?? '').trim() || String(r.EngineCylinders ?? '').trim()
    results.set(vin, {
      vin,
      trim: String(r.Trim ?? '').trim() || null,
      engine: buildEngineSummary(r),
      engine_cylinders: String(r.EngineCylinders ?? '').trim() || null,
      displacement_l: String(r.DisplacementL ?? '').trim() || null,
      fuel_type: String(r.FuelTypePrimary ?? '').trim() || null,
      decode_status: hasAnything ? 'decoded' : 'not_found',
      raw_response: r,
    })
  }
  return results
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const syncSecret = Deno.env.get('DROPTOP_SYNC_SECRET')
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    let authorized = !!syncSecret && suppliedSecret === syncSecret
    if (!authorized) {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (authHeader) {
        const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
        const { data: who, error: whoErr } = await caller.auth.getUser()
        authorized = !whoErr && !!who.user
      }
    }
    if (!authorized) return ok({ error: 'Not authorized' })

    const body = await req.json().catch(() => ({}))
    let requestedVins: string[] = Array.isArray(body.vins) ? body.vins.filter((v: unknown) => typeof v === 'string') : []
    // Auto-discover mode: no vins in the body (the scheduled dispatcher
    // call, or a manual "Run Now") — find undecoded VINs ourselves via
    // get_undecoded_vins rather than requiring the caller to know which
    // VINs exist. Fetch one more than the cap to tell "exactly this many
    // remained" apart from "there's more beyond this run" without a
    // separate (expensive, full-table) count query.
    let autoMode = false
    let autoMoreRemaining = false
    if (!requestedVins.length) {
      autoMode = true
      const { data: autoRows, error: autoErr } = await admin.rpc('get_undecoded_vins', { p_limit: AUTO_MAX_VINS + 1 })
      if (autoErr) return ok({ error: autoErr.message })
      const found = ((autoRows ?? []) as { vin: string }[]).map((r) => r.vin)
      autoMoreRemaining = found.length > AUTO_MAX_VINS
      requestedVins = found.slice(0, AUTO_MAX_VINS)
    }
    const uniqueVins = [...new Set(requestedVins.map((v) => v.trim().toUpperCase()).filter((v) => VIN_RE.test(v)))]
    if (!uniqueVins.length) {
      return ok({ success: true, auto: autoMode, requested: requestedVins.length, cached_hits: 0, newly_decoded: 0, invalid: requestedVins.length })
    }

    // Cache check — only genuinely new VINs cost an NHTSA call.
    const { data: cacheRows, error: cacheErr } = await (admin as any)
      .schema('inventory').from('vin_decoded')
      .select('vin')
      .in('vin', uniqueVins)
    if (cacheErr) return ok({ error: cacheErr.message })
    const alreadyCached = new Set((cacheRows ?? []).map((r: { vin: string }) => r.vin))
    const toDecode = uniqueVins.filter((v) => !alreadyCached.has(v))

    let newlyDecoded = 0
    const warnings: string[] = []
    if (toDecode.length) {
      const chunks: string[][] = []
      for (let i = 0; i < toDecode.length; i += NHTSA_BATCH_SIZE) chunks.push(toDecode.slice(i, i + NHTSA_BATCH_SIZE))

      const upserts: DecodedVin[] = []
      await mapWithConcurrency(chunks, NHTSA_CONCURRENCY, async (chunk) => {
        try {
          const decoded = await decodeBatch(chunk)
          for (const vin of chunk) {
            const d = decoded.get(vin)
            upserts.push(d ?? { vin, trim: null, engine: null, engine_cylinders: null, displacement_l: null, fuel_type: null, decode_status: 'not_found', raw_response: null })
          }
        } catch (chunkErr: unknown) {
          const msg = chunkErr instanceof Error ? chunkErr.message : String(chunkErr)
          warnings.push(`Batch of ${chunk.length}: ${msg}`)
          // Mark the whole failed chunk 'error' rather than leaving it
          // uncached — a transient NHTSA failure just means "click Decode
          // again later" (error rows aren't distinguished from not_found
          // in the UI, but decoded_at lets a future cleanup pass retry
          // only 'error' rows if that's ever worth doing).
          for (const vin of chunk) {
            upserts.push({ vin, trim: null, engine: null, engine_cylinders: null, displacement_l: null, fuel_type: null, decode_status: 'error', raw_response: null })
          }
        }
      })

      const nowIso = new Date().toISOString()
      const { error: upsertErr } = await (admin as any)
        .schema('inventory').from('vin_decoded')
        .upsert(upserts.map((u) => ({ ...u, decoded_at: nowIso })), { onConflict: 'vin' })
      if (upsertErr) return ok({ error: `cache upsert: ${upsertErr.message}` })
      newlyDecoded = upserts.filter((u) => u.decode_status === 'decoded').length
    }

    return ok({
      success: true,
      auto: autoMode,
      requested: requestedVins.length,
      invalid: requestedVins.length - uniqueVins.length,
      cached_hits: alreadyCached.size,
      newly_decoded: newlyDecoded,
      attempted: toDecode.length,
      more_remaining: autoMode ? autoMoreRemaining : undefined,
      warnings: warnings.length ? warnings : undefined,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
