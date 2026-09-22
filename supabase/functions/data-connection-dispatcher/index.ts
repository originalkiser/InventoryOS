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
// Dropped from 10 to match ORDER_CHUNK_SIZE in droptopService.ts — a real
// company-wide run timed out on 24 of 25 batches once packages/products/
// services line items were added (up to 4 tables' worth of rows per order
// now, not 1). See that constant's own comment for the full story.
const DROPTOP_ORDER_CHUNK_SIZE = 3
// Found 2026-09-21: Purchase Orders had been reusing DROPTOP_CHUNK_SIZE
// (20 — sized for Usage/On-Hand's lightweight single-table snapshot pull)
// for its own 180-day, multi-table (PO header + line items) sync, which is
// heavier per location than even a full month of Orders. Real production
// evidence: EVERY chunk of the daily scheduled run aborted, several days
// running ("The signal has been aborted" on 4/4 attempted chunks) — not an
// occasional straggler, a chunk size that was simply always too big for
// this specific sync's workload. Shrunk to 1 location/chunk, sequential,
// with a pause between calls (see its own runChunksConcurrently opts) —
// same fix already proven out on the historical Orders backfill's own
// identical symptom the day before.
const DROPTOP_PO_CHUNK_SIZE = 1

// Bounds every downstream sync call so one hung/slow invocation can't
// consume the rest of this dispatcher run — see the header comment on the
// main loop below for the incident this fixes (heatmap_rollup_refresh
// hanging on a missing index silently starved skybitz_tanks and
// droptop_orders of ever running, for most of a day, with no error
// surfaced anywhere). Each due connection now runs
// concurrently with the others (see the main loop below), so a slow chunk
// only delays its OWN connection_key, not its siblings — room to be
// generous here. Confirmed live 2026-09-03: droptop_orders' very first
// scheduled attempt (it had never run on schedule before, only ever
// manually) aborted at the old 90s on one chunk doing an unusually large
// first-time catch-up; 150s comfortably covers that without meaningfully
// delaying detection of an actually-hung call.
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

// Wraps one chunk's call: fetch + parse + catch, all in one place, so a
// single chunk throwing (a fetchWithTimeout abort, or any other
// network-level exception) can't propagate out of the whole run* function
// and abandon every remaining chunk — it used to, before this existed,
// silently dropping chunks that would have succeeded. `label` (e.g.
// "Chunk 4/29") prefixes every warning from this chunk so a partial
// failure can be attributed to roughly where it happened.
async function callChunk(
  url: string, secret: string, body: Record<string, unknown>, label: string,
): Promise<{ ok: boolean; warnings: string[] }> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
      body: JSON.stringify(body),
    })
    const { data, error } = await parseSyncResponse(res)
    if (error) return { ok: false, warnings: [`${label}: ${error}`] }
    return { ok: true, warnings: ((data?.warnings ?? []) as string[]).map((w) => `${label}: ${w}`) }
  } catch (err) {
    return { ok: false, warnings: [`${label}: ${err instanceof Error ? err.message : String(err)}`] }
  }
}

// droptop_orders' real production overnight run (2026-09-09) never updated
// its schedule row at all — not even to 'error' — which is what a schedule
// whose OWN total work is too big for one invocation looks like: the
// 2026-09-03 fix below (each schedule gets its own independent .update(),
// run concurrently with the others) stops one connection's slowness from
// blocking its SIBLINGS, but did nothing for a single connection whose own
// sequential chunk loop (91 chunks that night, one company_id's full
// location list ÷ DROPTOP_ORDER_CHUNK_SIZE) can outrun the platform's own
// execution-time ceiling for ONE invocation before ever reaching its own
// `.update()` call — so it just silently never got to run today, and (since
// isDue() still sees "last ran yesterday") retried the exact same losing
// race on every single dispatcher tick all night.
//
// Two-part fix, same shape used elsewhere in this session for an identical
// symptom: run CONCURRENCY chunks in flight at once instead of strictly one
// at a time (cuts total wall time roughly CONCURRENCY-fold in the common
// case), AND stop starting new chunks once TIME_BUDGET_MS has elapsed so a
// genuinely-too-big run still gets to WRITE something (a real 'partial'
// status covering however many chunks it got through) before the platform
// can kill the invocation out from under it — leaving a status the UI can
// actually show, instead of a schedule that looks like it never ran.
// Whatever chunks don't get processed today are picked up by the SAME
// incremental catch-up logic droptop-sync-orders already has for a missed
// day (see that function's own header comment) — no data is lost, just
// delayed by however many chunks were left over.
const CHUNK_CONCURRENCY = 4
const CHUNK_TIME_BUDGET_MS = 100_000

