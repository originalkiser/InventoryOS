import { useCallback, useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { GripVertical, Copy } from 'lucide-react'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Card, CardBody, Combobox, SbLoader, Badge, Button, Toggle, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import type { TankMonitor, Location, VendorPart } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const dt = (v: string | null | undefined) => { if (!v) return '—'; try { return format(new Date(v), 'MMM d, yyyy h:mm a') } catch { return String(v) } }
const metaOf = (l: Location | undefined, key: string): string => {
  if (!l) return ''
  const base = (l as any)[key]; if (base != null && base !== '') return String(base)
  const m = (l.metadata as any)?.[key]; return m == null ? '' : String(m)
}
const readingTime = (m: TankMonitor) => { const v = m.inventory_time ?? m.reading_date; return v ? new Date(v).getTime() : null }

interface MCol { id: string; label: string; render: (m: TankMonitor, ctx: Ctx) => ReactNode; sort?: (m: TankMonitor, ctx: Ctx) => string | number | null }
interface Ctx { shopOf: (id: string | null) => string; internalOf: (pid: string | null) => string }

const COLS: MCol[] = [
  { id: 'product', label: 'Product', render: (m) => m.product_id ?? '—', sort: (m) => m.product_id },
  { id: 'internal', label: 'Product ID (Internal)', render: (m, c) => c.internalOf(m.product_id), sort: (m, c) => c.internalOf(m.product_id) },
  { id: 'keepfill', label: 'VMI / Keepfill', render: (m) => (m.keep_fill ? <Badge color="sky">yes</Badge> : <span className="text-inky/40">—</span>), sort: (m) => (m.keep_fill ? 1 : 0) },
  { id: 'on_hand', label: 'On Hand (Gross)', render: (m) => num(m.on_hand), sort: (m) => m.on_hand },
  { id: 'available_capacity', label: 'Available Capacity', render: (m) => num(m.available_capacity), sort: (m) => m.available_capacity },
  { id: 'total_capacity', label: 'Total Capacity', render: (m) => num(m.total_capacity ?? ((m.on_hand ?? 0) + (m.available_capacity ?? 0))), sort: (m) => m.total_capacity ?? ((m.on_hand ?? 0) + (m.available_capacity ?? 0)) },
  { id: 'level_inches', label: 'Level (in)', render: (m) => num(m.level_inches), sort: (m) => m.level_inches },
  { id: 'height', label: 'Height', render: (m) => num(m.height), sort: (m) => m.height },
  { id: 'low_set_point_pct', label: 'Low Set Point (%)', render: (m) => num(m.low_set_point_pct), sort: (m) => m.low_set_point_pct },
  { id: 'volume_alarm_status', label: 'Volume Alarm', render: (m) => m.volume_alarm_status ?? '—', sort: (m) => m.volume_alarm_status },
  { id: 'battery_pct', label: "Bat' (%)", render: (m) => num(m.battery_pct), sort: (m) => m.battery_pct },
  { id: 'serial_rtu_id', label: 'Serial # (RTU ID)', render: (m) => m.serial_rtu_id ?? '—', sort: (m) => m.serial_rtu_id },
  { id: 'system_tank_id', label: 'System Tank ID', render: (m) => m.system_tank_id ?? '—', sort: (m) => m.system_tank_id },
  { id: 'key_note', label: 'Key Note', render: (m) => m.key_note ?? '—', sort: (m) => m.key_note },
  { id: 'inventory_time', label: 'Inventory Time', render: (m) => dt(m.inventory_time ?? m.reading_date), sort: (m) => readingTime(m) },
  { id: 'updated_at', label: 'Last Updated', render: (m) => dt(m.updated_at), sort: (m) => (m.updated_at ? new Date(m.updated_at).getTime() : null) },
]
const DEFAULT_ORDER = COLS.map((c) => c.id)
const ORDER_KEY = 'tankmon:colorder'
const HIDDEN_KEY = 'tankmon:hidden'

export function TankMonitorsPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const navigate = useNavigate()
  const { isExcluded } = useLocationExclusions()

  const [monitors, setMonitors] = useState<TankMonitor[]>([])
  const [parts, setParts] = useState<VendorPart[]>([])
  const [loading, setLoading] = useState(true)
  const [shopFilter, setShopFilter] = useState('')
  const [amFilter, setAmFilter] = useState('')
  const [offlineVmiOnly, setOfflineVmiOnly] = useState(true)
  const [ignored, setIgnored] = useAppSetting<string[]>('tank_low_vmi_ignore', [])
  const [matchIgnore, setMatchIgnore, matchIgnoreLoaded] = useAppSetting<string[]>('tank_match_ignore', [])
  const [showIgnored, setShowIgnored] = useState(false)

  // Location is hidden if the user excluded it (shared with the rest of the app).
  const isHidden = useCallback((id: string | null) => { const l = loc.byId(id); return !!l && isExcluded(l) }, [loc, isExcluded])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const PAGE = 1000
    // Count first, then fetch every page — a single select() is capped at 1000
    // rows, which silently dropped shops (and broke the VMI counts).
    const [{ count }, partRes] = await Promise.all([
      sb.schema('inventory').from('tank_monitors').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
      sb.schema('inventory').from('vendor_parts').select('part_number, our_part_number').eq('company_id', companyId),
    ])
    const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
    const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
      sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)))
    const all = results.flatMap((r: any) => (r.data ?? []) as TankMonitor[])
    // Collapse history to the latest reading per tank so counts reflect current
    // state (one row per tank), not every daily reading.
    const latest = new Map<string, TankMonitor>()
    for (const m of all) {
      const key = `${m.location_id ?? m.source_location ?? ''}|${m.system_tank_id ?? m.serial_rtu_id ?? m.product_id ?? ''}`
      const ex = latest.get(key)
      if (!ex || (readingTime(m) ?? 0) > (readingTime(ex) ?? 0)) latest.set(key, m)
    }
    setMonitors([...latest.values()])
    setParts((partRes.data ?? []) as VendorPart[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  // Raw monitor product → internal our_part_number via vendor parts.
  const internalMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of parts) { if (p.part_number && p.our_part_number) m.set(String(p.part_number).toLowerCase(), p.our_part_number) }
    return m
  }, [parts])
  const ctx: Ctx = useMemo(() => ({
    shopOf: (id) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    internalOf: (pid) => (pid ? (internalMap.get(pid.toLowerCase()) ?? pid) : '—'),
  }), [loc, internalMap])

  const assigned = useMemo(() => monitors.filter((m) => m.location_id && !isHidden(m.location_id)), [monitors, isHidden])
  const unassigned = useMemo(() => monitors.filter((m) => !m.location_id && !matchIgnore.includes(m.source_location || '(blank)')), [monitors, matchIgnore])

  // Filters (shop / area manager) applied to assigned monitors.
  const filtered = useMemo(() => assigned.filter((m) => {
    if (shopFilter && m.location_id !== shopFilter) return false
    if (amFilter && metaOf(loc.byId(m.location_id), 'area_manager') !== amFilter) return false
    return true
  }), [assigned, shopFilter, amFilter, loc])

  // Offline = last reading > 1 day behind the freshest reading in the dataset.
  const latestReading = useMemo(() => Math.max(0, ...monitors.map((m) => readingTime(m) ?? 0)), [monitors])
  const offline = useMemo(() => filtered.filter((m) => {
    if (offlineVmiOnly && !m.keep_fill) return false
    const t = readingTime(m); return t != null && latestReading - t > 86400000
  }), [filtered, latestReading, offlineVmiOnly])

  const areaManagers = useMemo(() => [...new Set(loc.locations.map((l) => metaOf(l, 'area_manager')).filter(Boolean))].sort(), [loc.locations])
  const shopOptions = useMemo(() => loc.locations.filter((l) => l.active).map((l) => ({ value: l.id, label: l.shop_city || l.name })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })), [loc.locations])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Tank Monitors</h1>
          <p className="text-xs text-inky mt-0.5">All monitors across shops. Match unassigned shops, spot offline monitors, and find low VMI coverage.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate('/config?tab=tank-monitor')}>Upload / Update Data ↗</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-60"><Combobox options={[{ value: '', label: 'All shops' }, ...shopOptions]} value={shopFilter} onChange={setShopFilter} placeholder="Filter by shop…" /></div>
        <div className="w-56"><Combobox options={[{ value: '', label: 'All area managers' }, ...areaManagers.map((a) => ({ value: a, label: a }))]} value={amFilter} onChange={setAmFilter} placeholder="Filter by area manager…" /></div>
        {(shopFilter || amFilter) && <button onClick={() => { setShopFilter(''); setAmFilter('') }} className="text-[11px] font-mono text-inky hover:text-navy hover:underline">Clear filters</button>}
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="all">All Monitors ({filtered.length})</TabsTrigger>
          <TabsTrigger value="offline">Offline ({offline.length})</TabsTrigger>
          <TabsTrigger value="lowvmi">Low VMI Coverage</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          {loading || !matchIgnoreLoaded ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div> : (
            <div className="flex flex-col gap-4">
              {matchIgnore.length > 0 && (
                <div className="text-[11px] font-mono">
                  <button onClick={() => setShowIgnored((o) => !o)} className="text-inky hover:text-navy hover:underline">
                    {matchIgnore.length} unassigned shop{matchIgnore.length !== 1 ? 's' : ''} ignored {showIgnored ? '▾' : '▸'}
                  </button>
                  {showIgnored && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {matchIgnore.map((s) => (
                        <span key={s} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-navy">
                          {s || '(blank)'}<button onClick={() => setMatchIgnore(matchIgnore.filter((x) => x !== s))} title="Un-ignore" className="text-inky/50 hover:text-[#C0392B]">✕</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {unassigned.length > 0 && <UnassignedMatcher rows={unassigned} shopOptions={shopOptions} companyId={companyId} onMatched={load} onReloadLocations={loc.reload} matchIgnore={matchIgnore} setMatchIgnore={setMatchIgnore} />}
              <MonitorTable rows={filtered} ctx={ctx} shopOf={ctx.shopOf} />
            </div>
          )}
        </TabsContent>

        <TabsContent value="offline">
          <div className="flex items-center gap-3 mb-3">
            <Toggle checked={offlineVmiOnly} onChange={setOfflineVmiOnly} label="VMI/keepfill only" color="cyan" />
            <span className="text-[11px] font-mono text-inky/50">Non-VMI tanks going quiet usually don't matter.</span>
          </div>
          {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : offline.length === 0 ? <p className="text-xs font-mono text-inky/50 py-8">No offline monitors — all reported within 1 day of the latest upload.</p>
            : <MonitorTable rows={offline} ctx={ctx} shopOf={ctx.shopOf} />}
        </TabsContent>

        <TabsContent value="lowvmi">
          <LowVmiView monitors={filtered} loc={loc} isExcluded={isExcluded} shopFilter={shopFilter} amFilter={amFilter} ignored={ignored} setIgnored={setIgnored} ctx={ctx} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Monitor table with reorder + hide columns ───────────────────────────────
function SortableHeader({ id, label, thBase }: { id: string; label: string; thBase: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <th ref={setNodeRef} style={style} className={thBase}>
      <div className="flex items-center gap-1">
        <button {...attributes} {...listeners} title="Drag to reorder" className="cursor-grab active:cursor-grabbing text-inky/40 hover:text-navy flex-shrink-0"><GripVertical className="w-3 h-3" /></button>
        <span>{label}</span>
      </div>
    </th>
  )
}

function MonitorTable({ rows, ctx, shopOf }: { rows: TankMonitor[]; ctx: Ctx; shopOf: (id: string | null) => string }) {
  const [order, setOrder] = useState<string[]>(() => {
    try { const s = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); if (Array.isArray(s)) { const k = s.filter((id: string) => DEFAULT_ORDER.includes(id)); return [...k, ...DEFAULT_ORDER.filter((id) => !k.includes(id))] } } catch { /* ignore */ }
    return DEFAULT_ORDER
  })
  const [hidden, setHidden] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') } catch { return [] } })
  const [colMenu, setColMenu] = useState(false)
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null)
  useEffect(() => { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) }, [order])
  useEffect(() => { localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden)) }, [hidden])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const colOf = (id: string) => COLS.find((c) => c.id === id)!
  const visible = order.filter((id) => !hidden.includes(id))

  const sorted = useMemo(() => {
    if (!sort) return rows
    const c = colOf(sort.id); if (!c.sort) return rows
    return [...rows].sort((a, b) => {
      const av = c.sort!(a, ctx), bv = c.sort!(b, ctx)
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort, ctx])

  const thBase = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky top-0 z-20'
  const tdBase = 'px-2 py-1.5 border-b border-navy/15 whitespace-nowrap text-navy'
  const stickyShop = 'sticky left-0 z-30 w-[170px] min-w-[170px]'

  const cellText = (id: string, m: TankMonitor): string => {
    if (id === 'keepfill') return m.keep_fill ? 'VMI' : ''
    if (id === 'internal') return ctx.internalOf(m.product_id)
    if (id === 'inventory_time') return dt(m.inventory_time ?? m.reading_date)
    if (id === 'updated_at') return dt(m.updated_at)
    const c = colOf(id); const v = c.sort ? c.sort(m, ctx) : null
    return v == null ? '' : String(v)
  }
  async function copyTable() {
    const header = ['Shop', ...visible.map((id) => colOf(id).label)].join('\t')
    const body = sorted.map((m) => [shopOf(m.location_id), ...visible.map((id) => cellText(id, m))].join('\t'))
    try { await navigator.clipboard.writeText([header, ...body].join('\n')); toast.success('Copied to clipboard') }
    catch { toast.error('Copy failed') }
  }

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No monitors for this view.</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="relative flex justify-end gap-2">
        <button onClick={copyTable} title="Copy table for email" className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy"><Copy className="w-3 h-3" /> Copy</button>
        <button onClick={() => setColMenu((o) => !o)} className="text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">Columns</button>
        {colMenu && (
          <div className="absolute right-0 top-8 z-40 bg-cream border border-navy/30 rounded-lg shadow-xl p-3 flex flex-col gap-1 max-h-72 overflow-auto">
            {COLS.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
                <input type="checkbox" checked={!hidden.includes(c.id)} onChange={() => setHidden((h) => (h.includes(c.id) ? h.filter((x) => x !== c.id) : [...h, c.id]))} className="accent-sky" />
                {c.label}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="overflow-auto max-h-[calc(100vh-18rem)] rounded border border-navy/30">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e: DragEndEvent) => { const { active, over } = e; if (over && active.id !== over.id) setOrder((o) => arrayMove(o, o.indexOf(String(active.id)), o.indexOf(String(over.id)))) }}>
          <table className="text-xs font-mono border-collapse">
            <thead>
              <tr>
                <th className={`${thBase} ${stickyShop} left-0 z-40`}>Shop</th>
                <SortableContext items={visible} strategy={horizontalListSortingStrategy}>
                  {visible.map((id) => (
                    <SortableHeader key={id} id={id} label={colOf(id).label} thBase={thBase} />
                  ))}
                </SortableContext>
              </tr>
              <tr>
                <th className={`px-2 py-1 border-b border-navy/20 bg-cream sticky top-[38px] left-0 z-40 ${stickyShop}`} />
                {visible.map((id) => (
                  <th key={id} className="px-2 py-1 border-b border-navy/20 bg-cream sticky top-[38px] z-20 text-left">
                    <button onClick={() => setSort((s) => (s?.id === id ? (s.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'asc' }))} className="text-[9px] font-mono text-inky/50 hover:text-navy normal-case">
                      sort{sort?.id === id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((m, idx) => {
                const band = idx % 2 ? 'bg-navy/[0.04]' : 'bg-cream'
                return (
                  <tr key={m.id} className={band}>
                    <td className={`${tdBase} sticky left-0 z-10 bg-cream ${stickyShop} font-semibold`} title={shopOf(m.location_id)}>{shopOf(m.location_id)}</td>
                    {visible.map((id) => <td key={id} className={tdBase}>{colOf(id).render(m, ctx)}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </DndContext>
      </div>
    </div>
  )
}

// ── Unassigned shop matcher ─────────────────────────────────────────────────
function UnassignedMatcher({ rows, shopOptions, companyId, onMatched, onReloadLocations, matchIgnore, setMatchIgnore }: {
  rows: TankMonitor[]; shopOptions: { value: string; label: string }[]; companyId: string; onMatched: () => void; onReloadLocations: () => void
  matchIgnore: string[]; setMatchIgnore: (v: string[]) => void
}) {
  const groups = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) { const k = r.source_location || '(blank)'; m.set(k, (m.get(k) ?? 0) + 1) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [rows])
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function match(source: string) {
    const locationId = pick[source]
    if (!locationId) { toast.error('Pick a shop to match'); return }
    setBusy(source)
    const sb = supabase as any
    // Add the POS mapping + assign existing unmatched rows with this source.
    const { error: mapErr } = await sb.schema('core').from('pos_location_map').insert({ company_id: companyId, pos_string: source, location_id: locationId })
    if (mapErr && !String(mapErr.message).toLowerCase().includes('duplicate')) { toast.error(mapErr.message); setBusy(null); return }
    const { error: updErr } = await sb.schema('inventory').from('tank_monitors').update({ location_id: locationId }).eq('company_id', companyId).eq('source_location', source)
    if (updErr) { toast.error(updErr.message); setBusy(null); return }
    toast.success('Shop matched'); setBusy(null); onReloadLocations(); onMatched()
  }

  return (
    <Card className="border-[#E67E22]/40 bg-[#E67E22]/5">
      <CardBody className="flex flex-col gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22] font-bold">Unassigned shops ({groups.length}) — match to a location</div>
        <p className="text-[11px] font-mono text-inky/60">These monitor rows didn't match a location via the POS mapping. Matching adds the mapping to Global Config → Location Mapping.</p>
        <div className="flex flex-col gap-1.5">
          {groups.map(([source, count]) => (
            <div key={source} className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-navy w-48 truncate" title={source}>{source}</span>
              <span className="text-[10px] font-mono text-inky/50">{count} monitor(s)</span>
              <div className="w-56"><Combobox options={shopOptions} value={pick[source] ?? ''} onChange={(v) => setPick((p) => ({ ...p, [source]: v }))} placeholder="Match to shop…" /></div>
              <Button size="sm" loading={busy === source} onClick={() => match(source)} disabled={!pick[source]}>Match</Button>
              <button onClick={() => setMatchIgnore([...matchIgnore, source])} className="text-[11px] font-mono text-inky hover:text-navy hover:underline" title="Temp hold — not a real location">Ignore</button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

// ── Low VMI coverage ────────────────────────────────────────────────────────
function LowVmiView({ monitors, loc, isExcluded, shopFilter, amFilter, ignored, setIgnored, ctx }: {
  monitors: TankMonitor[]; loc: ReturnType<typeof useLocations>; isExcluded: (l: Location) => boolean; shopFilter: string; amFilter: string; ignored: string[]; setIgnored: (v: string[]) => void; ctx: Ctx
}) {
  const byShop = useMemo(() => {
    const m = new Map<string, TankMonitor[]>()
    for (const mon of monitors) { if (!mon.location_id) continue; if (!m.has(mon.location_id)) m.set(mon.location_id, []); m.get(mon.location_id)!.push(mon) }
    return m
  }, [monitors])

  const shops = useMemo(() => loc.locations.filter((l) => {
    if (!l.active || isExcluded(l)) return false
    if (shopFilter && l.id !== shopFilter) return false
    if (amFilter && metaOf(l, 'area_manager') !== amFilter) return false
    const keepfill = (byShop.get(l.id) ?? []).filter((mo) => mo.keep_fill).length
    return keepfill < 4
  }).sort((a, b) => (a.shop_city || a.name).localeCompare(b.shop_city || b.name, undefined, { numeric: true })), [loc.locations, byShop, shopFilter, amFilter, isExcluded])

  const visible = shops.filter((l) => !ignored.includes(l.id))
  const toggleIgnore = (id: string) => setIgnored(ignored.includes(id) ? ignored.filter((x) => x !== id) : [...ignored, id])

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-mono text-inky/60">Shops with fewer than 4 monitors on VMI/Keepfill. Ignore shops that will never need more.</p>
      {visible.length === 0 ? <p className="text-xs font-mono text-inky/50 py-6">All shops meet the 4-monitor VMI threshold (or are ignored).</p> : visible.map((l) => {
        const mons = byShop.get(l.id) ?? []
        const keepfill = mons.filter((m) => m.keep_fill).length
        return (
          <Card key={l.id}>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-heading font-bold text-navy">{l.shop_city || l.name}</span>
                  <Badge color={keepfill === 0 ? 'red' : 'orange'}>{keepfill} on VMI</Badge>
                  <span className="text-[10px] font-mono text-inky/50">{mons.length} total monitor(s)</span>
                </div>
                <button onClick={() => toggleIgnore(l.id)} className="text-[11px] font-mono text-inky hover:text-navy hover:underline">Ignore</button>
              </div>
              {mons.length === 0 ? (
                <span className="text-xs font-body italic text-inky/50">No monitors configured</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {mons.map((m) => (
                    <span key={m.id} className="inline-flex items-center gap-1 rounded border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-navy">
                      {ctx.internalOf(m.product_id)}{m.keep_fill && <Badge color="sky">VMI</Badge>}
                    </span>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )
      })}
      {ignored.length > 0 && (
        <div className="text-[11px] font-mono text-inky/50">
          Ignored: {ignored.map((id) => loc.byId(id)?.shop_city || loc.byId(id)?.name || id).join(', ')}
          <button onClick={() => setIgnored([])} className="ml-2 text-inky hover:text-navy hover:underline">reset</button>
        </div>
      )}
    </div>
  )
}
