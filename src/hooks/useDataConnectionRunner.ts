// Shared "run a Data Connection sync right now" logic — extracted out of
// DataConnectionsTab.tsx (2026-09-23) so the TopBar's Sync Status widget can
// offer the exact same per-connection Run Now (for admins/developers)
// without forking or re-implementing any of this per-connection wiring.
// Pure move, no behavior change — DataConnectionsTab.tsx now imports these
// same pieces instead of defining its own local copies.
import { supabase } from '@/lib/supabase'
import { runSkybitzTankSync } from '@/services/skybitzService'
import { runDroptopSync, runDroptopPurchaseOrderSync, runDroptopOrderSync } from '@/services/droptopService'
import type { DataConnectionSchedule } from '@/types/integrations'
import {
  useSyncTasksStore, DROPTOP_ON_HAND_TASK_ID, DROPTOP_USAGE_TASK_ID,
  DROPTOP_PO_SYNC_TASK_ID, DROPTOP_ORDERS_TASK_ID, SKYBITZ_TANKS_TASK_ID, AUTOMATED_CHECKS_TASK_ID,
  HEATMAP_ROLLUP_TASK_ID, VIN_DECODE_TASK_ID, MONDAY_LOCATIONS_TASK_ID,
  DROPTOP_TIME_CLOCK_TASK_ID,
} from '@/stores/syncTasksStore'
import toast from 'react-hot-toast'

export const CONNECTION_META: Record<string, { label: string; description: string }> = {
  skybitz_tanks: { label: 'SkyBitz Tank Monitors', description: 'Pulls tank telemetry (on-hand, level, battery) over SFTP.' },
  droptop_on_hand: { label: 'Droptop — On Hand', description: 'Pulls current on-hand quantities from Droptop into Product Usage.' },
  droptop_usage: { label: 'Droptop — Usage', description: 'Pulls sales/adjustment activity from Droptop and logs the daily sold/adjusted ledger.' },
  droptop_purchase_orders: { label: 'Droptop — Purchase Orders', description: 'Pulls open/recent POs and their line items — feeds the PO Status page and Orders v2\'s "already on order" check.' },
  droptop_orders: { label: 'Droptop — Orders (Customers)', description: 'Pulls each location\'s orders forward from its last successful sync (yesterday, or a wider catch-up after a missed day) with the placing customer\'s address, and resolves a lat/lng by zip — feeds the Customer Heatmap. Use the Historical Backfill below for a one-time date-ranged pull.' },
  droptop_time_clock: { label: 'Droptop — Staff Time Clock', description: 'Pulls each location\'s clock-in/clock-out records forward from its last successful sync (yesterday, or a wider catch-up after a missed day) — feeds the Staffing Report (compares headcount against Droptop order volume/timing). Use the Historical Backfill below for a one-time date-ranged, region/market/shop-scoped pull.' },
  automated_checks: { label: 'Automated Checks', description: 'Scans the movement feed for abnormal adjustments, sales with zero on-hand, and tank-vs-Droptop variance — flags into Exception Reporting. Run this after the Droptop pulls, not before.' },
  heatmap_rollup_refresh: { label: 'Customer Heatmap — Zip Rollups', description: 'Recomputes the pre-aggregated zip/day rollup table Customer Heatmap reads for period-preset ranges, so those loads skip scanning the full orders table. Run Now right after a large Historical Backfill to skip the ~24h staleness window.' },
  vin_decode: { label: 'Vehicles — Engine/Trim Decode', description: 'Looks up Trim/Engine for synced vehicles\' VINs via NHTSA\'s free VIN-decode API, caching results so nothing is ever decoded twice. A big backlog is caught up incrementally over multiple runs, not all at once — the Droptop Vehicles page\'s own "Decode Engine/Trim" button still works independently for whatever\'s currently in view.' },
  monday_locations: { label: 'Monday.com — Locations', description: 'Syncs the "Open Stores List" Monday.com board into Locations — matches by store number to update existing shops, and adds any board item not already in SB Net (including closed/pre-opening ones the file upload never brought in). Never deactivates a location just because it\'s missing from the board.' },
}
export const CONNECTION_ORDER = ['skybitz_tanks', 'droptop_on_hand', 'droptop_usage', 'droptop_purchase_orders', 'droptop_orders', 'droptop_time_clock', 'automated_checks', 'heatmap_rollup_refresh', 'vin_decode', 'monday_locations']

export const TASK_ID_FOR: Record<string, string> = {
  skybitz_tanks: SKYBITZ_TANKS_TASK_ID,
  droptop_on_hand: DROPTOP_ON_HAND_TASK_ID,
  droptop_usage: DROPTOP_USAGE_TASK_ID,
  droptop_purchase_orders: DROPTOP_PO_SYNC_TASK_ID,
  droptop_orders: DROPTOP_ORDERS_TASK_ID,
  droptop_time_clock: DROPTOP_TIME_CLOCK_TASK_ID,
  automated_checks: AUTOMATED_CHECKS_TASK_ID,
  heatmap_rollup_refresh: HEATMAP_ROLLUP_TASK_ID,
  vin_decode: VIN_DECODE_TASK_ID,
  monday_locations: MONDAY_LOCATIONS_TASK_ID,
}
export function statusColor(status: string | null): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'success') return 'green'
  if (status === 'partial') return 'orange'
  if (status === 'error') return 'red'
  return 'gray'
}

