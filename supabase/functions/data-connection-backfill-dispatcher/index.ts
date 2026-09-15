// Advances every running inventory.data_connection_backfill_jobs row one
// bounded tick, entirely server-side — the "run it and forget it" answer to
// the Historical Orders/Usage/Staff-Time-Clock Backfill cards being plain
// client-side loops that die the moment the browser tab closes (see
// CLAUDE.md's "Background sync progress" note, and the still-separate
// manual backfill cards on Data Connections, which are unaffected by this
// and remain useful for "pull exactly this range right now").
//
// Overnight only (see isOvernight/OVERNIGHT_START_HOUR below) — found live
// 2026-09-15 that even chunked/rate-limited, a backfill running all day
// noticeably slowed down unrelated regular pages (Location Lookup,
// Staffing Report) by competing for the same database connections during
// business hours. A cron-triggered tick outside 9pm-6am company-local time
// is skipped with no DB write at all; a manual "Run Tick Now" from a real
// logged-in user always runs regardless of the hour.
//
// Orders / Staff Time Clock: each tick evaluates ONE month (the job's own
// cursor_month, walking backward), checking that month's real coverage via
// the existing Data Health RPCs (get_droptop_{orders,time_clock}_daily_
// coverage) against the job's target shops. A month already at or above
// min_coverage_pct is skipped (cheap — no Droptop API call); otherwise the
// job pulls it via that connection's own sync function in mode:'sync' with
// an explicit date range — CHUNKED across ticks (month_pending_ids), same
// as below. The cursor only advances to the previous month once
// month_pending_ids is genuinely empty. The job completes once cursor_month
// passes floor_month.
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
// Found live 2026-09-15: an earlier version of this function called the
// sync functions with a job's FULL shop list (267 shops) in one unchunked
// request and never checked the response's HTTP status before treating it
// as a success — the platform silently killed the invocation partway
// through (the exact "chunk-timeout at full-company scale" failure the
// routine data-connection-dispatcher already hit and fixed once, see its
// own DROPTOP_ORDER_CHUNK_SIZE/runChunksConcurrently/parseSyncResponse
// comments), and the truncated response read as a plain success. Real
// damage: May 2026 got pulled for only 12 of 267 shops, April for only 1,
// before each was wrongly marked "done". Fixed by copying that exact
// proven pattern here (fetchWithTimeout/parseSyncResponse/callChunk/
// runChunksConcurrently — this codebase copy-pastes these per function
// rather than sharing a module, same as the Droptop request-signing logic)
// plus month_pending_ids to track a month's own remaining shop chunks
// across ticks instead of assuming one tick finishes a whole month.
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
  month_pending_ids: string[] | null
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

// ── Chunked-call helpers — copied verbatim (in spirit) from
// data-connection-dispatcher/index.ts, which already proved this exact
// pattern out against the exact same failure mode. Kept as its own copy
// per this codebase's own convention (see the Droptop request-signing
// logic) rather than a shared module. ──────────────────────────────────
const FETCH_TIMEOUT_MS = 150_000
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// A non-2xx response (timeout, crash, killed invocation) or a body that
// isn't valid JSON must never read as "success" just because .error is
// absent — that's precisely the bug this function is named after fixing.
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

