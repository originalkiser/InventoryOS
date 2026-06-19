import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { Badge, Button } from '@/components/ui'
import { LocationSyncPanel } from '@/components/integrations/LocationSyncPanel'

type BadgeColor = 'navy' | 'inky' | 'sky' | 'red' | 'green' | 'orange'
const COLORS: BadgeColor[] = ['navy', 'inky', 'sky', 'red', 'green', 'orange']

type PillOp = '=' | '!=' | '<' | '>'
interface Pill { label: string; color: BadgeColor; source?: string; column?: string; op?: PillOp; value?: string }
type Block =
  | { id: string; type: 'pills'; title: string; pills: Pill[] }
  | { id: string; type: 'table'; title: string; source: string; columns: string[] }
interface ViewConfig { showSearch: boolean; blocks: Block[] }

const SOURCES = [
  { value: 'locations', label: 'Locations' },
  { value: 'monthly_counts', label: 'Monthly Counts' },
  { value: 'order_sessions', label: 'Orders' },
  { value: 'issues', label: 'Issues' },
  { value: 'tank_monitors', label: 'Tank Monitors' },
]
const VIEW_KEY = 'locationLookup.view'
const SIZE_KEY = 'locationLookup.size'
const POS_KEY = 'locationLookup.pos'
const uid = () => Math.random().toString(36).slice(2)

const DEFAULT_VIEW: ViewConfig = {
  showSearch: true,
  blocks: [
    { id: uid(), type: 'pills', title: 'Quick Status', pills: [{ label: 'Inactive', color: 'red', source: 'locations', column: 'active', op: '=', value: 'false' }] },
    { id: uid(), type: 'table', title: 'Locations', source: 'locations', columns: ['location_code', 'name', 'region'] },
  ],
}

function loadView(): ViewConfig {
  try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); if (v?.blocks) return v } catch { /* ignore */ }
  return DEFAULT_VIEW
}

// ---------------------------------------------------------------------------
export type LookupMode = 'hidden' | 'docked' | 'floating'

interface OverlayProps {
  mode: LookupMode
  width: number
  mobile: boolean
  onModeChange: (m: LookupMode) => void
  onToggle: () => void
  onWidthChange: (w: number) => void
}

export function LocationLookupOverlay({ mode, width, mobile, onModeChange, onToggle, onWidthChange }: OverlayProps) {
  const open = mode !== 'hidden'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); onToggle() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle])

  return open ? (
    <LookupPanel
      mode={mode} width={width} mobile={mobile} onModeChange={onModeChange} onWidthChange={onWidthChange}
      onClose={() => onModeChange('hidden')}
    />
  ) : null
}

