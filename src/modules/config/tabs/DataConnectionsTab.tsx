// Simplified place to run and schedule the app's server-side sync jobs
// (SkyBitz tank telemetry, Droptop on-hand, Droptop usage) without touching
// Supabase-side cron config. Automation is entirely driven by
// inventory.data_connection_schedules — a single fixed-cadence pg_cron job
// (data-connection-dispatcher) checks these rows and fires whatever's due;
// changing a connection's frequency or time is just a row update here.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Card, CardHeader, CardBody, Toggle, Badge, Select, SbLoader, MultiSelectDropdown } from '@/components/ui'
import { runSkybitzTankSync } from '@/services/skybitzService'
import { runDroptopSync, runDroptopPurchaseOrderSync, runDroptopOrderSync } from '@/services/droptopService'
import { runGeocoding } from '@/services/geocodingService'
import type { DataConnectionSchedule } from '@/types/integrations'
import { formatInTz } from '@/lib/tzFormat'
import {
  useSyncTasksStore, DROPTOP_ON_HAND_TASK_ID, DROPTOP_USAGE_TASK_ID,
  DROPTOP_PO_SYNC_TASK_ID, DROPTOP_ORDERS_TASK_ID, SKYBITZ_TANKS_TASK_ID, AUTOMATED_CHECKS_TASK_ID,
  GEOCODE_ORDERS_TASK_ID, HEATMAP_ROLLUP_TASK_ID,
} from '@/stores/syncTasksStore'
import toast from 'react-hot-toast'

// Exact match first, then substring fallback — a plain ilike substring
// search on a numeric shop code ("55") also matches unrelated shops that
// merely contain that code as a substring ("155"), and with no explicit
// ordering .limit(1) can silently pick either one. This is what made
// Inspect/Test One Shop look "broken" (returning 0 orders) when they'd
// actually resolved to the wrong shop entirely. Ambiguous substring
// matches are surfaced as an error instead of guessed at.
async function resolveShopLocation(sb: any, companyId: string, query: string): Promise<{ id: string; name: string }> {
  const trimmed = query.trim()
  const { data: exact, error: exactErr } = await sb.schema('core').from('locations')
    .select('id, name').eq('company_id', companyId).eq('name', trimmed).maybeSingle()
  if (exactErr) throw new Error(exactErr.message)
  if (exact) return exact
  const { data: matches, error: likeErr } = await sb.schema('core').from('locations')
    .select('id, name').eq('company_id', companyId).ilike('name', `%${trimmed}%`).order('name').limit(5)
  if (likeErr) throw new Error(likeErr.message)
  if (!matches?.length) throw new Error(`No location matching "${trimmed}"`)
  if (matches.length > 1) {
    throw new Error(`"${trimmed}" matches multiple shops (${matches.map((m: { name: string }) => m.name).join(', ')}) — type the exact shop number`)
  }
  return matches[0]
}

const TASK_ID_FOR: Record<string, string> = {
  skybitz_tanks: SKYBITZ_TANKS_TASK_ID,
  droptop_on_hand: DROPTOP_ON_HAND_TASK_ID,
  droptop_usage: DROPTOP_USAGE_TASK_ID,
  droptop_purchase_orders: DROPTOP_PO_SYNC_TASK_ID,
  droptop_orders: DROPTOP_ORDERS_TASK_ID,
  automated_checks: AUTOMATED_CHECKS_TASK_ID,
  heatmap_rollup_refresh: HEATMAP_ROLLUP_TASK_ID,
}

// Exported so DataConnectionUpdatesSection.tsx's sync-log table can display
// timestamps in this same company-configured timezone rather than the
// viewer's own browser timezone.
export const TIMEZONE_KEY = 'data_connection_timezone'
export const DEFAULT_TIMEZONE = 'America/Chicago'
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern (New York)' },
  { value: 'America/Chicago', label: 'Central (Chicago)' },
  { value: 'America/Denver', label: 'Mountain (Denver)' },
  { value: 'America/Phoenix', label: 'Mountain, no DST (Phoenix)' },
  { value: 'America/Los_Angeles', label: 'Pacific (Los Angeles)' },
  { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
  { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
]

const CONNECTION_META: Record<string, { label: string; description: string }> = {
  skybitz_tanks: { label: 'SkyBitz Tank Monitors', description: 'Pulls tank telemetry (on-hand, level, battery) over SFTP.' },
  droptop_on_hand: { label: 'Droptop — On Hand', description: 'Pulls current on-hand quantities from Droptop into Product Usage.' },
  droptop_usage: { label: 'Droptop — Usage', description: 'Pulls sales/adjustment activity from Droptop and logs the daily sold/adjusted ledger.' },
  droptop_purchase_orders: { label: 'Droptop — Purchase Orders', description: 'Pulls open/recent POs and their line items — feeds the PO Status page and Orders v2\'s "already on order" check.' },
  droptop_orders: { label: 'Droptop — Orders (Customers)', description: 'Pulls each location\'s orders forward from its last successful sync (yesterday, or a wider catch-up after a missed day) with the placing customer\'s address, and resolves a lat/lng by zip — feeds the Customer Heatmap. Use the Historical Backfill below for a one-time date-ranged pull.' },
  automated_checks: { label: 'Automated Checks', description: 'Scans the movement feed for abnormal adjustments, sales with zero on-hand, and tank-vs-Droptop variance — flags into Exception Reporting. Run this after the Droptop pulls, not before.' },
  heatmap_rollup_refresh: { label: 'Customer Heatmap — Zip Rollups', description: 'Recomputes the pre-aggregated zip/day rollup table Customer Heatmap reads for period-preset ranges, so those loads skip scanning the full orders table. Run Now right after a large Historical Backfill to skip the ~24h staleness window.' },
}
const CONNECTION_ORDER = ['skybitz_tanks', 'droptop_on_hand', 'droptop_usage', 'droptop_purchase_orders', 'droptop_orders', 'automated_checks', 'heatmap_rollup_refresh']

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

function statusColor(status: string | null): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'success') return 'green'
  if (status === 'partial') return 'orange'
  if (status === 'error') return 'red'
  return 'gray'
}

