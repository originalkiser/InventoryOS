import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Badge, Button, Card, CardBody, Combobox, Modal, SbLoader } from '@/components/ui'
import { IssueFormModal } from '@/modules/issues/IssueFormModal'
import { ExceptionReportModal } from '@/modules/exceptions/ExceptionReportModal'
import type { ExceptionReport } from '@/modules/exceptions/exceptions'
import { LocationCommsModal } from '@/modules/comms/LocationCommsModal'
import type { LocationComm } from '@/modules/comms/comms'
import { orderDayFromDelivery } from '@/lib/orderDay'
import type { Issue, Location } from '@/types'
import { format, differenceInCalendarDays, differenceInMonths } from 'date-fns'
import toast from 'react-hot-toast'

const LAST_SHOP_KEY = 'location-lookup:last-shop'
const VIEW_KEY = 'location-lookup:view'

interface TankRow {
  id: string; product_id: string | null; value: number | null; unit: string | null; serial_rtu_id: string | null
  on_hand: number | null; available_capacity: number | null; keep_fill: boolean | null; reading_date: string | null; inventory_time: string | null
}
interface ConfigRow {
  id: string; vendor_id: string | null; product_id: string | null
  capacity: number | null; order_trigger: number | null; order_limit: number | null
  metadata: Record<string, unknown> | null
}
interface IssueRow {
  id: string; title: string | null; status_id: string | null; issue_notes: string | null
  start_date: string | null; target_resolution_date: string | null; resolved_date: string | null
}

// Per-device view customization: ids hidden from each section.
interface ViewPrefs { sidebar: string[]; tank: string[]; config: string[] }

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const dateShort = (d: string | null | undefined) => { if (!d) return '—'; try { return format(new Date(d), 'MMM d, yyyy') } catch { return d } }
const dateTime = (d: string | null | undefined) => { if (!d) return '—'; try { return format(new Date(d), 'MMM d, yyyy · h:mm a') } catch { return d } }
const alignCls = (a: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')
const metaLabel = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// "2y 3m" / "8m" since a date — used for acquisition age.
function sinceLabel(dateStr: string): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  const months = differenceInMonths(new Date(), d)
  if (months < 0) return null
  const y = Math.floor(months / 12), m = months % 12
  if (y && m) return `${y}y ${m}m`
  return y ? `${y}y` : `${m}m`
}

// Normalize a tank unit string to a compact label. Tanks default to gallons.
const normUnit = (u: string | null | undefined): string | null => {
  if (!u) return null
  const s = u.trim().toLowerCase()
  if (s.startsWith('gal')) return 'Gal'
  if (s.startsWith('q')) return 'Qts'
  return null
}

// Relative callout for a weekday name vs today ("today" / "tomorrow" / "in 3 days" / "2 days ago").
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
function relativeDay(dayName: string): string | null {
  if (!dayName) return null
  const s = dayName.trim().toLowerCase()
  let target = WEEKDAYS.indexOf(s)
  if (target < 0) target = WEEKDAYS.findIndex((w) => w.startsWith(s.slice(0, 3)))
  if (target < 0) return null
  const today = new Date().getDay()
  const ahead = (target - today + 7) % 7 // days until next occurrence (0 = today)
  const ago = (today - target + 7) % 7 // days since last occurrence
  if (ahead === 0) return 'today'
  if (ahead === 1) return 'tomorrow'
  if (ago === 1) return 'yesterday'
  return ahead <= ago ? `in ${ahead} days` : `${ago} days ago`
}

// Read a location field: base column first, then metadata fallback.
function locVal(loc: Location | undefined, key: string): string {
  if (!loc) return ''
  const base = (loc as any)[key]
  if (base != null && base !== '') return String(base)
  const meta = (loc.metadata as any)?.[key]
  return meta == null ? '' : String(meta)
}

interface Col<T> { id: string; label: string; align: 'left' | 'right' | 'center'; render: (r: T) => ReactNode; sort?: (r: T) => string | number | null }