// `chunkSucceeded[i]` (added 2026-09-19) tells the caller exactly which
// input chunks actually succeeded, indexed the same as `chunks` — `false`
// for both a chunk that failed AND a chunk never even attempted before the
// time budget ran out (both leave `chunkSucceeded[i]` at its `false`
// default). `runDroptopOrders`/`runDroptopTimeClock` don't need this (they
// already re-derive "what's left" from a real per-location sync-state
// watermark next tick, so a dropped chunk there just naturally reappears
// in `remaining`) — this exists for `runDroptopPurchaseOrders`, which has
// no such watermark and used to silently re-attempt the exact same
// location list from the top every single scheduled run, permanently
// starving whichever locations sat in a chunk past the time-budget cutoff.
async function runChunksConcurrently(
  url: string, secret: string, chunks: string[][], bodyFor: (ids: string[]) => Record<string, unknown>,
  // concurrency/delayMs (added 2026-09-21, real production evidence: Purchase
  // Orders' daily sync has been aborting on EVERY chunk, multiple days
  // running — see runDroptopPurchaseOrders's own comment on why its chunk
  // size was the real culprit). Defaults preserve every other caller's
  // existing behavior unchanged.
  opts: { concurrency?: number; delayMs?: number } = {},
): Promise<{ status: string; message: string | null; chunkSucceeded: boolean[] }> {
  const concurrency = opts.concurrency ?? CHUNK_CONCURRENCY
  const delayMs = opts.delayMs ?? 0
  const warnings: string[] = []
  const chunkSucceeded: boolean[] = new Array(chunks.length).fill(false)
  let anySucceeded = false
  let processed = 0
  const startedAt = Date.now()
  let nextIndex = 0
  async function worker() {
    for (;;) {
      if (Date.now() - startedAt > CHUNK_TIME_BUDGET_MS) return
      const i = nextIndex++
      if (i >= chunks.length) return
      if (delayMs > 0 && i > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      const r = await callChunk(url, secret, bodyFor(chunks[i]), `Chunk ${i + 1}/${chunks.length}`)
      if (r.ok) { anySucceeded = true; chunkSucceeded[i] = true }
      warnings.push(...r.warnings)
      processed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker))
  if (processed < chunks.length) {
    warnings.push(`Stopped after ${processed}/${chunks.length} chunks (time budget) — remaining continue on the next scheduled run`)
  }
  if (!anySucceeded) return { status: 'error', message: warnings.join(' | ') || 'All chunks failed', chunkSucceeded }
  return { status: warnings.length ? 'partial' : 'success', message: warnings.length ? warnings.join(' | ') : null, chunkSucceeded }
}

// A non-2xx response (timeout, crash, killed invocation) or a body that
// isn't valid JSON both used to fall through a bare `.catch(() => ({}))` as
// an empty object at every call site below — no `.error` key, so it read as
// "success" even though nothing actually ran. That's the likely explanation
// for a schedule row marked success with no matching sync_log entry: the
// real failure got masked, so isDue() considered the day's run already
// done and never retried. Centralized here so every call site gets the
// real check instead of repeating (or missing) it. An aborted fetch (see
// fetchWithTimeout above) throws rather than resolving, so it's caught
// here too and turned into a real error message instead of an uncaught
// rejection.
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
  still_catching_up: boolean
  po_cursor_location_id: string | null
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
  const ranToday = wallClockIn(tz, new Date(s.last_run_at)).dateKey === nowLocal.dateKey
  if (!ranToday) return true
  // Already ran today — normally that's it until tomorrow. EXCEPTION: a
  // connection whose own work is too large for one invocation (droptop_orders/
  // droptop_time_clock, at real production location counts — see those
  // functions' own header comments) sets still_catching_up when a run left
  // real work undone, so it keeps getting picked up on ticks for the REST OF
  // TODAY (this dispatcher already fires every few minutes regardless, for
  // every other schedule) until it's actually caught up or genuinely stuck —
  // then still_catching_up clears and it goes quiet again until tomorrow's
  // daily_time, same as any other daily schedule. This is what lets "runs
  // once each morning" and "fully syncs every location" both stay true
  // without turning this into an all-day interval schedule.
  return s.still_catching_up === true
}

