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
import { useLocations } from '@/hooks/useLocations'
import { shopNumberCityLabel } from '@/lib/shopLabels'
import { Button, Card, CardHeader, CardBody, Toggle, Badge, Select, SbLoader, MultiSelectDropdown } from '@/components/ui'
import { runSkybitzTankSync } from '@/services/skybitzService'
import { runDroptopSync, runDroptopPurchaseOrderSync, runDroptopOrderSync } from '@/services/droptopService'
import { runGeocoding } from '@/services/geocodingService'
import { runAutoVinDecode } from '@/services/vinDecodeService'
import type { DataConnectionSchedule } from '@/types/integrations'
import { formatInTz } from '@/lib/tzFormat'
import {
  useSyncTasksStore, DROPTOP_ON_HAND_TASK_ID, DROPTOP_USAGE_TASK_ID,
  DROPTOP_PO_SYNC_TASK_ID, DROPTOP_ORDERS_TASK_ID, SKYBITZ_TANKS_TASK_ID, AUTOMATED_CHECKS_TASK_ID,
  GEOCODE_ORDERS_TASK_ID, HEATMAP_ROLLUP_TASK_ID, VIN_DECODE_TASK_ID, MONDAY_LOCATIONS_TASK_ID,
  DROPTOP_TIME_CLOCK_TASK_ID,
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
  droptop_time_clock: DROPTOP_TIME_CLOCK_TASK_ID,
  automated_checks: AUTOMATED_CHECKS_TASK_ID,
  heatmap_rollup_refresh: HEATMAP_ROLLUP_TASK_ID,
  vin_decode: VIN_DECODE_TASK_ID,
  monday_locations: MONDAY_LOCATIONS_TASK_ID,
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
  droptop_time_clock: { label: 'Droptop — Staff Time Clock', description: 'Pulls each location\'s clock-in/clock-out records forward from its last successful sync (yesterday, or a wider catch-up after a missed day) — feeds the Staffing Report (compares headcount against Droptop order volume/timing). Use the Historical Backfill below for a one-time date-ranged, region/market/shop-scoped pull.' },
  automated_checks: { label: 'Automated Checks', description: 'Scans the movement feed for abnormal adjustments, sales with zero on-hand, and tank-vs-Droptop variance — flags into Exception Reporting. Run this after the Droptop pulls, not before.' },
  heatmap_rollup_refresh: { label: 'Customer Heatmap — Zip Rollups', description: 'Recomputes the pre-aggregated zip/day rollup table Customer Heatmap reads for period-preset ranges, so those loads skip scanning the full orders table. Run Now right after a large Historical Backfill to skip the ~24h staleness window.' },
  vin_decode: { label: 'Vehicles — Engine/Trim Decode', description: 'Looks up Trim/Engine for synced vehicles\' VINs via NHTSA\'s free VIN-decode API, caching results so nothing is ever decoded twice. A big backlog (209,614 distinct VINs as of 2026-09-03) is caught up incrementally over multiple runs, not all at once — the Droptop Vehicles page\'s own "Decode Engine/Trim" button still works independently for whatever\'s currently in view.' },
  monday_locations: { label: 'Monday.com — Locations', description: 'Syncs the "Open Stores List" Monday.com board into Locations — matches by store number to update existing shops, and adds any board item not already in SB Net (including closed/pre-opening ones the file upload never brought in). Never deactivates a location just because it\'s missing from the board.' },
}
const CONNECTION_ORDER = ['skybitz_tanks', 'droptop_on_hand', 'droptop_usage', 'droptop_purchase_orders', 'droptop_orders', 'droptop_time_clock', 'automated_checks', 'heatmap_rollup_refresh', 'vin_decode', 'monday_locations']

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

function statusColor(status: string | null): 'green' | 'orange' | 'red' | 'gray' {
  if (status === 'success') return 'green'
  if (status === 'partial') return 'orange'
  if (status === 'error') return 'red'
  return 'gray'
}

