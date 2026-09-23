import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useLocations } from '@/hooks/useLocations'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Card, CardBody, Combobox, SbLoader, Toggle } from '@/components/ui'
import { TANK_VARIANCE_KEY, UNLISTED_LIMIT_KEY, DEFAULT_TANK_VARIANCE } from '@/modules/config/tabs/CategoryExpectationsTab'
import type { MonthlyEndingBalance } from '@/types'
import { format, parseISO, subMonths } from 'date-fns'

const LOOKBACK_MONTHS = 12
const PAGE = 1000

const usd = (v: number | null | undefined) =>
  v == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => !isNaN(n)).sort((a, b) => a - b)
  if (!xs.length) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2
}
function mean(nums: number[]): number | null {
  const xs = nums.filter((n) => !isNaN(n))
  return xs.length ? xs.reduce((s, n) => s + n, 0) / xs.length : null
}

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
  // Current-period TOTAL ending balance, live from inventory.counts — found
  // live 2026-09-22: monthly_ending_balances' per-category (Parts/Oil/
  // Additives) breakdown is a genuinely separate, manual Finance entry
  // (Global Config -> Ending Balances) with no live source at all — no
  // data_source_link row exists for it, confirmed directly against
  // production — so it normally only gets a row once the month is closed
  // out. That's NOT true of the total: `counts` (this same page's own
  // "Count Summary" upload) already has real ending_inventory_cost data
  // the moment a shop's Monthly count is uploaded, no month-end wait
  // needed (confirmed live: 213 real Monthly rows already sitting there
  // for the current period while monthly_ending_balances had zero). So the
  // Total KPI/Shop Detail row reads live from here; the three category
  // KPIs below it stay on monthly_ending_balances since that's genuinely
  // the only place that breakdown exists, and show "—" (not $0) until
  // Finance enters it for this period.
  const [currentCounts, setCurrentCounts] = useState<Map<string, number>>(new Map())
  // Live per-shop Oil/Parts/Additives/Other breakdown for the CURRENT
  // period, via get_current_balance_by_category — now possible because
  // droptop-sync-usage captures Droptop's own per-product unit_cost and
  // computes count_products.ending_value from it (2026-09-22). Requires
  // Month End's Daily Pull panel to have run at least once for this period
  // (writeToCountProducts) — until then this map is empty and the
  // oil/parts/additives KPIs below fall back to monthly_ending_balances
  // (still "—" for an open period), same graceful-degradation as before.
  const [currentCategoryBalances, setCurrentCategoryBalances] = useState<Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>>(new Map())
  // Same live per-shop breakdown, one period back — needed for a genuine
  // apples-to-apples "Other" comparison in the new Month-over-Month table
  // below, since monthly_ending_balances (Finance's own entry) has no
  // "Other" field at all to fall back to.
  const [prevCategoryBalances, setPrevCategoryBalances] = useState<Map<string, { oil: number; parts: number; additives: number; other: number; total: number }>>(new Map())
  const [currentSubmittedIds, setCurrentSubmittedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shopId, setShopId] = useState('')
  // "Other" is a broad catch-all (anything not Oil/Parts/Additives) and
  // usually not what someone means by "the ending balance" — excluded from
  // the Total tile by default, per explicit request, with a toggle to add
  // it back in.
  const [excludeOther, setExcludeOther] = useState(true)

  const prevMonth = useMemo(() => format(subMonths(parseISO(countMonth), 1), 'yyyy-MM-01'), [countMonth])
  const lookbackStart = useMemo(() => format(subMonths(parseISO(countMonth), LOOKBACK_MONTHS), 'yyyy-MM-01'), [countMonth])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    const sb = supabase as any
    try {
      // Paginated (id-tiebreak) fetch of the balance window so >1000 rows aren't truncated.
      const all: MonthlyEndingBalance[] = []
      for (let from = 0; ; from += PAGE) {
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
      }
      setBalances(all)

      // Live current-period total — see currentCounts' own comment above.
      // Same "Monthly" count_type + manual_count_entries definition of
      // "submitted" NotSubmittedTab.tsx already uses, so this KPI agrees
      // with that tab rather than introducing a second definition.
      const [{ data: countsRows }, { data: manualRows }] = await Promise.all([
        sb.schema('inventory').from('counts')
          .select('location_id, count_type, ending_inventory_cost, uploaded_at, created_at')
          .eq('company_id', companyId).eq('count_month', countMonth),
        sb.schema('inventory').from('manual_count_entries')
          .select('location_id').eq('company_id', companyId).eq('count_period', countMonth),
      ])
      const monthlyRows = ((countsRows ?? []) as {
        location_id: string | null; count_type: string | null; ending_inventory_cost: number | null
        uploaded_at: string | null; created_at: string | null
      }[]).filter((r) => (r.count_type ?? '').trim().toLowerCase() === 'monthly' && r.location_id)
      // A shop can have more than one Monthly row for the same period (a
      // corrected re-upload) — keep only the most recently uploaded one per
      // shop, same "latest wins" precedent as NotSubmittedTab.tsx's own
      // lastMap dedup.
      monthlyRows.sort((a, b) => (b.uploaded_at ?? b.created_at ?? '').localeCompare(a.uploaded_at ?? a.created_at ?? ''))
      const countsMap = new Map<string, number>()
      const submitted = new Set<string>()
      for (const r of monthlyRows) {
        submitted.add(r.location_id!)
        if (!countsMap.has(r.location_id!)) countsMap.set(r.location_id!, Number(r.ending_inventory_cost ?? 0))
      }
      for (const m of (manualRows ?? []) as { location_id: string | null }[]) if (m.location_id) submitted.add(m.location_id)
      setCurrentCounts(countsMap)
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

  // Current-month totals — Total is live (currentCounts, see its own
  // comment above). Oil/Parts/Additives prefer the live per-category
  // breakdown (currentCategoryBalances, keyed the same as field_key —
  // production's own field_definitions rows for this section are literally
  // 'oil'/'parts'/'additives') whenever it has data for this period, falling
  // back to monthly_ending_balances (still "—" until Finance enters it)
  // otherwise — so a still-open period stops showing "—" the moment Month
  // End's Daily Pull has run once, no month-close wait needed. 'other' has
  // no Finance-entry equivalent at all, so it's live-only.
  const currentTotals = useMemo(() => {
    const total = [...currentCounts.values()].reduce((s, v) => s + v, 0)
    const rows = balances.filter((b) => b.month === countMonth)
    const hasBalanceRow = rows.length > 0
    const hasLiveCategoryData = currentCategoryBalances.size > 0
    const liveSum = (key: 'oil' | 'parts' | 'additives' | 'other') =>
      [...currentCategoryBalances.values()].reduce((s, v) => s + v[key], 0)
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
    return { total, cats, other, shopCount: currentSubmittedIds.size }
  }, [currentCounts, currentSubmittedIds, balances, categories, countMonth, currentCategoryBalances])

  // Total tile with "Other" pulled back out, when the toggle above is on —
  // Total itself is independently sourced (currentCounts, a shop's own
  // self-reported count total) rather than literally built by summing the
  // category tiles, so this is "total minus whatever we can currently
  // attribute to Other," not a strict re-derivation. Only has an effect
  // when Other actually has live data for this period; otherwise there's
  // nothing to subtract and the toggle is a no-op.
  const displayedTotal = excludeOther && currentTotals.other != null ? currentTotals.total - currentTotals.other : currentTotals.total

  // Month-over-Month comparison for the KPI row — Total + each configured
  // category + Other (when it has data), each with the company-wide
  // current/last/delta AND the average of every individual shop's own
  // current-minus-last delta (per explicit request — these can differ from
  // the company-wide delta when the set of shops reporting each month
  // isn't identical, e.g. a shop submitted this month but not last).
  // "Total" per shop mirrors shopDetail's own historical source
  // (monthly_ending_balances.ending_balance for a closed month; currentCounts
  // for the live current month) rather than summing categories, same
  // total-vs-categories data-source split as currentTotals above.
  const companyMoM = useMemo(() => {
    const curBalRows = balances.filter((b) => b.month === countMonth)
    const prevBalRows = balances.filter((b) => b.month === prevMonth)

    function shopMap(period: 'current' | 'prev', key: 'total' | 'other' | string): Map<string, number> {
      if (key === 'total') {
        if (period === 'current') return currentCounts
        const m = new Map<string, number>()
        for (const r of prevBalRows) if (r.location_id) m.set(r.location_id, Number(r.ending_balance ?? 0))
        return m
      }
      const live = period === 'current' ? currentCategoryBalances : prevCategoryBalances
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
  }, [balances, countMonth, prevMonth, currentCounts, currentCategoryBalances, prevCategoryBalances, categories, excludeOther, currentTotals.other])

  const exceptionStats = useMemo(() => {
    const shops = new Set(exceptions.map((e) => e.location_id))
    return { products: exceptions.length, shops: shops.size, avg: shops.size ? exceptions.length / shops.size : 0 }
  }, [exceptions])

  // Per-shop history for the detail panel. Total's CURRENT value is live
  // (currentCounts) — everything else (Last Month, category rows, and the
  // avg/median series, which are always looking at already-closed months)
  // stays on monthly_ending_balances, same reasoning as currentTotals above.
  const shopDetail = useMemo(() => {
    if (!shopId) return null
    const rows = balances.filter((b) => b.location_id === shopId)
    const valFor = (r: MonthlyEndingBalance | undefined, key: string | null) =>
      r == null ? null : key ? Number((r.metadata as any)?.[key] ?? 0) : Number(r.ending_balance ?? 0)
    const curRow = rows.find((r) => r.month === countMonth)
    const prevRow = rows.find((r) => r.month === prevMonth)
    const seriesFor = (key: string | null) => rows.map((r) => valFor(r, key)!).filter((n) => n != null && !isNaN(n))
    const line = (label: string, key: string | null) => {
      const current = key === null ? (currentCounts.get(shopId) ?? null) : valFor(curRow, key)
      const last = valFor(prevRow, key)
      return { label, current, last, avg: mean(seriesFor(key)), med: median(seriesFor(key)),
        delta: current != null && last != null ? current - last : null }
    }
    return [line('Total', null), ...categories.map((c) => line(c.label, c.field_key))]
  }, [shopId, balances, categories, countMonth, prevMonth, currentCounts])

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

      {/* Shop detail lookup */}
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">Shop Detail</span>
            <div className="w-72">
              <Combobox options={loc.options} value={shopId} onChange={setShopId} placeholder="Pick a shop…" />
            </div>
          </div>
          {!shopId ? (
            <p className="text-xs font-mono text-inky/60">Select a shop to see its balances by category — current, last month, {LOOKBACK_MONTHS}-month average and median.</p>
          ) : (
            <div className="overflow-auto rounded border border-navy/30">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left">Category</th>
                    <th className="px-3 py-2 text-right">Current</th>
                    <th className="px-3 py-2 text-right">Last Month</th>
                    <th className="px-3 py-2 text-right">Δ vs Last</th>
                    <th className="px-3 py-2 text-right">Avg ({LOOKBACK_MONTHS}mo)</th>
                    <th className="px-3 py-2 text-right">Median</th>
                  </tr>
                </thead>
                <tbody>
                  {(shopDetail ?? []).map((r) => (
                    <tr key={r.label} className="border-b border-navy/20">
                      <td className="px-3 py-2 text-navy font-bold">{r.label}</td>
                      <td className="px-3 py-2 text-right text-navy">{usd(r.current)}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.last)}</td>
                      <td className={['px-3 py-2 text-right', r.delta == null ? 'text-inky/40' : r.delta >= 0 ? 'text-[#2ECC71]' : 'text-[#C0392B]'].join(' ')}>
                        {r.delta == null ? '—' : `${r.delta >= 0 ? '▲' : '▼'} ${usd(Math.abs(r.delta))}`}
                      </td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.avg)}</td>
                      <td className="px-3 py-2 text-right text-inky">{usd(r.med)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
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
