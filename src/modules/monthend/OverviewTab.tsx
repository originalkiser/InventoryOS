import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useLocations } from '@/hooks/useLocations'
import { useCustomFields } from '@/hooks/useCustomFields'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Card, CardBody, Combobox, SbLoader } from '@/components/ui'
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
  const [currentSubmittedIds, setCurrentSubmittedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [shopId, setShopId] = useState('')

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
  }, [companyId, countMonth, lookbackStart, tankVariance, unlistedLimit])

  useEffect(() => { load() }, [load])

  // Current-month totals — Total is live (currentCounts, see its own
  // comment above); the Parts/Oil/Additives breakdown stays on
  // monthly_ending_balances (the only place it exists) and shows null
  // ("—", not $0) whenever Finance hasn't entered this period yet.
  const currentTotals = useMemo(() => {
    const total = [...currentCounts.values()].reduce((s, v) => s + v, 0)
    const rows = balances.filter((b) => b.month === countMonth)
    const hasBalanceRow = rows.length > 0
    const cats: Record<string, number | null> = {}
    for (const c of categories) {
      cats[c.field_key] = hasBalanceRow ? rows.reduce((s, r) => s + Number((r.metadata as any)?.[c.field_key] ?? 0), 0) : null
    }
    return { total, cats, shopCount: currentSubmittedIds.size }
  }, [currentCounts, currentSubmittedIds, balances, categories, countMonth])

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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="Total Ending Balance" value={usd(currentTotals.total)} accent />
        {categories.map((c) => (
          <Kpi key={c.field_key} label={c.label} value={usd(currentTotals.cats[c.field_key])} />
        ))}
      </div>

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
