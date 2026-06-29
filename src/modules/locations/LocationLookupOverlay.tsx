import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  topOffset?: number
  sidebarWidth?: number
  onModeChange: (m: LookupMode) => void
  onToggle: () => void
  onWidthChange: (w: number) => void
}

export function LocationLookupOverlay({ mode, width, mobile, topOffset, sidebarWidth, onModeChange, onToggle, onWidthChange }: OverlayProps) {
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
      mode={mode} width={width} mobile={mobile} topOffset={topOffset} sidebarWidth={sidebarWidth}
      onModeChange={onModeChange} onWidthChange={onWidthChange} onClose={() => onModeChange('hidden')}
    />
  ) : null
}

// ---------------------------------------------------------------------------
function LookupPanel({ mode, width, mobile, topOffset = 48, sidebarWidth = 0, onModeChange, onWidthChange, onClose }: Omit<OverlayProps, 'onToggle'> & { onClose: () => void }) {
  const docked = mode === 'docked' && !mobile
  const maxPanelHeight = window.innerHeight - topOffset
  const [height, setHeight] = useState<number>(() => Math.min(Number(localStorage.getItem(SIZE_KEY)) || Math.round(window.innerHeight * 0.6), maxPanelHeight))
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
  const bottom = Math.max(pos?.bottom ?? 16, 0)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY, sw = width, sh = height
    const move = (ev: MouseEvent) => {
      onWidthChange(Math.min(Math.max(sw + (sx - ev.clientX), 320), window.innerWidth - 40))
      setHeight(Math.min(Math.max(sh + (sy - ev.clientY), 240), maxPanelHeight))
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
      const maxRight = Math.max(0, window.innerWidth - width - sidebarWidth)
      const nr = Math.min(Math.max(sr - (ev.clientX - sx), 0), maxRight)
      const nb = Math.min(Math.max(sb - (ev.clientY - sy), 0), window.innerHeight - topOffset - height)
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
  function saveColumns(id: string, columns: string[]) {
    setView((v) => {
      const newView = { ...v, blocks: v.blocks.map((b) => b.id === id ? { ...b, columns } as Block : b) }
      localStorage.setItem(VIEW_KEY, JSON.stringify(newView))
      return newView
    })
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
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', zIndex: 65 }
    : docked
    ? { position: 'fixed', top: topOffset, right: 0, bottom: 0, width, zIndex: 65 }
    : { position: 'fixed', right, bottom, width, height: Math.min(height, maxPanelHeight), maxHeight: maxPanelHeight, zIndex: 65 }

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
                className={['p-1 rounded transition-colors', mode === 'floating' ? 'text-sky' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'].join(' ')}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M4.146.146A.5.5 0 0 1 4.5 0h7a.5.5 0 0 1 .5.5c0 .68-.342 1.174-.646 1.479-.126.125-.25.224-.354.298v4.431l.078.048c.203.127.476.314.751.555C12.36 7.775 13 8.527 13 9.5a.5.5 0 0 1-.5.5h-4v4.5c0 .276-.224 1.5-.5 1.5s-.5-1.224-.5-1.5V10h-4a.5.5 0 0 1-.5-.5c0-.973.64-1.725 1.17-2.189A5.921 5.921 0 0 1 5 6.845V2.42a2.19 2.19 0 0 1-.354-.298C4.342 1.674 4 1.179 4 .5a.5.5 0 0 1 .146-.354z"/>
                </svg>
              </button>
              <button onClick={() => onModeChange('docked')} title="Push to right sidebar"
                className={['p-1 rounded transition-colors', mode === 'docked' ? 'text-sky' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'].join(' ')}>
                <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1 8a.5.5 0 0 1 .5-.5h9.793L8.146 4.354a.5.5 0 1 1 .708-.708l4 4a.5.5 0 0 1 0 .708l-4 4a.5.5 0 0 1-.708-.708L11.293 8.5H1.5A.5.5 0 0 1 1 8z"/>
                  <path d="M14.5 1a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-1 0v-13a.5.5 0 0 1 .5-.5z"/>
                </svg>
              </button>
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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={view.blocks.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-3">
              {view.blocks.map((b) => (
                <BlockWrap key={b.id} id={b.id} editing={editing}
                  onConfig={() => setConfigId((c) => (c === b.id ? null : b.id))} onRemove={() => removeBlock(b.id)}>
                  {b.type === 'pills'
                    ? <PillsBlock block={b} editing={editing && configId === b.id} onChange={(p) => updateBlock(b.id, p)} onFilter={setActiveFilter} />
                    : <TableBlock block={b} editing={editing && configId === b.id} search={search} activeFilter={activeFilter} onChange={(p) => updateBlock(b.id, p)} onSaveColumns={(cols) => saveColumns(b.id, cols)} />}
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

// Map internal column keys to readable header labels
const COL_LABELS: Record<string, string> = {
  location_code: 'Code',
  name: 'Name',
  region: 'Region',
  active: 'Active',
  updated_at: 'Updated',
  __pos__: 'POS String',
  'meta:owner': 'Owner',
  'meta:area_manager': 'Area Manager',
  'meta:regional_director': 'Regional Director',
  'meta:market': 'Market',
  'meta:delivery_day': 'Delivery Day',
}

function colLabel(c: string): string {
  if (COL_LABELS[c]) return COL_LABELS[c]
  if (c.startsWith('meta:')) {
    return c.slice(5).replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
  }
  return c.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
}

// Contextual filter hierarchy for locations
const LOC_FILTER_HIERARCHY = ['meta:owner', 'region', 'meta:market', 'meta:area_manager', 'meta:regional_director']

const PAGE = 1000
const PAGE_SIZES = [50, 100, 150, 200] as const

// ---------------------------------------------------------------------------
// Sortable column row used inside ManageColsPortal
function SortableColItem({ id, label, onToggle }: { id: string; label: string; onToggle: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="flex items-center gap-2 px-2 py-1.5 rounded border border-navy/15 bg-cream/80 dark:bg-[#0a2035]/80"
    >
      <span {...attributes} {...listeners} className="cursor-grab text-inky/40 select-none text-sm leading-none">⋮⋮</span>
      <input type="checkbox" checked onChange={onToggle} className="accent-sky cursor-pointer" />
      <span className="text-xs font-body text-navy dark:text-[#F2F1E6]">{label}</span>
    </div>
  )
}

// Portal-based Manage Columns modal — renders above everything (z-[200]) to avoid
// z-index conflicts with the panel itself.
function ManageColsPortal({ allCols, cols, onClose, onSave }: {
  allCols: string[]
  cols: string[]
  onClose: () => void
  onSave: (newCols: string[]) => void
}) {
  const [visible, setVisible] = useState<string[]>(cols)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setVisible((v) => {
      const oldIdx = v.indexOf(active.id as string)
      const newIdx = v.indexOf(over.id as string)
      return oldIdx >= 0 && newIdx >= 0 ? arrayMove(v, oldIdx, newIdx) : v
    })
  }

  function toggle(c: string) {
    setVisible((v) => v.includes(c) ? v.filter((x) => x !== c) : [...v, c])
  }

  const hidden = allCols.filter((c) => !visible.includes(c))

  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative w-full max-w-sm mx-4 max-h-[80vh] flex flex-col bg-cream dark:bg-[#0e2638] border border-navy/40 rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy/20 flex-shrink-0 bg-[#1a5c87] rounded-t-xl">
          <span className="text-xs font-heading font-bold text-[#F2F1E6] uppercase tracking-wide">Manage Columns</span>
          <button onClick={onClose} className="text-[#F2F1E6]/60 hover:text-[#F2F1E6] transition-colors">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {/* Visible columns — draggable to reorder */}
          <div className="flex flex-col gap-1">
            <p className="text-[10px] font-mono uppercase tracking-wide text-inky/60 dark:text-[#F2F1E6]/40">
              Visible · drag to reorder
            </p>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visible} strategy={verticalListSortingStrategy}>
                <div className="flex flex-col gap-1">
                  {visible.map((c) => (
                    <SortableColItem key={c} id={c} label={colLabel(c)} onToggle={() => toggle(c)} />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
            {visible.length === 0 && (
              <p className="text-xs font-body italic text-inky/50 py-1">No columns visible</p>
            )}
          </div>

          {/* Hidden columns */}
          {hidden.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] font-mono uppercase tracking-wide text-inky/60 dark:text-[#F2F1E6]/40">Hidden</p>
              {hidden.map((c) => (
                <div key={c} className="flex items-center gap-2 px-2 py-1.5 rounded border border-navy/10 bg-cream/40 dark:bg-[#0a2035]/40">
                  <span className="w-4" />
                  <input type="checkbox" checked={false} onChange={() => toggle(c)} className="accent-sky cursor-pointer" />
                  <span className="text-xs font-body text-inky/70 dark:text-[#F2F1E6]/60">{colLabel(c)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-navy/20 flex-shrink-0">
          <button onClick={onClose}
            className="px-3 py-1.5 text-xs font-heading uppercase tracking-wide rounded border border-navy/30 text-inky hover:border-navy">
            Cancel
          </button>
          <button onClick={() => { onSave(visible); onClose() }}
            className="px-3 py-1.5 text-xs font-heading uppercase tracking-wide rounded bg-[#1a5c87] text-[#F2F1E6] hover:bg-[#154d73]">
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function TableBlock({ block, editing, search, activeFilter, onChange, onSaveColumns }: {
  block: Extract<Block, { type: 'table' }>; editing: boolean; search: string
  activeFilter: { column: string; value: string; label: string } | null
  onChange: (p: Partial<Block>) => void
  onSaveColumns: (cols: string[]) => void
}) {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const [rows, setRows] = useState<Record<string, any>[]>([])
  const [allCols, setAllCols] = useState<string[]>([])
  const [colsOpen, setColsOpen] = useState(false)
  const isLocations = block.source === 'locations'
  const stateKey = `lookup.block.${block.id}.state`

  function loadState() {
    try { return JSON.parse(localStorage.getItem(stateKey) || 'null') ?? {} } catch { return {} }
  }
  const saved = loadState()

  const [sort, setSort] = useState<{ col: string; dir: 'asc' | 'desc' } | null>(
    saved.sort ?? (isLocations ? { col: 'location_code', dir: 'asc' } : null)
  )
  const [dropFilters, setDropFilters] = useState<Record<string, string>>(saved.dropFilters ?? {})
  const [pageSize, setPageSize] = useState<number | 'all'>(saved.pageSize ?? 50)
  const [page, setPage] = useState(saved.page ?? 0)

  // Persist state whenever it changes
  useEffect(() => {
    localStorage.setItem(stateKey, JSON.stringify({ sort, dropFilters, pageSize, page }))
  }, [sort, dropFilters, pageSize, page, stateKey])

  function deriveAllCols(r: Record<string, any>[], source: string) {
    const base = r[0] ? Object.keys(r[0]).filter((k) => k !== 'company_id' && k !== 'metadata') : []
    const baseSet = new Set(base)
    const metaKeys = new Set<string>()
    for (const row of r) {
      const m = row.metadata
      if (m && typeof m === 'object') for (const k of Object.keys(m)) metaKeys.add(`meta:${k}`)
    }
    // Exclude meta:X when X is already a real column (e.g. meta:region when region exists)
    const uniqueMetaKeys = [...metaKeys].filter((mk) => !baseSet.has(mk.slice(5)))
    return [...base, ...uniqueMetaKeys, ...(source === 'locations' ? ['__pos__'] : [])]
  }

  useEffect(() => {
    if (!isLocations) return
    const r = loc.locations as unknown as Record<string, any>[]
    setRows(r)
    setAllCols(deriveAllCols(r, 'locations'))
  }, [isLocations, loc.locations])

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

  const valueOf = (r: Record<string, any>, c: string) =>
    c === '__pos__' && isLocations ? loc.posStringFor(r.id) : cellVal(r, c)

  // Deduplicate: drop meta:X if X is already present (handles stale saved views)
  const rawCols = block.columns.length ? block.columns : allCols.slice(0, 4)
  const cols = rawCols.filter((c, _, arr) => !c.startsWith('meta:') || !arr.includes(c.slice(5)))

  // Which filter fields from the hierarchy actually exist in this dataset
  const filterFields = useMemo(
    () => LOC_FILTER_HIERARCHY.filter((f) => allCols.includes(f)),
    [allCols]
  )

  // For a given hierarchy field, rows that pass ALL filters ABOVE it (for counting options)
  function rowsAbove(fieldIdx: number, allRows: Record<string, any>[]): Record<string, any>[] {
    let r = allRows
    for (let i = 0; i < fieldIdx; i++) {
      const f = filterFields[i]
      const v = dropFilters[f]
      if (v) r = r.filter((row) => String(valueOf(row, f) ?? '') === v)
    }
    return r
  }

  // Base filtered rows (search + activeFilter + dropdown filters)
  const filtered = useMemo(() => {
    let r = rows
    const q = search.trim().toLowerCase()
    if (q) r = r.filter((row) => cols.some((c) => String(valueOf(row, c) ?? '').toLowerCase().includes(q)))
    if (activeFilter) r = r.filter((row) =>
      String(valueOf(row, activeFilter.column) ?? '').toLowerCase() === activeFilter.value.toLowerCase()
    )
    for (const [field, val] of Object.entries(dropFilters)) {
      if (val) r = r.filter((row) => String(valueOf(row, field) ?? '') === val)
    }
    return r
  }, [rows, search, cols, activeFilter, dropFilters]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sorted rows
  const sortedFiltered = useMemo(() => {
    if (!sort) return filtered
    return [...filtered].sort((a, b) => {
      const av = valueOf(a, sort.col)
      const bv = valueOf(b, sort.col)
      // Numeric sort for location_code
      if (sort.col === 'location_code') {
        const an = parseInt(String(av ?? ''), 10)
        const bn = parseInt(String(bv ?? ''), 10)
        if (!isNaN(an) && !isNaN(bn)) return sort.dir === 'asc' ? an - bn : bn - an
      }
      const cmp = String(av ?? '').localeCompare(String(bv ?? ''), undefined, { numeric: true })
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [filtered, sort]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSort(col: string) {
    setSort((prev) => {
      if (prev?.col !== col) return { col, dir: 'asc' }
      if (prev.dir === 'asc') return { col, dir: 'desc' }
      return null
    })
    setPage(0)
  }

  function setDropFilter(field: string, val: string, fieldIdx: number) {
    setDropFilters((prev) => {
      const next: Record<string, string> = {}
      // Keep filters above this level, clear this and below
      for (let i = 0; i < fieldIdx; i++) next[filterFields[i]] = prev[filterFields[i]] ?? ''
      next[field] = val
      return next
    })
    setPage(0)
  }

  const totalPages = pageSize === 'all' ? 1 : Math.ceil(sortedFiltered.length / pageSize)
  const shown = pageSize === 'all'
    ? sortedFiltered
    : sortedFiltered.slice(page * pageSize, (page + 1) * pageSize)

  const selectCls = 'rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none'

  return (
    <div className="flex flex-col gap-2">
      {/* Block header: title (editable in edit mode) + Columns button */}
      <div className="flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex flex-col gap-1.5 flex-1">
            <input value={block.title} onChange={(e) => onChange({ title: e.target.value })}
              className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none" />
            <select value={block.source} onChange={(e) => onChange({ source: e.target.value, columns: [] })} className={selectCls}>
              {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        ) : (
          <div className="text-[11px] font-heading uppercase tracking-wide text-inky">{block.title}</div>
        )}
        <button
          onClick={() => setColsOpen(true)}
          className="shrink-0 rounded border border-navy/30 px-2 py-1 text-[10px] font-heading uppercase tracking-wide text-inky hover:border-navy hover:text-navy transition-colors"
          title="Manage visible columns and their order"
        >
          Columns
        </button>
      </div>

      {colsOpen && (
        <ManageColsPortal
          allCols={allCols}
          cols={cols}
          onClose={() => setColsOpen(false)}
          onSave={onSaveColumns}
        />
      )}

      {/* Contextual filter dropdowns — locations source only */}
      {!editing && isLocations && filterFields.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {filterFields.map((field, fi) => {
            const above = rowsAbove(fi, rows)
            const opts = Array.from(
              new Map(above.map((r) => {
                const v = String(valueOf(r, field) ?? '')
                return [v, v]
              })).keys()
            ).filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

            // Count how many rows in `above` match each option
            const countFor = (v: string) => above.filter((r) => String(valueOf(r, field) ?? '') === v).length

            return (
              <select
                key={field}
                value={dropFilters[field] ?? ''}
                onChange={(e) => setDropFilter(field, e.target.value, fi)}
                className={`${selectCls} max-w-[140px]`}
              >
                <option value="">All {colLabel(field)}s</option>
                {opts.map((v) => (
                  <option key={v} value={v}>{v} ({countFor(v)})</option>
                ))}
              </select>
            )
          })}
          {Object.values(dropFilters).some(Boolean) && (
            <button
              onClick={() => { setDropFilters({}); setPage(0) }}
              className="text-[11px] font-body text-inky/60 hover:text-navy underline self-center"
            >
              Clear filters
            </button>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded border border-inky/20">
        <table className="w-full text-[11px] font-body">
          <thead className="bg-[#1a5c87] sticky top-0">
            <tr>
              {cols.map((c) => {
                const isSorted = sort?.col === c
                return (
                  <th
                    key={c}
                    onClick={() => toggleSort(c)}
                    className="px-2 py-1 text-left text-[#F2F1E6] font-heading uppercase tracking-wide cursor-pointer select-none hover:bg-[#1a5c87]/80 whitespace-nowrap"
                  >
                    {colLabel(c)}
                    {isSorted ? (sort!.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={i} className={i % 2 === 0 ? 'bg-cream dark:bg-[#0a2035]' : 'bg-[#ECEBD8] dark:bg-[#0D2035]'}>
                {cols.map((c) => <td key={c} className="px-2 py-1 text-navy whitespace-nowrap">{String(valueOf(r, c) ?? '') || '—'}</td>)}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={Math.max(1, cols.length)} className="px-2 py-2 text-inky italic font-body">No rows</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-[11px] font-body text-inky flex-wrap gap-1">
        <span>{sortedFiltered.length.toLocaleString()} rows</span>
        <div className="flex items-center gap-1.5 flex-wrap">
          <select
            value={pageSize}
            onChange={(e) => { setPageSize(e.target.value === 'all' ? 'all' : Number(e.target.value)); setPage(0) }}
            className={`${selectCls} py-0.5`}
          >
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n} / page</option>)}
            <option value="all">All</option>
          </select>
          {pageSize !== 'all' && totalPages > 1 && (
            <>
              <button onClick={() => setPage((p: number) => Math.max(0, p - 1))} disabled={page === 0}
                className="px-1.5 py-0.5 border border-navy/30 rounded disabled:opacity-30 hover:border-navy text-navy">‹</button>
              <span>{page + 1} / {totalPages}</span>
              <button onClick={() => setPage((p: number) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
                className="px-1.5 py-0.5 border border-navy/30 rounded disabled:opacity-30 hover:border-navy text-navy">›</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
