import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { computeMedian, evaluateRecountFlags } from '@/lib/recountEngine'
import { locationLabel, monthlySummaryTarget } from './countsShared'
import { CountSummaryUpload } from './CountSummaryUpload'
import { ProductDetailUpload } from './ProductDetailUpload'
import { CountsResultsTable, type SummaryResultRow, type ProductResultRow } from './CountsResultsTable'
import type {
  Location, MonthlyCount, CountUploadBatch, RecountConfig, MonthlyEndingBalance,
} from '@/types'
import { format, subMonths, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const DEFAULT_LOOKBACK = 6

// Module-level cache, keyed by company+period — survives unmount/remount, so
// switching Month End tabs (TabsContent unmounts inactive panels) and coming
// back to Counts doesn't re-run all 7 queries (including a 250k+ row
// aggregation RPC) from scratch. Stale-while-revalidate: a cached period
// renders instantly, then silently refreshes in the background once past
// the TTL — same pattern as useConfigTab's tabCache.
interface CountsCacheEntry {
  locations: Location[]
  recountConfig: RecountConfig | null
  counts: MonthlyCount[]
  productRows: ProductResultRow[]
  batches: CountUploadBatch[]
  balances: MonthlyEndingBalance[]
  userNames: Record<string, string>
  ts: number
}
const countsCache = new Map<string, CountsCacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

export function CountsTab() {
  const { profile } = useAuthStore()
  const { getCountMonth, recountConfig, setRecountConfig } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [counts, setCounts] = useState<MonthlyCount[]>([])
  const [productRows, setProductRows] = useState<ProductResultRow[]>([])
  const [batches, setBatches] = useState<CountUploadBatch[]>([])
  const [balances, setBalances] = useState<MonthlyEndingBalance[]>([])
  const [userNames, setUserNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)

  const lookbackN = recountConfig?.median_months_lookback ?? DEFAULT_LOOKBACK

  const applyEntry = useCallback((entry: CountsCacheEntry) => {
    setLocations(entry.locations)
    setRecountConfig(entry.recountConfig)
    setCounts(entry.counts)
    setProductRows(entry.productRows)
    setBatches(entry.batches)
    setBalances(entry.balances)
    setUserNames(entry.userNames)
  }, [setRecountConfig])

  // `force: true` (writes, and the realtime-triggered reload below) always
  // hits the network — we have positive evidence the data changed, so
  // serving a within-TTL cache entry would show stale results. A plain
  // mount/remount (tab switch back to Counts) uses the cache when fresh.
  const loadAll = useCallback(async (opts?: { force?: boolean }) => {
    if (!companyId) return
    const key = `${companyId}|${countMonth}`
    const cached = countsCache.get(key)
    if (cached) {
      applyEntry(cached)
      setLoading(false)
      if (!opts?.force && Date.now() - cached.ts < CACHE_TTL_MS) return
    } else {
      setLoading(true)
    }

    const sb = supabase as any
    const lowerBound = format(subMonths(new Date(countMonth), lookbackN + 1), 'yyyy-MM-dd')

    const [locRes, cfgRes, countRes, aggProdRes, batchRes, balRes, profRes] = await Promise.all([
      sb.schema('core').from('locations').select('*').eq('company_id', companyId).order('name'),
      sb.schema('inventory').from('recount_config').select('*').eq('company_id', companyId).maybeSingle(),
      sb.schema('inventory').from('counts').select('*').eq('company_id', companyId).eq('count_month', countMonth),
      // RPC does GROUP BY on the server — avoids shipping 256k+ raw rows to the client
      sb.rpc('get_aggregated_monthly_products', { p_company_id: companyId, p_count_month: countMonth }),
      sb.schema('inventory').from('count_batches').select('*').eq('company_id', companyId).eq('module', 'monthly').eq('count_month', countMonth).order('created_at', { ascending: false }),
      sb.schema('inventory').from('monthly_ending_balances').select('*').eq('company_id', companyId).gte('month', lowerBound).lt('month', countMonth).order('month', { ascending: false }),
      sb.schema('platform').from('user_profiles').select('id, full_name').eq('company_id', companyId),
    ])

    const locs = (locRes.data ?? []) as Location[]
    if (aggProdRes.error) {
      toast.error(`Product load failed: ${aggProdRes.error.message}`)
    }
    const names: Record<string, string> = {}
    for (const p of (profRes.data ?? []) as { id: string; full_name: string | null }[]) {
      names[p.id] = p.full_name ?? 'Unknown'
    }
    const entry: CountsCacheEntry = {
      locations: locs,
      recountConfig: (cfgRes.data ?? null) as RecountConfig | null,
      counts: (countRes.data ?? []) as MonthlyCount[],
      productRows: ((aggProdRes.data ?? []) as any[]).map((p) => ({
        location_label: locationLabel(p.location_id, locs),
        product_id: String(p.product_id ?? ''),
        category: String(p.category ?? ''),
        on_hand: Number(p.on_hand ?? 0),
        sold: Number(p.sold ?? 0),
        adjusted: Number(p.adjusted ?? 0),
        ending_value: Number(p.ending_value ?? 0),
        batch_count: Number(p.batch_count ?? 1),
      })),
      batches: (batchRes.data ?? []) as CountUploadBatch[],
      balances: (balRes.data ?? []) as MonthlyEndingBalance[],
      userNames: names,
      ts: Date.now(),
    }
    countsCache.set(key, entry)
    applyEntry(entry)
    setLoading(false)
  }, [companyId, countMonth, lookbackN, applyEntry])

  useEffect(() => { loadAll() }, [loadAll])

  // Realtime — reload on any change to the three count tables. Debounced:
  // Postgres emits roughly one change event per row, and count_products
  // sees bulk imports of 250k+ rows — reacting to every single one fired
  // this page's full reload (6 queries, including an aggregation RPC) up
  // to 250k times over, concurrently with the import itself hammering the
  // same connection. A quiet-period collapse turns that into one reload
  // shortly after the burst settles, regardless of how many rows changed.
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const debouncedReload = useCallback(() => {
    clearTimeout(reloadTimerRef.current)
    reloadTimerRef.current = setTimeout(() => { loadAll({ force: true }) }, 1500)
  }, [loadAll])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('monthend-counts-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'counts', filter: `company_id=eq.${companyId}` },
        () => { toast('Counts updated', { icon: '📊' }); debouncedReload() })
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'count_products', filter: `company_id=eq.${companyId}` },
        () => { debouncedReload() })
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'count_batches', filter: `company_id=eq.${companyId}` },
        () => { toast('Batches updated', { icon: '📦' }); debouncedReload() })
      .subscribe()
    return () => { clearTimeout(reloadTimerRef.current); void supabase.removeChannel(channel) }
  }, [companyId, debouncedReload])

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


  if (!companyId) {
    return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>
  }

  const periodLabel = format(parseISO(countMonth), 'MMMM yyyy')

  async function clearSummaryCounts() {
    const { error } = await (supabase as any)
      .schema('inventory').from('counts')
      .delete()
      .eq('company_id', companyId)
      .eq('count_month', countMonth)
    if (error) toast.error(error.message)
    else { toast.success('Count summaries cleared'); loadAll({ force: true }) }
  }

  async function clearProductCounts() {
    const sb = supabase as any
    // Delete product rows for this period directly
    const { error: e1 } = await sb
      .schema('inventory').from('count_products')
      .delete()
      .eq('company_id', companyId)
      .eq('count_month', countMonth)
    // Delete batch records for this period
    const { error: e2 } = await sb
      .schema('inventory').from('count_batches')
      .delete()
      .eq('company_id', companyId)
      .eq('module', 'monthly')
      .eq('count_month', countMonth)
    if (e1 || e2) toast.error('Failed to clear product counts')
    else { toast.success('Product batches cleared'); loadAll({ force: true }) }
  }

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
          onImported={() => loadAll({ force: true })}
          onClear={clearSummaryCounts}
        />
        <ProductDetailUpload
          locations={locations}
          companyId={companyId}
          countMonth={countMonth}
          uploadedBy={profile?.id ?? null}
          batches={batches}
          userNames={userNames}
          onChanged={() => loadAll({ force: true })}
          onClear={clearProductCounts}
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
