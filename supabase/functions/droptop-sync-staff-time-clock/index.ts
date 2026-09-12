// Droptop Staff Time Clock sync — new data connection (2026-09) pulling
// clock-in/clock-out records per location, to compare staffing against car
// counts (inventory.droptop_orders) and order timing. See
// inventory.droptop_time_records' own migration comment for the table
// shape and why the natural key is (location_id, droptop_user_id, clock_in)
// rather than a record id (Droptop's response has none).
//
// Same conventions as droptop-sync-orders (dual auth, sig-signed requests,
// per-location calls that never abort the whole batch, data_connection_
// sync_log entry) — not re-explained here. Deliberately 'sync' mode ONLY
// for now (explicit range or daysBack, same as Historical Backfill) — no
// 'incremental' steady-state mode yet. Start with a bounded manual
// backfill and see what the data actually looks like before building the
// ongoing-sync machinery (sync-state table, dispatcher wiring, UI card) —
// droptop-sync-orders' own incremental mode went through several rounds of
// real-production fixes (timeouts on first-ever catch-up, an unordered
// per-tick location batch letting stuck locations crowd out others) that
// are much easier to get right with real data in hand than to guess up
// front.
//
// get-staff-time-clock caps each request at a 31-day range (same
// constraint as get-orders) — split the same way.
//
// Requires Supabase secrets: DROPTOP_PUBLIC_KEY, DROPTOP_PRIVATE_KEY
// (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are injected.)
//
// POST body: { daysBack?, startUnix?, endUnix?, locationId?, locationIds? }
//   daysBack    — window size ending now; default 7 (matches the initial
//                 backfill ask). Ignored if startUnix/endUnix are both given.
//   startUnix/endUnix — explicit window (unix seconds).
//   locationId  — sync a single location
//   locationIds — sync a specific batch of locations (client-side chunking)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// ── Droptop auth sig — identical to the other Droptop sync functions ──────
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

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
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
        console.warn(`[droptop-sync-staff-time-clock] ${endpoint} fetch threw (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${message}`)
        await sleep(waitMs)
        continue
      }
      console.error(`[droptop-sync-staff-time-clock] ${endpoint} fetch threw, retries exhausted: ${message}`)
      throw fetchErr
    }

    if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
      const retryAfterHeader = Number(res.headers.get('retry-after'))
      const waitMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : 2000 * 2 ** attempt
      const body = await res.text().catch(() => '')
      console.warn(`[droptop-sync-staff-time-clock] ${endpoint} returned ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${waitMs}ms: ${body}`)
      await sleep(waitMs)
      continue
    }
    const text = await res.text()
    if (!res.ok) {
      console.error(`[droptop-sync-staff-time-clock] ${endpoint} failed with ${res.status}, retries exhausted or non-retryable: ${text}`)
      throw new Error(`Droptop ${res.status}: ${text}`)
    }
    return JSON.parse(text)
  }
}

const MAX_RANGE_SECONDS = 31 * 86400

interface DroptopUser {
  user_id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  phone_number?: string | null
}
interface DroptopTimeRecord {
  clock_in: number
  clock_out: number | null
  hours?: number | null
  hours_regular?: number | null
  hours_overtime?: number | null
  hourly_wage?: string | number | null
  overtime_pay_rate?: string | number | null
  work_week_start?: string | null
  work_week_end?: string | null
  hours_per_week?: number | null
  [key: string]: unknown
}

// No userId is passed (we want every staff member, not one) — per the
// endpoint's own docs, the response is then an array of {user, time_records}
// objects rather than a single one. Split into <=31-day sub-windows and
// merge, same "dedupe by natural key, last write wins" precedent as
// droptop-sync-orders' fetchOrders for a record repeated across a window
// boundary.
async function fetchTimeRecords(
  operationId: string, startUnix: number, endUnix: number, pub: string, priv: string,
): Promise<{ user: DroptopUser; record: DroptopTimeRecord }[]> {
  const byKey = new Map<string, { user: DroptopUser; record: DroptopTimeRecord }>()
  let windowStart = startUnix
  while (windowStart < endUnix) {
    const windowEnd = Math.min(windowStart + MAX_RANGE_SECONDS, endUnix)
    const res = await callDroptop('get-staff-time-clock', {
      operation_ids: operationId, startUnix: String(windowStart), endUnix: String(windowEnd),
    }, pub, priv)
    // Defensive unwrap — every other Droptop endpoint in this codebase has
    // turned out to nest one level deeper than its docs claimed at some
    // point (see droptop-sync-orders' own header comment).
    const entries: { user: DroptopUser; time_records?: DroptopTimeRecord[] }[] =
      Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : []
    for (const entry of entries) {
      const user = entry.user
      if (!user?.user_id) continue
      for (const record of entry.time_records ?? []) {
        if (!Number.isFinite(Number(record.clock_in))) continue
        byKey.set(`${user.user_id}|${record.clock_in}`, { user, record })
      }
    }
    windowStart = windowEnd
  }
  return [...byKey.values()]
}

