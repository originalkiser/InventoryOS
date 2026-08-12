import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Badge, Button, Card, CardBody, Combobox, SbLoader } from '@/components/ui'
import { orderDayFromDelivery } from '@/lib/orderDay'
import type { Location } from '@/types'
import { format, differenceInCalendarDays } from 'date-fns'

const LAST_SHOP_KEY = 'location-lookup:last-shop'
const VIEW_KEY = 'location-lookup:view'

interface TankRow {
  id: string; product_id: string | null; value: number | null; unit: string | null
  on_hand: number | null; keep_fill: boolean | null; reading_date: string | null; inventory_time: string | null
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
const alignCls = (a: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')
const metaLabel = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Read a location field: base column first, then metadata fallback.
function locVal(loc: Location | undefined, key: string): string {
  if (!loc) return ''
  const base = (loc as any)[key]
  if (base != null && base !== '') return String(base)
  const meta = (loc.metadata as any)?.[key]
  return meta == null ? '' : String(meta)
}

interface Col<T> { id: string; label: string; align: 'left' | 'right' | 'center'; render: (r: T) => ReactNode }

const TANK_COLS: Col<TankRow>[] = [
  { id: 'product', label: 'Product', align: 'left', render: (t) => t.product_id ?? '—' },
  { id: 'level', label: 'Current Level', align: 'right', render: (t) => `${num(t.value)} ${t.unit ?? ''}` },
  { id: 'on_hand', label: 'On Hand', align: 'right', render: (t) => num(t.on_hand) },
  { id: 'keepfill', label: 'Keepfill', align: 'center', render: (t) => (t.keep_fill ? <Badge color="green">yes</Badge> : <span className="text-inky/40">—</span>) },
  { id: 'updated', label: 'Last Update', align: 'left', render: (t) => dateShort(t.inventory_time ?? t.reading_date) },
]

const CONFIG_FIXED: Col<ConfigRow>[] = [
  { id: 'part', label: 'Part', align: 'left', render: (r) => r.product_id ?? '—' },
  { id: 'uom', label: 'UOM', align: 'left', render: (r) => String((r.metadata as any)?.uom ?? '—') },
  { id: 'capacity', label: 'Capacity', align: 'right', render: (r) => num(r.capacity) },
  { id: 'max', label: 'Max', align: 'right', render: (r) => num(r.order_limit) },
  { id: 'vmi', label: 'VMI', align: 'center', render: (r) => (String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? <Badge color="amber">VMI</Badge> : <span className="text-inky/40">—</span>) },
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
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
      const [tankRes, cfgRes, vendRes, issRes, statRes, supRes] = await Promise.all([
        sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).eq('location_id', shopId).order('product_id'),
        sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('location_id', shopId),
        sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
        sb.schema('platform').from('issues').select('id, title, status_id, issue_notes, start_date, target_resolution_date, resolved_date').eq('company_id', companyId).eq('location_id', shopId).is('deleted_at', null).order('created_at', { ascending: false }),
        sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
        sb.schema('core').from('location_supplemental').select('data').eq('company_id', companyId).eq('location_id', shopId).maybeSingle().then((r: any) => r).catch(() => ({ data: null })),
      ])
      setTanks((tankRes.data ?? []) as TankRow[])
      setConfigs((cfgRes.data ?? []) as ConfigRow[])
      setVendorNames(Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, v.name])))
      setIssues((issRes.data ?? []) as IssueRow[])
      setStatusNames(Object.fromEntries(((statRes.data ?? []) as any[]).map((s) => [s.id, s.name])))
      setSupplemental((supRes?.data?.data ?? null) as Record<string, string> | null)
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

  const rdDistributor = useMemo(() => {
    if (supplemental) {
      const k = Object.keys(supplemental).find((key) => key.includes('distributor'))
      if (k && supplemental[k]) return String(supplemental[k])
    }
    return locVal(location, 'rd_distributor')
  }, [supplemental, location])

  const stateVal = locVal(location, 'state')
  const inNC = ['nc', 'north carolina'].includes(stateVal.trim().toLowerCase())
  const sidebar: { label: string; value: string }[] = location ? [
    { label: 'Location', value: locVal(location, 'shop_city') || loc.labelOf(shopId) },
    { label: 'Area Manager', value: locVal(location, 'area_manager') },
    { label: 'AM Cell', value: locVal(location, 'am_phone') },
    { label: 'RDO', value: locVal(location, 'director') },
    { label: 'RD Order Day', value: orderDayFromDelivery(location.reladyne_delivery_day) },
    { label: 'RD Delivery Day', value: locVal(location, 'reladyne_delivery_day') },
    { label: 'RD Distributor', value: rdDistributor },
    { label: 'Address', value: [locVal(location, 'address'), locVal(location, 'city'), locVal(location, 'state'), locVal(location, 'zip')].filter(Boolean).join(', ') },
    { label: 'Shop Phone', value: locVal(location, 'store_phone') },
    { label: 'Acquisition Date', value: locVal(location, 'acquisition_date') },
    ...(inNC ? [{ label: 'NC Inspection Station', value: locVal(location, 'inspection_station_id') }] : []),
  ] : []

  const visibleSidebar = sidebar.filter((f) => !prefs.sidebar.includes(f.label))
  const visibleTankCols = TANK_COLS.filter((c) => !prefs.tank.includes(c.id))

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Inventory Location Lookup</h1>
          <p className="text-xs text-inky mt-0.5">Pick a shop to see its tanks, order configuration, and issues.</p>
        </div>
        <div className="flex items-center gap-2">
          {shopId && <Button size="sm" variant="secondary" onClick={() => setCustomizeOpen((o) => !o)}>{customizeOpen ? 'Done' : 'Customize'}</Button>}
          <div className="w-80"><Combobox options={loc.options} value={shopId} onChange={setShopId} placeholder="Search a shop…" /></div>
        </div>
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
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          {/* Sidebar */}
          <div className="flex flex-col gap-3">
            <Card>
              <CardBody className="flex flex-col gap-2">
                <span className="text-sm font-heading font-bold text-navy">{loc.labelOf(shopId)}</span>
                <dl className="flex flex-col gap-1.5 mt-1">
                  {visibleSidebar.map((f) => (
                    <div key={f.label} className="flex flex-col rounded-lg border border-navy/15 bg-navy/[0.03] px-2.5 py-1.5">
                      <dt className="text-[10px] font-mono font-semibold uppercase tracking-wide text-navy/70">{f.label}</dt>
                      <dd className="text-xs font-body text-navy break-words">{f.value || '—'}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>

            {/* Pending issues */}
            <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', pendingIssues.length ? 'border-[#E67E22]/50 bg-[#E67E22]/10' : 'border-navy/20 bg-cream'].join(' ')}>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Pending Issues</span>
                <span className={['text-lg font-heading font-bold', pendingIssues.length ? 'text-[#E67E22]' : 'text-navy'].join(' ')}>{pendingIssues.length}</span>
              </div>
              {pendingIssues.length === 0 ? (
                <span className="text-xs font-body text-inky/50">None</span>
              ) : pendingIssues.map((i) => {
                const start = i.start_date ? new Date(i.start_date + 'T00:00:00') : null
                const daysOpen = start ? differenceInCalendarDays(new Date(), start) : null
                const pastDue = !!i.target_resolution_date && differenceInCalendarDays(new Date(), new Date(i.target_resolution_date + 'T00:00:00')) > 0
                return (
                  <div key={i.id} className="rounded border border-navy/15 bg-cream/70 px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-body text-navy flex-1 truncate">{i.title}</span>
                      {pastDue && <Badge color="red">Past due</Badge>}
                    </div>
                    <div className="text-[10px] font-mono text-inky/60 flex flex-wrap gap-x-3 mt-0.5">
                      <span>Start {dateShort(i.start_date)}</span>
                      <span>Target {dateShort(i.target_resolution_date)}</span>
                      {daysOpen != null && <span className={pastDue ? 'text-[#C0392B] font-bold' : ''}>{daysOpen}d open</span>}
                    </div>
                  </div>
                )
              })}
              <button onClick={() => navigate('/issues?tab=pending')} className="text-[10px] font-mono text-sky text-left hover:underline">Open Issues →</button>
            </div>

            <div className="rounded-lg border border-navy/20 bg-cream px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Last Resolved</span>
                <span className="text-lg font-heading font-bold text-[#2ECC71]">{resolvedIssues.length}</span>
              </div>
              {resolvedIssues.slice(0, 4).map((i) => (
                <div key={i.id} className="text-xs font-body text-inky/70 truncate mt-0.5">✓ {i.title} <span className="text-inky/40">{dateShort(i.resolved_date)}</span></div>
              ))}
              {resolvedIssues.length === 0 && <div className="text-xs font-body text-inky/40 mt-0.5">None</div>}
            </div>
          </div>

          {/* Main */}
          <div className="flex flex-col gap-4">
            <Card>
              <CardBody className="flex flex-col gap-2">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">Tank Monitors ({tanks.length})</span>
                {tanks.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">No tank monitor readings for this shop.</p>
                ) : visibleTankCols.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">All tank columns hidden — enable some under Customize.</p>
                ) : (
                  <div className="overflow-auto rounded border border-navy/30">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                          {visibleTankCols.map((c) => <th key={c.id} className={`px-3 py-2 ${alignCls(c.align)}`}>{c.label}</th>)}
                        </tr>
                      </thead>
                      <tbody>
                        {tanks.map((t) => (
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

            {configsByVendor.length === 0 ? (
              <Card><CardBody><p className="text-xs font-mono text-inky/60">No order configuration for this shop.</p></CardBody></Card>
            ) : (
              <div className={configsByVendor.length >= 2 ? 'grid grid-cols-1 xl:grid-cols-2 gap-4 items-start' : 'flex flex-col gap-4'}>
                {configsByVendor.map(([vendor, rows]) => (
                  <OrderConfigBlock key={vendor} vendor={vendor} rows={rows} hidden={prefs.config} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
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

function OrderConfigBlock({ vendor, rows, hidden }: { vendor: string; rows: ConfigRow[]; hidden: string[] }) {
  const columns = useMemo(() => {
    const metaKeys = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) metaKeys.add(k)
    const metaCols: Col<ConfigRow>[] = [...metaKeys].sort().map((k) => ({ id: `meta:${k}`, label: metaLabel(k), align: 'left', render: (r) => String((r.metadata as any)?.[k] ?? '—') }))
    // part, uom, capacity, max, [meta…], vmi — then drop hidden columns.
    const vmi = CONFIG_FIXED.find((c) => c.id === 'vmi')!
    const ordered = [...CONFIG_FIXED.filter((c) => c.id !== 'vmi'), ...metaCols, vmi]
    return ordered.filter((c) => !hidden.includes(c.id))
  }, [rows, hidden])

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">{vendor} Order Config ({rows.length})</span>
        {columns.length === 0 ? (
          <p className="text-xs font-mono text-inky/60">All config columns hidden — enable some under Customize.</p>
        ) : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  {columns.map((c) => <th key={c.id} className={`px-3 py-2 ${alignCls(c.align)}`}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
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
