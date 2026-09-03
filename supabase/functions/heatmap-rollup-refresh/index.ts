// Customer Heatmap — nightly zip-rollup refresh. Recomputes
// inventory.heatmap_zip_rollups for every (company_id, location_id,
// order_date) combo touched (inserted or re-synced) since the last run, so
// a period-preset heatmap load can read a small pre-aggregated table
// instead of scanning the full droptop_orders table every time.
//
// Deliberately decoupled from droptop-sync-orders (Option 2 of the 3
// proposed — see project memory) rather than hooked into the tail of that
// function: zero risk to the already-stabilized sync pipeline, at the cost
// of up to ~24h staleness. The client papers over that by falling back to
// the existing raw-order query for any date range that includes "today" —
// see CustomerHeatmapPage.tsx.
//
// All the real aggregation work happens in one Postgres call
// (public.refresh_heatmap_zip_rollups) — this function just reads/advances
// the watermark in inventory.heatmap_rollup_state around that call.
//
// Runs on the existing Data Connections dispatcher schedule (a
// data_connection_schedules row, connection_key 'heatmap_rollup_refresh')
// rather than its own separate pg_cron entry — one more `else if` branch in
// data-connection-dispatcher/index.ts, same as automated_checks. That
// dispatcher already runs on a fixed cadence and checks which connections
// are due, so this needs no new cron schedule of its own.
//
// Callable two ways, same dual-auth shape as run-automated-checks (which
// this mirrors exactly, down to reusing the same secret):
//  - Unattended, via the dispatcher (X-Sync-Token = the same
//    DATA_CONNECTION_DISPATCH_SECRET the dispatcher itself is called with —
//    this function is only ever invoked by that dispatcher or an admin's
//    own session, so it doesn't need a secret of its own).
//  - Interactively, from Data Connections' "Refresh Rollups Now" button (a
//    real logged-in user's session) — lets an admin flush the ~24h
//    staleness window right after a large backfill, rather than waiting
//    for the next scheduled tick.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Every call through PostgREST (including this function's own service-role
// admin client) rides on a connection opened as `authenticator`, which sets
// statement_timeout=8s for the session — SET ROLE service_role afterward
// doesn't reset it. A single refresh_heatmap_zip_rollups() call covering a
// large backlog does real work well past that 8s budget even with proper
// indexes in place.
//
// Originally bounded each call by a wall-clock p_until window, but that
// didn't actually cap the expensive part: cost is driven by how many
// DISTINCT (company, location, order_date) groups get touched — each one
// means a full re-aggregation of that day's orders — not by how much real
// time the update-time window spans. This session's historical order
// backfill stamped `updated_at` on ~200k rows spanning 15 months of
// order_finalized_at dates within a comparatively narrow real-time window
// (when the backfill script ran), so even a 4-hour p_until window still
// swept in most of that backlog in one shot and kept timing out.
//
// Bounding by GROUP COUNT (p_max_groups) alone still wasn't enough — the
// underlying GROUP BY that discovers which groups changed still had to
// scan/aggregate every row since the watermark before it could sort and
// cut the result to p_max_groups, i.e. that discovery step's own cost was
// unbounded regardless of the output limit. The function now bounds
// discovery itself first via p_max_rows (a genuine index-range-scan
// early-stop, ordered by updated_at), then derives touched groups from
// just that row slice and caps those to p_max_groups before the actual
// expensive day-total re-aggregation. Confirmed under a simulated 8s
// statement_timeout before deploying this. The watermark is persisted
// after EVERY batch (not just at the end) so a later batch failing
// doesn't lose progress already made.
const GROUP_BATCH_SIZE = 60
const ROW_DISCOVERY_LIMIT = 20_000
const MAX_BATCHES_PER_RUN = 200 // guards against an infinite loop bug; TIME_BUDGET_MS is the real limit

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-sync-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function ok(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const startedAt = Date.now()

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const dispatchSecret = Deno.env.get('DATA_CONNECTION_DISPATCH_SECRET')
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

    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as any

    const { data: state, error: stateErr } = await admin
      .schema('inventory').from('heatmap_rollup_state')
      .select('last_watermark').eq('id', 'singleton').maybeSingle()
    if (stateErr) return ok({ error: `Unable to read rollup state: ${stateErr.message}` })

    const runStartedAt = Date.now()
    let watermark = new Date(state?.last_watermark ?? '1970-01-01T00:00:00.000Z')
    let totalDates = 0
    let totalRows = 0
    let batches = 0
    let caughtUp = false

    // Bounded by wall-clock time, not just batch count — this is called by
    // the dispatcher with its own ~150s bound on the whole call (see
    // data-connection-dispatcher's fetchWithTimeout), so leave enough
    // margin to return a real response instead of getting cut off mid-loop
    // with nothing persisted for the batch in flight. A large backlog that
    // doesn't fully clear in one invocation just continues on the next
    // 5-minute dispatcher tick — the watermark already reflects everything
    // done so far.
    const TIME_BUDGET_MS = 120_000
    for (; batches < MAX_BATCHES_PER_RUN && Date.now() - runStartedAt < TIME_BUDGET_MS; batches++) {
      const { data: result, error: rpcErr } = await admin.rpc('refresh_heatmap_zip_rollups', {
        p_since: watermark.toISOString(), p_max_groups: GROUP_BATCH_SIZE, p_max_rows: ROW_DISCOVERY_LIMIT,
      })
      if (rpcErr) {
        // Whatever ran in earlier batches this invocation already advanced
        // and persisted the watermark below — only what's left past that
        // point needs retrying on the next tick, not the whole backlog.
        return ok({ error: `Rollup refresh failed on batch ${batches + 1} (since ${watermark.toISOString()}): ${rpcErr.message}`, dates_recomputed: totalDates, rows_upserted: totalRows })
      }
      const row = (Array.isArray(result) ? result[0] : result) as
        { dates_recomputed: number; rows_upserted: number; new_watermark: string } | undefined
      if (!row) return ok({ error: 'Rollup refresh returned no result', dates_recomputed: totalDates, rows_upserted: totalRows })

      totalDates += row.dates_recomputed
      totalRows += row.rows_upserted
      const newWatermark = new Date(row.new_watermark)
      const advanced = newWatermark.getTime() > watermark.getTime()
      watermark = newWatermark

      const { error: advanceErr } = await admin
        .schema('inventory').from('heatmap_rollup_state')
        .update({
          last_watermark: watermark.toISOString(),
          last_run_at: new Date().toISOString(),
          last_run_summary: { dates_recomputed: totalDates, rows_upserted: totalRows, batches: batches + 1 },
        })
        .eq('id', 'singleton')
      if (advanceErr) return ok({ error: `Rollup refresh ran but failed to advance watermark: ${advanceErr.message}`, dates_recomputed: totalDates, rows_upserted: totalRows })

      // A batch returning 0 touched groups (nothing newer than the
      // watermark left) means it's fully caught up — stop rather than
      // spinning empty batches for the rest of the time budget. A batch
      // that found groups but somehow didn't advance the watermark would
      // otherwise loop forever on the same p_since; treated as caught up
      // too rather than risking an infinite loop.
      if (row.dates_recomputed === 0 || !advanced) { caughtUp = true; break }
    }

    return ok({
      success: true,
      dates_recomputed: totalDates,
      rows_upserted: totalRows,
      batches,
      watermark: watermark.toISOString(),
      caught_up: caughtUp,
      duration_ms: Date.now() - startedAt,
    })
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