async function callChunk(
  url: string, secret: string, body: Record<string, unknown>, label: string,
): Promise<{ ok: boolean; data: any; warnings: string[] }> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
      body: JSON.stringify(body),
    })
    const { data, error } = await parseSyncResponse(res)
    if (error) return { ok: false, data: null, warnings: [`${label}: ${error}`] }
    return { ok: true, data, warnings: ((data?.warnings ?? []) as string[]).map((w) => `${label}: ${w}`) }
  } catch (err) {
    return { ok: false, data: null, warnings: [`${label}: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

const CHUNK_CONCURRENCY = 4
const CHUNK_TIME_BUDGET_MS = 100_000

// Unlike the routine dispatcher's own version, this also totals up a
// numeric field (orders/records upserted) across every chunk that
// succeeded, and reports how many of the given chunks it actually got
// through — the caller needs that to know whether to keep the SAME
// month's remaining ids for next tick or move on.
async function runChunksConcurrently(
  url: string, secret: string, chunks: string[][], bodyFor: (ids: string[]) => Record<string, unknown>, countField: string,
): Promise<{ status: string; message: string | null; chunksProcessed: number; total: number }> {
  const warnings: string[] = []
  let anySucceeded = false
  let processed = 0
  let total = 0
  const startedAt = Date.now()
  let nextIndex = 0
  async function worker() {
    for (;;) {
      if (Date.now() - startedAt > CHUNK_TIME_BUDGET_MS) return
      const i = nextIndex++
      if (i >= chunks.length) return
      const r = await callChunk(url, secret, bodyFor(chunks[i]), `Chunk ${i + 1}/${chunks.length}`)
      if (r.ok) { anySucceeded = true; if (typeof r.data?.[countField] === 'number') total += r.data[countField] }
      warnings.push(...r.warnings)
      processed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
  const status = chunks.length === 0 ? 'success' : !anySucceeded ? 'error' : warnings.length ? 'partial' : 'success'
  return { status, message: warnings.length ? warnings.join(' | ') : null, chunksProcessed: processed, total }
}

// Overnight-only: found live 2026-09-15 that a backfill running all day
// (even chunked/rate-limited) still competes with regular app traffic for
// the same database connections during business hours, made worse by
// ticks that overlap the next cron cycle once a big month takes over 10
// minutes (see the whole file's own header comment on that). Real shops
// run roughly 7am-7pm Eastern (per core.locations' own typical store
// hours) — 9pm-6am company-local time is comfortably outside both shop
// hours and normal corporate-office usage. A cron-triggered tick outside
// this window is skipped entirely (no DB write at all, same as the
// routine dispatcher's own isDue() no-op) — a manual "Run Tick Now" click
// from a real logged-in user always runs regardless of the hour, since
// that's someone deliberately watching it right now, not an unattended
// all-day cadence.
const OVERNIGHT_START_HOUR = 21 // 9pm
const OVERNIGHT_END_HOUR = 6    // 6am
function isOvernight(now: Date, tz: string): boolean {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false }).format(now))
  return hour >= OVERNIGHT_START_HOUR || hour < OVERNIGHT_END_HOUR
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Bounds how many shops one tick will attempt, same guardrail idea as the
// routine dispatcher's MAX_LOCATIONS_PER_TICK — keeps a single invocation
// from ever trying to do a whole 267-shop month in one shot again.
const MAX_IDS_PER_TICK = 60

async function tickMonthWalkJob(admin: ReturnType<typeof createClient>, job: BackfillJob, supabaseUrl: string, droptopSecret: string): Promise<Record<string, unknown>> {
  const cursor = job.cursor_month!
  const pStart = cursor
  const pEnd = monthEndOf(cursor)
  const fnName = job.connection_key === 'droptop_orders' ? 'droptop-sync-orders' : 'droptop-sync-staff-time-clock'
  // Orders writes up to 4 child tables per order — far heavier per-location
  // than time clock's single-call-per-location pull, so it needs a much
  // smaller chunk (this codebase's own routine dispatcher already learned
  // this the hard way: DROPTOP_ORDER_CHUNK_SIZE=3 vs DROPTOP_CHUNK_SIZE=20).
  const chunkSize = job.connection_key === 'droptop_orders' ? 3 : 20
  const countField = job.connection_key === 'droptop_orders' ? 'orders_upserted' : 'records_upserted'

  let pendingIds = job.month_pending_ids
  let coverageNote = ''
  if (pendingIds == null) {
    // Starting a fresh month — check its real coverage first.
    const rpcName = job.connection_key === 'droptop_orders' ? 'get_droptop_orders_daily_coverage' : 'get_droptop_time_clock_daily_coverage'
    const { data: days, error: rpcErr } = await (admin as any).rpc(rpcName, { p_start: pStart, p_end: pEnd })
    if (rpcErr) throw new Error(rpcErr.message)
    const observed = new Set<string>()
    for (const row of (days ?? []) as { location_ids: string[] | null }[]) for (const id of row.location_ids ?? []) observed.add(id)
    const target = job.location_ids
    const coveredCount = target.filter((id) => observed.has(id)).length
    const coverage = target.length > 0 ? coveredCount / target.length : 1
    if (coverage >= job.min_coverage_pct) {
      const prevMonth = monthBefore(cursor)
      const completed = prevMonth < job.floor_month
      const summary = `${pStart} — ${(coverage * 100).toFixed(0)}% of ${target.length} shop(s) already covered, skipped`
      await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
        cursor_month: completed ? cursor : prevMonth, month_pending_ids: null,
        months_skipped: job.months_skipped + 1, status: completed ? 'completed' : 'running',
        last_run_at: new Date().toISOString(), last_tick_summary: summary, error_message: null, updated_at: new Date().toISOString(),
      }).eq('id', job.id)
      return { job_id: job.id, connection: job.connection_key, summary, completed }
    }
    pendingIds = target
    coverageNote = ` (was ${(coverage * 100).toFixed(0)}% covered)`
  }

  const thisTickIds = pendingIds.slice(0, MAX_IDS_PER_TICK)
  const remainingAfterTick = pendingIds.slice(MAX_IDS_PER_TICK)
  const startUnix = Math.floor(new Date(`${pStart}T00:00:00.000Z`).getTime() / 1000)
  const endUnix = Math.floor(new Date(`${pEnd}T23:59:59.999Z`).getTime() / 1000)
  const chunks = chunkArray(thisTickIds, chunkSize)
  const result = await runChunksConcurrently(
    `${supabaseUrl}/functions/v1/${fnName}`, droptopSecret, chunks,
    (ids) => ({ mode: 'sync', startUnix, endUnix, locationIds: ids }),
    countField,
  )
  if (result.status === 'error') throw new Error(result.message ?? 'All chunks failed')

  const monthDone = remainingAfterTick.length === 0
  const prevMonth = monthBefore(cursor)
  const completed = monthDone && prevMonth < job.floor_month
  let summary = `${pStart}${coverageNote} — pulled ${thisTickIds.length} shop(s) this tick (${result.total} ${countField.replace('_upserted', '')})`
  if (!monthDone) summary += `, ${remainingAfterTick.length} shop(s) left for this month`
  if (result.message) summary += ` | ${result.message}`

  await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
    cursor_month: monthDone ? (completed ? cursor : prevMonth) : cursor,
    month_pending_ids: monthDone ? null : remainingAfterTick,
    months_pulled: job.months_pulled + (monthDone ? 1 : 0),
    status: completed ? 'completed' : 'running',
    last_run_at: new Date().toISOString(),
    last_tick_summary: summary,
    error_message: result.status === 'partial' ? result.message : null,
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
  const r = await callChunk(`${supabaseUrl}/functions/v1/droptop-sync-usage`, droptopSecret,
    { mode: 'usage', daysBack: 30, logDailyActivity: true, locationIds: chunk }, 'usage backfill')
  if (!r.ok) throw new Error(r.warnings.join(' | ') || 'droptop-sync-usage failed')
  const completed = remaining.length === 0
  const summary = `Pulled ${chunk.length} shop(s)${typeof r.data?.products_upserted === 'number' ? `, ${r.data.products_upserted} products` : ''} — ${remaining.length} shop(s) remaining`
  await (admin as any).schema('inventory').from('data_connection_backfill_jobs').update({
    usage_pending_location_ids: remaining,
    usage_done_count: job.usage_done_count + chunk.length,
    status: completed ? 'completed' : 'running',
    last_run_at: new Date().toISOString(),
    last_tick_summary: summary,
    error_message: r.warnings.length ? r.warnings.join(' | ') : null,
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
    const isCronCall = !!dispatchSecret && suppliedSecret === dispatchSecret
    let authorized = isCronCall
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
    const now = new Date()

    for (const job of (jobs ?? []) as BackfillJob[]) {
      if (isCronCall) {
        const tz = await timezoneFor(job.company_id)
        if (!isOvernight(now, tz)) {
          results.push({ job_id: job.id, connection: job.connection_key, summary: `Skipped — outside the overnight window (${OVERNIGHT_START_HOUR}:00-${OVERNIGHT_END_HOUR}:00 ${tz})` })
          continue
        }
      }
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
