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

type BadgeColor = 'cyan' | 'green' | 'magenta' | 'amber' | 'red' | 'gray'
const COLORS: BadgeColor[] = ['cyan', 'green', 'magenta', 'amber', 'red', 'gray']

type PillOp = '=' | '!=' | '<' | '>'
// A pill is a live count chip: count of `source` rows where `column op value`.
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

  // Ctrl/Cmd+L toggles the overlay from anywhere.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') { e.preventDefault(); onToggle() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle])

  return (
    <>
      {/* Floating trigger */}
      <button
        onClick={onToggle}
        className="fixed bottom-[4.5rem] right-4 z-[60] flex items-center gap-1.5 rounded-full border border-[#ffb300]/40 bg-[#161820] px-4 py-2 font-mono text-xs text-[#ffb300] shadow-lg hover:bg-[#ffb300]/10"
        title="Location Lookup (Ctrl/Cmd+L)"
      >
        🔍 Lookup{open ? <span className={['text-[10px]', mode === 'docked' ? 'text-[#39ff14]' : 'text-[#00e5ff]'].join(' ')}>●</span> : null}
      </button>
      {open && (
        <LookupPanel
          mode={mode} width={width} mobile={mobile} onModeChange={onModeChange} onWidthChange={onWidthChange}
          onClose={() => onModeChange('hidden')}
        />
      )}
    </>
  )
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
  // Clicking a pill filters the location mini-tables to matching rows.
  const [activeFilter, setActiveFilter] = useState<{ column: string; value: string; label: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const right = pos?.right ?? 16
  const bottom = pos?.bottom ?? 16
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  // Float mode "stays on top" — it deliberately does NOT auto-close on outside
  // click so a location's info can hover over content while you work.

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
      className="flex flex-col overflow-hidden rounded-lg border border-[#2a2d3e] bg-[#161820] shadow-2xl">
      {/* resize handle (top-left) */}
      {!mobile && <div onMouseDown={startResize} className="absolute left-0 top-0 z-10 h-3 w-3 cursor-nwse-resize" title="Drag to resize" />}

      {/* header (drag to move) */}
      <div onMouseDown={startMove} className={['flex items-center justify-between border-b border-[#2a2d3e] px-3 py-2', (mobile || docked) ? '' : 'cursor-move'].join(' ')}>
        <span className="text-xs font-mono font-semibold uppercase tracking-wide text-[#ffb300]">Location Lookup</span>
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => setEditing((v) => !v)} title="Edit view"
            className={['p-1 rounded', editing ? 'text-[#00e5ff]' : 'text-gray-500 hover:text-white'].join(' ')}>✎</button>
          {!mobile && (
            <>
              <button onClick={() => onModeChange('floating')} title="Float on top (hover over content)"
                className={['p-1 rounded text-sm', mode === 'floating' ? 'text-[#00e5ff]' : 'text-gray-500 hover:text-white'].join(' ')}>⬛</button>
              <button onClick={() => onModeChange('docked')} title="Pin to right (push content)"
                className={['p-1 rounded text-sm', mode === 'docked' ? 'text-[#ffb300]' : 'text-gray-500 hover:text-white'].join(' ')}>📌</button>
            </>
          )}
          <button onClick={onClose} className="p-1 text-gray-500 hover:text-white" title="Hide">✕</button>
        </div>
      </div>

      {/* search (pinned top) + active pill filter chip */}
      {(view.showSearch || activeFilter) && (
        <div className="flex items-center gap-2 border-b border-[#2a2d3e] p-2">
          {view.showSearch && (
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tables…"
              className="flex-1 rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1 text-xs font-mono text-white placeholder-gray-600 focus:border-[#00e5ff] focus:outline-none" />
          )}
          {activeFilter && (
            <button onClick={() => setActiveFilter(null)} className="inline-flex items-center gap-1 rounded border border-[#ffb300]/40 bg-[#ffb300]/10 px-2 py-1 text-xs font-mono text-[#ffb300]">
              {activeFilter.label} ✕
            </button>
          )}
        </div>
      )}

      {/* blocks */}
      <div className="flex-1 overflow-auto p-3">
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
              {view.blocks.length === 0 && <p className="py-6 text-center text-xs font-mono text-gray-600">No blocks. Add one below.</p>}
            </div>
          </SortableContext>
        </DndContext>
      </div>

      {/* edit footer */}
      {editing && (
        <div className="flex items-center justify-between gap-2 border-t border-[#2a2d3e] p-2">
          <div className="flex items-center gap-2">
            <AddBlockMenu onAdd={addBlock} />
            <label className="flex cursor-pointer items-center gap-1 text-xs font-mono text-gray-400">
              <input type="checkbox" checked={view.showSearch} onChange={(e) => setView((v) => ({ ...v, showSearch: e.target.checked }))} className="accent-[#00e5ff]" />
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
      <button onClick={() => setOpen((o) => !o)} className="rounded border border-[#2a2d3e] px-2 py-1 text-xs font-mono text-gray-300 hover:text-white">+ Add Block</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full z-50 mb-1 w-36 rounded border border-[#2a2d3e] bg-[#161820] py-1 shadow-xl">
            <button onClick={() => { onAdd('pills'); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-xs font-mono text-gray-300 hover:bg-white/5">Pill Group</button>
            <button onClick={() => { onAdd('table'); setOpen(false) }} className="block w-full px-3 py-1.5 text-left text-xs font-mono text-gray-300 hover:bg-white/5">Mini Table</button>
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
      className={['rounded border border-[#2a2d3e] bg-[#0f1117] p-2', isDragging ? 'opacity-60' : ''].join(' ')}>
      {editing && (
        <div className="mb-1 flex items-center justify-end gap-1 text-gray-600">
          <span {...attributes} {...listeners} className="mr-auto cursor-grab" title="Drag to reorder">⋮⋮</span>
          <button onClick={onConfig} title="Configure" className="hover:text-gray-300">⚙</button>
          <button onClick={onRemove} title="Remove" className="hover:text-red-400">🗑</button>
        </div>
      )}
      {children}
    </div>
  )
}

// Parse a filter value to its likely JS type for the count query.
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

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <input value={block.title} onChange={(e) => onChange({ title: e.target.value })}
          className="rounded border border-[#2a2d3e] bg-[#161820] px-2 py-1 text-xs font-mono text-white" />
      ) : <div className="text-[11px] font-mono uppercase tracking-wide text-gray-500">{block.title}</div>}
      <div className="flex flex-wrap gap-1.5">
        {block.pills.map((p, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <button onClick={() => { if (p.column && p.value != null) onFilter({ column: p.column, value: p.value, label: p.label }) }} title={p.column ? `${p.column} ${p.op} ${p.value}` : undefined}>
              <Badge color={p.color}>{p.label || '—'}: {counts[i] ?? '…'}</Badge>
            </button>
            {editing && <button onClick={() => onChange({ pills: block.pills.filter((_, j) => j !== i) })} className="text-gray-600 hover:text-red-400">×</button>}
          </span>
        ))}
        {block.pills.length === 0 && !editing && <span className="text-xs font-mono text-gray-600">No pills</span>}
      </div>
      {editing && <PillEditor onAdd={(pill) => onChange({ pills: [...block.pills, pill] })} />}
    </div>
  )
}

