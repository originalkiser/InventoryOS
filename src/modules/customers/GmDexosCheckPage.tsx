// GM Warranty & Dexos Oil Check — route /gm-dexos-check (Droptop sidebar section).
//
// Business goal: GM vehicles still in warranty (under the age limit AND under the mileage limit — both must
// hold) should be serviced with a GM Dexos-approved oil. For every shop and month from August 2026 this counts
// DISTINCT vehicles serviced in each bucket (see gmDexos.ts BUCKETS) and the compliance % =
// GM-in-warranty vehicles on Dexos / all GM-in-warranty vehicles serviced.
//
// Data: inventory.get_gm_dexos_summary (server-side aggregate, migration 20261010z_gm_dexos_check.sql). One call
// over the whole company for a month takes ~20-30s (it has to look inside ~200k orders' services), which is
// uncomfortably close to the 30s API limit, so the page calls it month by month AND in shop chunks, sequentially,
// with a progress bar; chunks already fetched (same range/shops/settings) are cached for the session. Order-level
// detail (inventory.get_gm_dexos_detail) is loaded only when a row/count is clicked, paginated 50 at a time.
//
// The warranty limits, approved oil ids and GM makes are company-wide settings (platform.app_settings key
// 'gm_dexos_settings' via useAppSetting) edited in the collapsible Settings card.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useLocations } from '@/hooks/useLocations'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { DataTable } from '@/components/shared/DataTable'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { Button, Card, CardBody, CardHeader, Modal, MultiSelectDropdown, SbLoader } from '@/components/ui'
import {
  BUCKETS, DEFAULT_SETTINGS, REPORT_START, bucketLabel, chunkArray, compliancePct, monthChunks, monthLabel,
  normalizeSettings, parseSummaryRow, settingsKey, totalsOf, type Bucket, type GmDexosSettings, type MonthChunk, type SummaryRow,
} from './gmDexos'

const SHOP_CHUNK = 140
const DETAIL_PAGE = 50
const sb = supabase as any

// Session cache of finished summary calls, keyed by (month range, shop chunk, settings).
const summaryCache = new Map<string, SummaryRow[]>()

const fmtInt = (n: number) => n.toLocaleString()
const fmtPct = (n: number | null) => (n == null ? '—' : `${n.toFixed(1)}%`)
/** Good/bad coloring for a compliance %. Thresholds are display-only. */
function complianceClass(p: number | null): string {
  if (p == null) return 'text-inky/50'
  if (p >= 80) return 'text-sb-green font-bold'
  if (p >= 50) return 'text-sb-orange font-bold'
  return 'text-sb-red font-bold'
}

interface DetailRow {
  total_count: number
  order_id: string
  order_date: string
  vin: string | null
  vehicle_year: number | null
  vehicle_make: string | null
  vehicle_model: string | null
  mileage: number | string | null
  packages: string | null
  oil_product_ids: string | null
  uses_dexos: boolean
  bucket: Bucket
}

interface TableRow extends SummaryRow {
  id: string
  shopLabel: string
  monthLabel: string
  compliance: number | null
}