// ---------------------------------------------------------------------------
function LookupPanel({ mode, width, mobile, onModeChange, onWidthChange, onClose }: Omit<OverlayProps, 'onToggle'> & { onClose: () => void }) {
  const docked = mode === 'docked' && !mobile
  const [height, setHeight] = useState<number>(() => Number(localStorage.getItem(SIZE_KEY)) || Math.round(window.innerHeight * 0.6))
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || 'null') } catch { return null }
  })
  const [view, setView] = useState<ViewConfig>(loadView)
  const [editing, setEditing] = useState(false)
  const [configId, setConfigId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState<{ column: string; value: string; label: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const right = pos?.right ?? 16
  const bottom = pos?.bottom ?? 16
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY, sw = width, sh = height
    const move = (ev: MouseEvent) => {
      onWidthChange(Math.min(Math.max(sw + (sx - ev.clientX), 320), window.innerWidth - 40))
      setHeight(Math.min(Math.max(sh + (sy - ev.clientY), 240), window.innerHeight - 40))
    }
    const up = () => {
      localStorage.setItem(SIZE_KEY, String(height))
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  function startMove(e: React.MouseEvent) {
    if (mobile || docked) return
    const sx = e.clientX, sy = e.clientY, sr = right, sb = bottom
    const move = (ev: MouseEvent) => {
      const nr = Math.min(Math.max(sr - (ev.clientX - sx), 0), window.innerWidth - 120)
      const nb = Math.min(Math.max(sb - (ev.clientY - sy), 0), window.innerHeight - 80)
      setPos({ right: nr, bottom: nb })
    }
    const up = () => {
      setPos((p) => { if (p) localStorage.setItem(POS_KEY, JSON.stringify(p)); return p })
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  function saveView() { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); setEditing(false); setConfigId(null) }
  function updateBlock(id: string, patch: Partial<Block>) {
    setView((v) => ({ ...v, blocks: v.blocks.map((b) => (b.id === id ? { ...b, ...patch } as Block : b)) }))
  }
  function removeBlock(id: string) { setView((v) => ({ ...v, blocks: v.blocks.filter((b) => b.id !== id) })) }
  function addBlock(type: 'pills' | 'table') {
    const block: Block = type === 'pills'
      ? { id: uid(), type: 'pills', title: 'New Pills', pills: [] }
      : { id: uid(), type: 'table', title: 'New Table', source: 'locations', columns: [] }
    setView((v) => ({ ...v, blocks: [...v.blocks, block] }))
  }
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setView((v) => {
      const ids = v.blocks.map((b) => b.id)
      return { ...v, blocks: arrayMove(v.blocks, ids.indexOf(active.id as string), ids.indexOf(over.id as string)) }
    })
  }

  const panelStyle: React.CSSProperties = mobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', zIndex: 55 }
    : docked
    ? { position: 'fixed', top: 0, right: 0, bottom: 0, width, zIndex: 55 }
    : { position: 'fixed', right, bottom, width, height: Math.min(height, window.innerHeight * 0.9), maxHeight: '92vh', zIndex: 55 }

  return (
    <div ref={panelRef} style={panelStyle}
      className="flex flex-col overflow-hidden rounded-lg border border-navy/40 bg-cream dark:bg-[#0e2638] dark:border-[#C4DAE6]/20 shadow-2xl">
      {!mobile && <div onMouseDown={startResize} className="absolute left-0 top-0 z-10 h-3 w-3 cursor-nwse-resize" title="Drag to resize" />}

      {/* header */}
      <div onMouseDown={startMove} className={['flex items-center justify-between bg-[#1a5c87] border-b border-[#1a5c87]/40 px-3 py-2', (mobile || docked) ? '' : 'cursor-move'].join(' ')}>
        <span className="text-xs font-heading font-bold text-[#F2F1E6] uppercase tracking-wide">Location Lookup</span>
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => setEditing((v) => !v)} title="Edit view"
            className={['p-1 rounded transition-colors', editing ? 'text-sky' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'].join(' ')}>✎</button>
          {!mobile && (
            <>
              <button onClick={() => onModeChange('floating')} title="Float on top"
                className={['p-1 rounded text-sm transition-colors', mode === 'floating' ? 'text-sky' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'].join(' ')}>⬛</button>
              <button onClick={() => onModeChange('docked')} title="Pin to right (push content)"
                className={['p-1 rounded text-sm transition-colors', mode === 'docked' ? 'text-sky' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'].join(' ')}>📌</button>
            </>
          )}
          <button onClick={onClose} className="p-1 text-[#F2F1E6]/50 hover:text-[#F2F1E6] transition-colors" title="Hide">✕</button>
        </div>
      </div>

      {/* search + active filter chip */}
      {(view.showSearch || activeFilter) && (
        <div className="flex items-center gap-2 border-b border-navy/10 p-2">
          {view.showSearch && (
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables…"
              className="flex-1 rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none" />
          )}
          {activeFilter && (
            <button onClick={() => setActiveFilter(null)} className="inline-flex items-center gap-1 rounded border border-inky/30 bg-inky/10 px-2 py-1 text-xs font-body text-inky hover:border-navy">
              {activeFilter.label} ✕
            </button>
          )}
        </div>
      )}

      {/* blocks */}
      <div className="flex-1 overflow-auto p-3">
        <div className="mb-3">
          <LocationSyncPanel />
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={view.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-3">
              {view.blocks.map((b) => (
                <BlockWrap key={b.id} id={b.id} editing={editing}
                  onConfig={() => setConfigId((c) => (c === b.id ? null : b.id))} onRemove={() => removeBlock(b.id)}>
                  {b.type === 'pills'
                    ? <PillsBlock block={b} editing={editing && configId === b.id} onChange={(p) => updateBlock(b.id, p)} onFilter={setActiveFilter} />
                    : <TableBlock block={b} editing={editing && configId === b.id} search={search} activeFilter={activeFilter} onChange={(p) => updateBlock(b.id, p)} />}
                </BlockWrap>
              ))}
              {view.blocks.length === 0 && <p className="py-6 text-center text-xs font-body italic text-inky">No blocks. Add one below.</p>}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* edit footer */}
      {editing && (
        <div className="flex items-center justify-between gap-2 border-t border-navy/20 p-2">
          <div className="flex items-center gap-2">
            <AddBlockMenu onAdd={addBlock} />
            <label className="flex cursor-pointer items-center gap-1 text-xs font-body text-inky">
              <input type="checkbox" checked={view.showSearch} onChange={(e) => setView((v) => ({ ...v, showSearch: e.target.checked }))} className="accent-inky" />
              Search bar
            </label>
          </div>
          <Button size="sm" onClick={saveView}>Save View</Button>
        </div>
      )}
    </div>
  )
}

function AddBlockMenu({ onAdd }: { onAdd: (t: 'pills' | 'table') => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="rounded border border-navy/40 px-2 py-1 text-xs font-heading text-navy hover:bg-navy/5 uppercase">+ Add Block</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full z-50 mb-1 w-36 rounded border border-navy/40 bg-cream dark:bg-[#0e2638] py-1 shadow-xl">
            <button onClick={() => { onAdd('pills'); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-xs font-body text-navy hover:bg-navy/5">Pill Group</button>
            <button onClick={() => { onAdd('table'); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-xs font-body text-navy hover:bg-navy/5">Mini Table</button>
          </div>
        </>
      )}
    </div>
  )
}

function BlockWrap({ id, editing, onConfig, onRemove, children }: { id: string; editing: boolean; onConfig: () => void; onRemove: () => void; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={['rounded border border-navy/20 bg-cream/60 dark:bg-[#0a2035]/60 p-2', isDragging ? 'opacity-60' : ''].join(' ')}>
      {editing && (
        <div className="mb-1 flex items-center justify-end gap-1 text-inky/50">
          <span {...attributes} {...listeners} className="mr-auto cursor-grab" title="Drag to reorder">⋮⋮</span>
          <button onClick={onConfig} title="Configure" className="hover:text-navy">⚙</button>
          <button onClick={onRemove} title="Remove" className="hover:text-[#C0392B]">🗑</button>
        </div>
      )}
      {children}
    </div>
  )
}

function parseVal(v: string): string | number | boolean {
  if (v === 'true') return true
  if (v === 'false') return false
  const n = Number(v)
  return v.trim() !== '' && !isNaN(n) ? n : v
}

function PillsBlock({ block, editing, onChange, onFilter }: {
  block: Extract<Block, { type: 'pills' }>; editing: boolean
  onChange: (p: Partial<Block>) => void
  onFilter: (f: { column: string; value: string; label: string } | null) => void
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [counts, setCounts] = useState<(number | null)[]>([])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    Promise.all(block.pills.map(async (p) => {
      let q = (supabase as any).from(p.source || 'locations').select('*', { count: 'exact', head: true }).eq('company_id', companyId)
      if (p.column && p.op && p.value !== undefined && p.value !== '') {
        const val = parseVal(p.value)
        q = p.op === '!=' ? q.neq(p.column, val) : p.op === '<' ? q.lt(p.column, val) : p.op === '>' ? q.gt(p.column, val) : q.eq(p.column, val)
      }
      const { count } = await q
      return (count ?? 0) as number
    })).then((cs) => { if (!cancelled) setCounts(cs) }).catch(() => { if (!cancelled) setCounts([]) })
    return () => { cancelled = true }
  }, [block.pills, companyId])

  const inputCls = 'rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none'

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <input value={block.title} onChange={(e) => onChange({ title: e.target.value })}
          className={inputCls} />
      ) : <div className="text-[11px] font-heading uppercase tracking-wide text-inky">{block.title}</div>}
      <div className="flex flex-wrap gap-1.5">
        {block.pills.map((p, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <button onClick={() => { if (p.column && p.value != null) onFilter({ column: p.column, value: p.value, label: p.label }) }} title={p.column ? `${p.column} ${p.op} ${p.value}` : undefined}>
              <Badge color={p.color}>{p.label || '—'}: {counts[i] ?? '…'}</Badge>
            </button>
            {editing && <button onClick={() => onChange({ pills: block.pills.filter((_, j) => j !== i) })} className="text-inky/40 hover:text-[#C0392B]">×</button>}
          </span>
        ))}
        {block.pills.length === 0 && !editing && <span className="text-xs font-body italic text-inky">No pills</span>}
      </div>
      {editing && <PillEditor onAdd={(pill) => onChange({ pills: [...block.pills, pill] })} />}
    </div>
  )
}

function PillEditor({ onAdd }: { onAdd: (p: Pill) => void }) {
  const { profile } = useAuthStore()
  const [label, setLabel] = useState('')
  const [color, setColor] = useState<BadgeColor>('inky')
  const [source, setSource] = useState('locations')
  const [column, setColumn] = useState('')
  const [op, setOp] = useState<PillOp>('=')
  const [value, setValue] = useState('')
  const [cols, setCols] = useState<string[]>([])
  const [distinctVals, setDistinctVals] = useState<string[]>([])
  const listId = `pill-vals-${source}-${column}`

  useEffect(() => {
    if (!profile?.company_id) return
    let cancelled = false
    ;(supabase as any).from(source).select('*').eq('company_id', profile.company_id).limit(1)
      .then(({ data }: any) => { if (!cancelled) setCols(data?.[0] ? Object.keys(data[0]).filter((k) => k !== 'company_id' && k !== 'metadata') : []) })
    return () => { cancelled = true }
  }, [source, profile?.company_id])

  useEffect(() => {
    if (!profile?.company_id || !column) { setDistinctVals([]); return }
    let cancelled = false
    ;(supabase as any).from(source).select(column).eq('company_id', profile.company_id).limit(500)
      .then(({ data }: any) => {
        if (cancelled) return
        const vals = Array.from(new Set((data ?? []).map((r: any) => String(r[column] ?? '')).filter(Boolean))).sort() as string[]
        setDistinctVals(vals)
      })
    return () => { cancelled = true }
  }, [source, column, profile?.company_id])

  const selectCls = 'rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-1 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none'

  return (
    <div className="flex flex-col gap-1 rounded border border-navy/20 p-2">
      <div className="flex items-center gap-1">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pill label"
          className="flex-1 rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy placeholder-inky/50 focus:border-sky focus:outline-none" />
        <select value={color} onChange={(e) => setColor(e.target.value as BadgeColor)} className={selectCls}>
          {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <select value={source} onChange={(e) => { setSource(e.target.value); setColumn(''); setValue('') }} className={selectCls}>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={column} onChange={(e) => { setColumn(e.target.value); setValue('') }} className={`w-28 ${selectCls}`}>
          <option value="">column…</option>
          {cols.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={op} onChange={(e) => setOp(e.target.value as PillOp)} className={selectCls}>
          {(['=', '!=', '<', '>'] as PillOp[]).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="value"
          list={column ? listId : undefined}
          className="w-24 rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy placeholder-inky/50 focus:border-sky focus:outline-none"
        />
        {column && distinctVals.length > 0 && (
          <datalist id={listId}>
            {distinctVals.map((v) => <option key={v} value={v} />)}
          </datalist>
        )}
        <button onClick={() => { if (label.trim()) { onAdd({ label: label.trim(), color, source, column: column.trim() || undefined, op, value }); setLabel(''); setColumn(''); setValue('') } }}
          className="rounded border border-inky/30 px-2 py-1 text-xs font-heading text-inky hover:border-navy hover:text-navy uppercase">+ pill</button>
      </div>
      <p className="text-[10px] font-body text-inky/60">Live count of {source} where column ⋄ value (e.g. active = false). Click a pill to filter the table below.</p>
    </div>
  )
}

function cellVal(r: Record<string, any>, c: string): any {
  if (c.startsWith('meta:')) return (r.metadata as any)?.[c.slice(5)]
  return r[c]
}
const colLabel = (c: string) => (c.startsWith('meta:') ? c.slice(5) : c)

const PAGE = 1000

function TableBlock({ block, editing, search, activeFilter, onChange }: {
  block: Extract<Block, { type: 'table' }>; editing: boolean; search: string
  activeFilter: { column: string; value: string; label: string } | null
  onChange: (p: Partial<Block>) => void
}) {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [allCols, setAllCols] = useState<string[]>([])
  const [seeAll, setSeeAll] = useState(false)
  const isLocations = block.source === 'locations'

  // Derive allCols from a row sample
  function deriveAllCols(r: Record<string, any>[], source: string) {
    const base = r[0] ? Object.keys(r[0]).filter((k) => k !== 'company_id' && k !== 'metadata') : []
    const metaKeys = new Set<string>()
    for (const row of r) {
      const m = row.metadata
      if (m && typeof m === 'object') for (const k of Object.keys(m)) metaKeys.add(`meta:${k}`)
    }
    return [...base, ...metaKeys, ...(source === 'locations' ? ['__pos__'] : [])]
  }

  // Locations: reuse the already-loaded data from useLocations (no limit, no extra round-trip)
  useEffect(() => {
    if (!isLocations) return
    const r = loc.locations as unknown as Record<string, any>[]
    setRows(r)
    setAllCols(deriveAllCols(r, 'locations'))
  }, [isLocations, loc.locations])

  // Other sources: count then parallel-page fetch (no row cap)
  useEffect(() => {
    if (isLocations || !profile?.company_id) return
    let cancelled = false
    const sb = supabase as any
    ;(async () => {
      const { count, error: countErr } = await sb
        .from(block.source).select('*', { count: 'exact', head: true }).eq('company_id', profile.company_id)
      if (countErr || !count || cancelled) return
      const pageCount = Math.ceil(count / PAGE)
      const results = await Promise.all(
        Array.from({ length: pageCount }, (_, i) =>
          sb.from(block.source).select('*').eq('company_id', profile.company_id).range(i * PAGE, (i + 1) * PAGE - 1)
        )
      )
      if (cancelled) return
      const r = results.flatMap((res: any) => (res.data ?? []) as Record<string, any>[])
      setRows(r)
      setAllCols(deriveAllCols(r, block.source))
    })()
    return () => { cancelled = true }
  }, [isLocations, block.source, profile?.company_id])

  const valueOf = (r: Record<string, any>, c: string) => (c === '__pos__' && isLocations ? loc.posStringFor(r.id) : cellVal(r, c))
  const labelFor = (c: string) => (c === '__pos__' ? 'POS String' : colLabel(c))

  const cols = block.columns.length ? block.columns : allCols.slice(0, 4)
  const filtered = useMemo(() => {
    let r = rows
    const q = search.trim().toLowerCase()
    if (q) r = r.filter((row) => cols.some((c) => String(valueOf(row, c) ?? '').toLowerCase().includes(q)))
    if (activeFilter) r = r.filter((row) => String(valueOf(row, activeFilter.column) ?? '').toLowerCase() === activeFilter.value.toLowerCase())
    return r
  }, [rows, search, cols, activeFilter]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = seeAll ? filtered : filtered.slice(0, 20)

  const selectCls = 'rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none'

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <div className="flex flex-col gap-2">
          <input value={block.title} onChange={(e) => onChange({ title: e.target.value })}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none" />
          <select value={block.source} onChange={(e) => onChange({ source: e.target.value, columns: [] })} className={selectCls}>
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <div className="flex flex-wrap gap-2">
            {allCols.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1 text-[11px] font-body text-inky">
                <input type="checkbox" checked={cols.includes(c)} className="accent-inky"
                  onChange={() => onChange({ columns: cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c] })} />
                {labelFor(c)}
              </label>
            ))}
          </div>
        </div>
      ) : <div className="text-[11px] font-heading uppercase tracking-wide text-inky">{block.title}</div>}

      <div className="overflow-auto rounded border border-inky/20">
        <table className="w-full text-[11px] font-body">
          <thead className="bg-[#1a5c87]">
            <tr>{cols.map((c) => <th key={c} className="px-2 py-1 text-left text-[#F2F1E6] font-heading uppercase tracking-wide">{labelFor(c)}</th>)}</tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-cream dark:bg-[#0a2035]' : 'bg-[#ECEBD8] dark:bg-[#0D2035]'}>
                {cols.map((c) => <td key={c} className="px-2 py-1 text-navy">{String(valueOf(r, c) ?? '—') || '—'}</td>)}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={Math.max(1, cols.length)} className="px-2 py-2 text-inky italic font-body">No rows</td></tr>}
          </tbody>
        </table>
      </div>
      {filtered.length > 20 && (
        <button onClick={() => setSeeAll((s) => !s)} className="self-start text-[11px] font-body text-inky hover:text-navy hover:underline">
          {seeAll ? 'Show less' : `See all ${filtered.length}`}
        </button>
      )}
    </div>
  )
}
