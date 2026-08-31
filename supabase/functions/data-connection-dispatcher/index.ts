// Single fixed-cadence dispatcher for all scheduled data-connection syncs.
// pg_cron calls THIS function on a fixed interval (set up once, see the
// companion setup notes) — it never needs editing again. What actually runs,
// how often, and at what time is entirely driven by
// inventory.data_connection_schedules rows, which the Data Connections
// config page edits directly. That's the whole point: changing a
// connection's frequency/time is a row update in the app, not a Supabase-side
// cron edit.
//
// Requires Supabase secrets: DATA_CONNECTION_DISPATCH_SECRET (shared secret
// pg_cron sends back as X-Sync-Token), SKYBITZ_SYNC_SECRET, DROPTOP_SYNC_SECRET
// (forwarded to the underlying sync functions, which check them themselves).
//
// Cron-triggered only — no interactive use, so auth is the shared secret
// alone (unlike skybitz-tank-sync/droptop-sync-usage, which also accept a
// logged-in user for their own "Run Now" buttons).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

// Same chunk size as the client-side "Sync All" flow in droptopService.ts —
// keeps each droptop-sync-usage invocation's location count bounded well
// inside the platform's execution time limit.
const DROPTOP_CHUNK_SIZE = 20

// A non-2xx response (timeout, crash, killed invocation) or a body that
// isn't valid JSON both used to fall through a bare `.catch(() => ({}))` as
// an empty object at every call site below — no `.error` key, so it read as
// "success" even though nothing actually ran. That's the likely explanation
// for a schedule row marked success with no matching sync_log entry: the
// real failure got masked, so isDue() considered the day's run already
// done and never retried. Centralized here so every call site gets the
// real check instead of repeating (or missing) it.
async function parseSyncResponse(res: Response): Promise<{ data: any; error: string | null }> {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { data: null, error: `HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}` }
  }
  try {
    const data = await res.json()
    return { data, error: data?.error ? String(data.error) : null }
  } catch {
    return { data: null, error: 'Response was not valid JSON (likely a timed-out or killed invocation)' }
  }
}

interface Schedule {
  id: string
  company_id: string
  connection_key: string
  schedule_mode: 'interval' | 'daily'
  interval_minutes: number | null
  daily_time: string | null
  last_run_at: string | null
}

// Wall-clock hour/minute/date in an IANA timezone, via Intl (no external
// library needed — V8/Deno ships full ICU data) — this is what lets "6:00
// AM" mean 6:00 AM in the company's actual timezone, DST included, rather
// than requiring a manual UTC offset conversion.
function wallClockIn(tz: string, at: Date): { hour: number; minute: number; dateKey: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at).map((p) => [p.type, p.value]),
  )
  return { hour: Number(parts.hour), minute: Number(parts.minute), dateKey: `${parts.year}-${parts.month}-${parts.day}` }
}

function isDue(s: Schedule, now: Date, tz: string): boolean {
  if (s.schedule_mode === 'interval') {
    if (!s.interval_minutes || s.interval_minutes <= 0) return false
    if (!s.last_run_at) return true
    return now.getTime() - new Date(s.last_run_at).getTime() >= s.interval_minutes * 60_000
  }
  // daily: due once the company-local clock has passed today's HH:MM and it
  // hasn't already run today (in that same local calendar day) — the
  // dispatcher's own cadence (every few minutes) determines how close to
  // that exact minute it actually fires.
  if (!s.daily_time) return false
  const [h, m] = s.daily_time.split(':').map((v) => parseInt(v, 10))
  if (isNaN(h) || isNaN(m)) return false
  const nowLocal = wallClockIn(tz, now)
  if (nowLocal.hour < h || (nowLocal.hour === h && nowLocal.minute < m)) return false
  if (!s.last_run_at) return true
  return wallClockIn(tz, new Date(s.last_run_at)).dateKey !== nowLocal.dateKey
}

