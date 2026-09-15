// Advances every running inventory.data_connection_backfill_jobs row one
// bounded tick, entirely server-side — the "run it and forget it" answer to
// the Historical Orders/Usage/Staff-Time-Clock Backfill cards being plain
// client-side loops that die the moment the browser tab closes (see
// CLAUDE.md's "Background sync progress" note, and the still-separate
// manual backfill cards on Data Connections, which are unaffected by this
// and remain useful for "pull exactly this range right now").
//
// Orders / Staff Time Clock: each tick evaluates ONE month (the job's own
// cursor_month, walking backward), checking that month's real coverage via
// the existing Data Health RPCs (get_droptop_{orders,time_clock}_daily_
// coverage) against the job's target shops. A month already at or above
// min_coverage_pct is skipped (cheap — no Droptop API call); otherwise this
// tick pulls it via that connection's own sync function in mode:'sync' with
// an explicit date range, then the cursor still moves back one month either
// way. The job completes once cursor_month passes floor_month.
//
// Usage: droptop-sync-usage has no historical date-range mode at all —
// Droptop's usage/inventory API is a live-state snapshot, not a queryable
// ledger (see that function's own POST-body doc comment: daysBack always
// counts back from right now). Its "backfill" is really just running the
// real 30-day pull once per shop instead of waiting a month for the
// rolling average to build up on its own — so its job type is flat: a
// pending shop list, chunked a few shops per tick, done when the list is
// empty. No month-walking, no coverage-checking, nothing to skip.
//
// A tick's error is treated as transient (a Droptop rate limit, a timeout)
// unless the required secret itself is missing — the job stays 'running'
// and simply retries the same month/chunk on the next tick rather than
// requiring someone to notice and manually resume it, which would defeat
// the point of a background job. error_message/last_tick_summary are
// there so a genuinely stuck job is still visible from the UI.
//
// Requires Supabase secrets: DATA_CONNECTION_DISPATCH_SECRET (same shared
// secret pg_cron already sends to data-connection-dispatcher — this
// function is registered on its own separate cron schedule, not called
// FROM that dispatcher, so a slow backfill tick can never delay the
// routine incremental syncs), DROPTOP_SYNC_SECRET (already configured;
// used to call droptop-sync-orders/-usage/-staff-time-clock the same way
// the routine dispatcher does).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

interface BackfillJob {
  id: string
  company_id: string
  connection_key: 'droptop_orders' | 'droptop_usage' | 'droptop_time_clock'
  status: string
  location_ids: string[]
  cursor_month: string | null
  floor_month: string
  min_coverage_pct: number
  months_pulled: number
  months_skipped: number
  usage_pending_location_ids: string[] | null
  usage_done_count: number
}

function monthEndOf(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00.000Z`)
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return end.toISOString().slice(0, 10)
}
function monthBefore(monthStart: string): string {
  const d = new Date(`${monthStart}T00:00:00.000Z`)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10)
}

async function callSyncFn(supabaseUrl: string, secret: string, fnName: string, body: Record<string, unknown>) {
  const resp = await fetch(`${supabaseUrl}/functions/v1/${fnName}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: JSON.stringify(body),
  })
  const data = await resp.json().catch(() => ({ error: `${fnName} returned a non-JSON response (HTTP ${resp.status})` }))
  if (data?.error) throw new Error(String(data.error))
  return data
}