// Error/partial messages here can run to dozens of lines (a chunked sync's
// per-chunk failures all joined with " | ") — this was clogging the page
// with 50-line-tall red blocks. Collapsed to 2 lines by default with a
// Show more/less toggle, plus a dismiss (×) that persists to localStorage
// keyed by the exact message text — reappears automatically the moment the
// underlying message actually changes (a new failure, or clears on
// success), so dismissing never hides a genuinely new problem.
function DismissibleError({ storageKey, label, message }: { storageKey: string; label: string; message: string }) {
  const [dismissed, setDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(storageKey) } catch { /* ignore */ }
    setDismissed(stored === message)
    setExpanded(false)
  }, [storageKey, message])

  if (dismissed) return null
  const isLong = message.length > 160 || message.includes(' | ')
  return (
    <p className="text-[11px] font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-2 py-1 flex items-start gap-2">
      <span className="flex-1 min-w-0">
        <span className="text-inky/50 uppercase">{label} — </span>
        <span className={isLong && !expanded ? 'line-clamp-2 align-bottom' : ''}>{message}</span>
        {isLong && (
          <button type="button" onClick={() => setExpanded((v) => !v)} className="ml-1.5 text-sky hover:underline whitespace-nowrap">
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </span>
      <button
        type="button"
        onClick={() => { try { localStorage.setItem(storageKey, message) } catch { /* ignore */ } setDismissed(true) }}
        className="text-inky/40 hover:text-red-400 leading-none shrink-0 text-sm"
        title="Dismiss — reappears only if this changes to a new error"
      >
        ×
      </button>
    </p>
  )
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
  // 'other' surface — franchise shops included by default (matches Droptop
  // Orders/Customer Heatmap, the other Droptop-data surfaces).
  const loc = useLocations('other')
  const [backfillShops, setBackfillShops] = useState<string[]>([])
  const [backfillRegions, setBackfillRegions] = useState<string[]>([])
  const [backfillMarkets, setBackfillMarkets] = useState<string[]>([])
  const [testOrderShop, setTestOrderShop] = useState('')
  const [inspectOrdersShop, setInspectOrdersShop] = useState('')
  const [orderBackfillShops, setOrderBackfillShops] = useState<string[]>([])
  const [orderBackfillRegions, setOrderBackfillRegions] = useState<string[]>([])
  const [orderBackfillMarkets, setOrderBackfillMarkets] = useState<string[]>([])
  const [orderBackfillStart, setOrderBackfillStart] = useState(() => { const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString().slice(0, 10) })
  const [orderBackfillEnd, setOrderBackfillEnd] = useState(() => new Date().toISOString().slice(0, 10))
  const [timeClockBackfillShops, setTimeClockBackfillShops] = useState<string[]>([])
  const [timeClockBackfillRegions, setTimeClockBackfillRegions] = useState<string[]>([])
  const [timeClockBackfillMarkets, setTimeClockBackfillMarkets] = useState<string[]>([])
  const [timeClockBackfillStart, setTimeClockBackfillStart] = useState(() => { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString().slice(0, 10) })
  const [timeClockBackfillEnd, setTimeClockBackfillEnd] = useState(() => new Date().toISOString().slice(0, 10))

  // Shops eligible for any Droptop backfill — same scope as the routine
  // syncs (a Droptop Operation ID actually set). Shared by all three
  // backfill cards below (Usage/Orders/Staff Time Clock) rather than each
  // running its own fetch.
  const backfillOptions = useMemo(
    () => loc.locations
      .filter((l) => l.droptop_operation_id)
      .map((l) => ({ id: l.id, label: shopNumberCityLabel(l.name, l.shop_city) }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [loc.locations],
  )
  // Region/Market — same "narrow top-down" shape as Droptop Orders' own
  // filter set, but here they resolve to a location-id allowlist for a
  // BACKFILL target rather than narrowing an already-loaded result set:
  // picking a whole region/market lets an admin scope a backfill to "just
  // these stores" without hand-picking dozens of shops one at a time — the
  // actual ask behind adding these (large unscoped pulls, like Droptop
  // Orders, have been a real problem — see runDroptopOrders' own history).
  const regionOptions = useMemo(
    () => [...new Set(loc.locations.filter((l) => l.droptop_operation_id).map((l) => l.region ?? '').filter(Boolean))]
      .sort().map((v) => ({ value: v })),
    [loc.locations],
  )
  function marketOptionsFor(selectedRegions: string[]) {
    let r = loc.locations.filter((l) => l.droptop_operation_id)
    if (selectedRegions.length) r = r.filter((l) => selectedRegions.includes(l.region ?? ''))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))].sort().map((v) => ({ value: v }))
  }
  // Resolves Region/Market/Shop filters (each optional, AND-narrowed
  // together — an empty filter imposes no restriction from that level) down
  // to the final location-id set a backfill should target. Requires at
  // least one non-empty filter — an entirely empty set of filters returns
  // null (meaning "not scoped to anything, don't run"), which is what keeps
  // this from silently defaulting to "every shop" the way the old
  // unscoped historical pulls did.
  function resolveBackfillLocationIds(regions: string[], markets: string[], shopLabels: string[]): string[] | null {
    if (!regions.length && !markets.length && !shopLabels.length) return null
    const shopIds = new Set(shopLabels.map((l) => backfillOptions.find((o) => o.label === l)?.id).filter((id): id is string => !!id))
    const ids: string[] = []
    for (const l of loc.locations) {
      if (!l.droptop_operation_id) continue
      if (regions.length && !regions.includes(l.region ?? '')) continue
      if (markets.length && !markets.includes(loc.fieldValue(l.id, 'market'))) continue
      if (shopIds.size && !shopIds.has(l.id)) continue
      ids.push(l.id)
    }
    return ids
  }
  // Tracked checklist for the "backfill order history back to May 2025,
  // month by month" project — scaffolding only, per explicit direction: a
  // durable cross-session list of which months are done, NOT an automated
  // runner. "Use This Month" just pre-fills the Start/End fields above;
  // Run Backfill still has to be clicked same as any other range.
  const [backfillPlan, setBackfillPlan] = useState<{
    id: string; year_month: string; status: 'pending' | 'in_progress' | 'done'; orders_synced: number | null; notes: string | null
  }[]>([])
  const [backfillPlanLoading, setBackfillPlanLoading] = useState(true)
  // Real, computed-from-the-database order/shop counts per tracked month —
  // replaces trusting a manually-typed "orders synced" number with actual
  // ground truth. null = still loading; a month simply missing from the map
  // once loaded means zero orders landed for it yet.
  const [monthStats, setMonthStats] = useState<Record<string, { orders: number; shops: number }> | null>(null)
  const [monthStatsError, setMonthStatsError] = useState<string | null>(null)
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
  // Address Geocoding coverage — "how many of how many" the Run Geocoding
  // button below has actually gotten through. null = still loading/failed;
  // distinguished from "confirmed 0 eligible" the same way locationIdsInRange
  // is above, so a failed count doesn't silently render as "nothing to do."
  const [geocodeStats, setGeocodeStats] = useState<{ eligible: number; done: number; matched: number } | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('data_connection_schedules')
      .select('*').eq('company_id', companyId)
    setRows((data ?? []) as DataConnectionSchedule[])
  }, [companyId])

  useEffect(() => { load() }, [load])

  // Scheduled runs happen server-side (pg_cron -> data-connection-dispatcher)
  // with no client involved at all, so there's no event this tab can react
  // to when one finishes — poll while the tab is open instead, same pattern
  // TopBar.tsx already uses for its own 60s EOD-prompt check. 30s keeps the
  // "Scheduled: ..." timestamp/status feeling live without a manual refresh,
  // for a single cheap company-scoped select.
  useEffect(() => {
    if (!companyId) return
    const id = setInterval(() => { load() }, 30000)
    return () => clearInterval(id)
  }, [companyId, load])

  const loadGeocodeStats = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    // Each query builder call mutates and returns the same underlying
    // object rather than a fresh copy, so a shared "base" query reused
    // across three .select() calls would compound filters instead of
    // branching — hence three independently-built queries here.
    const [eligibleRes, doneRes, matchedRes] = await Promise.all([
      sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).not('address', 'is', null),
      sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).not('address', 'is', null).not('geocode_status', 'is', null),
      sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).not('address', 'is', null).eq('geocode_status', 'matched'),
    ])
    if (eligibleRes.error || doneRes.error || matchedRes.error) {
      // eslint-disable-next-line no-console
      console.error('Failed to load geocoding coverage:', eligibleRes.error ?? doneRes.error ?? matchedRes.error)
      return
    }
    setGeocodeStats({ eligible: eligibleRes.count ?? 0, done: doneRes.count ?? 0, matched: matchedRes.count ?? 0 })
  }, [companyId])
  useEffect(() => { loadGeocodeStats() }, [loadGeocodeStats])

  const loadBackfillPlan = useCallback(async () => {
    if (!companyId) return
    setBackfillPlanLoading(true)
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('droptop_order_backfill_plan')
      .select('id, year_month, status, orders_synced, notes')
      .eq('company_id', companyId)
      .order('year_month', { ascending: false })
    // Best-effort — brand-new table, may not be migrated in production yet
    // (see the decoupled-save convention in CLAUDE.md); the checklist card
    // itself just doesn't render if this comes back empty/erroring.
    if (!error) setBackfillPlan((data ?? []) as typeof backfillPlan)
    setBackfillPlanLoading(false)
  }, [companyId])
  useEffect(() => { loadBackfillPlan() }, [loadBackfillPlan])

  // One grouped query covering every tracked month at once
  // (get_droptop_order_month_stats, migration 20260918) rather than one
  // request per row — 15 months today and growing by one every month, and
  // a per-month loop here would be exactly the kind of unbatched request
  // pattern that made the gap-detection check above slow enough to time
  // out. Confirmed via EXPLAIN ANALYZE at ~4s for the full 15-month range.
  useEffect(() => {
    if (!companyId || !backfillPlan.length) return
    let cancelled = false
    const months = backfillPlan.map((r) => r.year_month).sort()
    const start = `${months[0]}-01`
    const [endY, endM] = months[months.length - 1].split('-').map(Number)
    const end = new Date(endY, endM, 0).toISOString().slice(0, 10) // last day of that month
    const sb = supabase as any
    sb.rpc('get_droptop_order_month_stats', { p_start: start, p_end: end }).then(({ data, error }: any) => {
      if (cancelled) return
      if (error) { setMonthStatsError(error.message); return }
      const map: Record<string, { orders: number; shops: number }> = {}
      for (const row of (data ?? []) as { year_month: string; orders: number | string; shops: number | string }[]) {
        map[row.year_month] = { orders: Number(row.orders), shops: Number(row.shops) }
      }
      setMonthStatsError(null)
      setMonthStats(map)
    })
    return () => { cancelled = true }
  }, [companyId, backfillPlan])

  async function updateBackfillPlanRow(id: string, patch: Partial<{ status: 'pending' | 'in_progress' | 'done'; orders_synced: number | null; notes: string | null }>) {
    const sb = supabase as any
    const extra: Record<string, unknown> = {}
    if (patch.status === 'in_progress') extra.started_at = new Date().toISOString()
    if (patch.status === 'done') extra.completed_at = new Date().toISOString()
    const { error } = await sb.schema('inventory').from('droptop_order_backfill_plan')
      .update({ ...patch, ...extra, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error(`Couldn't save: ${error.message}`); return }
    setBackfillPlan((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }

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
    async function fetchChunk(startStr: string, endStr: string): Promise<string[]> {
      const PAGE = 1000
      const ids: string[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await sb.rpc('get_droptop_order_location_ids_in_range', {
          p_start: startStr, p_end: endStr,
        }).range(from, from + PAGE - 1)
        if (error) throw new Error(error.message)
        const batch = (data ?? []) as { location_id: string }[]
        ids.push(...batch.map((r) => r.location_id))
        // < PAGE (not === 0) — the common case is well under 1000 distinct
        // locations, so waiting for an explicit empty page was running this
        // same range scan a second, unnecessary time on every load.
        if (batch.length < PAGE) break
      }
      return ids
    }
    async function run() {
      // One request per ~month-wide slice of the selected range instead of
      // one request covering the whole thing — a single 6-month-or-wider
      // scan of inventory.droptop_orders was slow enough to hit the
      // 'authenticated' role's 30s statement_timeout
      // (20260909_bump_authenticated_statement_timeout.sql) on its own, with
      // nothing actually broken. A ~1-month slice finishes in well under a
      // second (confirmed via EXPLAIN ANALYZE), and one retry per slice
      // absorbs a rare transient failure without giving up on the whole
      // check the way one giant request's failure used to.
      const CHUNK_DAYS = 31
      const all: string[] = []
      const rangeStart = new Date(`${orderBackfillStart}T00:00:00.000Z`)
      const rangeEnd = new Date(`${orderBackfillEnd}T00:00:00.000Z`)
      for (let chunkStart = rangeStart; chunkStart <= rangeEnd; ) {
        const chunkEndMs = Math.min(chunkStart.getTime() + CHUNK_DAYS * 86400_000 - 1, rangeEnd.getTime())
        const startStr = chunkStart.toISOString().slice(0, 10)
        const endStr = new Date(chunkEndMs).toISOString().slice(0, 10)
        try {
          all.push(...await fetchChunk(startStr, endStr))
        } catch {
          all.push(...await fetchChunk(startStr, endStr)) // one retry before giving up on the whole check
        }
        if (cancelled) return
        chunkStart = new Date(chunkEndMs + 1)
      }
      if (!cancelled) setLocationIdsInRange(new Set(all))
    }
    run().catch((e) => {
      if (cancelled) return
      // Leave locationIdsInRange at null (its "still loading" value) on a
      // real query failure, NOT an empty Set — a failed request silently
      // becoming an empty Set would make gapShopLabels below read as
      // "confirmed zero gap shops," exactly as misleading as the original
      // "everyone's a gap" bug, just in the other direction. Surfaced
      // persistently (locationIdsInRangeError below) — no toast: this check
      // runs unprompted on every page load, so a failure here shouldn't be
      // alarming.
      const message = e instanceof Error ? e.message : 'Failed to check gap shops'
      console.error('Failed to load in-range locations for gap detection:', message)
      setLocationIdsInRangeError(message)
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
      } else if (key === 'droptop_time_clock') {
        // Steady-state, same shape as droptop_orders above: each location
        // pulls forward from wherever it last successfully synced through
        // yesterday. Use the Historical Backfill controls below for a
        // one-time date-ranged, region/market/shop-scoped pull instead.
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
        // No `vins` in the body — auto-discover mode (see vin-decode's own
        // header comment). The Vehicles page's own "Decode Engine/Trim"
        // button calls the same function with an explicit vins list instead.
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
      // exist yet in production. A manual "Run Now" previously never wrote
      // back to this table at all (only the dispatcher's scheduled runs
      // did), so "Last run" silently only ever reflected the most recent
      // automated run no matter how many times someone ran it by hand.
      const row = rows?.find((r) => r.connection_key === key)
      if (row) {
        // Awaited (not fire-and-forget) so the load() below is guaranteed to
        // see this run's own status/timestamp — previously this write and
        // load() fired concurrently, so load() usually won the race and
        // reloaded the PREVIOUS run's data, making the card look stale until
        // a manual page refresh gave the write time to land.
        try {
          const sb = supabase as any
          await sb.schema('inventory').from('data_connection_schedules')
            .update({
              last_manual_run_at: new Date().toISOString(),
              last_manual_run_status: manualStatus,
              last_manual_run_message: manualMessage,
              last_manual_run_by: profile?.id ?? null,
            })
            .eq('id', row.id)
        } catch { /* best-effort — column set may not exist yet in production */ }
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
    const locationIds = resolveBackfillLocationIds(backfillRegions, backfillMarkets, backfillShops)
    if (!companyId || !locationIds?.length) return
    setRunning('backfill')
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_USAGE_TASK_ID, `Droptop Usage — 30-day backfill (${locationIds.length} shop${locationIds.length === 1 ? '' : 's'})`)
    const onProgress = (p: { batch: number; totalBatches: number }) => store.setProgress(DROPTOP_USAGE_TASK_ID, p.batch, p.totalBatches)
    try {
      const r = await runDroptopSync(companyId, { mode: 'usage', daysBack: 30, logDailyActivity: true, locationIds }, onProgress)
      const summary = `Backfill complete: ${r.operations_synced} shop(s), ${r.products_upserted} products — 30 days of history now in the ledger`
      store.finish(DROPTOP_USAGE_TASK_ID, 'success', summary)
      toast.success(summary)
      setBackfillShops([]); setBackfillRegions([]); setBackfillMarkets([])
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
  // captured unless something explicitly asks for it. Every (shop, week)
  // pair below is an independent upsert-only call, so they run through a
  // bounded worker pool (CONCURRENCY, below) instead of strictly one at a
  // time — same pattern droptopChildFetch.ts/useConfigTab.ts already use
  // elsewhere in this app. Kept modest rather than wide open: this hits
  // Droptop's real API, which this session already confirmed throws its
  // own platform-level rate-limit errors under load (see
  // droptop-sync-orders' fetch-throw retry fix) — too much concurrency here
  // just turns into more 429s to retry rather than actually finishing
  // faster. If a single shop's range is too wide to finish even at this
  // concurrency, narrow the dates and run it again in smaller pieces —
  // every write here is an upsert, so that's always safe to do.
  async function runOrderBackfill() {
    const locationIds = resolveBackfillLocationIds(orderBackfillRegions, orderBackfillMarkets, orderBackfillShops)
    if (!companyId || !locationIds?.length) return
    const cid = companyId // narrowed once here — TS loses the guard's narrowing once companyId is read from inside the worker() closure below
    setRunning('order-backfill')
    const store = useSyncTasksStore.getState()
    const idToShopLabel = new Map(backfillOptions.map((o) => [o.id, o.label]))

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

    // Flatten (shop, window) into one task list the worker pool below pulls
    // from — every call is an independent upsert, so processing order
    // doesn't matter once this is no longer strictly sequential.
    const tasks: { locationId: string; shopLabel: string; window: { startUnix: number; endUnix: number } }[] = []
    for (const locationId of locationIds) {
      for (const w of windows) tasks.push({ locationId, shopLabel: idToShopLabel.get(locationId) ?? locationId, window: w })
    }

    const totalSteps = tasks.length
    store.start(DROPTOP_ORDERS_TASK_ID, `Droptop Orders — historical backfill (${orderBackfillStart} to ${orderBackfillEnd})`, totalSteps)
    let ordersTotal = 0
    let step = 0
    const warnings: string[] = []

    const CONCURRENCY = 4
    let nextIndex = 0
    async function worker() {
      for (;;) {
        const i = nextIndex++
        if (i >= tasks.length) return
        const { locationId, shopLabel, window: w } = tasks[i]
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
        try {
          const r = await runDroptopOrderSync(cid, { startUnix: w.startUnix, endUnix: w.endUnix, locationId })
          ordersTotal += r.orders_upserted
          if (r.warnings?.length) warnings.push(...r.warnings.map((w2) => `${shopLabel} (${wLabel}): ${w2}`))
        } catch (err) {
          // One retry on the SAME narrow window before giving up — a
          // platform-level timeout kill is often a one-off (cold start,
          // momentary contention), not deterministic, so this alone
          // resolves a meaningful share of failures without needing an
          // even narrower re-split.
          try {
            const r = await runDroptopOrderSync(cid, { startUnix: w.startUnix, endUnix: w.endUnix, locationId })
            ordersTotal += r.orders_upserted
            if (r.warnings?.length) warnings.push(...r.warnings.map((w2) => `${shopLabel} (${wLabel}): ${w2}`))
          } catch (err2) {
            warnings.push(`${shopLabel} (${wLabel}): ${err2 instanceof Error ? err2.message : String(err2)}`)
          }
        }
        step++
        store.setProgress(DROPTOP_ORDERS_TASK_ID, step, totalSteps)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker))

    const summary = `Backfill: ${ordersTotal} orders across ${locationIds.length} shop(s), ${orderBackfillStart} to ${orderBackfillEnd}`
    if (warnings.length) {
      store.finish(DROPTOP_ORDERS_TASK_ID, 'partial', `${summary} — ${warnings.join(' | ')}`)
      toast(`${summary} (${warnings.length} issue(s) — see Data Syncs)`, { icon: '⚠️', duration: 12000 })
    } else {
      store.finish(DROPTOP_ORDERS_TASK_ID, 'success', summary)
      toast.success(summary)
      setOrderBackfillShops([]); setOrderBackfillRegions([]); setOrderBackfillMarkets([])
    }
    setRunning(null)

    // A big historical pull like this can easily bring in tens/hundreds of
    // thousands of vehicles the scheduled vin_decode job (once/day by
    // default) would take a long time to catch up on — see that
    // connection's own header comment on why the daily schedule alone
    // isn't sized for a backfill-scale burst. Kick off a catch-up decode
    // pass automatically, deliberately NOT awaited here (this backfill's
    // own "running" state and button already cleared above) — it runs as
    // its own tracked task so the backfill UI doesn't stay blocked for
    // however long the decode catch-up takes on top of the backfill itself.
    // Best-effort: if this fails, the scheduled job / manual Vehicles-page
    // button still cover it eventually, so it doesn't retry here.
    if (ordersTotal > 0) {
      const vinStore = useSyncTasksStore.getState()
      // totalBatches left at its default 0 (indeterminate) — how many VINs
      // this backfill introduced isn't known ahead of time, so this is a
      // "N processed so far" counter, not a fraction. See SyncTask's own
      // totalBatches comment for that convention.
      vinStore.start(VIN_DECODE_TASK_ID, 'Engine/Trim Decode — catching up on vehicles from this backfill')
      runAutoVinDecode((p) => vinStore.setProgress(VIN_DECODE_TASK_ID, p.processedSoFar))
        .then((r) => {
          vinStore.finish(VIN_DECODE_TASK_ID, 'success', `${r.newlyDecoded} decoded (${r.cachedHits} already cached)`)
        })
        .catch((err) => {
          vinStore.finish(VIN_DECODE_TASK_ID, 'error', err instanceof Error ? err.message : 'Decode catch-up failed')
        })
    }
  }

  // One-time, explicitly-scoped historical pull for the Staff Time Clock
  // connection — same reasoning as Historical Orders Backfill above (large
  // unscoped pulls across every shop for a wide range are exactly what's
  // been causing trouble with Droptop's real API — see runDroptopOrders'
  // own history in the dispatcher), so this requires an explicit
  // Region/Market/Shop scope rather than defaulting to "every shop."
  // Routine catch-up (yesterday, or since the last successful pull) runs
  // automatically/on-demand from the main connection card above instead —
  // this is only for reaching further back or re-pulling a specific range.
  async function runTimeClockBackfill() {
    const locationIds = resolveBackfillLocationIds(timeClockBackfillRegions, timeClockBackfillMarkets, timeClockBackfillShops)
    if (!companyId || !locationIds?.length) return
    setRunning('time-clock-backfill')
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_TIME_CLOCK_TASK_ID, `Droptop Staff Time Clock — historical backfill (${timeClockBackfillStart} to ${timeClockBackfillEnd})`)
    try {
      const startUnix = Math.floor(new Date(`${timeClockBackfillStart}T00:00:00.000Z`).getTime() / 1000)
      const endUnix = Math.floor(new Date(`${timeClockBackfillEnd}T23:59:59.999Z`).getTime() / 1000)
      const { data, error } = await supabase.functions.invoke('droptop-sync-staff-time-clock', {
        body: { mode: 'sync', startUnix, endUnix, locationIds },
      })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      const warnings: string[] = data.warnings ?? []
      const summary = `Staff Time Clock: ${data.locations_synced} shop(s), ${data.records_upserted} record(s), ${timeClockBackfillStart} to ${timeClockBackfillEnd}`
      if (warnings.length) {
        store.finish(DROPTOP_TIME_CLOCK_TASK_ID, 'partial', `${summary} — ${warnings.join(' | ')}`)
        toast(`${summary} (${warnings.length} issue(s) — see Data Syncs)`, { icon: '⚠️', duration: 12000 })
      } else {
        store.finish(DROPTOP_TIME_CLOCK_TASK_ID, 'success', summary)
        toast.success(summary)
        setTimeClockBackfillShops([]); setTimeClockBackfillRegions([]); setTimeClockBackfillMarkets([])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Backfill failed'
      store.finish(DROPTOP_TIME_CLOCK_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    } finally {
      setRunning(null)
    }
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
      loadGeocodeStats()
    }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  if (rows === null) return <div className="py-8"><SbLoader /></div>

  const ordered = [...rows].sort((a, b) => CONNECTION_ORDER.indexOf(a.connection_key) - CONNECTION_ORDER.indexOf(b.connection_key))
  const backfillTargetIds = resolveBackfillLocationIds(backfillRegions, backfillMarkets, backfillShops)
  const orderBackfillTargetIds = resolveBackfillLocationIds(orderBackfillRegions, orderBackfillMarkets, orderBackfillShops)
  const timeClockBackfillTargetIds = resolveBackfillLocationIds(timeClockBackfillRegions, timeClockBackfillMarkets, timeClockBackfillShops)

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
                  <DismissibleError storageKey={`dc-dismissed-error:${row.id}:scheduled`} label="Scheduled" message={row.last_run_message} />
                )}
                {(row.last_manual_run_status === 'error' || row.last_manual_run_status === 'partial') && row.last_manual_run_message && (
                  <DismissibleError storageKey={`dc-dismissed-error:${row.id}:manual`} label="Manual" message={row.last_manual_run_message} />
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
            Manual only — always scope it to at least a region, market, or shop, never runs on a schedule.
          </p>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Region</span>
              <MultiSelectDropdown options={regionOptions} selected={backfillRegions} onChange={setBackfillRegions} placeholder="Any region" countNoun="regions" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Market</span>
              <MultiSelectDropdown options={marketOptionsFor(backfillRegions)} selected={backfillMarkets} onChange={setBackfillMarkets} placeholder="Any market" countNoun="markets" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown
                options={backfillOptions.map((o) => ({ value: o.label }))}
                selected={backfillShops}
                onChange={setBackfillShops}
                placeholder="Any shop"
                showAllOption={false}
                searchable
                countNoun="shops"
              />
            </div>
            <Button size="sm" loading={running === 'backfill'} disabled={!backfillTargetIds?.length} onClick={runBackfill}>
              Run Backfill{backfillTargetIds?.length ? ` (${backfillTargetIds.length} shop${backfillTargetIds.length === 1 ? '' : 's'})` : ''}
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
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Region</span>
              <MultiSelectDropdown options={regionOptions} selected={orderBackfillRegions} onChange={setOrderBackfillRegions} placeholder="Any region" countNoun="regions" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Market</span>
              <MultiSelectDropdown options={marketOptionsFor(orderBackfillRegions)} selected={orderBackfillMarkets} onChange={setOrderBackfillMarkets} placeholder="Any market" countNoun="markets" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown
                options={backfillOptions.map((o) => ({ value: o.label }))}
                selected={orderBackfillShops}
                onChange={setOrderBackfillShops}
                placeholder="Any shop"
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
            <Button size="sm" loading={running === 'order-backfill'} disabled={!orderBackfillTargetIds?.length} onClick={runOrderBackfill}>
              Run Backfill{orderBackfillTargetIds?.length ? ` (${orderBackfillTargetIds.length} shop${orderBackfillTargetIds.length === 1 ? '' : 's'})` : ''}
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
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Historical Staff Time Clock Backfill</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            The routine Droptop — Staff Time Clock sync above only pulls forward from each shop's last successful
            sync (yesterday, or a catch-up after a missed day). This pulls a specific date range once, for the
            region/market/shop(s) you pick — reaching further back, or scoped to just the stores that need it,
            rather than backfilling every shop at once for the whole range.
          </p>
          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Region</span>
              <MultiSelectDropdown options={regionOptions} selected={timeClockBackfillRegions} onChange={setTimeClockBackfillRegions} placeholder="Any region" countNoun="regions" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Market</span>
              <MultiSelectDropdown options={marketOptionsFor(timeClockBackfillRegions)} selected={timeClockBackfillMarkets} onChange={setTimeClockBackfillMarkets} placeholder="Any market" countNoun="markets" searchable />
            </div>
            <div>
              <span className="block text-[10px] font-mono text-inky uppercase tracking-wide mb-1">Shop(s)</span>
              <MultiSelectDropdown
                options={backfillOptions.map((o) => ({ value: o.label }))}
                selected={timeClockBackfillShops}
                onChange={setTimeClockBackfillShops}
                placeholder="Any shop"
                showAllOption={false}
                searchable
                countNoun="shops"
              />
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Start</span>
              <input type="date" value={timeClockBackfillStart} max={timeClockBackfillEnd} onChange={(e) => setTimeClockBackfillStart(e.target.value)} className={fieldCls} />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">End</span>
              <input type="date" value={timeClockBackfillEnd} min={timeClockBackfillStart} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setTimeClockBackfillEnd(e.target.value)} className={fieldCls} />
            </label>
            <Button size="sm" loading={running === 'time-clock-backfill'} disabled={!timeClockBackfillTargetIds?.length} onClick={runTimeClockBackfill}>
              Run Backfill{timeClockBackfillTargetIds?.length ? ` (${timeClockBackfillTargetIds.length} shop${timeClockBackfillTargetIds.length === 1 ? '' : 's'})` : ''}
            </Button>
          </div>
        </CardBody>
      </Card>

      {!backfillPlanLoading && backfillPlan.length > 0 && (
        <Card>
          <CardHeader>
            <span className="text-xs font-mono text-navy uppercase tracking-wide">
              Historical Backfill Plan — {backfillPlan.filter((r) => r.status === 'done').length} / {backfillPlan.length} months
            </span>
          </CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-[11px] font-mono text-inky/60">
              Tracked checklist only — working backwards month by month is still done manually with the Historical
              Orders Backfill controls above. "Use This Month" just fills in that range; Run Backfill still has to be
              clicked there yourself. Orders/Shops are real counts read straight from the synced data, not typed in.
            </p>
            {monthStatsError && (
              <p className="text-[11px] font-mono text-[#C0392B]">Couldn't load real order/shop counts ({monthStatsError}).</p>
            )}
            <div className="overflow-x-auto rounded border border-navy/20">
              <table className="w-full text-[11px] font-mono">
                <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                  <th className="text-left px-2 py-1">Month</th>
                  <th className="text-left px-2 py-1">Status</th>
                  <th className="text-right px-2 py-1">Orders</th>
                  <th className="text-right px-2 py-1">Shops w/ Orders</th>
                  <th className="text-left px-2 py-1">Notes</th>
                  <th className="text-left px-2 py-1"></th>
                </tr></thead>
                <tbody>
                  {backfillPlan.map((r) => {
                    const [y, m] = r.year_month.split('-').map(Number)
                    const monthStart = `${r.year_month}-01`
                    const monthEnd = new Date(y, m, 0).toISOString().slice(0, 10) // day 0 of next month = last day of this one
                    const monthLabel = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
                    const stats = monthStats?.[r.year_month]
                    return (
                      <tr key={r.id} className="border-b border-navy/10">
                        <td className="px-2 py-1 text-navy whitespace-nowrap">{monthLabel}</td>
                        <td className="px-2 py-1">
                          <Select value={r.status} onChange={(e) => updateBackfillPlanRow(r.id, { status: e.target.value as 'pending' | 'in_progress' | 'done' })}
                            options={[{ value: 'pending', label: 'Pending' }, { value: 'in_progress', label: 'In Progress' }, { value: 'done', label: 'Done' }]} />
                        </td>
                        <td className="px-2 py-1 text-right text-navy tabular-nums">
                          {monthStats === null ? '…' : (stats?.orders ?? 0).toLocaleString()}
                        </td>
                        <td className="px-2 py-1 text-right text-inky tabular-nums">
                          {monthStats === null ? '…' : (stats?.shops ?? 0).toLocaleString()}
                        </td>
                        <td className="px-2 py-1">
                          <input type="text" defaultValue={r.notes ?? ''} placeholder="—"
                            onBlur={(e) => { const v = e.target.value || null; if (v !== r.notes) updateBackfillPlanRow(r.id, { notes: v }) }}
                            className={`${fieldCls} w-full min-w-[140px]`} />
                        </td>
                        <td className="px-2 py-1">
                          <button
                            onClick={() => { setOrderBackfillStart(monthStart); setOrderBackfillEnd(monthEnd) }}
                            className="text-[10px] font-mono text-sky hover:underline whitespace-nowrap"
                            title="Fill the Historical Orders Backfill Start/End fields above with this month's range">
                            Use This Month
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardBody>
        </Card>
      )}

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
          {geocodeStats && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] font-mono text-inky">
                <span>
                  {geocodeStats.done.toLocaleString()} / {geocodeStats.eligible.toLocaleString()} addresses geocoded
                  {geocodeStats.done > 0 && <span className="text-inky/50"> ({geocodeStats.matched.toLocaleString()} matched, {(geocodeStats.done - geocodeStats.matched).toLocaleString()} no match)</span>}
                </span>
                <span className="text-inky/50">
                  {geocodeStats.eligible > 0 ? Math.round((geocodeStats.done / geocodeStats.eligible) * 100) : 0}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-navy/10 overflow-hidden">
                <div
                  className="h-full bg-sky rounded-full transition-[width]"
                  style={{ width: `${geocodeStats.eligible > 0 ? Math.min(100, (geocodeStats.done / geocodeStats.eligible) * 100) : 0}%` }}
                />
              </div>
            </div>
          )}
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
