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
    const since = state?.last_watermark ?? '1970-01-01T00:00:00.000Z'

    const { data: result, error: rpcErr } = await admin.rpc('refresh_heatmap_zip_rollups', { p_since: since })
    if (rpcErr) return ok({ error: `Rollup refresh failed: ${rpcErr.message}` })
    const row = (Array.isArray(result) ? result[0] : result) as
      { dates_recomputed: number; rows_upserted: number; new_watermark: string } | undefined
    if (!row) return ok({ error: 'Rollup refresh returned no result' })

    const { error: advanceErr } = await admin
      .schema('inventory').from('heatmap_rollup_state')
      .update({
        last_watermark: row.new_watermark,
        last_run_at: new Date().toISOString(),
        last_run_summary: { dates_recomputed: row.dates_recomputed, rows_upserted: row.rows_upserted },
      })
      .eq('id', 'singleton')
    if (advanceErr) return ok({ error: `Rollup refresh ran but failed to advance watermark: ${advanceErr.message}` })

    return ok({
      success: true,
      dates_recomputed: row.dates_recomputed,
      rows_upserted: row.rows_upserted,
      watermark: row.new_watermark,
      duration_ms: Date.now() - startedAt,
    })
  } catch (err) {
    return ok({ error: err instanceof Error ? err.message : String(err) })
  }
})