async function tickMonthWalkJob(admin: ReturnType<typeof createClient>, job: BackfillJob, supabaseUrl: string, droptopSecret: string): Promise<Record<string, unknown>> {
  const cursor = job.cursor_month!
  const pStart = cursor
  const pEnd = monthEndOf(cursor)
  const rpcName = job.connection_key === 'droptop_orders' ? 'get_droptop_orders_daily_coverage' : 'get_droptop_time_clock_daily_coverage'

  const { data: days, error: rpcErr } = await (admin as any).rpc(rpcName, { p_start: pStart, p_end: pEnd })
  if (rpcErr) throw new Error(rpcErr.message)
  const observed = new Set<string>()
  for (const row of (days ?? []) as { location_ids: string[] | null }[]) for (const id of row.location_ids ?? []) observed.add(id)
  const target = job.location_ids
  const coveredCount = target.filter((id) => observed.has(id)).length
  const coverage = target.length > 0 ? coveredCount / target.length : 1

  let pulled = false
  let summary: string
  if (coverage >= job.min_coverage_pct) {
    summary = `${pStart} — ${(coverage * 100).toFixed(0)}% of ${target.length} shop(s) already covered, skipped`
  } else {
    const fnName = job.connection_key === 'droptop_orders' ? 'droptop-sync-orders' : 'droptop-sync-staff-time-clock'
    const startUnix = Math.floor(new Date(`${pStart}T00:00:00.000Z`).getTime() / 1000)
    const endUnix = Math.floor(new Date(`${pEnd}T23:59:59.999Z`).getTime() / 1000)
    const result = await callSyncFn(supabaseUrl, droptopSecret, fnName, { mode: 'sync', startUnix, endUnix, locationIds: target })
    pulled = true
    summary = `${pStart} — pulled (was ${(coverage * 100).toFixed(0)}% covered)`
    if (typeof result?.orders_upserted === 'number') summary += `, ${result.orders_upserted} orders`
    if (typeof result?.records_upserted === 'number') summary += `, ${result.records_upserted} records`
  }

  const prevMonth = monthBefore(cursor)
  const completed = prevMonth < job.floor_month
  await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
    cursor_month: completed ? cursor : prevMonth,
    months_pulled: job.months_pulled + (pulled ? 1 : 0),
    months_skipped: job.months_skipped + (pulled ? 0 : 1),
    status: completed ? 'completed' : 'running',
    last_run_at: new Date().toISOString(),
    last_tick_summary: summary,
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id)
  return { job_id: job.id, connection: job.connection_key, summary, completed }
}

async function tickUsageJob(admin: ReturnType<typeof createClient>, job: BackfillJob, supabaseUrl: string, droptopSecret: string): Promise<Record<string, unknown>> {
  const pending = job.usage_pending_location_ids ?? []
  if (pending.length === 0) {
    await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
      status: 'completed', last_run_at: new Date().toISOString(), last_tick_summary: 'All shops already pulled', updated_at: new Date().toISOString(),
    }).eq('id', job.id)
    return { job_id: job.id, connection: job.connection_key, summary: 'completed (nothing pending)', completed: true }
  }
  const CHUNK = 15
  const chunk = pending.slice(0, CHUNK)
  const remaining = pending.slice(CHUNK)
  const result = await callSyncFn(supabaseUrl, droptopSecret, 'droptop-sync-usage', { mode: 'usage', daysBack: 30, logDailyActivity: true, locationIds: chunk })
  const completed = remaining.length === 0
  const summary = `Pulled ${chunk.length} shop(s)${typeof result?.products_upserted === 'number' ? `, ${result.products_upserted} products` : ''} — ${remaining.length} shop(s) remaining`
  await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
    usage_pending_location_ids: remaining,
    usage_done_count: job.usage_done_count + chunk.length,
    status: completed ? 'completed' : 'running',
    last_run_at: new Date().toISOString(),
    last_tick_summary: summary,
    error_message: null,
    updated_at: new Date().toISOString(),
  }).eq('id', job.id)
  return { job_id: job.id, connection: job.connection_key, summary, completed }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const dispatchSecret = Deno.env.get('DATA_CONNECTION_DISPATCH_SECRET')
    const droptopSecret = Deno.env.get('DROPTOP_SYNC_SECRET')

    // Cron (shared secret) or a real logged-in user (a "Run tick now"
    // button, so a job doesn't have to wait for the next cron cycle to
    // show visible progress) — same dual-auth shape as skybitz-tank-sync.
    const suppliedSecret = req.headers.get('x-sync-token') ?? ''
    let authorized = !!dispatchSecret && suppliedSecret === dispatchSecret
    if (!authorized) {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (authHeader) {
        const caller = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
        const { data: who, error: whoErr } = await caller.auth.getUser()
        authorized = !whoErr && !!who.user
      }
    }
    if (!authorized) return ok({ error: 'Not authorized' })
    if (!droptopSecret) return ok({ error: 'DROPTOP_SYNC_SECRET not configured' })

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: jobs, error } = await (admin as any)
      .schema('inventory').from('data_connection_backfill_jobs').select('*').eq('status', 'running')
    if (error) return ok({ error: error.message })

    const results: Record<string, unknown>[] = []
    for (const job of (jobs ?? []) as BackfillJob[]) {
      try {
        if (job.connection_key === 'droptop_usage') {
          results.push(await tickUsageJob(admin, job, supabaseUrl, droptopSecret))
        } else {
          results.push(await tickMonthWalkJob(admin, job, supabaseUrl, droptopSecret))
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
          last_run_at: new Date().toISOString(), error_message: message, updated_at: new Date().toISOString(),
        }).eq('id', job.id)
        results.push({ job_id: job.id, connection: job.connection_key, error: message })
      }
    }

    return ok({ success: true, jobs_processed: results.length, results })
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