function PillEditor({ onAdd }: { onAdd: (p: Pill) => void }) {
  const { profile } = useAuthStore()
  const [label, setLabel] = useState('')
  const [color, setColor] = useState<BadgeColor>('cyan')
  const [source, setSource] = useState('locations')
  const [column, setColumn] = useState('')
  const [op, setOp] = useState<PillOp>('=')
  const [value, setValue] = useState('')
  const [cols, setCols] = useState<string[]>([])

  // Populate the column dropdown from the chosen table's actual columns.
  useEffect(() => {
    if (!profile?.company_id) return
    let cancelled = false
    ;(supabase as any).from(source).select('*').eq('company_id', profile.company_id).limit(1)
      .then(({ data }: any) => { if (!cancelled) setCols(data?.[0] ? Object.keys(data[0]).filter((k) => k !== 'company_id' && k !== 'metadata') : []) })
    return () => { cancelled = true }
  }, [source, profile?.company_id])
  return (
    <div className="flex flex-col gap-1 rounded border border-[#2a2d3e] p-2">
      <div className="flex items-center gap-1">
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pill label"
          className="flex-1 rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1 text-xs font-mono text-white" />
        <select value={color} onChange={(e) => setColor(e.target.value as BadgeColor)} className="rounded border border-[#2a2d3e] bg-[#0f1117] px-1 py-1 text-xs font-mono text-white">
          {COLORS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-1">
        <select value={source} onChange={(e) => { setSource(e.target.value); setColumn('') }} className="rounded border border-[#2a2d3e] bg-[#0f1117] px-1 py-1 text-xs font-mono text-white">
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={column} onChange={(e) => setColumn(e.target.value)} className="w-28 rounded border border-[#2a2d3e] bg-[#0f1117] px-1 py-1 text-xs font-mono text-white">
          <option value="">column…</option>
          {cols.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={op} onChange={(e) => setOp(e.target.value as PillOp)} className="rounded border border-[#2a2d3e] bg-[#0f1117] px-1 py-1 text-xs font-mono text-white">
          {(['=', '!=', '<', '>'] as PillOp[]).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
        <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="value"
          className="w-20 rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1 text-xs font-mono text-white" />
        <button onClick={() => { if (label.trim()) { onAdd({ label: label.trim(), color, source, column: column.trim() || undefined, op, value }); setLabel(''); setColumn(''); setValue('') } }}
          className="rounded border border-[#2a2d3e] px-2 py-1 text-xs font-mono text-[#00e5ff] hover:bg-white/5">+ pill</button>
      </div>
      <p className="text-[10px] font-mono text-gray-600">Live count of {source} where column ⋄ value (e.g. active = false). Click a pill to filter the table below.</p>
    </div>
  )
}

// Value for a (possibly metadata-derived) column key.
function cellVal(r: Record<string, any>, c: string): any {
  if (c.startsWith('meta:')) return (r.metadata as any)?.[c.slice(5)]
  return r[c]
}
const colLabel = (c: string) => (c.startsWith('meta:') ? c.slice(5) : c)

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

  useEffect(() => {
    if (!profile?.company_id) return
    let cancelled = false
    ;(supabase as any).from(block.source).select('*').eq('company_id', profile.company_id).limit(100)
      .then(({ data }: any) => {
        if (cancelled) return
        const r = (data ?? []) as Record<string, any>[]
        setRows(r)
        // Dynamic columns from the actual rows, with metadata jsonb keys expanded
        // into individually-selectable meta:<key> columns (union across rows).
        const base = r[0] ? Object.keys(r[0]).filter((k) => k !== 'company_id' && k !== 'metadata') : []
        const metaKeys = new Set<string>()
        for (const row of r) { const m = row.metadata; if (m && typeof m === 'object') for (const k of Object.keys(m)) metaKeys.add(`meta:${k}`) }
        // Locations gain a derived POS String column (reverse of POS mapping).
        setAllCols([...base, ...metaKeys, ...(block.source === 'locations' ? ['__pos__'] : [])])
      })
    return () => { cancelled = true }
  }, [block.source, profile?.company_id])

  // Value/label resolvers that also handle the derived POS column.
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

  return (
    <div className="flex flex-col gap-2">
      {editing ? (
        <div className="flex flex-col gap-2">
          <input value={block.title} onChange={(e) => onChange({ title: e.target.value })}
            className="rounded border border-[#2a2d3e] bg-[#161820] px-2 py-1 text-xs font-mono text-white" />
          <select value={block.source} onChange={(e) => onChange({ source: e.target.value, columns: [] })}
            className="rounded border border-[#2a2d3e] bg-[#161820] px-2 py-1 text-xs font-mono text-white">
            {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          <div className="flex flex-wrap gap-2">
            {allCols.map((c) => (
              <label key={c} className="flex cursor-pointer items-center gap-1 text-[11px] font-mono text-gray-400">
                <input type="checkbox" checked={cols.includes(c)} className="accent-[#00e5ff]"
                  onChange={() => onChange({ columns: cols.includes(c) ? cols.filter((x) => x !== c) : [...cols, c] })} />
                {labelFor(c)}
              </label>
            ))}
          </div>
        </div>
      ) : <div className="text-[11px] font-mono uppercase tracking-wide text-gray-500">{block.title}</div>}

      <div className="overflow-auto rounded border border-[#2a2d3e]">
        <table className="w-full text-[11px] font-mono">
          <thead className="bg-[#161820] text-gray-500"><tr>{cols.map((c) => <th key={c} className="px-2 py-1 text-left">{labelFor(c)}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={i % 2 ? 'bg-white/[0.02]' : ''}>{cols.map((c) => <td key={c} className="px-2 py-1 text-gray-300">{String(valueOf(r, c) ?? '—') || '—'}</td>)}</tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={Math.max(1, cols.length)} className="px-2 py-2 text-gray-600">No rows</td></tr>}
          </tbody>
        </table>
      </div>
      {filtered.length > 20 && (
        <button onClick={() => setSeeAll((s) => !s)} className="self-start text-[11px] font-mono text-[#00e5ff] hover:underline">
          {seeAll ? 'Show less' : `See all ${filtered.length}`}
        </button>
      )}
    </div>
  )
}
