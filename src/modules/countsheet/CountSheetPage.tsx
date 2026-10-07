// Count Sheet (proof of concept) — a working sheet for counting a shop's inventory. Lists every Droptop product for the shop; the counter
// can sort and filter it, group products into places (bays, shelves, rooms…), put them in the order they actually walk, and add as many
// count entries per product as they need. Counts are kept on the sheet only — NOTHING is pushed to Droptop yet.
import { useEffect, useMemo, useState } from 'react'
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Download, GripVertical, Plus, X } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Modal, MultiSelectDropdown, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { QtyStepper } from '@/modules/orders-v2/lineControls'
import { dShort, num } from '@/modules/orders-v2/shared'
import { useCountSheet, type ActivityHint, type CatalogProduct, type Entry, type Place } from './useCountSheet'

type Hook = ReturnType<typeof useCountSheet>
type SortKey = 'alpha' | 'sequence' | 'usage' | 'category' | 'mine'
const SHOP_KEY = 'count_sheet_last_shop'
const GRID = 'grid grid-cols-[22px_minmax(170px,1.3fr)_88px_68px_70px_minmax(150px,1fr)_minmax(150px,1fr)_minmax(300px,2.3fr)_74px_70px] gap-x-2'

const daysAgo = (iso: string) => Math.round((Date.now() - new Date(`${iso}T00:00:00`).getTime()) / 86_400_000)
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n), 2)}`
const isDecimal = (p: CatalogProduct) => (p.on_hand != null && p.on_hand % 1 !== 0) || /oil|fluid|additive|chemical/i.test(p.category ?? '')

export function CountSheetPage() {
  const loc = useLocations()
  const [locationId, setLocationId] = useState<string>(() => { try { return localStorage.getItem(SHOP_KEY) ?? '' } catch { return '' } })
  const cs = useCountSheet(locationId || null)
  const [newOpen, setNewOpen] = useState(false)
  useEffect(() => { try { if (locationId) localStorage.setItem(SHOP_KEY, locationId) } catch { /* ignore */ } }, [locationId])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Count Sheet</h1>
          <p className="text-xs text-inky mt-0.5 max-w-3xl">Count a shop's inventory by place — bay, shelf, room — in the order you walk it. Counts stay on this sheet; nothing is sent to Droptop.</p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <div className="w-64"><Combobox label="Shop" options={loc.includedOptions} value={locationId} onChange={(v) => setLocationId(v)} placeholder="Select shop…" /></div>
          {locationId && cs.sheets.length > 0 && (
            <label className="flex flex-col gap-1 text-xs font-heading text-inky uppercase tracking-wide">Sheet
              <select value={cs.sheetId ?? ''} onChange={(e) => cs.setSheetId(e.target.value)} className="bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy normal-case tracking-normal">
                {cs.sheets.map((s) => <option key={s.id} value={s.id}>{s.label} · {dShort(s.count_date)}</option>)}
              </select>
            </label>
          )}
          {locationId && <Button size="sm" onClick={() => setNewOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" />New sheet</Button>}
        </div>
      </div>

      <p className="text-[11px] font-mono text-[#E67E22] border border-[#E67E22]/40 bg-[#E67E22]/10 rounded px-3 py-1.5">Proof of concept — counts are saved to this sheet only and are not pushed to Droptop.</p>

      {!locationId ? (
        <Card><CardBody className="text-sm font-mono text-inky py-10 text-center">Pick a shop to start a count sheet.</CardBody></Card>
      ) : cs.loadingCatalog ? (
        <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
      ) : cs.catalog.length === 0 ? (
        <Card><CardBody className="text-sm font-mono text-inky py-10 text-center">No Droptop products on file for this shop yet.</CardBody></Card>
      ) : !cs.sheetId ? (
        <Card><CardBody className="text-sm font-mono text-inky py-10 text-center flex flex-col items-center gap-3">
          No count sheet for this shop yet.
          <Button size="sm" onClick={() => setNewOpen(true)}>Start a count sheet</Button>
        </CardBody></Card>
      ) : cs.loadingSheet ? (
        <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
      ) : (
        <SheetView cs={cs} shopLabel={loc.includedOptions.find((o) => o.value === locationId)?.label ?? ''} />
      )}

      <NewSheetModal open={newOpen} onClose={() => setNewOpen(false)} hasPrevious={cs.sheets.length > 0}
        onCreate={async (label, copy) => { await cs.createSheet(label, copy); setNewOpen(false) }} />
    </div>
  )
}

function NewSheetModal({ open, onClose, hasPrevious, onCreate }: { open: boolean; onClose: () => void; hasPrevious: boolean; onCreate: (label: string, copy: boolean) => void }) {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const [label, setLabel] = useState('')
  const [copy, setCopy] = useState(true)
  return (
    <Modal open={open} onClose={onClose} title="New count sheet" size="md">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs font-heading uppercase tracking-wide text-inky">Name
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={`Count — ${today}`} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy normal-case tracking-normal" />
        </label>
        {hasPrevious && (
          <label className="flex items-start gap-2 text-xs font-mono text-navy">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} className="mt-0.5 accent-inky" />
            Start from the last sheet's places and product order (counts start empty)
          </label>
        )}
        <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" onClick={() => onCreate(label.trim() || `Count — ${today}`, hasPrevious && copy)}>Create</Button></div>
      </div>
    </Modal>
  )
}

// ── the sheet ───────────────────────────────────────────────────────────────────────────────────────────────────────

function SheetView({ cs, shopLabel }: { cs: Hook; shopLabel: string }) {
  const [view, setView] = useState<string>('all') // 'all' | 'unplaced' | place id
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('alpha')
  const [cats, setCats] = useState<string[]>([])
  const [countedFilter, setCountedFilter] = useState<'all' | 'uncounted' | 'counted'>('all')
  const [hideEmpty, setHideEmpty] = useState(false)
  const [newPlace, setNewPlace] = useState('')
  const placeView = cs.places.find((p) => p.id === view) ?? null
  useEffect(() => { if (view !== 'all' && view !== 'unplaced' && !placeView) setView('all') }, [view, placeView])
  // Entering a place defaults to the order the counter set up there.
  useEffect(() => { if (placeView) setSort('mine'); else setSort((s) => (s === 'mine' ? 'alpha' : s)) }, [placeView?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const placeName = useMemo(() => new Map(cs.places.map((p) => [p.id, p.name])), [cs.places])
  const hasSequence = cs.catalog.some((p) => p.count_sequence != null)
  const categories = useMemo(() => [...new Set(cs.catalog.map((p) => p.category ?? 'Uncategorized'))].sort(), [cs.catalog])

  const totalOf = (id: string) => { const es = cs.byProduct.get(id) ?? []; return es.some((e) => e.qty != null) ? es.reduce((s, e) => s + (e.qty ?? 0), 0) : null }

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    let list = cs.catalog.filter((p) => {
      const es = cs.byProduct.get(p.product_id) ?? []
      if (placeView) { if (!es.some((e) => e.place_id === placeView.id)) return false }
      else if (view === 'unplaced' && es.some((e) => e.place_id != null)) return false
      if (q && !`${p.product_id} ${p.category ?? ''}`.toLowerCase().includes(q)) return false
      if (cats.length && !cats.includes(p.category ?? 'Uncategorized')) return false
      const counted = totalOf(p.product_id) != null
      if (countedFilter === 'counted' && !counted) return false
      if (countedFilter === 'uncounted' && counted) return false
      if (hideEmpty && !placeView && (p.on_hand ?? 0) <= 0 && !(p.daily_usage && p.daily_usage > 0) && es.length === 0) return false
      return true
    })
    const mineKey = (p: CatalogProduct) => Math.min(...(cs.byProduct.get(p.product_id) ?? []).filter((e) => !placeView || e.place_id === placeView.id).map((e) => e.sort_order), Number.POSITIVE_INFINITY)
    list = [...list].sort((a, b) => {
      switch (sort) {
        case 'sequence': return (a.count_sequence ?? 1e9) - (b.count_sequence ?? 1e9) || a.product_id.localeCompare(b.product_id)
        case 'usage': return (b.daily_usage ?? -1) - (a.daily_usage ?? -1) || a.product_id.localeCompare(b.product_id)
        case 'category': return (a.category ?? '').localeCompare(b.category ?? '') || a.product_id.localeCompare(b.product_id)
        case 'mine': return mineKey(a) - mineKey(b) || a.product_id.localeCompare(b.product_id)
        default: return a.product_id.localeCompare(b.product_id)
      }
    })
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cs.catalog, cs.byProduct, view, placeView, search, cats, countedFilter, hideEmpty, sort])

  const counted = cs.catalog.filter((p) => totalOf(p.product_id) != null).length

  async function submitPlace() {
    if (!newPlace.trim()) return
    const id = await cs.addPlace(newPlace)
    setNewPlace('')
    if (id) setView(id)
  }

  function exportCsv() {
    const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['Product', 'Category', 'Droptop on hand', 'Counted total', 'Variance', 'Places'].map(esc).join(',')]
    for (const p of cs.catalog) {
      const es = cs.byProduct.get(p.product_id) ?? []
      const total = totalOf(p.product_id)
      if (total == null) continue
      lines.push([p.product_id, p.category, p.on_hand, total, p.on_hand != null ? total - p.on_hand : '', es.filter((e) => e.qty != null).map((e) => `${e.place_id ? placeName.get(e.place_id) ?? '?' : 'Unassigned'}: ${e.qty}`).join('; ')].map(esc).join(','))
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a'); a.href = url; a.download = `count-sheet-${shopLabel.replace(/\W+/g, '-')}.csv`; a.click(); URL.revokeObjectURL(url)
  }

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }))
  function onDragEnd(e: DragEndEvent) {
    if (!placeView || !e.over || e.active.id === e.over.id) return
    const ids = rows.map((r) => r.product_id)
    const from = ids.indexOf(String(e.active.id)), to = ids.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    void cs.reorderPlace(placeView.id, arrayMove(ids, from, to))
  }

  const countOf = (placeId: string) => new Set(cs.entries.filter((e) => e.place_id === placeId).map((e) => e.product_id)).size
  const catalogOptions = useMemo(() => cs.catalog.map((p) => ({ value: p.product_id, label: `${p.product_id}${p.category ? ` — ${p.category}` : ''}` })), [cs.catalog])

  return (
    <div className="flex flex-col gap-3">
      {/* places */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill active={view === 'all'} onClick={() => setView('all')}>All products</Pill>
        <Pill active={view === 'unplaced'} onClick={() => setView('unplaced')}>Not in a place</Pill>
        {cs.places.map((p) => (
          <Pill key={p.id} active={view === p.id} onClick={() => setView(p.id)}>{p.name} <span className="text-navy/60">{countOf(p.id)}</span></Pill>
        ))}
        <span className="flex items-center gap-1">
          <input value={newPlace} onChange={(e) => setNewPlace(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void submitPlace() }} placeholder="New place (Bay 1, Back room…)"
            className="bg-cream border border-navy/30 rounded px-2 py-1 text-[11px] font-mono text-navy w-52 focus:outline-none focus:border-sky" />
          <Button size="sm" variant="secondary" onClick={() => void submitPlace()} disabled={!newPlace.trim()}><Plus className="w-3 h-3" /></Button>
        </span>
      </div>
      {placeView && (
        <div className="flex items-center gap-3 text-[11px] font-mono text-inky flex-wrap">
          <span>Drag <GripVertical className="w-3 h-3 inline -mt-0.5" /> to put {placeView.name}'s products in the order you walk them.</span>
          <button type="button" className="underline hover:text-navy" onClick={() => { const n = window.prompt('Rename place', placeView.name); if (n) void cs.renamePlace(placeView.id, n) }}>Rename</button>
          <button type="button" className="underline hover:text-[#C0392B]" onClick={() => { if (window.confirm(`Remove "${placeView.name}"? Its counts are kept and become "not in a place".`)) { void cs.deletePlace(placeView.id); setView('all') } }}>Remove place</button>
          <div className="w-72"><Combobox compact options={catalogOptions} value="" placeholder={`Add a product to ${placeView.name}…`}
            onChange={(v) => { if (v) void cs.addEntry(v, placeView.id, null) }} /></div>
        </div>
      )}

      {/* filters */}
      <div className="flex flex-wrap items-end gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products…" className="bg-cream border border-navy/30 rounded px-2.5 py-1.5 text-xs font-mono text-navy w-56 focus:outline-none focus:border-sky" />
        <label className="flex flex-col gap-0.5 text-[10px] font-mono uppercase tracking-wide text-inky">Sort
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy normal-case">
            <option value="alpha">A → Z</option>
            <option value="sequence" disabled={!hasSequence}>Droptop count sequence{hasSequence ? '' : ' (not synced yet)'}</option>
            <option value="usage">Usage (highest first)</option>
            <option value="category">Product type</option>
            {placeView && <option value="mine">My order in this place</option>}
          </select>
        </label>
        <div className="flex flex-col gap-0.5 text-[10px] font-mono uppercase tracking-wide text-inky">Product type
          <div className="w-52"><MultiSelectDropdown options={categories.map((c) => ({ value: c }))} selected={cats} onChange={setCats} placeholder="All types" countNoun="types" searchable /></div>
        </div>
        <label className="flex flex-col gap-0.5 text-[10px] font-mono uppercase tracking-wide text-inky">Show
          <select value={countedFilter} onChange={(e) => setCountedFilter(e.target.value as typeof countedFilter)} className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy normal-case">
            <option value="all">Everything</option><option value="uncounted">Not counted yet</option><option value="counted">Counted</option>
          </select>
        </label>
        {!placeView && <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy pb-1.5"><input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="accent-inky" />Hide zero-stock, no-usage products</label>}
        <span className="ml-auto flex items-center gap-3 pb-1">
          <span className="text-[11px] font-mono text-inky">{counted} of {cs.catalog.length} counted · {rows.length} shown</span>
          <Button size="sm" variant="secondary" onClick={exportCsv} disabled={counted === 0}><Download className="w-3 h-3 mr-1" />Export counts</Button>
          <button type="button" className="text-[11px] font-mono text-[#C0392B] hover:underline" onClick={() => { if (window.confirm('Delete this whole count sheet?')) void cs.deleteSheet() }}>Delete sheet</button>
        </span>
      </div>

      {/* list */}
      <div className="overflow-x-auto rounded border border-navy/30">
        <div className="min-w-[1180px]">
          <div className={`${GRID} px-2 py-2 bg-cream border-b border-navy/30 text-[10px] font-mono uppercase tracking-wide text-inky sticky top-0 z-10`}>
            <span /><span>Product</span><span>Type</span><span className="text-right">Droptop qty</span><span className="text-right">Usage/day</span>
            <span>Last receipt</span><span>Last adjustment</span><span>Count</span><span className="text-right">{placeView ? 'This place' : 'Counted'}</span><span className="text-right">Variance</span>
          </div>
          {rows.length === 0 ? (
            <p className="text-xs font-mono text-inky py-8 text-center">{placeView ? 'No products in this place yet — add one above, or switch to All products and use "Add to place".' : 'Nothing matches those filters.'}</p>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={rows.map((r) => r.product_id)} strategy={verticalListSortingStrategy}>
                {rows.map((p, idx) => (
                  <ProductRow key={p.product_id} p={p} band={idx % 2 === 1} cs={cs} places={cs.places} placeName={placeName} placeId={placeView?.id ?? null} view={view}
                    hint={cs.hints.get(p.product_id)} entries={cs.byProduct.get(p.product_id) ?? []} sortable={!!placeView} />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>
    </div>
  )
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={`text-xs font-mono rounded border px-2.5 py-1 ${active ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`}>{children}</button>
  )
}

// ── one product ─────────────────────────────────────────────────────────────────────────────────────────────────────

function HintCell({ h, kind }: { h: ActivityHint | undefined; kind: 'receipt' | 'adjustment' }) {
  const x = h?.[kind]
  if (!x) return <span className="text-[11px] font-mono text-inky/50">—</span>
  const age = daysAgo(x.date)
  const recent = age <= 14
  const tone = kind === 'receipt' ? (recent ? 'text-[#27A860]' : 'text-inky') : (recent ? 'text-[#E67E22] font-bold' : 'text-inky')
  return (
    <span className={`text-[11px] font-mono leading-tight ${tone}`} title={`${kind === 'receipt' ? 'Received' : 'Adjusted'} ${dShort(x.date)} (${age} day${age === 1 ? '' : 's'} ago): ${signed(x.qty)}`}>
      {dShort(x.date).replace(/, \d{4}$/, '')} <strong>{signed(x.qty)}</strong><br /><span className="text-inky/70 font-normal">{age === 0 ? 'today' : `${age}d ago`}</span>
    </span>
  )
}

function ProductRow({ p, band, cs, places, placeName, placeId, view, hint, entries, sortable }: {
  p: CatalogProduct; band: boolean; cs: Hook; places: Place[]; placeName: Map<string, string>; placeId: string | null; view: string
  hint: ActivityHint | undefined; entries: Entry[]; sortable: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: p.product_id, disabled: !sortable })
  const shown = placeId ? entries.filter((e) => e.place_id === placeId) : view === 'unplaced' ? entries.filter((e) => e.place_id == null) : entries
  const others = placeId ? entries.filter((e) => e.place_id !== placeId) : []
  const total = entries.some((e) => e.qty != null) ? entries.reduce((s, e) => s + (e.qty ?? 0), 0) : null
  const here = placeId ? (shown.some((e) => e.qty != null) ? shown.reduce((s, e) => s + (e.qty ?? 0), 0) : null) : total
  const variance = total != null && p.on_hand != null ? total - p.on_hand : null
  const decimal = isDecimal(p)
  const defaultPlace = placeId

  async function addCount() { await cs.addEntry(p.product_id, defaultPlace, null) }

  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1, zIndex: isDragging ? 20 : undefined }}
      className={`${GRID} px-2 py-2 items-start border-b border-navy/10 ${band ? 'bg-[#ECEBD8] dark:bg-[#0D2035]' : 'bg-cream'}`}>
      <span className="pt-1">{sortable
        ? <button type="button" {...attributes} {...listeners} title="Drag to reorder" className="text-navy/60 hover:text-navy cursor-grab touch-none"><GripVertical className="w-4 h-4" /></button> : null}</span>
      <div className="min-w-0 pt-1">
        <div className="text-sm font-heading font-bold text-navy break-words leading-tight">{p.product_id}</div>
        {p.count_sequence != null && <div className="text-[10px] font-mono text-inky">Seq {p.count_sequence}</div>}
      </div>
      <span className="text-[11px] font-mono text-inky pt-1 break-words">{p.category ?? '—'}</span>
      <span className="text-sm font-mono text-navy text-right pt-1">{p.on_hand == null ? '—' : num(p.on_hand, 2)}</span>
      <span className="text-sm font-mono text-navy text-right pt-1">{p.daily_usage == null ? '—' : num(p.daily_usage, 2)}</span>
      <span className="pt-1"><HintCell h={hint} kind="receipt" /></span>
      <span className="pt-1"><HintCell h={hint} kind="adjustment" /></span>

      <div className="flex flex-col gap-1.5">
        {shown.length === 0 ? (
          <EntryLine entry={null} decimal={decimal} places={places} fixedPlaceId={placeId} cs={cs} productId={p.product_id} />
        ) : (
          shown.map((e, i) => (
            <div key={e.id} className="flex flex-col gap-0.5">
              <EntryLine entry={e} decimal={decimal} places={places} fixedPlaceId={placeId} cs={cs} productId={p.product_id} last={i === shown.length - 1} onAdd={addCount} />
              {i === 0 && others.length > 0 && (
                <span className="text-[10px] font-mono text-[#E67E22] leading-tight">
                  Also counted: {others.map((o) => `${o.place_id ? placeName.get(o.place_id) ?? 'another place' : 'not in a place'} ${o.qty == null ? '(not counted)' : num(o.qty, 2)}`).join(' · ')}
                </span>
              )}
            </div>
          ))
        )}
        {!placeId && places.length > 0 && (
          <select value="" onChange={(e) => { if (e.target.value) void cs.addEntry(p.product_id, e.target.value, null) }}
            className="self-start bg-transparent border border-dashed border-navy/30 rounded px-1.5 py-0.5 text-[10px] font-mono text-inky hover:border-navy">
            <option value="">＋ Add to place…</option>
            {places.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
          </select>
        )}
      </div>

      <span className="text-sm font-mono font-bold text-navy text-right pt-1">{here == null ? '—' : num(here, 2)}
        {placeId && total != null && others.length > 0 && <span className="block text-[10px] font-normal text-inky">total {num(total, 2)}</span>}</span>
      <span className={`text-sm font-mono text-right pt-1 ${variance == null ? 'text-inky/50' : variance === 0 ? 'text-[#27A860]' : 'text-[#C0392B] font-bold'}`}>{variance == null ? '—' : signed(variance)}</span>
    </div>
  )
}

/** One count entry: [place] [− qty +] [✕] and "+ add count" on the last one. With no entry yet, typing a count creates it. */
function EntryLine({ entry, decimal, places, fixedPlaceId, cs, productId, last, onAdd }: {
  entry: Entry | null; decimal: boolean; places: Place[]; fixedPlaceId: string | null; cs: Hook; productId: string; last?: boolean; onAdd?: () => void
}) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {places.length > 0 && (
        <select value={entry ? entry.place_id ?? '' : fixedPlaceId ?? ''} disabled={!entry}
          onChange={(e) => entry && void cs.setEntryPlace(entry.id, e.target.value || null)}
          className="bg-transparent border border-navy/25 rounded px-1 py-0.5 text-[11px] font-mono text-navy w-28 disabled:opacity-60" title="Which place this count is in">
          <option value="">No place</option>
          {places.map((pl) => <option key={pl.id} value={pl.id}>{pl.name}</option>)}
        </select>
      )}
      <QtyStepper compact bulk={decimal} inputClassName="w-16" value={entry?.qty ?? 0} muted={entry?.qty == null}
        onChange={(n) => {
          if (entry) { cs.setQty(entry.id, n); return }
          if (creating) return
          setCreating(true)
          void cs.addEntry(productId, fixedPlaceId, n).finally(() => setCreating(false))
        }} />
      {entry && (
        <button type="button" title="Remove this entry" onClick={() => void cs.removeEntry(entry.id)} className="text-inky/40 hover:text-[#C0392B]"><X className="w-3.5 h-3.5" /></button>
      )}
      {entry && last && onAdd && (
        <button type="button" title="Add another count for this product (another shelf, another box…)" onClick={onAdd}
          className="inline-flex items-center gap-0.5 text-[10px] font-mono text-navy border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy"><Plus className="w-3 h-3" />add count</button>
      )}
    </div>
  )
}
