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

interface Schedule {
  id: string
  company_id: string
  connection_key: string
  schedule_mode: 'interval' | 'daily_utc'
  interval_minutes: number | null
  daily_time_utc: string | null
  last_run_at: string | null
}

function isDue(s: Schedule, now: Date): boolean {
  if (s.schedule_mode === 'interval') {
    if (!s.interval_minutes || s.interval_minutes <= 0) return false
    if (!s.last_run_at) return true
    return now.getTime() - new Date(s.last_run_at).getTime() >= s.interval_minutes * 60_000
  }
  // daily_utc: due once the clock has passed today's HH:MM (UTC) and it
  // hasn't already run today — the dispatcher's own cadence (every few
  // minutes) is what determines how close to that exact minute it fires.
  if (!s.daily_time_utc) return false
  const [h, m] = s.daily_time_utc.split(':').map((v) => parseInt(v, 10))
  if (isNaN(h) || isNaN(m)) return false
  const todayAtTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0))
  if (now.getTime() < todayAtTime.getTime()) return false
  if (!s.last_run_at) return true
  return new Date(s.last_run_at).getTime() < todayAtTime.getTime()
}

async function runSkybitzTanks(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetch(`${supabaseUrl}/functions/v1/skybitz-tank-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const data = await res.json().catch(() => ({}))
  return data?.error ? { status: 'error', message: String(data.error) } : { status: 'success', message: null }
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
    const data = await res.json().catch(() => ({}))
    if (data?.error) warnings.push(String(data.error))
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

    for (const s of (schedules ?? []) as Schedule[]) {
      if (!isDue(s, now)) continue

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
