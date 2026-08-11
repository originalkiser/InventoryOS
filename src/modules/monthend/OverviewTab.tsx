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
        if (batch.length < PAGE) break
      }
      setBalances(all)

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

  // Current-month category totals (Total + each simplified category).
  const currentTotals = useMemo(() => {
    const rows = balances.filter((b) => b.month === countMonth)
    const total = rows.reduce((s, r) => s + Number(r.ending_balance ?? 0), 0)
    const cats: Record<string, number> = {}
    for (const c of categories) cats[c.field_key] = rows.reduce((s, r) => s + Number((r.metadata as any)?.[c.field_key] ?? 0), 0)
    return { total, cats, shopCount: rows.length }
  }, [balances, categories, countMonth])

  const exceptionStats = useMemo(() => {
    const shops = new Set(exceptions.map((e) => e.location_id))
    return { products: exceptions.length, shops: shops.size, avg: shops.size ? exceptions.length / shops.size : 0 }
  }, [exceptions])

  // Per-shop history for the detail panel.
  const shopDetail = useMemo(() => {
    if (!shopId) return null
    const rows = balances.filter((b) => b.location_id === shopId)
    const valFor = (r: MonthlyEndingBalance | undefined, key: string | null) =>
      r == null ? null : key ? Number((r.metadata as any)?.[key] ?? 0) : Number(r.ending_balance ?? 0)
    const curRow = rows.find((r) => r.month === countMonth)
    const prevRow = rows.find((r) => r.month === prevMonth)
    const seriesFor = (key: string | null) => rows.map((r) => valFor(r, key)!).filter((n) => n != null && !isNaN(n))
    const line = (label: string, key: string | null) => {
      const current = valFor(curRow, key)
      const last = valFor(prevRow, key)
      return { label, current, last, avg: mean(seriesFor(key)), med: median(seriesFor(key)),
        delta: current != null && last != null ? current - last : null }
    }
    return [line('Total', null), ...categories.map((c) => line(c.label, c.field_key))]
  }, [shopId, balances, categories, countMonth, prevMonth])

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