async function runSkybitzTanks(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/skybitz-tank-sync`, {
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
//
// Real production bug found live 2026-09-19: this always chunked the SAME
// unordered `SELECT id` result from the top every single scheduled run —
// combined with a real daily "Stopped after 8/15 chunks (time budget)"
// truncation, whichever locations happened to fall past the cutoff never
// got attempted, day after day, forever (no per-location watermark exists
// for this connection the way droptop_orders/droptop_time_clock have —
// see this file's header comment on that being a deliberately-deferred
// question for a MUTABLE-status record like a PO). Fixed with a much
// simpler fairness mechanism that sidesteps that harder question entirely:
// a persisted rotating cursor (inventory.data_connection_schedules.
// po_cursor_location_id) — each run starts right after wherever the LAST
// run's confirmed-good prefix of chunks ended (ordering locations by `id`
// so "after the cursor" is well-defined), wrapping back to the start once
// it reaches the end. A location that's starved by one truncated run is
// first in line on the very next tick instead of waiting for tomorrow's
// run to reach the same spot and stall again in the same place.
async function runDroptopPurchaseOrders(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string, cursorLocationId: string | null,
): Promise<{ status: string; message: string | null; newCursorLocationId?: string | null; stillCatchingUp?: boolean }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
    .order('id')
  if (locErr) return { status: 'error', message: locErr.message }
  const ids = (locs ?? []).map((l: { id: string }) => l.id)
  if (!ids.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  // A cursor pointing at a location that's since been deactivated/removed
  // (or a first-ever run, cursor null) just starts from the top — no
  // special-casing needed beyond indexOf returning -1.
  const cursorIdx = cursorLocationId ? ids.indexOf(cursorLocationId) : -1
  const rotated = cursorIdx === -1 ? ids : [...ids.slice(cursorIdx + 1), ...ids.slice(0, cursorIdx + 1)]

  const chunks: string[][] = []
  for (let i = 0; i < rotated.length; i += DROPTOP_PO_CHUNK_SIZE) chunks.push(rotated.slice(i, i + DROPTOP_PO_CHUNK_SIZE))

  const result = await runChunksConcurrently(
    `${supabaseUrl}/functions/v1/droptop-sync-purchase-orders`, secret, chunks,
    (locationIds) => ({ mode: 'sync', daysBack: 180, locationIds }),
    { concurrency: 1, delayMs: 3000 },
  )

  // Advance the cursor only through the longest UNBROKEN prefix of chunks
  // that actually succeeded, starting from chunk 0 — a chunk that failed
  // or was never attempted has to stay at the FRONT of the next run, not
  // get skipped over just because a later chunk happened to finish first
  // under CHUNK_CONCURRENCY. `stillCatchingUp` (same generic mechanism
  // isDue() already gives droptop_orders/droptop_time_clock) lets a
  // truncated run retry again later the SAME day instead of waiting until
  // tomorrow's scheduled time, so full coverage typically completes within
  // one day/night rather than drip-feeding across many.
  let lastGoodChunk = -1
  for (let i = 0; i < result.chunkSucceeded.length; i++) {
    if (result.chunkSucceeded[i]) lastGoodChunk = i
    else break
  }
  const newCursorLocationId = lastGoodChunk >= 0 ? chunks[lastGoodChunk][chunks[lastGoodChunk].length - 1] : cursorLocationId
  // Root cause of the 2026-09-20 Disk IO Budget incident: this used to be
  // `lastGoodChunk < chunks.length - 1` with no regard for WHY chunks
  // didn't finish — a run where every single chunk failed outright
  // (result.status === 'error', zero successes) got the exact same
  // "retry in ~5 minutes" treatment as a run that made real progress and
  // simply ran out of time budget. When the failure reason is the
  // downstream DB/API itself struggling, that retry-every-5-minutes
  // behavior is a self-inflicted retry storm — it hammers the same
  // already-struggling resource repeatedly all day instead of backing
  // off. A total failure now falls back to the ORIGINAL safe behavior
  // (wait for tomorrow's daily_time); only genuine partial progress
  // (status 'partial', at least one real success) stays same-day-retried.
  const stillCatchingUp = result.status !== 'error' && lastGoodChunk < chunks.length - 1
  return { status: result.status, message: result.message, newCursorLocationId, stillCatchingUp }
}

// Replaces the earlier runDroptopCustomers (droptop-sync-customers is
// superseded — see droptop-sync-orders' own header comment).
//
// Real production evidence 2026-09-09: even with runChunksConcurrently's
// bounded concurrency + time budget (above), droptop_orders STILL never
// completed a single invocation all morning (confirmed live via
// query_logs — many droptop-sync-orders calls firing every 5-minute tick,
// yet data_connection_schedules.last_run_at never advanced past the PRIOR
// day). Root cause: 91 chunks is simply too much real work — real network
// round trips to Droptop's API, some hitting Droptop's own rate limits —
// to reliably finish inside ONE invocation's platform execution-time
// ceiling, no matter how many run concurrently within it.
//
// Real fix: don't try to process every location every invocation at all.
// inventory.droptop_order_sync_state already tracks each location's own
// last_synced_date — a location whose date already reaches "yesterday"
// (the incremental mode's own target end date, see droptop-sync-orders'
// header comment) is fully caught up and doesn't need touching again until
// tomorrow's date rolls over. Filtering to just the REMAINING locations
// each tick, capped at MAX_LOCATIONS_PER_TICK, means: a normal day's first
// pass (whichever tick — manual or scheduled — happens to run first)
// catches up the vast majority in one go, and every tick after that does
// almost nothing (a fast couple of read-only queries, no Droptop calls at
// all once nothing remains) rather than always attempting all 278
// locations from scratch. Confirmed live the morning of this fix: 261/278
// already caught up, only 17 stragglers actually needed work.
//
// This is why the schedule row was switched from 'daily' (fires once, has
// to succeed with everyone caught up in that ONE attempt or wait until
// tomorrow) to 'interval'/15-minutes (see the migration this shipped
// with) — repeated small attempts throughout the day naturally mop up
// whatever a given tick didn't get to, at negligible cost once caught up.
const MAX_LOCATIONS_PER_TICK = 60
async function runDroptopOrders(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string,
): Promise<{ status: string; message: string | null; stillCatchingUp?: boolean }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const allIds = (locs ?? []).map((l: { id: string }) => l.id)
  if (!allIds.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  // Incremental mode always advances through YESTERDAY (never today — see
  // droptop-sync-orders' own header comment), so "caught up" for today's
  // cycle means last_synced_date already reaches yesterday's date, not
  // today's.
  const yesterdayUtc = new Date(); yesterdayUtc.setUTCHours(0, 0, 0, 0); yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1)
  const targetDateStr = yesterdayUtc.toISOString().slice(0, 10)
  const { data: stateRows, error: stateErr } = await (admin as any)
    .schema('inventory').from('droptop_order_sync_state')
    .select('location_id, last_synced_date').eq('company_id', companyId).in('location_id', allIds)
  if (stateErr) return { status: 'error', message: `sync-state read: ${stateErr.message}` }
  const caughtUp = new Set(
    (stateRows ?? [])
      .filter((r: { last_synced_date: string }) => r.last_synced_date >= targetDateStr)
      .map((r: { location_id: string }) => r.location_id),
  )
  const lastSyncedByLocation = new Map(
    (stateRows ?? []).map((r: { location_id: string; last_synced_date: string }) => [r.location_id, r.last_synced_date]),
  )
  const remaining = allIds.filter((id: string) => !caughtUp.has(id))
  if (!remaining.length) return { status: 'success', message: null }

  // The base query above has no ORDER BY, so without this, "the first
  // MAX_LOCATIONS_PER_TICK of whatever order Postgres happens to return"
  // decides who gets attempted each tick — if a subset of locations
  // consistently fails against Droptop (a stale/invalid
  // droptop_operation_id, an account-side issue, etc.), they never
  // advance past this filter, and an arbitrary row order gives nothing
  // else priority over them. Sorting the most-overdue locations first
  // (no sync-state row at all == furthest behind) means one tick's worth
  // of persistently-failing locations can't crowd out everyone else
  // indefinitely — and a location that's STILL always at the back after
  // this change is a real, visible signal (check
  // inventory.droptop_order_sync_state for it) rather than noise from row
  // ordering.
  remaining.sort((a: string, b: string) => {
    const da = lastSyncedByLocation.get(a) ?? ''
    const db = lastSyncedByLocation.get(b) ?? ''
    return da < db ? -1 : da > db ? 1 : 0
  })

  const thisTick = remaining.slice(0, MAX_LOCATIONS_PER_TICK)
  const chunks: string[][] = []
  for (let i = 0; i < thisTick.length; i += DROPTOP_ORDER_CHUNK_SIZE) chunks.push(thisTick.slice(i, i + DROPTOP_ORDER_CHUNK_SIZE))

  const result = await runChunksConcurrently(
    `${supabaseUrl}/functions/v1/droptop-sync-orders`, secret, chunks,
    (locationIds) => ({ mode: 'incremental', locationIds }),
  )
  if (remaining.length > thisTick.length) {
    const note = `${remaining.length - thisTick.length} more location(s) still catching up — continues on the next tick`
    // Never report 'success' here — result.status can be 'success' when
    // every location THIS tick attempted actually worked, but that's not
    // the whole truth when locations are still waiting behind the
    // MAX_LOCATIONS_PER_TICK cap. Real bug found 2026-09-13: this used to
    // pass a same-tick 'success' straight through even with hundreds of
    // locations still uncaught, which read as "all good" in the UI despite
    // the message saying otherwise.
    return {
      status: result.status === 'success' ? 'partial' : result.status,
      message: result.message ? `${result.message} | ${note}` : note,
      stillCatchingUp: true,
    }
  }
  return { ...result, stillCatchingUp: false }
}

// Same "don't retry the whole company every tick" fix as runDroptopOrders
// above, against its own separate sync-state table
// (inventory.droptop_time_clock_sync_state) — a lighter pull than orders
// (one Droptop call per location, no per-order child tables to write), so
// reuses DROPTOP_CHUNK_SIZE rather than needing orders' own smaller
// DROPTOP_ORDER_CHUNK_SIZE, but still batches across ticks rather than
// attempting every location in one invocation — the whole point of moving
// this off "manual backfill only" is for it to behave like every other
// Droptop connection here, including under real company-wide location
// counts.
async function runDroptopTimeClock(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string,
): Promise<{ status: string; message: string | null; stillCatchingUp?: boolean }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const allIds = (locs ?? []).map((l: { id: string }) => l.id)
  if (!allIds.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  const yesterdayUtc = new Date(); yesterdayUtc.setUTCHours(0, 0, 0, 0); yesterdayUtc.setUTCDate(yesterdayUtc.getUTCDate() - 1)
  const targetDateStr = yesterdayUtc.toISOString().slice(0, 10)
  const { data: stateRows, error: stateErr } = await (admin as any)
    .schema('inventory').from('droptop_time_clock_sync_state')
    .select('location_id, last_synced_date').eq('company_id', companyId).in('location_id', allIds)
  if (stateErr) return { status: 'error', message: `sync-state read: ${stateErr.message}` }
  const caughtUp = new Set(
    (stateRows ?? [])
      .filter((r: { last_synced_date: string }) => r.last_synced_date >= targetDateStr)
      .map((r: { location_id: string }) => r.location_id),
  )
  const lastSyncedByLocation = new Map(
    (stateRows ?? []).map((r: { location_id: string; last_synced_date: string }) => [r.location_id, r.last_synced_date]),
  )
  const remaining = allIds.filter((id: string) => !caughtUp.has(id))
  if (!remaining.length) return { status: 'success', message: null }

  // Most-overdue-first — same fairness fix as runDroptopOrders, so a
  // persistently-failing subset of locations can't crowd out everyone else
  // tick after tick.
  remaining.sort((a: string, b: string) => {
    const da = lastSyncedByLocation.get(a) ?? ''
    const db = lastSyncedByLocation.get(b) ?? ''
    return da < db ? -1 : da > db ? 1 : 0
  })

  const thisTick = remaining.slice(0, MAX_LOCATIONS_PER_TICK)
  const chunks: string[][] = []
  for (let i = 0; i < thisTick.length; i += DROPTOP_CHUNK_SIZE) chunks.push(thisTick.slice(i, i + DROPTOP_CHUNK_SIZE))

  const result = await runChunksConcurrently(
    `${supabaseUrl}/functions/v1/droptop-sync-staff-time-clock`, secret, chunks,
    (locationIds) => ({ mode: 'incremental', locationIds }),
  )
  if (remaining.length > thisTick.length) {
    const note = `${remaining.length - thisTick.length} more location(s) still catching up — continues on the next tick`
    return {
      status: result.status === 'success' ? 'partial' : result.status,
      message: result.message ? `${result.message} | ${note}` : note,
      stillCatchingUp: true,
    }
  }
  return { ...result, stillCatchingUp: false }
}

// run-automated-checks reuses this same dispatch secret rather than minting
// its own — it's only ever called by this dispatcher or an admin's own
// interactive session, never unattended by anything else.
async function runAutomatedChecks(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/run-automated-checks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { error } = await parseSyncResponse(res)
  return error ? { status: 'error', message: error } : { status: 'success', message: null }
}

// vin-decode already accepts DROPTOP_SYNC_SECRET (its own dual-auth check,
// same as skybitz-tank-sync/droptop-sync-usage) so this reuses that rather
// than minting a new secret. No company_id needed — vin-decode's
// auto-discover mode (empty body) finds its own work via get_undecoded_vins,
// which isn't company-scoped (a VIN's factory spec is global reference data).
async function runVinDecode(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/vin-decode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { data, error } = await parseSyncResponse(res)
  if (error) return { status: 'error', message: error }
  return { status: 'success', message: `${data?.newly_decoded ?? 0} decoded (${data?.cached_hits ?? 0} already cached)${data?.more_remaining ? ' — more remain for next run' : ''}` }
}

// Same reasoning as runAutomatedChecks above — reuses the dispatch secret,
// no secret of its own. Recomputes Customer Heatmap's pre-aggregated zip
// rollups for whatever droptop_orders rows changed since the last run.
async function runHeatmapRollupRefresh(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/heatmap-rollup-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { data, error } = await parseSyncResponse(res)
  if (error) return { status: 'error', message: error }
  return { status: 'success', message: `${data?.dates_recomputed ?? 0} location-day(s) recomputed, ${data?.rows_upserted ?? 0} zip row(s) written` }
}

// Same dual-auth shape as heatmap-rollup-refresh — reuses the dispatch
// secret, no secret of its own. Re-evaluates every enabled Staffing
// Alerts rule and replaces the company's whole violation set (a
// snapshot, not a history log — see that table's own migration comment).
async function runStaffingAlerts(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/staffing-alerts-refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { data, error } = await parseSyncResponse(res)
  if (error) return { status: 'error', message: error }
  return { status: 'success', message: `${data?.rules_checked ?? 0} rule(s) checked, ${data?.violations_found ?? 0} violation(s) found` }
}

// Same reasoning as runHeatmapRollupRefresh — reuses the dispatch secret,
// no secret of its own. Replaces the old ad-hoc "Location Data Sources"
// config UI entirely; this is the only supported way locations sync from
// Monday.com now. Not company-scoped in its own request body (the function
// resolves the single-tenant company_id itself) — matches vin_decode's
// reasoning for the same shape.
async function runMondayLocations(supabaseUrl: string, secret: string): Promise<{ status: string; message: string | null }> {
  const res = await fetchWithTimeout(`${supabaseUrl}/functions/v1/monday-sync-locations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-sync-token': secret },
    body: '{}',
  })
  const { data, error } = await parseSyncResponse(res)
  if (error) return { status: 'error', message: error }
  const warnCount = (data?.warnings ?? []).length
  return {
    status: warnCount ? 'partial' : 'success',
    message: `${data?.added ?? 0} added, ${data?.updated ?? 0} updated, ${data?.skipped ?? 0} skipped (of ${data?.total_board_items ?? 0} board items)`
      + (warnCount ? ` — ${(data.warnings as string[]).join(' | ')}` : ''),
  }
}