type SortState = { id: string; dir: 'asc' | 'desc' } | null
function applySort<T>(rows: T[], cols: Col<T>[], sort: SortState): T[] {
  if (!sort) return rows
  const col = cols.find((c) => c.id === sort.id)
  if (!col?.sort) return rows
  const get = col.sort
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })
}
const nextSort = (cur: SortState, id: string): SortState => (cur?.id === id ? (cur.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'asc' })
const sortArrow = (sort: SortState, id: string) => (sort?.id === id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

const TANK_COLS: Col<TankRow>[] = [
  { id: 'product', label: 'Product', align: 'left', render: (t) => t.product_id ?? '—', sort: (t) => t.product_id },
  { id: 'serial', label: 'Serial #', align: 'left', render: (t) => t.serial_rtu_id ?? '—', sort: (t) => t.serial_rtu_id },
  { id: 'on_hand', label: 'On Hand', align: 'right', render: (t) => num(t.on_hand), sort: (t) => t.on_hand },
  { id: 'available', label: 'Available', align: 'right', render: (t) => num(t.available_capacity), sort: (t) => t.available_capacity },
  { id: 'keepfill', label: 'Keepfill', align: 'center', render: (t) => (t.keep_fill ? <Badge color="sky">yes</Badge> : <span className="text-inky/40">—</span>), sort: (t) => (t.keep_fill ? 1 : 0) },
  {
    id: 'updated', label: 'Last Update', align: 'left',
    sort: (t) => { const d = t.inventory_time ?? t.reading_date; return d ? new Date(d).getTime() : null },
    render: (t) => {
      const d = t.inventory_time ?? t.reading_date
      // A monitor that hasn't reported in > 2 days reads as offline.
      const stale = !!d && Date.now() - new Date(d).getTime() > 2 * 86400000
      return <span className={stale ? 'text-[#C0392B] font-bold' : ''} title={stale ? 'No reading in over 2 days — monitor may be offline' : undefined}>{dateTime(d)}{stale ? ' ⚠' : ''}</span>
    },
  },
]

const CONFIG_FIXED: Col<ConfigRow>[] = [
  { id: 'part', label: 'Part', align: 'left', render: (r) => r.product_id ?? '—', sort: (r) => r.product_id },
  { id: 'uom', label: 'UOM', align: 'left', render: (r) => String((r.metadata as any)?.uom ?? '—'), sort: (r) => String((r.metadata as any)?.uom ?? '') },
  { id: 'capacity', label: 'Capacity', align: 'right', render: (r) => num(r.capacity), sort: (r) => r.capacity },
  { id: 'max', label: 'Max', align: 'right', render: (r) => num(r.order_limit), sort: (r) => r.order_limit },
  { id: 'vmi', label: 'VMI', align: 'center', render: (r) => (String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? <Badge color="sky">VMI</Badge> : <span className="text-inky/40">—</span>), sort: (r) => (String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? 1 : 0) },
]
// Metadata keys that are plumbing, not config attributes — never shown as columns.
const CONFIG_META_EXCLUDE = new Set(['vmi', 'uom', 'vendor_id', 'location_id', 'vendor_name', 'location_label'])

export function LocationLookupPage() {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null

  const [shopId, setShopId] = useState<string>(() => { try { return localStorage.getItem(LAST_SHOP_KEY) ?? '' } catch { return '' } })
  const [supplemental, setSupplemental] = useState<Record<string, string> | null>(null)
  const [tanks, setTanks] = useState<TankRow[]>([])
  const [configs, setConfigs] = useState<ConfigRow[]>([])
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({})
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [statusNames, setStatusNames] = useState<Record<string, string>>({})
  const [exceptions, setExceptions] = useState<ExceptionReport[]>([])
  const [excModalOpen, setExcModalOpen] = useState(false)
  const [editingExc, setEditingExc] = useState<Partial<ExceptionReport> | null>(null)
  const [comms, setComms] = useState<LocationComm[]>([])
  const [commModalOpen, setCommModalOpen] = useState(false)
  const [editingComm, setEditingComm] = useState<Partial<LocationComm> | null>(null)
  const [tankSort, setTankSort] = useState<SortState>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // Issues modal: list toggle (pending/resolved) + inline editor.
  // editIssue: undefined = editor closed, null = new issue, object = edit existing.
  const [issuesModalOpen, setIssuesModalOpen] = useState(false)
  const [modalView, setModalView] = useState<'pending' | 'resolved'>('pending')
  const [editIssue, setEditIssue] = useState<Partial<Issue> | null | undefined>(undefined)
  const [prefs, setPrefs] = useState<ViewPrefs>(() => {
    try { const p = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}'); return { sidebar: p.sidebar ?? [], tank: p.tank ?? [], config: p.config ?? [] } }
    catch { return { sidebar: [], tank: [], config: [] } }
  })
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(prefs)) } catch { /* ignore */ } }, [prefs])
  const toggleHidden = (group: keyof ViewPrefs, id: string) =>
    setPrefs((p) => ({ ...p, [group]: p[group].includes(id) ? p[group].filter((x) => x !== id) : [...p[group], id] }))

  const location = loc.byId(shopId)

  const load = useCallback(async () => {
    if (!companyId || !shopId) return
    setLoading(true); setError(null)
    const sb = supabase as any
    try {
      const [tankRes, cfgRes, vendRes, issRes, statRes, supRes, excRes, commRes] = await Promise.all([
        sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).eq('location_id', shopId).order('product_id'),
        sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('location_id', shopId),
        sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
        sb.schema('platform').from('issues').select('*').eq('company_id', companyId).eq('location_id', shopId).is('deleted_at', null).order('created_at', { ascending: false }),
        sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
        sb.schema('core').from('location_supplemental').select('data').eq('company_id', companyId).eq('location_id', shopId).maybeSingle().then((r: any) => r).catch(() => ({ data: null })),
        sb.schema('inventory').from('exception_reports').select('*').eq('company_id', companyId).eq('location_id', shopId).order('date_of_finding', { ascending: false, nullsFirst: false }).then((r: any) => r).catch(() => ({ data: [] })),
        sb.schema('inventory').from('location_comms').select('*').eq('company_id', companyId).eq('location_id', shopId).order('comm_date', { ascending: false, nullsFirst: false }).then((r: any) => r).catch(() => ({ data: [] })),
      ])
      setTanks((tankRes.data ?? []) as TankRow[])
      setConfigs((cfgRes.data ?? []) as ConfigRow[])
      setVendorNames(Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, v.name])))
      setIssues((issRes.data ?? []) as IssueRow[])
      setStatusNames(Object.fromEntries(((statRes.data ?? []) as any[]).map((s) => [s.id, s.name])))
      setSupplemental((supRes?.data?.data ?? null) as Record<string, string> | null)
      setExceptions((excRes?.data ?? []) as ExceptionReport[])
      setComms((commRes?.data ?? []) as LocationComm[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load location detail')
    } finally {
      setLoading(false)
    }
  }, [companyId, shopId])

  useEffect(() => { load() }, [load])
  useEffect(() => { try { if (shopId) localStorage.setItem(LAST_SHOP_KEY, shopId) } catch { /* ignore */ } }, [shopId])

  const configsByVendor = useMemo(() => {
    const groups = new Map<string, ConfigRow[]>()
    for (const c of configs) {
      const name = c.vendor_id ? (vendorNames[c.vendor_id] ?? 'Unassigned Vendor') : 'Unassigned Vendor'
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name)!.push(c)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [configs, vendorNames])

  // All config columns (fixed + discovered metadata) for the customize panel.
  const allConfigMetaKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of configs) for (const k of Object.keys(c.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) s.add(k)
    return [...s].sort()
  }, [configs])

  const isPending = (s: string) => { const n = s.toLowerCase(); return n.includes('pending') || n.includes('open') }
  const isResolved = (s: string) => { const n = s.toLowerCase(); return n.includes('resolved') || n.includes('closed') || n.includes('complete') }
  const pendingIssues = issues.filter((i) => isPending(statusNames[i.status_id ?? ''] ?? ''))
  const resolvedIssues = issues.filter((i) => isResolved(statusNames[i.status_id ?? ''] ?? ''))

  // Keepfill tanks first, then non-keepfill — each alpha-sorted by product.
  const sortedTanks = useMemo(() => {
    const byProduct = (a: TankRow, b: TankRow) =>
      (a.product_id ?? '').localeCompare(b.product_id ?? '', undefined, { sensitivity: 'base' })
    return [...tanks.filter((t) => t.keep_fill).sort(byProduct), ...tanks.filter((t) => !t.keep_fill).sort(byProduct)]
  }, [tanks])

  // Unit shown on the On Hand header: use a shared row unit if present, else default to gallons.
  const tankUnit = useMemo(() => {
    const units = new Set(tanks.map((t) => normUnit(t.unit)).filter(Boolean) as string[])
    return units.size === 1 ? [...units][0] : units.size === 0 ? 'Gal' : null
  }, [tanks])

  // Shop display + options use shop_city only ("234-Stockbridge") — no "### —" prefix.
  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'
  const shopOptions = useMemo(
    () => loc.locations.filter((l) => l.active).map((l) => ({ value: l.id, label: l.shop_city || l.name }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [loc.locations],
  )

  function openIssues(view: 'pending' | 'resolved') { setModalView(view); setEditIssue(undefined); setIssuesModalOpen(true) }
  async function deleteIssue(id: string) {
    const { error: delErr } = await (supabase as any).schema('platform').from('issues')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (delErr) { toast.error('Failed to delete issue'); return }
    toast.success('Issue deleted'); load()
  }

  // Exceptions write the same inventory.exception_reports the Exception Reporting page reads.
  async function saveException(fields: Partial<ExceptionReport>, id?: string) {
    const sb = supabase as any
    const base = { ...fields, company_id: companyId, updated_by: profile?.id ?? null, last_change_source: 'manual', updated_at: new Date().toISOString() }
    const { error: sErr } = id
      ? await sb.schema('inventory').from('exception_reports').update(base).eq('id', id)
      : await sb.schema('inventory').from('exception_reports').insert(base)
    if (sErr) { toast.error(sErr.message); return }
    toast.success(id ? 'Exception updated' : 'Exception logged'); load()
  }
  async function deleteException(id: string) {
    const { error: delErr } = await (supabase as any).schema('inventory').from('exception_reports').delete().eq('id', id)
    if (delErr) { toast.error('Failed to delete exception'); return }
    toast.success('Exception deleted'); load()
  }
  function openAddException() { setEditingExc({ location_id: shopId }); setExcModalOpen(true) }
  function openEditException(e: ExceptionReport) { setEditingExc(e); setExcModalOpen(true) }
  function openAddComm() { setEditingComm({ location_id: shopId }); setCommModalOpen(true) }
  function openEditComm(c: LocationComm) { setEditingComm(c); setCommModalOpen(true) }
  async function deleteComm(id: string) {
    const { error: delErr } = await (supabase as any).schema('inventory').from('location_comms').delete().eq('id', id)
    if (delErr) { toast.error('Failed to delete communication'); return }
    toast.success('Communication deleted'); load()
  }

  const rdDistributor = useMemo(() => {
    if (supplemental) {
      const k = Object.keys(supplemental).find((key) => key.includes('distributor'))
      if (k && supplemental[k]) return String(supplemental[k])
    }
    return locVal(location, 'rd_distributor')
  }, [supplemental, location])

  const stateVal = locVal(location, 'state')
  const inNC = ['nc', 'north carolina'].includes(stateVal.trim().toLowerCase())
  const rdOrderDay = location ? orderDayFromDelivery(location.reladyne_delivery_day) : ''
  const rdDeliveryDay = locVal(location, 'reladyne_delivery_day')
  const sidebar: { label: string; value: string; note?: string }[] = location ? [
    { label: 'Location', value: locVal(location, 'shop_city') || shopLabel(shopId) },
    { label: 'Area Manager', value: locVal(location, 'area_manager') },
    { label: 'AM Cell', value: locVal(location, 'am_phone') },
    { label: 'RDO', value: locVal(location, 'director') },
    { label: 'RD Order Day', value: rdOrderDay, note: relativeDay(rdOrderDay) ?? undefined },
    { label: 'RD Delivery Day', value: rdDeliveryDay, note: relativeDay(rdDeliveryDay) ?? undefined },
    { label: 'RD Distributor', value: rdDistributor },
    { label: 'Address', value: [locVal(location, 'address'), locVal(location, 'city'), locVal(location, 'state'), locVal(location, 'zip')].filter(Boolean).join(', ') },
    { label: 'Shop Phone', value: locVal(location, 'store_phone') },
    { label: 'Acquisition Date', value: locVal(location, 'acquisition_date'), note: sinceLabel(locVal(location, 'acquisition_date')) ?? undefined },
    ...(inNC ? [{ label: 'NC Inspection Station', value: locVal(location, 'inspection_station_id') }] : []),
  ] : []

  const visibleSidebar = sidebar.filter((f) => !prefs.sidebar.includes(f.label))
  const visibleTankCols = TANK_COLS.filter((c) => !prefs.tank.includes(c.id))

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="sticky top-0 z-30 bg-cream pt-1 pb-2 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Inventory Location Lookup</h1>
          {shopId
            ? <p className="text-sm font-heading font-bold text-navy mt-0.5">{shopLabel(shopId)}</p>
            : <p className="text-xs text-inky mt-0.5">Pick a shop to see its tanks, order configuration, and issues.</p>}
        </div>
        {!shopId && (
          <div className="w-80"><Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Search a shop…" /></div>
        )}
      </div>

      {shopId && customizeOpen && (
        <Card>
          <CardBody className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CheckGroup title="Left panel fields" items={sidebar.map((f) => ({ id: f.label, label: f.label }))} hidden={prefs.sidebar} onToggle={(id) => toggleHidden('sidebar', id)} />
            <CheckGroup title="Tank monitor columns" items={TANK_COLS.map((c) => ({ id: c.id, label: c.label }))} hidden={prefs.tank} onToggle={(id) => toggleHidden('tank', id)} />
            <CheckGroup title="Order config columns" items={[...CONFIG_FIXED.map((c) => ({ id: c.id, label: c.label })), ...allConfigMetaKeys.map((k) => ({ id: `meta:${k}`, label: metaLabel(k) }))]} hidden={prefs.config} onToggle={(id) => toggleHidden('config', id)} />
          </CardBody>
        </Card>
      )}

      {!shopId ? (
        <p className="text-xs font-mono text-inky/60 py-8">Select a shop above to begin.</p>
      ) : loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
      ) : error ? (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
          {/* Left info — frozen while the tables/issues scroll */}
          <div className="lg:sticky lg:top-[4.5rem] self-start flex flex-col gap-3">
            <Card>
              <CardBody className="flex flex-col gap-2">
                <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Change shop…" />
                <dl className="flex flex-col gap-1.5 mt-1">
                  {visibleSidebar.map((f) => (
                    <div key={f.label} className="flex flex-col rounded-lg border border-navy/15 bg-navy/[0.03] px-2.5 py-1.5">
                      <dt className="text-[10px] font-mono font-semibold uppercase tracking-wide text-navy/70">{f.label}</dt>
                      <dd className="text-xs font-body text-navy break-words">
                        {f.value || '—'}
                        {f.note && <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-sky/40 text-navy">{f.note}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <button onClick={() => navigate('/global-config?tab=locations')} title="Open Locations config"
                  className="mt-1 self-start text-[11px] font-mono text-inky hover:text-sky transition-colors text-left inline-flex items-center gap-1">
                  Open Locations Config <span className="text-[10px]">↗</span>
                </button>
              </CardBody>
            </Card>
          </div>

          {/* Main */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col xl:flex-row gap-4 items-start">
              <Card className="w-fit max-w-full">
              <CardBody className="flex flex-col gap-2">
                <button onClick={() => navigate('/config?tab=tank-monitor')} title="Open Tank Monitor config"
                  className="text-xs font-mono text-navy uppercase tracking-wide hover:text-sky transition-colors text-left inline-flex items-center gap-1 self-start">
                  Tank Monitors ({tanks.length}) <span className="text-[10px] text-inky/50">↗</span>
                </button>
                {tanks.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">No tank monitor readings for this shop.</p>
                ) : visibleTankCols.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">All tank columns hidden — enable some under Customize.</p>
                ) : (
                  <div className="w-fit max-w-full self-start overflow-x-auto rounded border border-navy/30">
                    <table className="text-xs font-mono">
                      <thead>
                        <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                          {visibleTankCols.map((c) => (
                            <th key={c.id} className={`px-3 py-2 ${alignCls(c.align)}`}>
                              <button onClick={() => setTankSort((s) => nextSort(s, c.id))} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-center">
                                {(c.id === 'on_hand' || c.id === 'available') && tankUnit ? `${c.label} (${tankUnit})` : c.label}{sortArrow(tankSort, c.id)}
                              </button>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {(tankSort ? applySort(tanks, TANK_COLS, tankSort) : sortedTanks).map((t) => (
                          <tr key={t.id} className="border-b border-navy/20">
                            {visibleTankCols.map((c) => <td key={c.id} className={`px-3 py-1.5 text-navy ${alignCls(c.align)}`}>{c.render(t)}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
              </Card>
              <div className="flex flex-col gap-3 flex-1 min-w-[260px] w-full xl:w-auto">
                <IssuesColumn pending={pendingIssues} resolved={resolvedIssues} onManage={openIssues} />
                <ExceptionsBox exceptions={exceptions} onAdd={openAddException} onEdit={openEditException} />
                <CommsBox comms={comms} onAdd={openAddComm} onEdit={openEditComm} />
              </div>
            </div>

            {configsByVendor.length === 0 ? (
              <Card><CardBody><p className="text-xs font-mono text-inky/60">No order configuration for this shop.</p></CardBody></Card>
            ) : (
              <div className="flex flex-col gap-4">
                {configsByVendor.map(([vendor, rows]) => (
                  <OrderConfigBlock key={vendor} vendor={vendor} rows={rows} hidden={prefs.config} onOpenConfig={() => navigate('/config?tab=order-config')} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {shopId && (
        <button onClick={() => setCustomizeOpen((o) => !o)}
          className="fixed bottom-6 right-6 z-30 rounded-full bg-navy text-cream px-5 py-2.5 text-xs font-mono uppercase tracking-wide shadow-lg hover:bg-navy/90 transition-colors">
          {customizeOpen ? 'Done' : 'Customize'}
        </button>
      )}

      {/* Issues list — toggle pending/resolved, edit inline without leaving the page. */}
      <Modal open={issuesModalOpen && editIssue === undefined} onClose={() => setIssuesModalOpen(false)} title={`Issues — ${loc.labelOf(shopId)}`} size="lg">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="inline-flex rounded-lg border border-navy/20 overflow-hidden text-xs font-mono">
            {(['pending', 'resolved'] as const).map((v) => (
              <button key={v} onClick={() => setModalView(v)}
                className={['px-3 py-1.5 uppercase tracking-wide transition-colors', modalView === v ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                {v === 'pending' ? `Pending (${pendingIssues.length})` : `Resolved (${resolvedIssues.length})`}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => setEditIssue({ location_id: shopId } as Partial<Issue>)}>+ New Issue</Button>
        </div>
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-auto">
          {(modalView === 'pending' ? pendingIssues : resolvedIssues).map((i) => {
            const pastDue = modalView === 'pending' && !!i.target_resolution_date &&
              differenceInCalendarDays(new Date(), new Date(i.target_resolution_date + 'T00:00:00')) > 0
            return (
              <button key={i.id} onClick={() => setEditIssue(i as unknown as Partial<Issue>)}
                className="text-left rounded-lg border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-body text-navy flex-1 truncate">{i.title || 'Untitled issue'}</span>
                  <Badge color={modalView === 'pending' ? 'amber' : 'green'}>{statusNames[i.status_id ?? ''] ?? '—'}</Badge>
                  {pastDue && <Badge color="red">Past due</Badge>}
                </div>
                <div className="text-[10px] font-mono text-inky/60 flex flex-wrap gap-x-3 mt-1">
                  <span>Start {dateShort(i.start_date)}</span>
                  <span>Target {dateShort(i.target_resolution_date)}</span>
                  {modalView === 'resolved' && <span>Resolved {dateShort(i.resolved_date)}</span>}
                </div>
              </button>
            )
          })}
          {(modalView === 'pending' ? pendingIssues : resolvedIssues).length === 0 && (
            <p className="text-xs font-mono text-inky/50 py-6 text-center">No {modalView} issues for this shop.</p>
          )}
        </div>
      </Modal>

      {editIssue !== undefined && (
        <IssueFormModal
          open
          existing={editIssue}
          onClose={() => setEditIssue(undefined)}
          onSaved={() => { setEditIssue(undefined); load() }}
          onDelete={deleteIssue}
        />
      )}

      <ExceptionReportModal open={excModalOpen} onClose={() => setExcModalOpen(false)} existing={editingExc}
        onSubmit={saveException} onDelete={deleteException} />

      <LocationCommsModal open={commModalOpen} onClose={() => setCommModalOpen(false)} existing={editingComm}
        lockedLocationId={shopId} onSaved={load} onDelete={deleteComm} />
    </div>
  )
}

function IssuesColumn({ pending, resolved, onManage }: { pending: IssueRow[]; resolved: IssueRow[]; onManage: (v: 'pending' | 'resolved') => void }) {
  const top = pending[0]
  const start = top?.start_date ? new Date(top.start_date + 'T00:00:00') : null
  const daysOpen = start ? differenceInCalendarDays(new Date(), start) : null
  const pastDue = !!top?.target_resolution_date && differenceInCalendarDays(new Date(), new Date(top.target_resolution_date + 'T00:00:00')) > 0
  return (
    <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', pending.length ? 'border-[#E67E22]/50 bg-[#E67E22]/10' : 'border-navy/20 bg-cream'].join(' ')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Issues</span>
        <div className="flex items-center gap-3">
          <span className={['text-sm font-heading font-bold', pending.length ? 'text-[#E67E22]' : 'text-navy'].join(' ')}>{pending.length} <span className="text-[10px] font-mono font-normal text-inky/60">open</span></span>
          <span className="text-sm font-heading font-bold text-[#2ECC71]">{resolved.length} <span className="text-[10px] font-mono font-normal text-inky/60">resolved</span></span>
        </div>
      </div>
      {top ? (
        <button onClick={() => onManage('pending')} className="text-left rounded border border-navy/15 bg-cream/70 hover:bg-cream px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-body text-navy flex-1 truncate">{top.title}</span>
            {pastDue && <Badge color="red">Past due</Badge>}
          </div>
          <div className="text-[10px] font-mono text-inky/60 flex flex-wrap gap-x-3 mt-0.5">
            <span>Start {dateShort(top.start_date)}</span>
            <span>Target {dateShort(top.target_resolution_date)}</span>
            {daysOpen != null && <span className={pastDue ? 'text-[#C0392B] font-bold' : ''}>{daysOpen}d open</span>}
          </div>
        </button>
      ) : (
        <span className="text-xs font-body text-inky/50">No open issues</span>
      )}
      {pending.length > 1 && <span className="text-[10px] font-mono text-inky/50">+{pending.length - 1} more open</span>}
      <button onClick={() => onManage('pending')} className="text-[10px] font-mono text-sky text-left hover:underline">Manage Issues →</button>
    </div>
  )
}

function ExceptionsBox({ exceptions, onAdd, onEdit }: { exceptions: ExceptionReport[]; onAdd: () => void; onEdit: (e: ExceptionReport) => void }) {
  const isClosed = (s: string | null) => (s ?? '').toLowerCase().includes('closed')
  const open = exceptions.filter((e) => !isClosed(e.status))
  return (
    <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', open.length ? 'border-[#C0392B]/40 bg-[#C0392B]/5' : 'border-navy/20 bg-cream'].join(' ')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Exception Reports</span>
        <span className={['text-lg font-heading font-bold', open.length ? 'text-[#C0392B]' : 'text-navy'].join(' ')}>{open.length}</span>
      </div>
      {exceptions.length === 0 ? (
        <span className="text-xs font-body text-inky/50">None</span>
      ) : exceptions.slice(0, 5).map((e) => (
        <button key={e.id} onClick={() => onEdit(e)} className="text-left rounded border border-navy/15 bg-cream/70 hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-body text-navy flex-1 truncate">{[e.report_type, e.issue].filter(Boolean).join(' · ') || 'Exception'}</span>
            {e.status && <Badge color={isClosed(e.status) ? 'green' : 'amber'}>{e.status}</Badge>}
          </div>
          <div className="text-[10px] font-mono text-inky/60 mt-0.5">Found {dateShort(e.date_of_finding)}</div>
        </button>
      ))}
      <button onClick={onAdd} className="text-[10px] font-mono text-sky text-left hover:underline">+ Add Exception</button>
    </div>
  )
}

function CommsBox({ comms, onAdd, onEdit }: { comms: LocationComm[]; onAdd: () => void; onEdit: (c: LocationComm) => void }) {
  const isClosed = (s: string | null) => (s ?? '').toLowerCase().includes('closed')
  const open = comms.filter((c) => !isClosed(c.status))
  return (
    <div className="rounded-lg border border-navy/20 bg-cream px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Location Comms</span>
        <span className="text-lg font-heading font-bold text-navy">{open.length}</span>
      </div>
      {comms.length === 0 ? (
        <span className="text-xs font-body text-inky/50">None</span>
      ) : comms.slice(0, 5).map((c) => (
        <button key={c.id} onClick={() => onEdit(c)} className="text-left rounded border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-body text-navy flex-1 truncate">{[c.comm_type, c.contact_method].filter(Boolean).join(' · ') || 'Communication'}</span>
            {c.status && <Badge color={isClosed(c.status) ? 'green' : 'amber'}>{c.status}</Badge>}
          </div>
          <div className="text-[10px] font-mono text-inky/60 mt-0.5">{dateShort(c.comm_date)}{(c.products ?? []).length ? ` · ${(c.products ?? []).length} product(s)` : ''}</div>
        </button>
      ))}
      <button onClick={onAdd} className="text-[10px] font-mono text-sky text-left hover:underline">+ Add Communication</button>
    </div>
  )
}

function CheckGroup({ title, items, hidden, onToggle }: { title: string; items: { id: string; label: string }[]; hidden: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-mono uppercase tracking-widest text-navy/70 font-semibold">{title}</span>
      {items.length === 0 ? <span className="text-[11px] font-mono text-inky/40 italic">None</span> : items.map((it) => (
        <label key={it.id} className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
          <input type="checkbox" checked={!hidden.includes(it.id)} onChange={() => onToggle(it.id)} className="accent-sky" />
          {it.label}
        </label>
      ))}
    </div>
  )
}

function OrderConfigBlock({ vendor, rows, hidden, onOpenConfig }: { vendor: string; rows: ConfigRow[]; hidden: string[]; onOpenConfig: () => void }) {
  const [sort, setSort] = useState<SortState>(null)
  const columns = useMemo(() => {
    const metaKeys = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) metaKeys.add(k)
    const metaCols: Col<ConfigRow>[] = [...metaKeys].sort().map((k) => ({ id: `meta:${k}`, label: metaLabel(k), align: 'left', render: (r) => String((r.metadata as any)?.[k] ?? '—'), sort: (r) => String((r.metadata as any)?.[k] ?? '') }))
    // part, uom, capacity, max, [meta…], vmi — then drop hidden columns.
    const vmi = CONFIG_FIXED.find((c) => c.id === 'vmi')!
    const ordered = [...CONFIG_FIXED.filter((c) => c.id !== 'vmi'), ...metaCols, vmi]
    return ordered.filter((c) => !hidden.includes(c.id))
  }, [rows, hidden])

  const sortedRows = useMemo(() => applySort(rows, columns, sort), [rows, columns, sort])

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <button onClick={onOpenConfig} title="Open Order Config"
          className="text-xs font-mono text-navy uppercase tracking-wide hover:text-sky transition-colors text-left inline-flex items-center gap-1 self-start">
          {vendor} Order Config ({rows.length}) <span className="text-[10px] text-inky/50">↗</span>
        </button>
        {columns.length === 0 ? (
          <p className="text-xs font-mono text-inky/60">All config columns hidden — enable some under Customize.</p>
        ) : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  {columns.map((c) => (
                    <th key={c.id} className={`px-3 py-2 ${alignCls(c.align)}`}>
                      <button onClick={() => setSort((s) => nextSort(s, c.id))} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-center">
                        {c.label}{sortArrow(sort, c.id)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr key={r.id} className="border-b border-navy/20">
                    {columns.map((c) => <td key={c.id} className={`px-3 py-1.5 text-navy ${alignCls(c.align)}`}>{c.render(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