export function DataConnectionsTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [timezone, setTimezone] = useAppSetting<string>(TIMEZONE_KEY, DEFAULT_TIMEZONE)
  const [rows, setRows] = useState<DataConnectionSchedule[] | null>(null)
  const [running, setRunning] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [inspectShop, setInspectShop] = useState('')
  const [inspectProductId, setInspectProductId] = useState('')
  const [backfillOptions, setBackfillOptions] = useState<{ id: string; label: string }[]>([])
  const [backfillShops, setBackfillShops] = useState<string[]>([])
  const [testOrderShop, setTestOrderShop] = useState('')
  const [inspectOrdersShop, setInspectOrdersShop] = useState('')
  const [orderBackfillShops, setOrderBackfillShops] = useState<string[]>([])
  const [orderBackfillStart, setOrderBackfillStart] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().slice(0, 10) })
  const [orderBackfillEnd, setOrderBackfillEnd] = useState(() => new Date().toISOString().slice(0, 10))
  // Which eligible shops have at least one order WITHIN the currently
  // selected backfill range (not "ever, at any date" — see the effect
  // below for why that distinction turned out to matter). null = still
  // loading OR the check failed; distinguished from a real failure by
  // locationIdsInRangeError below, since gapShopLabels renders nothing for
  // BOTH otherwise, and a failed check silently looking identical to
  // "confirmed zero gap shops" is exactly as misleading as the original
  // "everyone's a gap" bug, just in the opposite direction.
  const [locationIdsInRange, setLocationIdsInRange] = useState<Set<string> | null>(null)
  const [locationIdsInRangeError, setLocationIdsInRangeError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('data_connection_schedules')
      .select('*').eq('company_id', companyId)
    setRows((data ?? []) as DataConnectionSchedule[])
  }, [companyId])

  useEffect(() => { load() }, [load])

  // Locations eligible for the historical backfill — only shops already
  // mapped to a Droptop Operation ID, same scope as the routine usage sync.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.schema('core').from('locations')
      .select('id, name, shop_city')
      .eq('company_id', companyId)
      .not('droptop_operation_id', 'is', null)
      .order('name')
      .then(({ data }: any) => {
        if (cancelled) return
        setBackfillOptions((data ?? []).map((l: any) => ({ id: l.id, label: l.shop_city ? `${l.name} — ${l.shop_city}` : l.name })))
      })
    return () => { cancelled = true }
  }, [companyId])

  // For the "Select Gap Shops" convenience below. Originally checked
  // inventory.droptop_orders_synced_locations ("has this location EVER had
  // an order land, at any date") — but that missed a real case found live
  // (2026-09-02): shop 212 has exactly 2 orders, both from the last day of
  // August, and shop 114 has 33 orders spanning only 3 days at month-end —
  // both read as "already synced" even though their actual historical
  // depth for a real backfill range is essentially nothing (their
  // Historical Backfill likely never ran or never finished; only the
  // routine daily incremental sync ever wrote anything for them). The
  // question that actually matters for this button is "does this shop
  // have ANY order within the range I'm about to backfill" — so this now
  // re-checks against the CURRENTLY SELECTED start/end instead of all
  // time, via a small RPC (public.get_droptop_order_location_ids_in_range)
  // that does the DISTINCT server-side. Paginated the same defensive way
  // as every other fetch in this codebase — a real company has ~250
  // eligible shops, nowhere near the 1000-row API cap, but that "it's a
  // small result, no pagination needed" reasoning was also wrong once
  // already this session (the Heatmap's rollup RPC), so it isn't trusted
  // here either.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLocationIdsInRangeError(null)
    const sb = supabase as any
    async function run() {
      const PAGE = 1000
      const all: string[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.rpc('get_droptop_order_location_ids_in_range', {
          p_start: orderBackfillStart, p_end: orderBackfillEnd,
        }).range(from, from + PAGE - 1)
        if (cancelled) return
        if (error) {
          // Leave locationIdsInRange at null (its "still loading" value) on
          // a real query failure, NOT an empty Set — a failed request
          // silently becoming an empty Set would make gapShopLabels below
          // read as "confirmed zero gap shops," exactly as misleading as
          // the original "everyone's a gap" bug, just in the other
          // direction. Surfaced persistently (locationIdsInRangeError
          // below), not just a toast that disappears.
          console.error('Failed to load in-range locations for gap detection:', error.message)
          setLocationIdsInRangeError(error.message)
          toast.error(`Unable to check which shops have orders in this range — gap detection unavailable (${error.message})`)
          return
        }
        const batch = (data ?? []) as { location_id: string }[]
        all.push(...batch.map((r) => r.location_id))
        if (batch.length === 0) break
      }
      if (!cancelled) setLocationIdsInRange(new Set(all))
    }
    run().catch((e) => {
      if (cancelled) return
      const message = e instanceof Error ? e.message : 'Failed to check gap shops'
      setLocationIdsInRangeError(message)
      toast.error(`Unable to check which shops have orders in this range — gap detection unavailable (${message})`)
    })
    return () => { cancelled = true }
  }, [companyId, orderBackfillStart, orderBackfillEnd])

  const gapShopLabels = useMemo(
    () => locationIdsInRange === null ? [] : backfillOptions.filter((o) => !locationIdsInRange.has(o.id)).map((o) => o.label),
    [backfillOptions, locationIdsInRange],
  )

  async function saveRow(row: DataConnectionSchedule, patch: Partial<DataConnectionSchedule>) {
    setSaving(row.id)
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('data_connection_schedules')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    setSaving(null)
    if (error) { toast.error('Failed to save schedule'); return }
    setRows((prev) => prev?.map((r) => (r.id === row.id ? { ...r, ...patch } : r)) ?? prev)
  }

  async function runNow(key: string) {
    if (!companyId) return
    setRunning(key)
    // Progress is tracked globally (syncTasksStore, shown in the TopBar),
    // not just this local `running` flag — that's what lets the sync keep
    // reporting correctly even if you navigate away from this tab while
    // it's still going, since the store isn't tied to this component's
    // lifecycle the way local state is.
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
        // Steady-state: each location pulls forward from wherever it last
        // successfully synced through yesterday (30-day catch-up cap) — see
        // inventory.droptop_order_sync_state / droptop-sync-orders' header
        // comment. Use the Historical Backfill controls below for a
        // one-time date-ranged pull instead.
        const r = await runDroptopOrderSync(companyId, { incremental: true }, onProgress)
        summary = `Droptop orders: ${r.locations_synced} shop(s), ${r.orders_upserted} new order(s)`
          + (r.orders_missing_zip_match ? ` (${r.orders_missing_zip_match} missing a zip match — excluded from the heatmap)` : '')
        warnings = r.warnings
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
      // exist yet in production. A manual "Run Now" previously never wrote
      // back to this table at all (only the dispatcher's scheduled runs
      // did), so "Last run" silently only ever reflected the most recent
      // automated run no matter how many times someone ran it by hand.
      const row = rows?.find((r) => r.connection_key === key)
      if (row) {
        const sb = supabase as any
        sb.schema('inventory').from('data_connection_schedules')
          .update({
            last_manual_run_at: new Date().toISOString(),
            last_manual_run_status: manualStatus,
            last_manual_run_message: manualMessage,
            last_manual_run_by: profile?.id ?? null,
          })
          .eq('id', row.id)
          .then(() => {})
      }
      setRunning(null)
      load()
    }
  }

  // Read-only peek at Droptop's raw, unmapped change-event shape — the same
  // "run it and read the console" step needed to confirm what a receiving
  // event's real change_type looks like before an abnormal-receipt check
  // can be built. A button here (using the app's own already-authenticated
  // client) is more reliable than reconstructing a session token by hand in
  // a pasted console script.
  //
  // Scoped variant: pass a shop name (or id) to inspect that one location
  // instead of an arbitrary first location, and get back a per-product
  // sale-event breakdown (count, summed qty, resulting daily_usage) — not
  // just a 5-row sample — so a specific product's number can be checked
  // against an independent manual calculation. An optional product id also
  // dumps every raw matching change event, for spotting duplicates or an
  // unexpected change_type by eye.
  async function inspectDroptopUsage() {
    if (!companyId) return
    setRunning('inspect')
    try {
      let locationId: string | undefined
      const shopQuery = inspectShop.trim()
      if (shopQuery) {
        const loc = await resolveShopLocation(supabase, companyId, shopQuery)
        locationId = loc.id
      }
      const productId = inspectProductId.trim() || undefined
      const { data, error } = await supabase.functions.invoke('droptop-sync-usage', {
        body: { mode: 'inspect', ...(locationId ? { locationId } : {}), ...(productId ? { productId } : {}) },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      // eslint-disable-next-line no-console
      console.log('Droptop inspect result:', data)
      if (data.product_breakdown?.length) {
        // eslint-disable-next-line no-console
        console.table(data.product_breakdown)
      }
      if (data.matching_raw_changes?.length) {
        // eslint-disable-next-line no-console
        console.log(`Raw '${data.requested_product_id}' change events:`, data.matching_raw_changes)
      }
      toast.success(
        `Inspect complete — ${data.product_breakdown?.length ?? 0} product(s) over ${data.window_days} day(s) logged to the browser console (press F12, check the table${productId ? ' and raw events' : ''}).`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Inspect failed')
    } finally {
      setRunning(null)
    }
  }

  // One-time historical backfill for a chosen set of shops — meant for a
  // newly-acquired shop already on Droptop before it acquisition, where the
  // ongoing daysBack:1 daily job (appending one day at a time to
  // inventory.daily_product_activity, see droptop-sync-usage's step 5b) has
  // no history to average over yet. Never defaults to "all locations" —
  // every other shop already has its rolling average building up naturally
  // from the routine daily job and doesn't need this. Manual-only: no
  // schedule, no automation toggle.
  async function runBackfill() {
    if (!companyId || !backfillShops.length) return
    setRunning('backfill')
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_USAGE_TASK_ID, `Droptop Usage — 30-day backfill (${backfillShops.length} shop${backfillShops.length === 1 ? '' : 's'})`)
    const onProgress = (p: { batch: number; totalBatches: number }) => store.setProgress(DROPTOP_USAGE_TASK_ID, p.batch, p.totalBatches)
    try {
      const labelToId = new Map(backfillOptions.map((o) => [o.label, o.id]))
      const locationIds = backfillShops.map((label) => labelToId.get(label)).filter((id): id is string => !!id)
      const r = await runDroptopSync(companyId, { mode: 'usage', daysBack: 30, logDailyActivity: true, locationIds }, onProgress)
      const summary = `Backfill complete: ${r.operations_synced} shop(s), ${r.products_upserted} products — 30 days of history now in the ledger`
      store.finish(DROPTOP_USAGE_TASK_ID, 'success', summary)
      toast.success(summary)
      setBackfillShops([])
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backfill failed'
      store.finish(DROPTOP_USAGE_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    } finally {
      setRunning(null)
    }
  }

  // Scoped single-shop test — one location, one edge function invocation,
  // last 30 days — so real per-shop volume/timing can be checked before
  // running company-wide. Also reports into the same global sync tracker
  // Run Now uses (a prior version of this button — back when it targeted
  // the now-superseded customer-list sync — only showed a toast, not
  // TopBar progress, which read as "did this actually do anything?").
  async function testOneShopOrders() {
    if (!companyId || !testOrderShop.trim()) return
    setRunning('test-orders')
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_ORDERS_TASK_ID, `Droptop Orders — test (${testOrderShop.trim()})`)
    try {
      const loc = await resolveShopLocation(supabase, companyId, testOrderShop.trim())
      const startedAt = Date.now()
      const { data, error } = await supabase.functions.invoke('droptop-sync-orders', {
        body: { mode: 'sync', daysBack: 30, locationId: loc.id },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
      // "0 orders" and "orders pulled but 0 mapped" read identically as
      // "no data" on the Heatmap afterward if this isn't loud about which
      // one actually happened — surfacing the matched location's real name
      // too, since a fuzzy name search silently resolving to the wrong
      // shop would otherwise look exactly like "it worked" here.
      const summary = `Matched "${loc.name}" — ${data.orders_upserted} orders in ${seconds}s (${data.orders_with_coordinates} mapped, ${data.orders_missing_zip_match} missing a zip match)`
      if (data.orders_upserted === 0) {
        store.finish(DROPTOP_ORDERS_TASK_ID, 'partial', `${summary} — no orders in this window for "${loc.name}". Wrong shop matched, or genuinely none placed?`)
        toast(`No orders found for "${loc.name}" in the last 30 days.`, { icon: '⚠️', duration: 10000 })
      } else if (data.orders_with_coordinates === 0) {
        store.finish(DROPTOP_ORDERS_TASK_ID, 'partial', `${summary} — none had a zip match, so none will show on the Heatmap.`)
        toast(`${data.orders_upserted} orders pulled for "${loc.name}", but 0 mapped — none will show on the Heatmap (all missing a zip match).`, { icon: '⚠️', duration: 12000 })
      } else {
        store.finish(DROPTOP_ORDERS_TASK_ID, 'success', summary)
        toast.success(summary, { duration: 10000 })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Test pull failed'
      store.finish(DROPTOP_ORDERS_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    } finally {
      setRunning(null)
    }
  }

  // Read-only peek at Droptop's raw get-orders response for one shop, no
  // writes at all (mode:'inspect') — built to settle whether the top-level
  // "products" array is ever really populated by the LIVE API for this
  // account, vs. only the already-synced historical raw_data. Logs full raw
  // JSON to the console and a per-order table (top-level products count vs.
  // services' own nested products count) so the answer doesn't require
  // manually reading through raw JSON by eye.
  async function inspectDroptopOrders() {
    if (!companyId || !inspectOrdersShop.trim()) return
    setRunning('inspect-orders')
    try {
      const loc = await resolveShopLocation(supabase, companyId, inspectOrdersShop.trim())
      const { data, error } = await supabase.functions.invoke('droptop-sync-orders', {
        body: { mode: 'inspect', locationId: loc.id },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      const raw: any[] = Array.isArray(data.raw_response) ? data.raw_response : []
      // eslint-disable-next-line no-console
      console.log(`Droptop orders inspect — "${loc.name}" (resolved location id: ${loc.id})`, {
        resolved_location_id_from_server: data.resolved_location_id,
        operation_id: data.operation_id,
        requested_params: data.requested_params,
        requested_window_human: data.requested_window_human,
        raw_result_shape: data.raw_result_shape,
        raw_response: raw,
      })
      if (raw.length === 0) {
        toast(
          `0 orders for "${loc.name}" in the last 3 days — full request/response details (operation id, exact window, what Droptop actually returned) logged to the console (F12).`,
          { icon: '⚠️', duration: 12000 },
        )
        return
      }
      const summary = raw.map((o) => ({
        order_id: o.order_id,
        top_level_products: Array.isArray(o.products) ? o.products.length : 'missing field',
        services: Array.isArray(o.services) ? o.services.length : 'missing field',
        services_nested_products: Array.isArray(o.services)
          ? o.services.reduce((n: number, s: any) => n + (Array.isArray(s.products) ? s.products.length : 0), 0)
          : 0,
      }))
      // eslint-disable-next-line no-console
      console.log('Per-order counts:')
      // eslint-disable-next-line no-console
      console.table(summary)
      // Flattened service/product detail — one row per product a service
      // actually consumed (or one row for a service with no products, so it
      // still shows up rather than silently vanishing from the table).
      const servicesDetail = raw.flatMap((o) => {
        const services = Array.isArray(o.services) ? o.services : []
        if (!services.length) return []
        return services.flatMap((s: any) => {
          const products = Array.isArray(s.products) ? s.products : []
          if (!products.length) {
            return [{ order_id: o.order_id, package_id: s.package_id, service_name: s.service_name, product_id: null, product_type: null, uom: null, quantity_total: null }]
          }
          return products.map((p: any) => ({
            order_id: o.order_id,
            package_id: s.package_id,
            service_name: s.service_name,
            product_id: p.product_id,
            product_type: p.product_type,
            uom: p.uom,
            quantity_total: p.quantity_total,
          }))
        })
      })
      // eslint-disable-next-line no-console
      console.log('Service/product detail (one row per product a service consumed):')
      // eslint-disable-next-line no-console
      console.table(servicesDetail)
      const anyTopLevel = raw.some((o) => Array.isArray(o.products) && o.products.length > 0)
      toast(
        `${raw.length} order(s) for "${loc.name}" (last 3 days) — top-level "products" populated on ${anyTopLevel ? 'at least one order' : 'NONE of them'}. Per-order counts and service/product detail logged to the console (F12).`,
        { icon: anyTopLevel ? undefined : '🔎', duration: 12000 },
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Inspect failed')
    } finally {
      setRunning(null)
    }
  }

  // One-time historical pull for building up real order/pricing history —
  // the routine sync only pulls a rolling 30-day window (light on Droptop's
  // API and this app's database), so anything older than that never gets
  // captured unless something explicitly asks for it. Runs one shop at a
  // time, sequentially (not chunked into groups) — a wide date range on
  // even a single shop can already mean many sequential 31-day sub-window
  // calls internally (get-orders' own per-request cap), so this keeps the
  // one variable that's actually unbounded (the date range you choose) from
  // compounding with concurrent shops in the same invocation. If a single
  // shop's range is too wide to finish in one invocation, narrow the dates
  // and run it again in smaller pieces — every write here is an upsert, so
  // that's always safe to do.
  async function runOrderBackfill() {
    if (!companyId || !orderBackfillShops.length) return
    setRunning('order-backfill')
    const store = useSyncTasksStore.getState()
    const labelToId = new Map(backfillOptions.map((o) => [o.label, o.id]))
    const locationIds = orderBackfillShops.map((label) => labelToId.get(label)).filter((id): id is string => !!id)

    // Split into weekly sub-windows per shop rather than one request
    // covering the whole selected range. Confirmed 2026-09 — a single
    // 31-day request for an unusually busy shop can push that one edge
    // function invocation past its execution time limit, returning
    // "Edge Function returned a non-2xx status code" with ZERO orders
    // written (not a partial write — the whole invocation dies with no
    // useful diagnostic, and there's no CLI log access to see why). A
    // week-sized window bounds each invocation's work regardless of how
    // busy any one shop turns out to be, and a failed week only costs
    // that week — not the shop's whole range — so it's cheap to retry.
    const WINDOW_DAYS = 7
    const rangeStart = new Date(`${orderBackfillStart}T00:00:00.000Z`)
    const rangeEnd = new Date(`${orderBackfillEnd}T23:59:59.999Z`)
    const windows: { startUnix: number; endUnix: number }[] = []
    for (let winStart = rangeStart; winStart <= rangeEnd; ) {
      const winEndMs = Math.min(winStart.getTime() + WINDOW_DAYS * 86400_000 - 1, rangeEnd.getTime())
      windows.push({ startUnix: Math.floor(winStart.getTime() / 1000), endUnix: Math.floor(winEndMs / 1000) })
      winStart = new Date(winEndMs + 1)
    }

    const totalSteps = locationIds.length * windows.length
    store.start(DROPTOP_ORDERS_TASK_ID, `Droptop Orders — historical backfill (${orderBackfillStart} to ${orderBackfillEnd})`, totalSteps)
    let ordersTotal = 0
    const warnings: string[] = []
    let step = 0
    for (let i = 0; i < locationIds.length; i++) {
      for (const w of windows) {
        step++
        store.setProgress(DROPTOP_ORDERS_TASK_ID, step, totalSteps)
        const wLabel = `${new Date(w.startUnix * 1000).toISOString().slice(0, 10)} to ${new Date(w.endUnix * 1000).toISOString().slice(0, 10)}`
        // Every warning pushed below is prefixed with which shop/window it
        // came from — a real bug found live: an invocation that returned
        // 200 OK but had one internal batch fail (e.g. "Order batch 0-131:
        // canceling statement due to statement timeout" from a per-batch
        // upsert inside droptop-sync-orders) pushed that message with NO
        // shop/date context at all, only the catch-block path below (a
        // whole invocation throwing) attached one — so a partial failure
        // inside an otherwise-successful call was impossible to attribute
        // to a specific shop or week from the summary alone.
        const shopLabel = orderBackfillShops[i] ?? locationIds[i]
        try {
          const r = await runDroptopOrderSync(companyId, { startUnix: w.startUnix, endUnix: w.endUnix, locationId: locationIds[i] })
          ordersTotal += r.orders_upserted
          if (r.warnings?.length) warnings.push(...r.warnings.map((w2) => `${shopLabel} (${wLabel}): ${w2}`))
        } catch (err) {
          // One retry on the SAME narrow window before giving up — a
          // platform-level timeout kill is often a one-off (cold start,
          // momentary contention), not deterministic, so this alone
          // resolves a meaningful share of failures without needing an
          // even narrower re-split.
          try {
            const r = await runDroptopOrderSync(companyId, { startUnix: w.startUnix, endUnix: w.endUnix, locationId: locationIds[i] })
            ordersTotal += r.orders_upserted
            if (r.warnings?.length) warnings.push(...r.warnings.map((w2) => `${shopLabel} (${wLabel}): ${w2}`))
          } catch (err2) {
            warnings.push(`${shopLabel} (${wLabel}): ${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
      }
    }
    const summary = `Backfill: ${ordersTotal} orders across ${locationIds.length} shop(s), ${orderBackfillStart} to ${orderBackfillEnd}`
    if (warnings.length) {
      store.finish(DROPTOP_ORDERS_TASK_ID, 'partial', `${summary} — ${warnings.join(' | ')}`)
      toast(`${summary} (${warnings.length} issue(s) — see Data Syncs)`, { icon: '⚠️', duration: 12000 })
    } else {
      store.finish(DROPTOP_ORDERS_TASK_ID, 'success', summary)
      toast.success(summary)
      setOrderBackfillShops([])
    }
    setRunning(null)
  }

  // Address-level geocoding for the Customer Heatmap — resolves each
  // order's street address to real lat/lng via the free Census Geocoder,
  // as an alternative to zip-centroid plotting. Loops the Edge Function
  // (bounded orders per invocation server-side) until nothing's left to
  // geocode, same "many small calls" reasoning as the Droptop syncs.
  async function runGeocodingJob() {
    if (!companyId) return
    setRunning('geocoding')
    const store = useSyncTasksStore.getState()
    store.start(GEOCODE_ORDERS_TASK_ID, 'Address Geocoding — resolving order addresses via Census')
    try {
      const summary = await runGeocoding(companyId, (p) => {
        store.setProgress(GEOCODE_ORDERS_TASK_ID, p.totalProcessed, p.totalProcessed + p.remaining)
      })
      const text = `Geocoding: ${summary.totalMatched} matched, ${summary.totalNoMatch} no match, ${summary.totalCachedHits} from cache (${summary.totalProcessed} orders processed)`
      if (summary.warnings.length) {
        store.finish(GEOCODE_ORDERS_TASK_ID, 'partial', `${text} — ${summary.warnings.length} warning(s)`)
        toast(`${text} — some rows had issues, see Data Syncs`, { icon: '⚠️', duration: 12000 })
      } else {
        store.finish(GEOCODE_ORDERS_TASK_ID, 'success', text)
        toast.success(text, { duration: 10000 })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Geocoding failed'
      store.finish(GEOCODE_ORDERS_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    } finally {
      setRunning(null)
    }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  if (rows === null) return <div className="py-8"><SbLoader /></div>

  const ordered = [...rows].sort((a, b) => CONNECTION_ORDER.indexOf(a.connection_key) - CONNECTION_ORDER.indexOf(b.connection_key))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Data Connections</h2>
          <p className="text-xs text-inky mt-0.5">
            Run any sync now, or turn on automation and set how often (or what time of day) it runs — no Supabase-side
            cron editing needed.
          </p>
        </div>
        <div className="w-56">
          <Select
            label="Timezone for daily times"
            options={TIMEZONE_OPTIONS}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {ordered.map((row) => {
          const meta = CONNECTION_META[row.connection_key] ?? { label: row.connection_key, description: '' }
          // Whichever of scheduled/manual happened most recently drives the
          // header badge — a quick "is this connection currently healthy"
          // signal, with the full breakdown (both, separately) below.
          const scheduledAt = row.last_run_at
          const manualAt = row.last_manual_run_at ?? null
          const manualIsNewer = !!manualAt && (!scheduledAt || new Date(manualAt) > new Date(scheduledAt))
          const latestStatus = manualIsNewer ? row.last_manual_run_status : row.last_run_status
          return (
            <Card key={row.id}>
              <CardHeader className="flex items-center justify-between">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">{meta.label}</span>
                <Badge color={statusColor(latestStatus ?? null)}>
                  {latestStatus ?? 'never run'}
                </Badge>
              </CardHeader>
              <CardBody className="flex flex-col gap-3">
                <p className="text-[11px] font-mono text-inky/60">{meta.description}</p>

                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Automate</span>
                  <Toggle
                    checked={row.enabled}
                    onChange={(v) => saveRow(row, { enabled: v })}
                    color="green" size="sm" label={row.enabled ? 'On' : 'Off'}
                  />
                </div>

                <div className={row.enabled ? '' : 'opacity-40 pointer-events-none'}>
                  <div className="flex gap-1 mb-2">
                    {(['interval', 'daily'] as const).map((m) => (
                      <button key={m} onClick={() => saveRow(row, { schedule_mode: m })}
                        className={['flex-1 px-2 py-1 rounded border text-xs font-mono transition-colors',
                          row.schedule_mode === m ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
                        {m === 'interval' ? 'Every N minutes' : `Daily at (${timezone.split('/').pop()?.replace('_', ' ')})`}
                      </button>
                    ))}
                  </div>
                  {row.schedule_mode === 'interval' ? (
                    <input
                      type="number" min={5}
                      defaultValue={row.interval_minutes ?? ''}
                      onBlur={(e) => { const v = Number(e.target.value); if (v > 0) saveRow(row, { interval_minutes: v }) }}
                      placeholder="e.g. 240"
                      className={`${fieldCls} w-full`}
                    />
                  ) : (
                    <input
                      type="time"
                      defaultValue={row.daily_time ?? ''}
                      onBlur={(e) => e.target.value && saveRow(row, { daily_time: e.target.value })}
                      className={`${fieldCls} w-full`}
                    />
                  )}
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-navy/10">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[10px] font-mono text-inky/60">
                      <span className="text-inky/40 uppercase tracking-wide">Scheduled: </span>
                      {row.last_run_at
                        ? <>{row.last_run_status ?? 'success'} · {formatInTz(row.last_run_at, timezone)}</>
                        : 'never run'}
                    </span>
                    <span className="text-[10px] font-mono text-inky/60">
                      <span className="text-inky/40 uppercase tracking-wide">Manual: </span>
                      {row.last_manual_run_at
                        ? <>{row.last_manual_run_status ?? 'success'} · {formatInTz(row.last_manual_run_at, timezone)}</>
                        : 'never run'}
                      {saving === row.id && ' · saving…'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {row.connection_key === 'droptop_usage' && (
                      <>
                        <input
                          value={inspectShop} onChange={(e) => setInspectShop(e.target.value)}
                          placeholder="Shop (optional)" title="Location name to scope the Inspect to — leave blank for an arbitrary location"
                          className={`${fieldCls} w-28`}
                        />
                        <input
                          value={inspectProductId} onChange={(e) => setInspectProductId(e.target.value)}
                          placeholder="Product id (optional)" title="Also dump every raw change event for this product id"
                          className={`${fieldCls} w-32`}
                        />
                        <Button size="sm" variant="secondary" loading={running === 'inspect'} onClick={inspectDroptopUsage}
                          title="Read-only peek at Droptop's raw change-event shape, logged to the browser console — no data written">
                          Inspect
                        </Button>
                      </>
                    )}
                    {row.connection_key === 'droptop_orders' && (
                      <>
                        <input
                          value={testOrderShop} onChange={(e) => setTestOrderShop(e.target.value)}
                          placeholder="Shop to test" title="Pull just this one shop's last 30 days of orders — bypasses chunking entirely, for checking real volume/timing before Run Now"
                          className={`${fieldCls} w-28`}
                        />
                        <Button size="sm" variant="secondary" loading={running === 'test-orders'} disabled={!testOrderShop.trim()} onClick={testOneShopOrders}>
                          Test One Shop
                        </Button>
                        <input
                          value={inspectOrdersShop} onChange={(e) => setInspectOrdersShop(e.target.value)}
                          placeholder="Shop to inspect" title="Read-only: pulls this shop's last 3 days straight from Droptop's live API, no writes — logs the raw response and a per-order products/services breakdown to the console"
                          className={`${fieldCls} w-28`}
                        />
                        <Button size="sm" variant="secondary" loading={running === 'inspect-orders'} disabled={!inspectOrdersShop.trim()} onClick={inspectDroptopOrders}>
                          Inspect
                        </Button>
                      </>
                    )}
                    <Button size="sm" loading={running === row.connection_key} onClick={() => runNow(row.connection_key)}>
                      Run Now
                    </Button>
                  </div>
                </div>
                {(row.last_run_status === 'error' || row.last_run_status === 'partial') && row.last_run_message && (
                  <p className="text-[11px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-2 py-1">
                    <span className="text-inky/50 uppercase">Scheduled — </span>{row.last_run_message}
                  </p>
                )}
                {(row.last_manual_run_status === 'error' || row.last_manual_run_status === 'partial') && row.last_manual_run_message && (
                  <p className="text-[11px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-2 py-1">
                    <span className="text-inky/50 uppercase">Manual — </span>{row.last_manual_run_message}
                  </p>
                )}
              </CardBody>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Historical Usage Backfill</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            The routine Droptop Usage sync above only pulls one day at a time and builds up its 30-day rolling average
            naturally — no action needed for shops already on Droptop. This is for a shop that's <em>already</em> on
            Droptop when it's acquired (or any other case a shop's history needs pulling in from scratch): it runs a
            real 30-day pull once and backfills the daily activity ledger immediately instead of waiting a month.
            Manual only — always pick the shop(s) explicitly, never runs on a schedule.
          </p>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown
                options={backfillOptions.map((o) => ({ value: o.label }))}
                selected={backfillShops}
                onChange={setBackfillShops}
                placeholder="Select shop(s)…"
                showAllOption={false}
                searchable
                countNoun="shops"
              />
            </div>
            <Button size="sm" loading={running === 'backfill'} disabled={!backfillShops.length} onClick={runBackfill}>
              Run Backfill
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Historical Orders Backfill</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            The routine Droptop Orders sync above only pulls a rolling last-30-days window — enough to keep the
            Customer Heatmap and Droptop Orders page current, but it won't build a deep pricing/sales history on its
            own since anything older than 30 days simply isn't in the window it re-pulls each time. This pulls a
            specific date range once, for the shop(s) you pick. Runs one shop at a time (not chunked) — a wide range
            on a busy shop can still take a while or need splitting into smaller pieces if it times out; every write
            here is an upsert, so re-running any part of it is always safe.
          </p>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown
                options={backfillOptions.map((o) => ({ value: o.label }))}
                selected={orderBackfillShops}
                onChange={setOrderBackfillShops}
                placeholder="Select shop(s)…"
                showAllOption={false}
                searchable
                countNoun="shops"
              />
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Start</span>
              <input type="date" value={orderBackfillStart} max={orderBackfillEnd} onChange={(e) => setOrderBackfillStart(e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">End</span>
              <input type="date" value={orderBackfillEnd} min={orderBackfillStart} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setOrderBackfillEnd(e.target.value)} className={fieldCls} />
            </label>
            <Button size="sm" loading={running === 'order-backfill'} disabled={!orderBackfillShops.length} onClick={runOrderBackfill}>
              Run Backfill
            </Button>
          </div>
          {locationIdsInRangeError ? (
            // Persistent, not just the toast that already fired — a failed
            // check renders identically to "confirmed zero gaps" otherwise
            // (gapShopLabels is [] either way), which is exactly as
            // misleading as the original "everyone's a gap" bug, just in
            // the other direction: it looks like everything's backfilled
            // when really nobody knows.
            <p className="text-[11px] font-mono text-[#C0392B]">
              Unable to check for gap shops ({locationIdsInRangeError}) — some shops may still need backfill; this list can't confirm it right now.
            </p>
          ) : gapShopLabels.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap text-[11px] font-mono text-inky/60">
              <span className="text-[#E67E22]">{gapShopLabels.length} shop(s) have no orders in this Start–End range</span>
              <Button size="sm" variant="secondary" onClick={() => setOrderBackfillShops(gapShopLabels)}
                title="Selects every backfill-eligible shop with zero orders in the Start-End range selected above">
                Select Gap Shops
              </Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Address Geocoding</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            Resolves each order's actual street address to real coordinates via the free US Census Geocoder — an
            optional, more precise alternative to the Customer Heatmap's default zip-centroid plotting (toggle it on
            the Heatmap page once addresses are geocoded here). Repeat customers only cost one lookup, not one per
            order — results are cached by address. Runs in small batches automatically; click again anytime to pick
            up any new orders since the last run.
          </p>
          <div>
            <Button size="sm" loading={running === 'geocoding'} onClick={runGeocodingJob}>
              Run Geocoding
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}