// Company-local "YYYY-MM-01" for the month currently in its month-end
// period (last 10 days of the month — same rule as src/utils/monthEndUtils
// .ts's isMonthEndPeriod, re-implemented timezone-aware here since a Deno
// edge function's own "now" has no relationship to any one company's local
// calendar day). Returns null outside that window.
function monthEndCountMonthFor(date: Date, timeZone: string): string | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const year = get('year'), month = get('month'), day = get('day')
  const lastDay = new Date(year, month, 0).getDate()
  if (day < lastDay - 9) return null
  return `${year}-${String(month).padStart(2, '0')}-01`
}

// Chunks locations the same way the interactive "Sync All" button does —
// sequential batches, so one automated run can't run long enough to hit the
// platform's per-invocation execution time limit.
//
// countMonth (added 2026-09-22, live report: the Month-End panel's own
// "Pull Now" is the ONLY thing that ever fed inventory.count_products — the
// routine scheduled on-hand sync ran every morning, logged a "success" row
// to the same droptop_sync_log table the panel displays, and never once
// wrote to count_products, so the panel's own "no separate upload needed
// for what's already pulled today" claim was false for every automatic
// run). Passed only for mode:'inventory' (the on-hand connection) — usage-
// mode rows never carry on_hands, so the count_products feed's own
// `on_hands != null` filter would exclude all of them anyway.
async function runDroptopChunked(
  supabaseUrl: string, serviceKey: string, secret: string, companyId: string, mode: 'inventory' | 'usage',
  countMonth: string | null = null,
): Promise<{ status: string; message: string | null }> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data: locs, error: locErr } = await (admin as any)
    .schema('core').from('locations').select('id').eq('company_id', companyId).not('droptop_operation_id', 'is', null)
  if (locErr) return { status: 'error', message: locErr.message }
  const ids = (locs ?? []).map((l: { id: string }) => l.id)
  if (!ids.length) return { status: 'error', message: 'No locations have a Droptop Operation ID set.' }

  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += DROPTOP_CHUNK_SIZE) chunks.push(ids.slice(i, i + DROPTOP_CHUNK_SIZE))

  return runChunksConcurrently(
    `${supabaseUrl}/functions/v1/droptop-sync-usage`, secret, chunks,
    (locationIds) => (mode === 'usage'
      ? { mode, locationIds, daysBack: 1, logDailyActivity: true }
      : { mode, locationIds, ...(countMonth ? { writeToCountProducts: true, countMonth } : {}) }),
  )
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

    // Emergency kill switch (added 2026-09-20, live Disk IO Budget incident)
    // — set as a plain Supabase secret so it can be flipped without a code
    // deploy. Checked before any DB access so it works even while Postgres
    // itself is unreachable/degraded; toggle off (`supabase secrets unset
    // EMERGENCY_PAUSE_DISPATCH`) once the project is healthy again.
    if (Deno.env.get('EMERGENCY_PAUSE_DISPATCH') === 'true') {
      return ok({ status: 'paused', message: 'Dispatcher paused via EMERGENCY_PAUSE_DISPATCH secret' })
    }

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

    // Due schedules used to be processed one at a time in a plain for-loop,
    // each `await`ed in turn. That meant one slow or hanging connection
    // (found live 2026-09-03: heatmap_rollup_refresh's Postgres statement
    // silently exceeding statement_timeout on every attempt, once its
    // underlying join had no supporting index at ~200k+ rows post-backfill)
    // consumed the whole invocation's time budget on every single 5-minute
    // tick, so the platform's own execution-time limit killed the
    // invocation before the loop ever reached whatever came after it —
    // skybitz_tanks and droptop_orders sat at "never run today" for hours
    // with no error logged anywhere, since the invocation died before
    // reaching their `.update()` calls at all. Each due schedule is now
    // processed independently (its own try/catch, its own bounded fetch via
    // fetchWithTimeout, its own `.update()` call made as soon as IT
    // finishes) and they all run concurrently — one hanging schedule can no
    // longer block, delay, or hide the others.
    async function processSchedule(s: Schedule): Promise<Record<string, unknown> | null> {
      const tz = await timezoneFor(s.company_id)
      if (!isDue(s, now, tz)) return null

      let outcome: { status: string; message: string | null; stillCatchingUp?: boolean; newCursorLocationId?: string | null }
      try {
        if (s.connection_key === 'skybitz_tanks') {
          if (!skybitzSecret) { outcome = { status: 'error', message: 'SKYBITZ_SYNC_SECRET not configured' } }
          else outcome = await runSkybitzTanks(supabaseUrl, skybitzSecret)
        } else if (s.connection_key === 'droptop_on_hand' || s.connection_key === 'droptop_usage') {
          if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
          else outcome = await runDroptopChunked(
            supabaseUrl, serviceKey, droptopSecret, s.company_id,
            s.connection_key === 'droptop_on_hand' ? 'inventory' : 'usage',
            s.connection_key === 'droptop_on_hand' ? monthEndCountMonthFor(now, tz) : null,
          )
        } else if (s.connection_key === 'droptop_purchase_orders') {
          if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
          else outcome = await runDroptopPurchaseOrders(supabaseUrl, serviceKey, droptopSecret, s.company_id, s.po_cursor_location_id)
        } else if (s.connection_key === 'droptop_orders') {
          if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
          else outcome = await runDroptopOrders(supabaseUrl, serviceKey, droptopSecret, s.company_id)
        } else if (s.connection_key === 'droptop_time_clock') {
          if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
          else outcome = await runDroptopTimeClock(supabaseUrl, serviceKey, droptopSecret, s.company_id)
        } else if (s.connection_key === 'automated_checks') {
          // Run after the Droptop pulls so the movement feed it reads is fresh —
          // schedule its own interval later in the day than droptop_usage's if
          // they're both daily-at-a-time schedules, since ordering between two
          // "interval" schedules otherwise isn't guaranteed.
          outcome = !dispatchSecret ? { status: 'error', message: 'DATA_CONNECTION_DISPATCH_SECRET not configured' }
            : await runAutomatedChecks(supabaseUrl, dispatchSecret)
        } else if (s.connection_key === 'heatmap_rollup_refresh') {
          outcome = !dispatchSecret ? { status: 'error', message: 'DATA_CONNECTION_DISPATCH_SECRET not configured' }
            : await runHeatmapRollupRefresh(supabaseUrl, dispatchSecret)
        } else if (s.connection_key === 'staffing_alerts') {
          outcome = !dispatchSecret ? { status: 'error', message: 'DATA_CONNECTION_DISPATCH_SECRET not configured' }
            : await runStaffingAlerts(supabaseUrl, dispatchSecret)
        } else if (s.connection_key === 'vin_decode') {
          if (!droptopSecret) { outcome = { status: 'error', message: 'DROPTOP_SYNC_SECRET not configured' } }
          else outcome = await runVinDecode(supabaseUrl, droptopSecret)
        } else if (s.connection_key === 'monday_locations') {
          outcome = !dispatchSecret ? { status: 'error', message: 'DATA_CONNECTION_DISPATCH_SECRET not configured' }
            : await runMondayLocations(supabaseUrl, dispatchSecret)
        } else {
          outcome = { status: 'error', message: `Unknown connection_key: ${s.connection_key}` }
        }
      } catch (err) {
        // A hung fetch aborted by fetchWithTimeout lands here (it throws
        // rather than resolving), as would any other unexpected exception —
        // caught per-schedule so it can't take the rest of the batch down
        // with it the way an uncaught throw in the old sequential loop did.
        outcome = { status: 'error', message: err instanceof Error ? err.message : String(err) }
      }

      const nextRunAt = s.schedule_mode === 'interval' && s.interval_minutes
        ? new Date(now.getTime() + s.interval_minutes * 60_000).toISOString()
        : null
      await (admin as any).schema('inventory').from('data_connection_schedules')
        .update({
          last_run_at: now.toISOString(),
          last_run_status: outcome.status,
          last_run_message: outcome.message,
          next_run_at: nextRunAt,
          // droptop_orders/droptop_time_clock/droptop_purchase_orders set
          // this true when real work remains — every other connection's
          // outcome always resolves it back to false, which is what lets a
          // daily schedule that previously needed same-day retries go quiet
          // again once it's caught up. See isDue()'s own comment for how
          // this is consumed.
          still_catching_up: outcome.stillCatchingUp === true,
          // Purchase Orders' own rotating-cursor fairness fix (2026-09-19,
          // see runDroptopPurchaseOrders' header comment) — every other
          // connection never sets this, so leaving it out of the payload
          // (rather than writing undefined/null) means their rows are
          // simply never touched, per Supabase JS's own "only SETs columns
          // present in the payload" behavior.
          ...(outcome.newCursorLocationId !== undefined ? { po_cursor_location_id: outcome.newCursorLocationId } : {}),
        })
        .eq('id', s.id)

      return { connection_key: s.connection_key, ...outcome }
    }

    const settled = await Promise.all(((schedules ?? []) as Schedule[]).map(processSchedule))
    for (const r of settled) if (r) results.push(r)

    return ok({ success: true, checked: (schedules ?? []).length, dispatched: results.length, results })
  } catch (err: unknown) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