async function runSkybitzTanks(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/skybitz-tank-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { error } = await parseSyncResponse(res)
  return error ? { status: 'error', message: error } : { status: 'success', message: null }
}

// Chunked the same way runDroptopChunked (below) handles on-hand/usage — a
// single invocation covering every location was assumed fine for POs given
// low per-shop volume, but a real run proved otherwise ("Edge Function
// returned a non-2xx status code" after ~3 minutes on the full location
// list). Same fix: bounded batches, one invocation per batch.
async function runDroptopPurchaseOrders(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string,
): Promise<{ status: string; message: string | null }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const ids = (locs ?? []).map((l: { id: string }) => l.id)
  if (!ids.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += DROPTOP_CHUNK_SIZE) chunks.push(ids.slice(i, i + DROPTOP_CHUNK_SIZE))

  const warnings: string[] = []
  let anySucceeded = false
  for (const locationIds of chunks) {
    const res = await fetch(`${supabaseUrl}/functions/v1/droptop-sync-purchase-orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
      body: JSON.stringify({ mode: 'sync', daysBack: 180, locationIds }),
    })
    const { data, error } = await parseSyncResponse(res)
    if (error) warnings.push(error)
    else { anySucceeded = true; if (data?.warnings?.length) warnings.push(...data.warnings) }
  }
  if (!anySucceeded) return { status: 'error', message: warnings.join(' | ') || 'All chunks failed' }
  return { status: warnings.length ? 'partial' : 'success', message: warnings.length ? warnings.join(' | ') : null }
}

// Same chunking as runDroptopPurchaseOrders above — one invocation per
// batch of locations, not one call covering every location.
async function runDroptopCustomers(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string,
): Promise<{ status: string; message: string | null }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const ids = (locs ?? []).map((l: { id: string }) => l.id)
  if (!ids.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += DROPTOP_CHUNK_SIZE) chunks.push(ids.slice(i, i + DROPTOP_CHUNK_SIZE))

  const warnings: string[] = []
  let anySucceeded = false
  for (const locationIds of chunks) {
    const res = await fetch(`${supabaseUrl}/functions/v1/droptop-sync-customers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
      body: JSON.stringify({ mode: 'sync', locationIds }),
    })
    const { data, error } = await parseSyncResponse(res)
    if (error) warnings.push(error)
    else { anySucceeded = true; if (data?.warnings?.length) warnings.push(...data.warnings) }
  }
  if (!anySucceeded) return { status: 'error', message: warnings.join(' | ') || 'All chunks failed' }
  return { status: warnings.length ? 'partial' : 'success', message: warnings.length ? warnings.join(' | ') : null }
}

// run-automated-checks reuses this same dispatch secret rather than minting
// its own — it's only ever called by this dispatcher or an admin's own
// interactive session, never unattended by anything else.
async function runAutomatedChecks(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/run-automated-checks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { error } = await parseSyncResponse(res)
  return error ? { status: 'error', message: error } : { status: 'success', message: null }
}

