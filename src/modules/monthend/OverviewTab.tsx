import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useLocations } from '@/hooks/useLocations'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { Card, CardBody, SbLoader, Select, Toggle } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { TANK_VARIANCE_KEY, UNLISTED_LIMIT_KEY, DEFAULT_TANK_VARIANCE } from '@/modules/config/tabs/CategoryExpectationsTab'
import { ShopBalanceModal } from './ShopBalanceModal'
import { useMonthEndExclusions } from './useMonthEndExclusions'
import type { MonthlyEndingBalance } from '@/types'
import { format, parseISO, subMonths } from 'date-fns'

export const LOOKBACK_MONTHS = 12
const PAGE = 1000

export const usd = (v: number | null | undefined) =>
  v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)

interface ExceptionRow { location_id: string | null; product_id: string }

export function OverviewTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const loc = useLocations()
  const { active: categories } = useCustomFields('ending_balance')
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [tankVariance] = useAppSetting<number>(TANK_VARIANCE_KEY, DEFAULT_TANK_VARIANCE)
  const [unlistedLimit] = useAppSetting<number | null>(UNLISTED_LIMIT_KEY, null)

  const [balances, setBalances] = useState<MonthlyEndingBalance[]>([])
  const [openRecounts, setOpenRecounts] = useState(0)
  const [completeRecounts, setCompleteRecounts] = useState(0)
  const [exceptions, setExceptions] = useState<ExceptionRow[]>([])
  // Which shops have submitted a count for the current period — Monthly
  // count_type rows in `counts` or a manual_count_entries row, same
  // definition NotSubmittedTab.tsx already uses. 2026-09-28: this used to
  // also carry each shop's dollar total (ending_inventory_cost, an uploaded
  // Count Summary figure) for the Total Ending Balance KPI/Shop Detail row,
  // but per explicit request that KPI (and the category tiles) must reflect
  // actual on-hand inventory, not what a shop uploaded — both now read from
  // currentCategoryBalances below instead (live, Droptop-on-hand-derived).
  // This set stays purely a submission tracker.
  // Live per-shop Oil/Parts/Additives/Other breakdown for the CURRENT
  // period, via get_current_balance_by_category — now possible because
  // droptop-sync-usage captures Droptop's own per-product unit_cost and
  // computes count_products.ending_value from it (2026-09-22). Requires the
  // scheduled daily Droptop on-hand sync (data-connection-dispatcher's
  // droptop_on_hand connection) to have run at least once for this period
  // (writeToCountProducts, only set once inside the month-end window — see
  // that dispatcher's own monthEndCountMonthFor()) — 2026-09-28: this used
  // to require a manual click on a "Daily Pull" panel here, removed once
  // the routine scheduled sync started doing the same write automatically
  // every morning. Until that first automated write lands for a period,
  // this map is empty and the oil/parts/additives KPIs below fall back to
  // monthly_ending_balances (still "—" for an open period), same
  // graceful-degradation as before.
  const [currentCategoryBalances, setCurrentCategoryBalances] = useState<Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>>(new Map())
  // Same live per-shop breakdown, one period back — needed for a genuine
  // apples-to-apples "Other" comparison in the new Month-over-Month table
  // below, since monthly_ending_balances (Finance's own entry) has no
  // "Other" field at all to fall back to.
  const [prevCategoryBalances, setPrevCategoryBalances] = useState<Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>>(new Map())
  const [currentSubmittedIds, setCurrentSubmittedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Shop Balances table row click (2026-09-28 ask) — opens ShopBalanceModal,
  // which lazy-loads its own 12-month history + on-demand product detail;
  // replaces the old single-shop Combobox-picker "Shop Detail" panel.
  const [modalShop, setModalShop] = useState<{ id: string; label: string } | null>(null)
  // "Other" is a broad catch-all (anything not Oil/Parts/Additives) and
  // usually not what someone means by "the ending balance" — excluded from
  // the Total tile by default, per explicit request, with a toggle to add
  // it back in.
  const [excludeOther, setExcludeOther] = useState(true)
  // Company-wide, cross-month shop exclusions (2026-09-28 ask) — managed on
  // the new Exclusions tab. overviewExcludedIds covers both reasons
  // ('overview_only' and 'everything'), since Overview is included in
  // "everything" by definition.
  const { overviewExcludedIds } = useMonthEndExclusions()
  // How many rows each outlier callout shows — user-configurable (2026-09-28
  // ask), persisted per-user across sessions/devices.
  const [outlierN, setOutlierN] = useProfilePref<number>('monthend:outlier-n', 3)

  const prevMonth = useMemo(() => format(subMonths(parseISO(countMonth), 1), 'yyyy-MM-01'), [countMonth])
  const lookbackStart = useMemo(() => format(subMonths(parseISO(countMonth), LOOKBACK_MONTHS), 'yyyy-MM-01'), [countMonth])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    const sb = supabase as any
    try {
      // Paginated (id-tiebreak) fetch of the balance window so >1000 rows aren't truncated.
      const all: MonthlyEndingBalance[] = []
      let from = 0
      for (;;) {
        const { data, error } = await sb.schema('inventory').from('monthly_ending_balances')
          .select('*').eq('company_id', companyId)
          .gte('month', lookbackStart).lte('month', countMonth)
          .order('id', { ascending: true }).range(from, from + PAGE - 1)
        if (error) throw error
        const batch = (data ?? []) as MonthlyEndingBalance[]
        all.push(...batch)
        // Exit only on a genuinely empty page — the project's API "Max
        // Rows" setting silently caps every response at 1000 regardless of
        // the requested range, so a full page here doesn't mean "last page."
        if (batch.length === 0) break
        from += batch.length
      }
      setBalances(all)

      // Which shops have submitted a count this period — same "Monthly"
      // count_type + manual_count_entries definition of "submitted"
      // NotSubmittedTab.tsx already uses, so this agrees with that tab
      // rather than introducing a second definition. No longer reads
      // ending_inventory_cost (2026-09-28 — see currentSubmittedIds' own
      // comment above): this is purely a submission tracker now.
      const [{ data: countsRows }, { data: manualRows }] = await Promise.all([
        sb.schema('inventory').from('counts')
          .select('location_id, count_type')
          .eq('company_id', companyId).eq('count_month', countMonth),
        sb.schema('inventory').from('manual_count_entries')
          .select('location_id').eq('company_id', companyId).eq('count_period', countMonth),
      ])
      const monthlyRows = ((countsRows ?? []) as { location_id: string | null; count_type: string | null }[])
        .filter((r) => (r.count_type ?? '').trim().toLowerCase() === 'monthly' && r.location_id)
      const submitted = new Set<string>()
      for (const r of monthlyRows) submitted.add(r.location_id!)
      for (const m of (manualRows ?? []) as { location_id: string | null }[]) if (m.location_id) submitted.add(m.location_id)
      setCurrentSubmittedIds(submitted)

      const { data: catBalRows, error: catBalErr } = await sb.rpc('get_current_balance_by_category', {
        p_company_id: companyId, p_count_month: countMonth,
      })
      if (catBalErr) throw catBalErr
      const catBalMap = new Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>()
      for (const r of (catBalRows ?? []) as { location_id: string; oil: number | null; parts: number | null; additives: number | null; other: number | null; total: number | null }[]) {
        catBalMap.set(r.location_id, {
          oil: Number(r.oil ?? 0), parts: Number(r.parts ?? 0), additives: Number(r.additives ?? 0),
          other: Number(r.other ?? 0), total: Number(r.total ?? 0),
        })
      }
      setCurrentCategoryBalances(catBalMap)

      const { data: prevCatBalRows, error: prevCatBalErr } = await sb.rpc('get_current_balance_by_category', {
        p_company_id: companyId, p_count_month: prevMonth,
      })
      if (prevCatBalErr) throw prevCatBalErr
      const prevCatBalMap = new Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>()
      for (const r of (prevCatBalRows ?? []) as { location_id: string; oil: number | null; parts: number | null; additives: number | null; other: number | null; total: number | null }[]) {
        prevCatBalMap.set(r.location_id, {
          oil: Number(r.oil ?? 0), parts: Number(r.parts ?? 0), additives: Number(r.additives ?? 0),
          other: Number(r.other ?? 0), total: Number(r.total ?? 0),
        })
      }
      setPrevCategoryBalances(prevCatBalMap)

      const { data: recounts } = await sb.schema('inventory').from('recount_requests')
        .select('completed_flags').eq('company_id', companyId)
        .filter('recount_fields->>count_month', 'eq', countMonth)
      const rc = (recounts ?? []) as { completed_flags: boolean[] | null }[]
      setCompleteRecounts(rc.filter((r) => (r.completed_flags ?? [])[0]).length)
      setOpenRecounts(rc.filter((r) => !(r.completed_flags ?? [])[0]).length)

      const { data: exc } = await sb.rpc('get_product_expectation_exceptions', {
        p_company_id: companyId, p_count_month: countMonth,
        p_tank_variance: tankVariance ?? DEFAULT_TANK_VARIANCE, p_unlisted_limit: unlistedLimit ?? null,
      })
      setExceptions((exc ?? []) as ExceptionRow[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load overview')
    } finally {
      setLoading(false)
    }
  }, [companyId, countMonth, prevMonth, lookbackStart, tankVariance, unlistedLimit])

  useEffect(() => { load() }, [load])

  // Excluded shops (2026-09-28 ask) are filtered out ONCE, here — every
  // downstream total/table/outlier below reads these filtered versions
  // instead of the raw fetched state, so nothing has to re-implement the
  // filter itself. balances (monthly_ending_balances) is filtered too,
  // since it feeds several of the same computations as a fallback source.
  const filteredBalances = useMemo(
    () => (overviewExcludedIds.size ? balances.filter((b) => !b.location_id || !overviewExcludedIds.has(b.location_id)) : balances),
    [balances, overviewExcludedIds],
  )
  const filteredCurrentCategoryBalances = useMemo(() => {
    if (!overviewExcludedIds.size) return currentCategoryBalances
    const m = new Map(currentCategoryBalances)
    for (const id of overviewExcludedIds) m.delete(id)
    return m
  }, [currentCategoryBalances, overviewExcludedIds])
  const filteredPrevCategoryBalances = useMemo(() => {
    if (!overviewExcludedIds.size) return prevCategoryBalances
    const m = new Map(prevCategoryBalances)
    for (const id of overviewExcludedIds) m.delete(id)
    return m
  }, [prevCategoryBalances, overviewExcludedIds])

  // Current-month totals — Total AND Oil/Parts/Additives/Other all come
  // from the same live per-shop breakdown (currentCategoryBalances, via
  // get_current_balance_by_category — real on-hand qty × unit cost from the
  // daily Droptop sync), not from an uploaded Count Summary (2026-09-28,
  // explicit request: these must reflect actual on-hand inventory, not what
  // a shop uploaded). Oil/Parts/Additives (keyed the same as field_key —
  // production's own field_definitions rows for this section are literally
  // 'oil'/'parts'/'additives') fall back to monthly_ending_balances (still
  // "—" until Finance enters it) only when there's no live data at all yet
  // for this period; Total and 'other' have no Finance-entry equivalent, so
  // they're live-only and show "—" until the daily sync has run at least
  // once for this period.
  const currentTotals = useMemo(() => {
    const rows = filteredBalances.filter((b) => b.month === countMonth)
    const hasBalanceRow = rows.length > 0
    const hasLiveCategoryData = filteredCurrentCategoryBalances.size > 0
    const liveSum = (key: 'oil' | 'parts' | 'additives' | 'other' | 'total') =>
      [...filteredCurrentCategoryBalances.values()].reduce((s, v) => s + v[key], 0)
    const cats: Record<string, number | null> = {}
    for (const c of categories) {
      const liveKey = c.field_key as 'oil' | 'parts' | 'additives'
      if (hasLiveCategoryData && (liveKey === 'oil' || liveKey === 'parts' || liveKey === 'additives')) {
        cats[c.field_key] = liveSum(liveKey)
      } else {
        cats[c.field_key] = hasBalanceRow ? rows.reduce((s, r) => s + Number((r.metadata as any)?.[c.field_key] ?? 0), 0) : null
      }
    }
    const other = hasLiveCategoryData ? liveSum('other') : null
    const total = hasLiveCategoryData ? liveSum('total') : null
    return { total, cats, other, shopCount: currentSubmittedIds.size }
  }, [currentSubmittedIds, filteredBalances, categories, countMonth, filteredCurrentCategoryBalances])

  // Total tile with "Other" pulled back out, when the toggle above is on —
  // now a strict re-derivation (both Total and Other come from the same
  // live breakdown, and the RPC's own `total` is a plain sum across every
  // category including Other), unlike before this KPI switched to a live
  // source. Only has an effect when Other actually has live data for this
  // period; otherwise there's nothing to subtract and the toggle is a no-op.
  const displayedTotal = excludeOther && currentTotals.other != null ? (currentTotals.total ?? 0) - currentTotals.other : currentTotals.total

  // Month-over-Month comparison for the KPI row — Total + each configured
  // category + Other (when it has data), each with the company-wide
  // current/last/delta AND the average of every individual shop's own
  // current-minus-last delta (per explicit request — these can differ from
  // the company-wide delta when the set of shops reporting each month
  // isn't identical, e.g. a shop submitted this month but not last).
  // "Total" per shop mirrors shopDetail's own historical source
  // (monthly_ending_balances.ending_balance for a closed month; the live
  // currentCategoryBalances total for the current month, 2026-09-28) rather
  // than summing categories here — though for the current month those are
  // now the same underlying number either way, since Total and the
  // categories share one live source.
  const companyMoM = useMemo(() => {
    const curBalRows = filteredBalances.filter((b) => b.month === countMonth)
    const prevBalRows = filteredBalances.filter((b) => b.month === prevMonth)

    function shopMap(period: 'current' | 'prev', key: 'total' | 'other' | string): Map<string, number> {
      if (key === 'total') {
        if (period === 'current') {
          const m = new Map<string, number>()
          for (const [id, v] of filteredCurrentCategoryBalances) m.set(id, v.total)
          return m
        }
        const m = new Map<string, number>()
        for (const r of prevBalRows) if (r.location_id) m.set(r.location_id, Number(r.ending_balance ?? 0))
        return m
      }
      const live = period === 'current' ? filteredCurrentCategoryBalances : filteredPrevCategoryBalances
      if (key === 'other') {
        const m = new Map<string, number>()
        for (const [id, v] of live) m.set(id, v.other)
        return m
      }
      if ((key === 'oil' || key === 'parts' || key === 'additives') && live.size > 0) {
        const m = new Map<string, number>()
        for (const [id, v] of live) m.set(id, (v as any)[key])
        return m
      }
      const rows = period === 'current' ? curBalRows : prevBalRows
      const m = new Map<string, number>()
      for (const r of rows) if (r.location_id) m.set(r.location_id, Number((r.metadata as any)?.[key] ?? 0))
      return m
    }

    function rowFor(label: string, key: 'total' | 'other' | string) {
      let curMap = shopMap('current', key)
      let prevMap = shopMap('prev', key)
      // Total follows the same "Other excluded by default" preference as
      // the KPI tile — subtracted per shop first so avgDeltaPerShop stays
      // consistent with the displayed current/last/delta, not just the
      // aggregate.
      if (key === 'total' && excludeOther) {
        const curOther = shopMap('current', 'other')
        const prevOther = shopMap('prev', 'other')
        curMap = new Map([...curMap].map(([id, v]) => [id, v - (curOther.get(id) ?? 0)]))
        prevMap = new Map([...prevMap].map(([id, v]) => [id, v - (prevOther.get(id) ?? 0)]))
      }
      const current = curMap.size ? [...curMap.values()].reduce((s, v) => s + v, 0) : null
      const last = prevMap.size ? [...prevMap.values()].reduce((s, v) => s + v, 0) : null
      const delta = current != null && last != null ? current - last : null
      const commonIds = [...curMap.keys()].filter((id) => prevMap.has(id))
      const avgDeltaPerShop = commonIds.length
        ? commonIds.reduce((s, id) => s + (curMap.get(id)! - prevMap.get(id)!), 0) / commonIds.length
        : null
      return { label, current, last, delta, avgDeltaPerShop }
    }

    const rows = [rowFor('Total', 'total'), ...categories.map((c) => rowFor(c.label, c.field_key))]
    if (currentTotals.other != null) rows.push(rowFor('Other', 'other'))
    return rows
  }, [filteredBalances, countMonth, prevMonth, filteredCurrentCategoryBalances, filteredPrevCategoryBalances, categories, excludeOther, currentTotals.other])

  const exceptionStats = useMemo(() => {
    const shops = new Set(exceptions.map((e) => e.location_id))
    return { products: exceptions.length, shops: shops.size, avg: shops.size ? exceptions.length / shops.size : 0 }
  }, [exceptions])

  // Shop Balances table (2026-09-28 ask) — one row per shop, current-period
  // Total/Oil/Parts/Additives/Other, all from the same live
  // currentCategoryBalances source as the KPI tiles above. Replaces the old
  // single-shop Combobox-picker panel with a browsable, sortable table of
  // every shop at once — row click opens ShopBalanceModal for the
  // historical/product-level drill-down instead.
  interface ShopBalanceRow { location_id: string; shop: string; oil: number; parts: number; additives: number; other: number; total: number }
  const shopBalanceRows: ShopBalanceRow[] = useMemo(() => {
    const rows: ShopBalanceRow[] = []
    for (const [id, v] of filteredCurrentCategoryBalances) {
      rows.push({ location_id: id, shop: loc.labelOf(id), oil: v.oil, parts: v.parts, additives: v.additives, other: v.other, total: v.total })
    }
    return rows
  }, [filteredCurrentCategoryBalances, loc])

  // Outlier callouts — top/bottom N by current Total $, and top N by
  // absolute MoM % change in a shop's overall Total (not per-category, per
  // explicit request) among shops with a real prior-month total to compare
  // against. N is user-configurable (outlierN below).
  //
  // Prior-month total prefers the live currentCategoryBalances-style source
  // (prevCategoryBalances, from get_current_balance_by_category) but falls
  // back to monthly_ending_balances.ending_balance when a shop has NO live
  // entry at all for that month (2026-09-28 ask — found live: August had no
  // count_products data company-wide, which silently excluded every shop
  // from this callout since prevCategoryBalances was simply empty for that
  // month; Finance's own monthly_ending_balances still had real August
  // entries to fall back to). `.has(id)` is the trigger, not "total === 0"
  // — a shop can legitimately have a real $0 live balance for a month.
  const outliers = useMemo(() => {
    const byTotalDesc = [...shopBalanceRows].sort((a, b) => b.total - a.total)
    const topHigh = byTotalDesc.slice(0, outlierN)
    const bottomLow = byTotalDesc.length > outlierN ? [...byTotalDesc].reverse().slice(0, outlierN) : []

    const prevTotalFallback = new Map<string, number>()
    for (const b of filteredBalances) if (b.month === prevMonth && b.location_id) prevTotalFallback.set(b.location_id, Number(b.ending_balance ?? 0))

    const pctChanges: { location_id: string; shop: string; pct: number }[] = []
    for (const [id, cur] of filteredCurrentCategoryBalances) {
      const prevTotal = filteredPrevCategoryBalances.has(id) ? filteredPrevCategoryBalances.get(id)!.total : (prevTotalFallback.get(id) ?? null)
      if (prevTotal == null || !prevTotal) continue
      pctChanges.push({ location_id: id, shop: loc.labelOf(id), pct: (cur.total - prevTotal) / Math.abs(prevTotal) })
    }
    const topPctChange = pctChanges.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct)).slice(0, outlierN)

    return { topHigh, bottomLow, topPctChange }
  }, [shopBalanceRows, filteredCurrentCategoryBalances, filteredPrevCategoryBalances, filteredBalances, prevMonth, outlierN, loc])

  const shopCol = useMemo(() => createColumnHelper<ShopBalanceRow>(), [])
  const shopColumns = useMemo(() => [
    shopCol.accessor('shop', { header: 'Shop' }),
    shopCol.accessor('total', { header: 'Total', cell: (i) => <div className="text-right font-bold">{usd(i.getValue())}</div> }),
    shopCol.accessor('oil', { header: 'Oil', cell: (i) => <div className="text-right">{usd(i.getValue())}</div> }),
    shopCol.accessor('parts', { header: 'Parts', cell: (i) => <div className="text-right">{usd(i.getValue())}</div> }),
    shopCol.accessor('additives', { header: 'Additives', cell: (i) => <div className="text-right">{usd(i.getValue())}</div> }),
    // fill: true (2026-09-28 ask) — makes this, the last column, absorb the
    // container's remaining width instead of the table leaving dead space
    // to the right (DataTable only turns on its own `w-full` when at least
    // one visible column opts into this, same convention PoStatusPage's
    // own onOrderColumns PO# column already uses).
    shopCol.accessor('other', { header: 'Other', meta: { fill: true }, cell: (i) => <div className="text-right">{usd(i.getValue())}</div> }),
  ], [shopCol])

  const SHOP_TABLE_KEY = 'monthend:shop-balances'
  const {
    table: shopTable, globalFilter: shopGlobalFilter, setGlobalFilter: setShopGlobalFilter,
    columnVisibility: shopColumnVisibility, columnOrder: shopColumnOrder, setColumnOrder: setShopColumnOrder,
  } = useTable(shopBalanceRows, shopColumns, {
    persistKey: SHOP_TABLE_KEY,
    initialPageSize: 50,
    initialSorting: [{ id: 'total', desc: true }],
  })
  useColumnPrefs(SHOP_TABLE_KEY, shopTable, shopColumnVisibility, shopColumnOrder, setShopColumnOrder)

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
  if (error) return <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Overview — {format(parseISO(countMonth), 'MMMM yyyy')}</h2>
        <p className="text-xs text-inky mt-0.5">Current balances by category and recount activity for the period.</p>
      </div>

      {/* Category balance KPIs */}
      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Kpi label="Total Ending Balance" value={usd(displayedTotal)} accent />
          {categories.map((c) => (
            <Kpi key={c.field_key} label={c.label} value={usd(currentTotals.cats[c.field_key])} />
          ))}
          {currentTotals.other != null && <Kpi label="Other" value={usd(currentTotals.other)} />}
        </div>
        {currentTotals.other != null && (
          <label className="flex items-center gap-2 text-[10px] font-mono text-inky/60 uppercase tracking-wide">
            <Toggle checked={!excludeOther} onChange={(v) => setExcludeOther(!v)} size="sm" color="cyan" />
            Include Other in Total
          </label>
        )}
      </div>

      {/* Month-over-month comparison */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Month over Month</span>
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Category</th>
                  <th className="px-3 py-2 text-right">Current</th>
                  <th className="px-3 py-2 text-right">Last Month</th>
                  <th className="px-3 py-2 text-right">Δ vs Last</th>
                  <th className="px-3 py-2 text-right">Avg Δ / Shop</th>
                </tr>
              </thead>
              <tbody>
                {companyMoM.map((r) => (
                  <tr key={r.label} className="border-b border-navy/20">
                    <td className="px-3 py-2 text-navy font-bold">{r.label}</td>
                    <td className="px-3 py-2 text-right text-navy">{usd(r.current)}</td>
                    <td className="px-3 py-2 text-right text-inky">{usd(r.last)}</td>
                    <td className={['px-3 py-2 text-right', r.delta == null ? 'text-inky/40' : r.delta >= 0 ? 'text-[#2ECC71]' : 'text-[#C0392B]'].join(' ')}>
                      {r.delta == null ? '—' : `${r.delta >= 0 ? '▲' : '▼'} ${usd(Math.abs(r.delta))}`}
                    </td>
                    <td className={['px-3 py-2 text-right', r.avgDeltaPerShop == null ? 'text-inky/40' : r.avgDeltaPerShop >= 0 ? 'text-[#2ECC71]' : 'text-[#C0392B]'].join(' ')}>
                      {r.avgDeltaPerShop == null ? '—' : `${r.avgDeltaPerShop >= 0 ? '▲' : '▼'} ${usd(Math.abs(r.avgDeltaPerShop))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] font-mono text-inky/50">
            Δ vs Last is the company-wide total's change; Avg Δ / Shop averages each individual shop's own change — they can differ when the shops reporting this month and last month aren't identical.
          </p>
        </CardBody>
      </Card>

      {/* Recount KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi label="Shops Submitted" value={currentTotals.shopCount.toLocaleString()} />
        <Kpi label="Products Flagged" value={exceptionStats.products.toLocaleString()} highlight={exceptionStats.products > 0} />
        <Kpi label="Shops Flagged" value={exceptionStats.shops.toLocaleString()} />
        <Kpi label="Avg Flagged / Shop" value={exceptionStats.avg ? exceptionStats.avg.toFixed(1) : '—'} />
        <Kpi label="Open Recounts" value={openRecounts.toLocaleString()} highlight={openRecounts > 0} />
        <Kpi label="Complete Recounts" value={completeRecounts.toLocaleString()} />
      </div>

      {/* Outlier callouts — current Total $ high/low, and MoM % swing */}
      <div className="flex items-center justify-end gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Show</span>
        <div className="w-28">
          <Select value={String(outlierN)} onChange={(e) => setOutlierN(Number(e.target.value))}
            options={[{ value: '3', label: 'Top 3' }, { value: '5', label: 'Top 5' }, { value: '10', label: 'Top 10' }]} />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <OutlierCard title={`Top ${outlierN} — Highest Balance`}
          rows={outliers.topHigh.map((r) => ({ location_id: r.location_id, label: r.shop, value: usd(r.total) }))}
          onSelect={(id, label) => setModalShop({ id, label })} />
        <OutlierCard title={`Bottom ${outlierN} — Lowest Balance`}
          rows={outliers.bottomLow.map((r) => ({ location_id: r.location_id, label: r.shop, value: usd(r.total) }))}
          onSelect={(id, label) => setModalShop({ id, label })} />
        <OutlierCard title={`Top ${outlierN} — MoM % Change (Total)`}
          rows={outliers.topPctChange.map((r) => ({
            location_id: r.location_id, label: r.shop, value: `${r.pct >= 0 ? '▲' : '▼'} ${Math.abs(r.pct * 100).toFixed(1)}%`,
            tone: r.pct >= 0 ? 'up' as const : 'down' as const,
          }))}
          onSelect={(id, label) => setModalShop({ id, label })} />
      </div>

      {/* Shop Balances — every shop, current period, by category */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Shop Balances — {format(parseISO(countMonth), 'MMMM yyyy')}</span>
          <DataTable
            table={shopTable}
            globalFilter={shopGlobalFilter}
            onGlobalFilterChange={setShopGlobalFilter}
            exportFilename="Shop Balances"
            onRowClick={(r) => setModalShop({ id: r.location_id, label: r.shop })}
          />
        </CardBody>
      </Card>

      {modalShop && companyId && (
        <ShopBalanceModal
          open={!!modalShop}
          onClose={() => setModalShop(null)}
          companyId={companyId}
          locationId={modalShop.id}
          shopLabel={modalShop.label}
          countMonth={countMonth}
        />
      )}
    </div>
  )
}

function OutlierCard({ title, rows, onSelect }: {
  title: string
  rows: { location_id: string; label: string; value: string; tone?: 'up' | 'down' }[]
  // Opens the same ShopBalanceModal a Shop Balances table row click does
  // (2026-09-28 ask) — a shop's name here is just another way to reach it.
  onSelect: (locationId: string, label: string) => void
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{title}</span>
        {rows.length === 0 ? (
          <span className="text-xs font-mono text-inky/40">—</span>
        ) : (
          <ol className="flex flex-col gap-1">
            {rows.map((r, i) => (
              <li key={r.location_id} className="flex items-center justify-between gap-2 text-xs font-mono">
                <button type="button" onClick={() => onSelect(r.location_id, r.label)}
                  className="text-left text-navy truncate hover:underline hover:text-sky transition-colors">
                  {i + 1}. {r.label}
                </button>
                <span className={[
                  'shrink-0',
                  r.tone === 'up' ? 'text-[#2ECC71]' : r.tone === 'down' ? 'text-[#C0392B]' : 'text-navy font-bold',
                ].join(' ')}>{r.value}</span>
              </li>
            ))}
          </ol>
        )}
      </CardBody>
    </Card>
  )
}

function Kpi({ label, value, accent, highlight }: { label: string; value: string; accent?: boolean; highlight?: boolean }) {
  return (
    <div className={[
      'rounded-lg border px-4 py-3 flex flex-col gap-1',
      accent ? 'border-navy/40 bg-navy/[0.04]' : 'border-navy/20 bg-cream',
    ].join(' ')}>
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label}</span>
      <span className={['text-lg font-heading font-bold', highlight ? 'text-[#E67E22]' : 'text-navy'].join(' ')}>{value}</span>
    </div>
  )
}
