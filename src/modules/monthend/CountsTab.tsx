import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { computeMedian, evaluateRecountFlags } from '@/lib/recountEngine'
import { aggregateProductBatches } from '@/lib/additiveProducts'
import { locationLabel, monthlySummaryTarget } from './countsShared'
import { CountSummaryUpload } from './CountSummaryUpload'
import { ProductDetailUpload } from './ProductDetailUpload'
import { CountsResultsTable, type SummaryResultRow, type ProductResultRow } from './CountsResultsTable'
import type {
  Location, MonthlyCount, MonthlyCountProduct, CountUploadBatch, RecountConfig, MonthlyEndingBalance,
} from '@/types'
import { format, subMonths } from 'date-fns'
import toast from 'react-hot-toast'

const DEFAULT_LOOKBACK = 6

export function CountsTab() {
  const { profile } = useAuthStore()
  const { getCountMonth, recountConfig, setRecountConfig } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [counts, setCounts] = useState<MonthlyCount[]>([])
  const [products, setProducts] = useState<MonthlyCountProduct[]>([])
  const [batches, setBatches] = useState<CountUploadBatch[]>([])
  const [balances, setBalances] = useState<MonthlyEndingBalance[]>([])
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const lookbackN = recountConfig?.median_months_lookback ?? DEFAULT_LOOKBACK

  const loadAll = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const lowerBound = format(subMonths(new Date(countMonth), lookbackN + 1), 'yyyy-MM-dd')

    const [locRes, cfgRes, countRes, prodRes, batchRes, balRes, profRes] = await Promise.all([
      sb.from('locations').select('*').eq('company_id', companyId).order('location_code'),
      sb.from('recount_config').select('*').eq('company_id', companyId).maybeSingle(),
      sb.from('monthly_counts').select('*').eq('company_id', companyId).eq('count_month', countMonth),
      sb.from('monthly_count_products').select('*').eq('company_id', companyId).eq('count_month', countMonth),
      sb.from('count_upload_batches').select('*').eq('company_id', companyId).eq('module', 'monthly').eq('count_month', countMonth).order('created_at', { ascending: false }),
      sb.from('monthly_ending_balances').select('*').eq('company_id', companyId).gte('month', lowerBound).lt('month', countMonth).order('month', { ascending: false }),
      sb.from('profiles').select('id, full_name').eq('company_id', companyId),
    ])

    setLocations((locRes.data ?? []) as Location[])
    setRecountConfig((cfgRes.data ?? null) as RecountConfig | null)
    setCounts((countRes.data ?? []) as MonthlyCount[])
    setProducts((prodRes.data ?? []) as MonthlyCountProduct[])
    setBatches((batchRes.data ?? []) as CountUploadBatch[])
    setBalances((balRes.data ?? []) as MonthlyEndingBalance[])
    const names: Record<string, string> = {}
    for (const p of (profRes.data ?? []) as { id: string; full_name: string | null }[]) {
      names[p.id] = p.full_name ?? 'Unknown'
    }
    setUserNames(names)
    setLoading(false)
  }, [companyId, countMonth, lookbackN, setRecountConfig])

  useEffect(() => { loadAll() }, [loadAll])

  // Realtime — reload + toast on any change to the three count tables
  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('monthend-counts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'monthly_counts', filter: `company_id=eq.${companyId}` },
        () => { toast('Counts updated', { icon: '📊' }); loadAll() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'monthly_count_products', filter: `company_id=eq.${companyId}` },
        () => { loadAll() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'count_upload_batches', filter: `company_id=eq.${companyId}` },
        () => { toast('Batches updated', { icon: '📦' }); loadAll() })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, loadAll])

  // ---- Derive summary rows (one per location) with live recount evaluation ----
  const summaryRows: SummaryResultRow[] = (() => {
    // Build per-location balance history (most recent first)
    const histByLoc = new Map<string, number[]>()
    for (const b of balances) {
      if (!b.location_id) continue
      const arr = histByLoc.get(b.location_id) ?? []
      arr.push(Number(b.ending_balance))
      histByLoc.set(b.location_id, arr)
    }

    // Dedupe counts to latest count_date per location
    const byLoc = new Map<string, MonthlyCount>()
    for (const c of counts) {
      const key = c.location_id ?? `__null_${c.id}`
      const existing = byLoc.get(key)
      if (!existing || new Date(c.count_date) > new Date(existing.count_date)) byLoc.set(key, c)
    }

    return Array.from(byLoc.values()).map((c) => {
      const hist = c.location_id ? histByLoc.get(c.location_id) ?? [] : []
      const prev = hist.length ? hist[0] : null
      const median = computeMedian(hist.slice(0, lookbackN))
      const evaln = evaluateRecountFlags(c, prev, median, recountConfig)
      return {
        location_id: c.location_id,
        location_label: locationLabel(c.location_id, locations),
        count_type: c.count_type,
        count_date: c.count_date,
        total_adjustments: c.total_adjustments,
        adjustment_value: c.adjustment_value,
        abs_adjustment_value: c.abs_adjustment_value,
        ending_inventory_cost: c.ending_inventory_cost,
        prev_month_ending: prev,
        median,
        var_vs_last_month: evaln.varVsLastMonth,
        var_vs_median: evaln.varVsMedian,
        flags: evaln.flags,
      }
    })
  })()

  // ---- Derive aggregated product rows (additive across batches) ----
  const productRows: ProductResultRow[] = aggregateProductBatches(products).map((p) => ({
    location_label: locationLabel(p.location_id, locations),
    product_id: p.product_id,
    on_hand: p.on_hand,
    sold: p.sold,
    adjusted: p.adjusted,
    ending_value: p.ending_value,
    batch_count: p.batch_count,
  }))

  if (!companyId) {
    return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  }

  const periodLabel = format(new Date(countMonth), 'MMMM yyyy')

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs font-mono text-inky">
        Period: <span className="text-inky">{periodLabel}</span>
        {' · '}{counts.length} summary {counts.length === 1 ? 'row' : 'rows'}
        {' · '}{batches.length} product {batches.length === 1 ? 'batch' : 'batches'}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CountSummaryUpload
          locations={locations}
          companyId={companyId}
          target={monthlySummaryTarget(countMonth)}
          uploadedBy={profile?.id ?? null}
          onImported={loadAll}
        />
        <ProductDetailUpload
          locations={locations}
          companyId={companyId}
          countMonth={countMonth}
          uploadedBy={profile?.id ?? null}
          batches={batches}
          userNames={userNames}
          onChanged={loadAll}
        />
      </div>

      <div>
        <h2 className="text-xs font-mono text-inky uppercase tracking-wide mb-3">Results — {periodLabel}</h2>
        <CountsResultsTable
          summaryRows={summaryRows}
          productRows={productRows}
          lookbackN={lookbackN}
          loading={loading}
        />
      </div>
    </div>
  )
}