// Chunks locations the same way the interactive "Sync All" button does —
// sequential batches, so one automated run can't run long enough to hit the
// platform's per-invocation execution time limit.
async function runDroptopChunked(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string, mode: 'inventory' | 'usage',
): Promise<{ status: string; message: string | null }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const ids = (locs ?? []).map((l: { id: string }) => l.id)
  if (!ids.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += DROPTOP_CHUNK_SIZE) chunks.push(ids.slice(i, i + DROPTOP_CHUNK_SIZE))

  const warnings: string[] = []
  let anySucceeded = false
  for (const locationIds of chunks) {
    const body: Record<string, unknown> = { mode, locationIds }
    if (mode === 'usage') { body.daysBack = 1; body.logDailyActivity = true }
    const res = await fetch(`${supabaseUrl}/functions/v1/droptop-sync-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
      body: JSON.stringify(body),
    })
    const { data, error } = await parseSyncResponse(res)
    if (error) warnings.push(error)
    else { anySucceeded = true; if (data?.warnings?.length) warnings.push(...data.warnings) }
  }
  if (!anySucceeded) return { status: 'error', message: warnings.join(' | ') || 'All chunks failed' }
  return { status: warnings.length ? 'partial' : 'success', message: warnings.length ? warnings.join(' | ') : null }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const dispatchSecret = Deno.env.get('DATA_CONNECTION_DISPATCH_SECRET')
    const skybitzSecret = Deno.env.get('SKYBITZ_SYNC_SECRET')
    const droptopSecret = Deno.env.get('DROPTOP_SYNC_SECRET')

    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    if (!dispatchSecret || suppliedSecret !== dispatchSecret) return ok({ error: 'Not authorized' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: schedules, error } = await (admin as any)
      .schema('inventory').from('data_connection_schedules').select('*').eq('enabled', true)
    if (error) return ok({ error: error.message })

    const now = new Date()
    const results: Record<string, unknown>[] = []
    const tzByCompany = new Map<string, string>()
    async function timezoneFor(companyId: string): Promise<string> {
      if (tzByCompany.has(companyId)) return tzByCompany.get(companyId)!
      const { data } = await (admin as any)
        .schema('platform').from('app_settings').select('value')
        .eq('company_id', companyId).eq('key', 'data_connection_timezone').maybeSingle()
      const tz = typeof data?.value === 'string' ? data.value : 'America/Chicago'
      tzByCompany.set(companyId, tz)
      return tz
    }

    for (const s of (schedules ?? []) as Schedule[]) {
      const tz = await timezoneFor(s.company_id)
      if (!isDue(s, now, tz)) continue

      let outcome: { status: string; message: string | null }
      if (s.connection_key === 'skybitz_tanks') {
        if (!skybitzSecret) { outcome = { status: 'error', message: 'SKYBITZ_SYNC_SECRET not configured' } }
        else outcome = await runSkybitzTanks(supabaseUrl, skybitzSecret)
      } else if (s.connection_key === 'droptop_on_hand' || s.connection_key === 'droptop_usage') {
        if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
        else outcome = await runDroptopChunked(
          supabaseUrl, serviceKey, droptopSecret, s.company_id,
          s.connection_key === 'droptop_on_hand' ? 'inventory' : 'usage',
        )
      } else if (s.connection_key === 'droptop_purchase_orders') {
        if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
        else outcome = await runDroptopPurchaseOrders(supabaseUrl, serviceKey, droptopSecret, s.company_id)
      } else if (s.connection_key === 'droptop_customers') {
        if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
        else outcome = await runDroptopCustomers(supabaseUrl, serviceKey, droptopSecret, s.company_id)
      } else if (s.connection_key === 'automated_checks') {
        // Run after the Droptop pulls so the movement feed it reads is fresh —
        // schedule its own interval later in the day than droptop_usage's if
        // they're both daily-at-a-time schedules, since ordering between two
        // "interval" schedules otherwise isn't guaranteed.
        outcome = !dispatchSecret ? { status: 'error', message: 'DATA_CONNECTION_DISPATCH_SECRET not configured' }
          : await runAutomatedChecks(supabaseUrl, dispatchSecret)
      } else {
        outcome = { status: 'error', message: `Unknown connection_key: ${s.connection_key}` }
      }

      const nextRunAt = s.schedule_mode === 'interval' && s.interval_minutes
        ? new Date(now.getTime() + s.interval_minutes * 60_000).toISOString()
        : null
      await (admin as any).schema('inventory').from('data_connection_schedules')
        .update({ last_run_at: now.toISOString(), last_run_status: outcome.status, last_run_message: outcome.message, next_run_at: nextRunAt })
        .eq('id', s.id)

      results.push({ connection_key: s.connection_key, ...outcome })
    }

    return ok({ success: true, checked: (schedules ?? []).length, dispatched: results.length, results })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