function tsToIso(unix: unknown): string | null {
  const n = Number(unix)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}
function numOrNull(v: unknown): number | null {
  return v != null && Number.isFinite(Number(v)) ? Number(v) : null
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
    const nowUnix = Math.floor(Date.now() / 1000)
    const hasExplicitRange = Number.isFinite(Number(body.startUnix)) && Number.isFinite(Number(body.endUnix))
    const daysBack = Math.min(3650, Math.max(1, Number(body.daysBack) || 7))
    const startUnix = hasExplicitRange ? Number(body.startUnix) : nowUnix - daysBack * 86400
    const endUnix = hasExplicitRange ? Number(body.endUnix) : nowUnix
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

    const warnings: string[] = []
    const recordsByKey = new Map<string, ReturnType<typeof buildRow>>()

    function buildRow(locationId2: string, user: DroptopUser, record: DroptopTimeRecord, nowIso: string) {
      return {
        company_id: companyId,
        location_id: locationId2,
        droptop_user_id: user.user_id,
        first_name: user.first_name ?? null,
        last_name: user.last_name ?? null,
        email: user.email ?? null,
        phone_number: user.phone_number ?? null,
        clock_in: tsToIso(record.clock_in)!,
        clock_out: tsToIso(record.clock_out),
        hours: numOrNull(record.hours),
        hours_regular: numOrNull(record.hours_regular),
        hours_overtime: numOrNull(record.hours_overtime),
        hourly_wage: numOrNull(record.hourly_wage),
        overtime_pay_rate: numOrNull(record.overtime_pay_rate),
        work_week_start: record.work_week_start ?? null,
        work_week_end: record.work_week_end ?? null,
        hours_per_week: numOrNull(record.hours_per_week),
        raw: record,
        last_change_source: 'droptop',
        updated_at: nowIso,
      }
    }

    const nowIso = new Date().toISOString()
    for (const loc of locations) {
      try {
        const entries = await fetchTimeRecords(loc.droptop_operation_id, startUnix, endUnix, publicKey, privateKey)
        for (const { user, record } of entries) {
          recordsByKey.set(`${loc.id}|${user.user_id}|${record.clock_in}`, buildRow(loc.id, user, record, nowIso))
        }
      } catch (e) {
        warnings.push(`location ${loc.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const rows = [...recordsByKey.values()]
    const UPSERT_BATCH = 200
    let recordsUpserted = 0
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const slice = rows.slice(i, i + UPSERT_BATCH)
      let lastErr: string | null = null
      let succeeded = false
      for (let attempt = 0; attempt <= 2; attempt++) {
        const { error: upsertErr } = await (admin as any)
          .schema('inventory').from('droptop_time_records')
          .upsert(slice, { onConflict: 'company_id,location_id,droptop_user_id,clock_in' })
        if (!upsertErr) { succeeded = true; break }
        lastErr = upsertErr.message
        if (attempt < 2) await sleep(500 * (attempt + 1))
      }
      if (!succeeded) { warnings.push(`Record batch ${i}-${i + slice.length}: ${lastErr}`); continue }
      recordsUpserted += slice.length
    }

    const status = warnings.length ? (recordsUpserted > 0 ? 'partial' : 'error') : 'success'
    await (admin as any).schema('inventory').from('data_connection_sync_log').insert({
      company_id: companyId,
      connection: 'droptop_time_clock',
      started_at: new Date(startedAt).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      items_updated: recordsUpserted,
      items_unchanged: 0,
      items_inserted: 0,
      status,
      error_message: warnings.length ? warnings.join(' | ') : null,
    })

    return ok({
      success: status !== 'error',
      locations_synced: locations.length,
      records_upserted: recordsUpserted,
      window: { startUnix, endUnix },
      warnings,
    })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