export function GmDexosCheckPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations('other')

  // Period: defaults to a custom range starting Aug 2026 (the report's first month) through today.
  const periodKey = 'gm-dexos:period'
  const hadStoredPeriod = useRef<boolean>((() => { try { return !!localStorage.getItem(periodKey) } catch { return false } })())
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod(periodKey, 'last_month')
  // The summary load waits for this so a first visit doesn't fire a throwaway query for the hook's default period.
  const [periodReady, setPeriodReady] = useState(hadStoredPeriod.current)
  useEffect(() => {
    if (hadStoredPeriod.current) return
    hadStoredPeriod.current = true
    setCustomStart(REPORT_START)
    setCustomEnd(new Date().toISOString().slice(0, 10))
    setPeriod('custom')
    setPeriodReady(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Settings (company-wide).
  const [storedSettings, saveSettings] = useAppSetting<GmDexosSettings>('gm_dexos_settings', DEFAULT_SETTINGS)
  const settings = useMemo(() => normalizeSettings(storedSettings), [storedSettings])
  const sKey = settingsKey(settings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState<GmDexosSettings>(settings)
  const [newOil, setNewOil] = useState('')
  const [newMake, setNewMake] = useState('')
  useEffect(() => { setDraft(settings) }, [settings])
  const draftDirty = settingsKey(draft) !== sKey

  // Filters (same Region/Market/AM/Shop shape as the other Droptop reports).
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [shopLabels, setShopLabels] = useState<string[]>([])
  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])
  const regionOptions = useMemo(
    () => [...new Set(loc.locations.map((l) => l.region ?? '').filter(Boolean))].sort().map((v) => ({ value: v })),
    [loc.locations],
  )
  const marketOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions])
  const amOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    if (filterMarkets.length) r = r.filter((l) => filterMarkets.includes(loc.fieldValue(l.id, 'market')))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'area_manager')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets])
  // Shops to query: the filtered set, or every active shop when nothing is filtered.
  const queryLocationIds = useMemo(() => {
    const anyFilter = filterRegions.length || filterMarkets.length || filterAMs.length || shopIds.length
    const ids: string[] = []
    for (const o of loc.includedOptions) {
      const l = loc.byId(o.value)
      if (!l) continue
      if (anyFilter) {
        if (filterRegions.length && !filterRegions.includes(l.region ?? '')) continue
        if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) continue
        if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) continue
        if (shopIds.length && !shopIds.includes(l.id)) continue
      }
      ids.push(l.id)
    }
    return ids.sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.includedOptions, loc.byId, filterRegions, filterMarkets, filterAMs, shopIds])
  const locIdsKey = queryLocationIds.join(',')

  // ── Summary load (month by month × shop chunks, sequential, progressive) ─────────────────────────
  const [rows, setRows] = useState<SummaryRow[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' })
  const [errors, setErrors] = useState<string[]>([])
  const [reloadToken, setReloadToken] = useState(0)
  const runId = useRef(0)

  useEffect(() => {
    if (!companyId || loc.loading || !periodReady) return
    const chunks: MonthChunk[] = monthChunks(range.start < REPORT_START ? REPORT_START : range.start, range.end)
    const idChunks = chunkArray(queryLocationIds, SHOP_CHUNK)
    const myRun = ++runId.current
    setErrors([])
    if (!chunks.length || !idChunks.length) { setRows([]); setLoading(false); return }
    const calls = chunks.flatMap((m) => idChunks.map((ids, i) => ({ m, ids, i })))
    setRows([])
    setLoading(true)
    setProgress({ done: 0, total: calls.length, label: '' })
    ;(async () => {
      const acc: SummaryRow[] = []
      const errs: string[] = []
      for (let n = 0; n < calls.length; n++) {
        const { m, ids, i } = calls[n]
        if (runId.current !== myRun) return
        const label = `${monthLabel(m.month)}${idChunks.length > 1 ? ` (shops ${i * SHOP_CHUNK + 1}-${i * SHOP_CHUNK + ids.length})` : ''}`
        setProgress({ done: n, total: calls.length, label })
        const key = `${m.start}|${m.end}|${ids.join(',')}|${sKey}`
        let got = summaryCache.get(key)
        if (!got) {
          const { data, error } = await sb.schema('inventory').rpc('get_gm_dexos_summary', {
            p_start: m.start, p_end: m.end, p_location_ids: ids,
            p_max_age_years: settings.maxAgeYears, p_max_miles: settings.maxMiles,
            p_approved_ids: settings.approvedIds, p_gm_makes: settings.gmMakes,
          })
          if (runId.current !== myRun) return
          if (error) { errs.push(`${label}: ${error.message}`); continue }
          got = ((data ?? []) as Record<string, unknown>[]).map(parseSummaryRow)
          summaryCache.set(key, got)
        }
        acc.push(...got)
        setRows([...acc])
      }
      if (runId.current !== myRun) return
      setErrors(errs)
      setProgress({ done: calls.length, total: calls.length, label: '' })
      setLoading(false)
    })()
    return () => { runId.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, loc.loading, periodReady, range.start, range.end, locIdsKey, sKey, reloadToken])

  const tableRows = useMemo<TableRow[]>(() => rows.map((r) => ({
    ...r,
    id: `${r.location_id}|${r.month}`,
    shopLabel: loc.labelOf(r.location_id),
    monthLabel: monthLabel(r.month),
    compliance: compliancePct(r.gm_warranty_dexos, r.gm_warranty_miss),
  })).sort((a, b) => (a.month === b.month ? a.shopLabel.localeCompare(b.shopLabel, undefined, { numeric: true }) : a.month.localeCompare(b.month))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, loc.labelOf])
  const totals = useMemo(() => totalsOf(rows), [rows])

  // ── Detail modal ─────────────────────────────────────────────────────────────────────────────
  const [detail, setDetail] = useState<{ row: TableRow; bucket: Bucket | null } | null>(null)
  const [detailRows, setDetailRows] = useState<DetailRow[] | null>(null)
  const [detailTotal, setDetailTotal] = useState(0)
  const [detailPage, setDetailPage] = useState(0)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailBucket = detail?.bucket ?? null

  const loadDetail = useCallback(async (row: TableRow, bucket: Bucket | null, page: number) => {
    setDetailLoading(true)
    setDetailError(null)
    const mStart = row.month < range.start ? range.start : row.month
    const last = new Date(Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 0)).toISOString().slice(0, 10)
    const mEnd = last > range.end ? range.end : last
    const { data, error } = await sb.schema('inventory').rpc('get_gm_dexos_detail', {
      p_start: mStart, p_end: mEnd, p_location_id: row.location_id, p_bucket: bucket,
      p_max_age_years: settings.maxAgeYears, p_max_miles: settings.maxMiles,
      p_approved_ids: settings.approvedIds, p_gm_makes: settings.gmMakes,
      p_limit: DETAIL_PAGE, p_offset: page * DETAIL_PAGE,
    })
    if (error) { setDetailError(error.message); setDetailRows([]); setDetailLoading(false); return }
    const list = (data ?? []) as DetailRow[]
    setDetailRows(list)
    setDetailTotal(list.length ? Number(list[0].total_count) : 0)
    setDetailLoading(false)
  }, [range.start, range.end, settings.maxAgeYears, settings.maxMiles, settings.approvedIds, settings.gmMakes])

  const openDetail = useCallback((row: TableRow, bucket: Bucket | null) => {
    setDetail({ row, bucket })
    setDetailPage(0)
    setDetailRows(null)
    loadDetail(row, bucket, 0)
  }, [loadDetail])

  const goPage = (p: number) => {
    if (!detail) return
    setDetailPage(p)
    loadDetail(detail.row, detail.bucket, p)
  }
  const changeBucket = (b: Bucket | null) => {
    if (!detail) return
    setDetail({ row: detail.row, bucket: b })
    setDetailPage(0)
    loadDetail(detail.row, b, 0)
  }

  // ── Table ─────────────────────────────────────────────────────────────────────────────────────
  const col = useMemo(() => createColumnHelper<TableRow>(), [])
  const countCell = (r: TableRow, key: keyof SummaryRow, bucket: Bucket, cls = 'text-navy') => {
    const v = r[key] as number
    return v > 0
      ? <button type="button" className={`tabular-nums underline decoration-dotted underline-offset-2 hover:text-sky ${cls}`} title="Load the orders behind this count" onClick={() => openDetail(r, bucket)}>{fmtInt(v)}</button>
      : <span className="tabular-nums text-inky/40">0</span>
  }
  const columns = useMemo(() => [
    col.accessor('shopLabel', { header: 'Shop', cell: (i) => <span className="text-navy font-bold">{i.getValue()}</span> }),
    col.accessor('month', { header: 'Month', cell: (i) => i.row.original.monthLabel }),
    col.accessor('total_vehicles', { header: 'Vehicles', cell: (i) => <span className="tabular-nums">{fmtInt(i.getValue())}</span> }),
    col.accessor('gm_warranty_dexos', { header: 'GM Warranty - Dexos', cell: (i) => countCell(i.row.original, 'gm_warranty_dexos', 'gm_warranty_dexos', 'text-sb-green font-bold') }),
    col.accessor('gm_warranty_miss', { header: 'GM Warranty - NOT Dexos', cell: (i) => countCell(i.row.original, 'gm_warranty_miss', 'gm_warranty_miss', 'text-sb-red font-bold') }),
    col.accessor('compliance', {
      header: 'Compliance %',
      cell: (i) => <span className={`tabular-nums ${complianceClass(i.getValue())}`}>{fmtPct(i.getValue())}</span>,
      sortUndefined: 'last',
    }),
    col.accessor('gm_out_of_warranty', { header: 'GM Out of Warranty', cell: (i) => countCell(i.row.original, 'gm_out_of_warranty', 'gm_out_of_warranty') }),
    col.accessor('gm_unknown', { header: 'GM Unknown', cell: (i) => countCell(i.row.original, 'gm_unknown', 'gm_unknown', 'text-inky') }),
    col.accessor('nongm_dexos', { header: 'Non-GM - Dexos', cell: (i) => countCell(i.row.original, 'nongm_dexos', 'nongm_dexos') }),
    col.accessor('nongm_no_dexos', { header: 'Non-GM - Not Dexos', cell: (i) => countCell(i.row.original, 'nongm_no_dexos', 'nongm_no_dexos', 'text-inky') }),
    col.display({
      id: 'detail', header: '',
      cell: (i) => <Button size="sm" variant="secondary" onClick={() => openDetail(i.row.original, null)}>Detail</Button>,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col, openDetail])
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(tableRows, columns, { persistKey: 'gm-dexos-check' })
  useColumnPrefs('gm-dexos-check', table, columnVisibility, columnOrder, setColumnOrder)

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  const FilterLabel = ({ children }: { children: ReactNode }) => (
    <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{children}</span>
  )

  const tile = (label: string, value: string, sub: string, cls = 'text-navy') => (
    <Card className="px-4 py-3 min-w-[9rem] flex-1">
      <div className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-heading tabular-nums ${cls}`}>{value}</div>
      <div className="text-[10px] font-mono text-inky/60">{sub}</div>
    </Card>
  )

  const detailRowsCount = detailRows?.length ?? 0
  const lastPage = Math.max(0, Math.ceil(detailTotal / DETAIL_PAGE) - 1)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-heading text-navy uppercase tracking-wide">GM Warranty &amp; Dexos Oil Check</h1>
        <p className="text-xs text-inky mt-0.5 max-w-3xl">
          GM vehicles still in warranty (younger than {settings.maxAgeYears} yr AND under {fmtInt(settings.maxMiles)} miles) should get an
          approved Dexos oil. Counts are distinct vehicles per shop and month; a vehicle counts as Dexos when any product on its
          order(s) that month is an approved oil (case-type variants included). Click a count or Detail to load the orders behind it.
        </p>
      </div>

      <div className="flex items-end gap-2 flex-wrap">
        <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} customEnd={customEnd}
          onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} earliestDate={REPORT_START} />
        <div className="flex flex-col gap-0.5"><FilterLabel>Region</FilterLabel>
          <MultiSelectDropdown options={regionOptions} selected={filterRegions} onChange={setFilterRegions} placeholder="All Regions" countNoun="regions" searchable /></div>
        <div className="flex flex-col gap-0.5"><FilterLabel>Market</FilterLabel>
          <MultiSelectDropdown options={marketOptions} selected={filterMarkets} onChange={setFilterMarkets} placeholder="All Markets" countNoun="markets" searchable /></div>
        <div className="flex flex-col gap-0.5"><FilterLabel>Area Manager</FilterLabel>
          <MultiSelectDropdown options={amOptions} selected={filterAMs} onChange={setFilterAMs} placeholder="All AMs" countNoun="AMs" searchable /></div>
        <div className="flex flex-col gap-0.5"><FilterLabel>Shop(s)</FilterLabel>
          <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels} placeholder="All Shops" countNoun="shops" searchable /></div>
        <Button size="sm" variant="secondary" disabled={loading} onClick={() => {
          for (const k of [...summaryCache.keys()]) summaryCache.delete(k)
          setReloadToken((t) => t + 1)
        }}>Refresh</Button>
      </div>

      {/* Settings */}
      <Card>
        <CardHeader className="flex items-center justify-between cursor-pointer" >
          <button type="button" className="flex items-center gap-2 text-left w-full" onClick={() => setSettingsOpen((o) => !o)} aria-expanded={settingsOpen}>
            <span className="text-xs font-mono text-inky">{settingsOpen ? '▼' : '▶'}</span>
            <span className="text-sm font-heading text-navy uppercase tracking-wide">Settings</span>
            <span className="text-[10px] font-mono text-inky/60">
              warranty: &lt; {settings.maxAgeYears} yr and &lt; {fmtInt(settings.maxMiles)} mi · {settings.approvedIds.length} approved oils · {settings.gmMakes.length} GM makes
            </span>
          </button>
        </CardHeader>
        {settingsOpen && (
          <CardBody className="flex flex-col gap-4">
            <div className="flex gap-4 flex-wrap">
              <label className="flex flex-col gap-0.5 text-xs text-inky font-mono">
                Warranty age (years, less than)
                <input type="number" min={1} step={0.5} value={draft.maxAgeYears}
                  onChange={(e) => setDraft({ ...draft, maxAgeYears: Number(e.target.value) })}
                  className="bg-cream border border-navy/40 rounded px-2 py-1 text-sm text-navy w-40 focus:outline-none focus:ring-2 focus:ring-sky" />
              </label>
              <label className="flex flex-col gap-0.5 text-xs text-inky font-mono">
                Warranty mileage (less than)
                <input type="number" min={1000} step={1000} value={draft.maxMiles}
                  onChange={(e) => setDraft({ ...draft, maxMiles: Number(e.target.value) })}
                  className="bg-cream border border-navy/40 rounded px-2 py-1 text-sm text-navy w-40 focus:outline-none focus:ring-2 focus:ring-sky" />
              </label>
            </div>
            <ChipListEditor
              title="Approved Dexos oil product ids (base ids — case-type variants like D / BB / C are matched automatically)"
              items={draft.approvedIds} newValue={newOil} setNewValue={setNewOil} placeholder="e.g. DEXOS-SYN-5W30"
              onChange={(approvedIds) => setDraft({ ...draft, approvedIds })} />
            <ChipListEditor
              title="Makes treated as GM (matched case-insensitively against the vehicle's make)"
              items={draft.gmMakes} newValue={newMake} setNewValue={setNewMake} placeholder="e.g. Chevrolet"
              onChange={(gmMakes) => setDraft({ ...draft, gmMakes })} />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={!draftDirty} onClick={() => saveSettings(normalizeSettings(draft))}>Save settings</Button>
              <Button size="sm" variant="muted" disabled={settingsKey(draft) === settingsKey(DEFAULT_SETTINGS)} onClick={() => setDraft(DEFAULT_SETTINGS)}>Reset to defaults</Button>
              {draftDirty && <span className="text-[10px] font-mono text-sb-orange">Unsaved changes — saving reloads the report.</span>}
            </div>
          </CardBody>
        )}
      </Card>

      {errors.length > 0 && (
        <div className="text-xs font-mono text-sb-red border border-sb-red/30 bg-sb-red/5 rounded px-2 py-1.5 flex flex-col gap-1">
          <div>Some data failed to load ({errors.length}) — totals below are incomplete.</div>
          {errors.slice(0, 4).map((e, i) => <div key={i}>{e}</div>)}
          <div><Button size="sm" variant="secondary" onClick={() => setReloadToken((t) => t + 1)}>Retry</Button></div>
        </div>
      )}

      {/* KPI tiles */}
      <div className="flex gap-3 flex-wrap">
        {tile('Compliance', fmtPct(totals.compliance), 'GM in warranty on Dexos', complianceClass(totals.compliance))}
        {tile('GM in warranty', fmtInt(totals.gmWarrantyDexos + totals.gmWarrantyMiss), 'distinct vehicle-months serviced')}
        {tile('Compliance misses', fmtInt(totals.gmWarrantyMiss), 'GM in warranty, NOT Dexos', totals.gmWarrantyMiss ? 'text-sb-red' : 'text-navy')}
        {tile('GM out of warranty', fmtInt(totals.gmOutOfWarranty), 'by age or mileage')}
        {tile('Non-GM on Dexos', fmtInt(totals.nonGmDexos), `of ${fmtInt(totals.nonGmDexos + totals.nonGmNoDexos)} non-GM`)}
      </div>

      {loading && (
        <LoadingProgress
          fraction={progress.total ? progress.done / progress.total : null}
          countText={`Loading ${progress.label || '…'} — ${progress.done} of ${progress.total} steps${rows.length ? ` · ${fmtInt(rows.length)} shop-months so far` : ''}`}
          messages={['Counting vehicles by shop and month', 'Checking which oils went in GM warranty vehicles', 'Matching Dexos case types']}
        />
      )}

      {!loading && !errors.length && tableRows.length === 0 && (
        <p className="text-xs font-mono text-inky py-6 text-center">No orders with vehicle data found for this range and shop selection.</p>
      )}

      {tableRows.length > 0 && (
        <DataTable
          table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
          exportFilename="gm-warranty-dexos-check"
          loading={false}
        />
      )}

      <Modal
        open={!!detail}
        onClose={() => { setDetail(null); setDetailRows(null) }}
        size="wide"
        title={detail ? `${detail.row.shopLabel} — ${detail.row.monthLabel}` : ''}
      >
        {detail && (
          <div className="flex flex-col gap-3">
            <div className="flex items-end gap-3 flex-wrap">
              <label className="flex flex-col gap-0.5 text-[10px] font-mono text-inky/70 uppercase tracking-wide">
                Bucket
                <select value={detailBucket ?? ''} onChange={(e) => changeBucket((e.target.value || null) as Bucket | null)}
                  className="bg-cream border border-navy/40 rounded px-2 py-1 text-xs text-navy normal-case focus:outline-none focus:ring-2 focus:ring-sky">
                  <option value="">All orders</option>
                  {BUCKETS.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
                </select>
              </label>
              <span className="text-xs font-mono text-inky">
                {detailLoading ? 'Loading…' : `${fmtInt(detailTotal)} order${detailTotal === 1 ? '' : 's'}`}
                {detailTotal > DETAIL_PAGE && !detailLoading && ` · page ${detailPage + 1} of ${lastPage + 1}`}
              </span>
              <div className="flex gap-1 ml-auto">
                <Button size="sm" variant="secondary" disabled={detailLoading || detailPage === 0} onClick={() => goPage(detailPage - 1)}>Prev</Button>
                <Button size="sm" variant="secondary" disabled={detailLoading || detailPage >= lastPage} onClick={() => goPage(detailPage + 1)}>Next</Button>
              </div>
            </div>
            <p className="text-[10px] font-mono text-inky/60">
              Order-level view: a vehicle serviced twice in the month appears once per order, so these counts can exceed the distinct-vehicle counts in the table.
            </p>
            {detailError && <p className="text-xs font-mono text-sb-red">{detailError}</p>}
            {detailLoading && detailRows === null ? <div className="py-8"><SbLoader /></div> : (
              <div className="overflow-auto max-h-[60vh] border border-navy/20 rounded">
                <table className="w-full text-xs font-body">
                  <thead className="bg-navy text-cream sticky top-0">
                    <tr>
                      {['Order #', 'Date', 'Vehicle', 'Mileage', 'Packages', 'Oil product ids', 'Dexos?', 'Bucket'].map((h) => (
                        <th key={h} className="text-left px-2 py-1.5 font-heading uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className={detailLoading ? 'opacity-50' : ''}>
                    {(detailRows ?? []).map((r) => (
                      <tr key={r.order_id} className="border-t border-navy/10 odd:bg-band">
                        <td className="px-2 py-1 whitespace-nowrap text-navy font-bold">{r.order_id}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{r.order_date}</td>
                        <td className="px-2 py-1 whitespace-nowrap">{[r.vehicle_year, r.vehicle_make, r.vehicle_model].filter(Boolean).join(' ') || '—'}</td>
                        <td className="px-2 py-1 whitespace-nowrap tabular-nums">{r.mileage != null ? Number(r.mileage).toLocaleString() : '—'}</td>
                        <td className="px-2 py-1">{r.packages ?? '—'}</td>
                        <td className="px-2 py-1">{r.oil_product_ids ?? '—'}</td>
                        <td className={`px-2 py-1 font-bold ${r.uses_dexos ? 'text-sb-green' : 'text-inky/60'}`}>{r.uses_dexos ? 'Yes' : 'No'}</td>
                        <td className={`px-2 py-1 whitespace-nowrap ${r.bucket === 'gm_warranty_miss' ? 'text-sb-red font-bold' : ''}`}>{bucketLabel(r.bucket)}</td>
                      </tr>
                    ))}
                    {!detailLoading && detailRowsCount === 0 && (
                      <tr><td colSpan={8} className="px-2 py-6 text-center text-inky">No orders in this bucket.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function ChipListEditor({ title, items, onChange, newValue, setNewValue, placeholder }: {
  title: string
  items: string[]
  onChange: (v: string[]) => void
  newValue: string
  setNewValue: (v: string) => void
  placeholder: string
}) {
  const add = () => {
    const v = newValue.trim()
    if (!v || items.some((x) => x.toLowerCase() === v.toLowerCase())) { setNewValue(''); return }
    onChange([...items, v])
    setNewValue('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-mono text-inky">{title}</span>
      <div className="flex flex-wrap gap-1.5">
        {items.map((x) => (
          <span key={x} className="inline-flex items-center gap-1 bg-sky/30 text-navy text-xs font-mono rounded px-2 py-0.5">
            {x}
            <button type="button" className="text-inky hover:text-sb-red" aria-label={`Remove ${x}`} onClick={() => onChange(items.filter((i) => i !== x))}>×</button>
          </span>
        ))}
        {items.length === 0 && <span className="text-[10px] font-mono text-sb-orange">None — nothing will count as Dexos / GM.</span>}
      </div>
      <div className="flex gap-1.5">
        <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={placeholder}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          className="bg-cream border border-navy/40 rounded px-2 py-1 text-xs text-navy w-64 focus:outline-none focus:ring-2 focus:ring-sky" />
        <Button size="sm" variant="secondary" onClick={add}>Add</Button>
      </div>
    </div>
  )
}