/**
 * Runs one connection's sync right now, exactly as DataConnectionsTab.tsx's
 * "Run Now" button always has — reports live progress into the shared
 * useSyncTasksStore (so it shows in the TopBar regardless of which page
 * started it) and best-effort writes last_manual_run_* back onto its
 * data_connection_schedules row. Never throws — every branch's own error is
 * caught, toasted, and reported into the store as a failed task.
 */
export async function runDataConnectionNow(
  key: string,
  ctx: { companyId: string; rows: DataConnectionSchedule[] | null; profileId: string | null },
): Promise<void> {
  const { companyId, rows, profileId } = ctx
  const store = useSyncTasksStore.getState()
  const taskId = TASK_ID_FOR[key] ?? key
  store.start(taskId, CONNECTION_META[key]?.label ?? key)
  const onProgress = (p: { batch: number; totalBatches: number }) => store.setProgress(taskId, p.batch, p.totalBatches)
  let manualStatus: 'success' | 'partial' | 'error' = 'success'
  let manualMessage: string | null = null
  try {
    let summary = ''
    let warnings: string[] | undefined
    if (key === 'skybitz_tanks') {
      const r = await runSkybitzTankSync()
      summary = `SkyBitz: ${r.updated} updated, ${r.inserted} new, ${r.unchanged} unchanged`
    } else if (key === 'droptop_on_hand') {
      const r = await runDroptopSync(companyId, { mode: 'inventory', daysBack: 1 }, onProgress)
      summary = `Droptop on-hand: ${r.operations_synced} shop(s), ${r.products_upserted} products`
      warnings = r.warnings
    } else if (key === 'droptop_usage') {
      const r = await runDroptopSync(companyId, { mode: 'usage', daysBack: 1, logDailyActivity: true }, onProgress)
      summary = `Droptop usage: ${r.operations_synced} shop(s), ${r.products_upserted} products`
        + (r.rolling_usage_applied ? ` (${r.rolling_usage_applied} using a rolling 30-day average)` : '')
      warnings = r.warnings
    } else if (key === 'droptop_purchase_orders') {
      const r = await runDroptopPurchaseOrderSync({ daysBack: 180 }, companyId, onProgress)
      summary = `Droptop POs: ${r.locations_synced} shop(s), ${r.pos_upserted} POs, ${r.items_written} line items`
      warnings = r.warnings
    } else if (key === 'droptop_orders') {
      const r = await runDroptopOrderSync(companyId, { incremental: true }, onProgress)
      summary = `Droptop orders: ${r.locations_synced} shop(s), ${r.orders_upserted} new order(s)`
        + (r.orders_missing_zip_match ? ` (${r.orders_missing_zip_match} missing a zip match — excluded from the heatmap)` : '')
      warnings = r.warnings
    } else if (key === 'droptop_time_clock') {
      const { data, error } = await supabase.functions.invoke('droptop-sync-staff-time-clock', { body: { mode: 'incremental' } })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      summary = `Staff Time Clock: ${data.locations_synced} shop(s), ${data.records_upserted} record(s)`
      warnings = data.warnings
    } else if (key === 'automated_checks') {
      const { data, error } = await supabase.functions.invoke('run-automated-checks', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      summary = `Automated Checks: ${data.created} new exception${data.created === 1 ? '' : 's'} flagged (${data.checked} anomal${data.checked === 1 ? 'y' : 'ies'} found)`
    } else if (key === 'heatmap_rollup_refresh') {
      const { data, error } = await supabase.functions.invoke('heatmap-rollup-refresh', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      summary = `Zip Rollups: ${data.dates_recomputed} location-day(s) recomputed, ${data.rows_upserted} zip row(s) written`
    } else if (key === 'vin_decode') {
      const { data, error } = await supabase.functions.invoke('vin-decode', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      summary = `Engine/Trim Decode: ${data.newly_decoded} decoded (${data.cached_hits} already cached)`
        + (data.more_remaining ? ' — more remain, click Run Now again or wait for the next scheduled run' : '')
    } else if (key === 'monday_locations') {
      const { data, error } = await supabase.functions.invoke('monday-sync-locations', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      summary = `Monday.com Locations: ${data.added} added, ${data.updated} updated, ${data.skipped} skipped (of ${data.total_board_items} board items)`
      warnings = data.warnings
    }
    if (warnings?.length) { manualStatus = 'partial'; manualMessage = `${summary} — ${warnings.join(' | ')}` }
    else manualMessage = summary
    store.finish(taskId, manualStatus === 'partial' ? 'partial' : 'success', manualMessage)
    if (manualStatus === 'partial') toast(manualMessage ?? summary, { icon: '⚠️', duration: 10000 })
    else toast.success(summary)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Sync failed'
    manualStatus = 'error'; manualMessage = message
    store.finish(taskId, 'error', message)
    toast.error(message, { duration: 12000 })
  } finally {
    // Best-effort — last_manual_run_* is a newer column set that may not
    // exist yet in production.
    const row = rows?.find((r) => r.connection_key === key)
    if (row) {
      try {
        const sb = supabase as any
        await sb.schema('inventory').from('data_connection_schedules')
          .update({
            last_manual_run_at: new Date().toISOString(),
            last_manual_run_status: manualStatus,
            last_manual_run_message: manualMessage,
            last_manual_run_by: profileId,
          })
          .eq('id', row.id)
      } catch { /* best-effort — column set may not exist yet in production */ }
    }
  }
}
