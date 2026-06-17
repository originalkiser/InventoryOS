import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext, useSortable, arrayMove,
  horizontalListSortingStrategy, verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { format } from 'date-fns'
import { Button, Badge } from '@/components/ui'
import { useProjects } from '@/hooks/useProjects'
import { useProjectColumns, type ColumnDef } from '@/hooks/useProjectColumns'
import { useAppSetting } from '@/hooks/useAppSetting'
import { supabase } from '@/lib/supabase'
import type { Profile, Project, ProjectTask, Task } from '@/types'

type CellType = 'text' | 'date' | 'status' | 'datetime'

const COLUMN_DEFS: (ColumnDef & { type: CellType })[] = [
  { key: 'project_name', label: 'Project Name', defaultWidth: 220, type: 'text' },
  { key: 'start_date', label: 'Start Date', defaultWidth: 130, type: 'date' },
  { key: 'target_end_date', label: 'Target End Date', defaultWidth: 150, type: 'date' },
  { key: 'status', label: 'Status', defaultWidth: 140, type: 'status' },
  { key: 'last_update', label: 'Last Update', defaultWidth: 150, type: 'datetime' },
  { key: 'description', label: 'Description', defaultWidth: 280, type: 'text' },
  { key: 'vendor', label: 'Vendor', defaultWidth: 150, type: 'text' },
  { key: 'category', label: 'Category', defaultWidth: 150, type: 'text' },
]
const TYPE_OF = Object.fromEntries(COLUMN_DEFS.map((c) => [c.key, c.type])) as Record<string, CellType>

const STATUS_OPTIONS = ['Not Started', 'In Progress', 'Stuck (Vendor)', 'Blocked', 'Complete']
type PillColor = 'gray' | 'cyan' | 'red' | 'green' | 'amber' | 'magenta'
// Generalized so custom statuses still get a sensible color.
function colorForStatus(s: string): PillColor {
  const v = (s || '').toLowerCase()
  if (v.includes('complete') || v.includes('done')) return 'green'
  if (v.includes('progress')) return 'cyan'
  if (v.includes('stuck') || v.includes('block')) return 'red'
  if (v.includes('not started') || v === '') return 'gray'
  return 'magenta'
}
const CTRL_W = 64

// Sub-task column widths — persisted independently of project columns.
const SUBTASK_COL_DEFAULTS: Record<string, number> = {
  task: 220, status: 120, assignee: 120, due: 110, notes: 200,
}
const SUBTASK_COLS = [
  { key: 'task', label: 'Task' },
  { key: 'status', label: 'Status' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'due', label: 'Due' },
  { key: 'notes', label: 'Notes' },
] as const
const SUBTASK_LS_KEY = 'projects.subtaskColWidths'

function loadSubColWidths(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(SUBTASK_LS_KEY) || 'null')
    if (saved && typeof saved === 'object') return { ...SUBTASK_COL_DEFAULTS, ...saved }
  } catch { /* ignore */ }
  return SUBTASK_COL_DEFAULTS
}

function SubTaskHeaderCell({ colKey, label, width, onResize }: {
  colKey: string; label: string; width: number; onResize: (key: string, w: number) => void
}) {
  function startResize(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = width
    const move = (ev: MouseEvent) => onResize(colKey, Math.max(60, startW + (ev.clientX - startX)))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  return (
    <th style={{ width, minWidth: width, maxWidth: width }}
      className="relative select-none px-2 py-1.5 text-left">
      {label}
      <span onMouseDown={startResize}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#00e5ff]/40" />
    </th>
  )
}

// Wrapping, expand/collapse, click-to-edit text cell (Description / Notes).
function ExpandableTextCell({ value, onSave, placeholder }: { value: string | null; onSave: (v: string) => void; placeholder?: string }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  if (editing) {
    return (
      <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { setEditing(false); if ((value ?? '') !== v) onSave(v) }}
        rows={3}
        className="w-full resize-y rounded border border-[#00e5ff] bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:outline-none" />
    )
  }
  const text = value ?? ''
  return (
    <div className="px-1.5 py-1">
      <div onClick={() => setEditing(true)}
        className={['cursor-text whitespace-pre-wrap break-words text-xs font-mono', text ? 'text-navy' : 'text-inky/70', expanded ? '' : 'line-clamp-2'].join(' ')}>
        {text || placeholder || '—'}
      </div>
      {text.length > 60 && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-0.5 text-[10px] font-mono text-inky hover:underline">{expanded ? 'less' : 'more'}</button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
function StatusPill({ value, onChange, options = STATUS_OPTIONS, colorOf, onAddOption }: {
  value: string | null
  onChange: (v: string) => void
  options?: string[]
  colorOf?: (s: string) => PillColor
  onAddOption?: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const v = value ?? 'Not Started'
  const color = (s: string) => (colorOf ? colorOf(s) : colorForStatus(s))
  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom + 4 })
    }
    setOpen((o) => !o)
  }
  function addCustom() {
    const name = prompt('New status name')?.trim()
    if (name && onAddOption) { onAddOption(name); onChange(name) }
    setOpen(false)
  }
  return (
    <>
      <button ref={btnRef} onClick={toggle}><Badge color={color(v)}>{v}</Badge></button>
      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          {/* fixed so the menu isn't clipped by the grid's overflow container */}
          <div className="fixed z-[61] w-44 rounded border border-navy/30 bg-cream py-1 shadow-xl" style={{ left: rect.left, top: rect.top }}>
            {options.map((s) => (
              <button key={s} onClick={() => { onChange(s); setOpen(false) }} className="flex w-full items-center px-2 py-1 hover:bg-navy/5">
                <Badge color={color(s)}>{s}</Badge>
              </button>
            ))}
            {onAddOption && (
              <button onClick={addCustom} className="flex w-full items-center px-2 py-1 text-xs font-mono text-inky hover:bg-navy/5">＋ custom…</button>
            )}
          </div>
        </>
      )}
    </>
  )
}

function EditableCell({ value, type, onSave, placeholder }: { value: string | null; type: CellType; onSave: (v: string) => void; placeholder?: string }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  return (
    <input
      value={v}
      type={type === 'date' ? 'date' : 'text'}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((value ?? '') !== v) onSave(v) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      className="w-full bg-transparent px-2 py-1 text-xs font-mono text-navy placeholder-inky/50 rounded border border-transparent hover:border-navy/30 focus:border-[#00e5ff] focus:bg-cream focus:outline-none"
    />
  )
}

// Sortable header cell with a drag grip, sort click, pin toggle, and resize handle.
function HeaderCell({ col, left, sortDir, onSort, onTogglePin, onResize }: {
  col: { key: string; label: string; width: number; pinned: boolean }
  left: number | null
  sortDir: 'asc' | 'desc' | null
  onSort: () => void
  onTogglePin: () => void
  onResize: (w: number) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: col.key })
  const style: React.CSSProperties = {
    width: col.width, minWidth: col.width, maxWidth: col.width,
    transform: CSS.Transform.toString(transform), transition,
    ...(left != null ? { position: 'sticky', left, zIndex: 20 } : {}),
  }
  function startResize(e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation()
    const startX = e.clientX, startW = col.width
    const move = (ev: MouseEvent) => onResize(startW + (ev.clientX - startX))
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  return (
    <th ref={setNodeRef} style={style}
      className={['relative select-none border-b border-r border-navy/30 bg-cream px-1 py-2 text-left', isDragging ? 'opacity-60' : ''].join(' ')}>
      <div className="flex items-center gap-1">
        <span {...attributes} {...listeners} className="cursor-grab text-inky/70 hover:text-navy" title="Drag to reorder">⋮⋮</span>
        <button onClick={onSort} className="flex-1 truncate text-left text-[11px] font-mono uppercase tracking-wide text-inky hover:text-navy">
          {col.label}{sortDir ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button onClick={onTogglePin} title={col.pinned ? 'Unpin' : 'Pin to left'}
          className={['px-0.5 text-xs', col.pinned ? 'text-orange-600' : 'text-inky/70 hover:text-navy'].join(' ')}>📌</button>
      </div>
      <span onMouseDown={startResize} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#00e5ff]/40" />
    </th>
  )
}

// ---------------------------------------------------------------------------
function AssigneeCell({ taskId, value, profiles, onSave }: {
  taskId: string; value: string | null; profiles: Profile[]; onSave: (v: string) => void
}) {
  const [v, setV] = useState(value ?? '')
  const listId = `assignee-${taskId}`
  useEffect(() => { setV(value ?? '') }, [value])
  return (
    <>
      <input
        value={v}
        list={listId}
        placeholder="—"
        onChange={(e) => setV(e.target.value)}
        onBlur={() => { if ((value ?? '') !== v) onSave(v) }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
        className="w-full bg-transparent px-2 py-1 text-xs font-mono text-navy placeholder-inky/50 rounded border border-transparent hover:border-navy/30 focus:border-[#00e5ff] focus:bg-cream focus:outline-none"
      />
      <datalist id={listId}>
        {profiles.map((p) => (
          <option key={p.id} value={p.full_name ?? p.email ?? ''} />
        ))}
      </datalist>
    </>
  )
}

function LinkedTaskRow({ task, subColWidths, onToggle }: {
  task: Task
  subColWidths: Record<string, number>
  onToggle: (id: string, done: boolean) => void
}) {
  function tdStyle(key: string): React.CSSProperties {
    const w = subColWidths[key] ?? SUBTASK_COL_DEFAULTS[key]
    return { width: w, minWidth: w, maxWidth: w, overflow: 'hidden' }
  }
  return (
    <tr className="border-t border-navy/30/50">
      <td style={{ width: 28, minWidth: 28 }} />
      <td style={{ width: 32, minWidth: 32 }} className="px-2 text-center">
        <input type="checkbox" checked={task.completed} className="accent-inky"
          onChange={(e) => onToggle(task.id, e.target.checked)} />
      </td>
      <td style={tdStyle('task')} className="px-2 py-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={['text-xs font-mono truncate', task.completed ? 'line-through text-inky/40' : 'text-navy'].join(' ')}>
            {task.title}
          </span>
          <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-mono bg-navy/10 text-inky/60 leading-none uppercase">mtg</span>
        </div>
      </td>
      <td style={tdStyle('status')} className="px-2 py-1 text-xs font-mono text-inky/30">—</td>
      <td style={tdStyle('assignee')} className="px-2 py-1 text-xs font-mono text-navy truncate">{task.assignee_name ?? '—'}</td>
      <td style={tdStyle('due')} className="px-2 py-1 text-xs font-mono text-inky/60">
        {task.target_date ? format(new Date(task.target_date + 'T00:00:00'), 'MMM d, yyyy') : '—'}
      </td>
      <td style={tdStyle('notes')} className="px-2 py-1 text-xs font-mono text-inky/60 truncate">{task.notes ?? ''}</td>
      <td style={{ width: 32, minWidth: 32 }} />
    </tr>
  )
}

function SubTasks({ projectId, tasks, linkedTasks, onAdd, onUpdate, onDelete, onReorder, onToggleLinked, statusOptions, onAddStatus, subColWidths, onSubColResize, profiles }: {
  projectId: string
  tasks: ProjectTask[]
  linkedTasks: Task[]
  onAdd: (projectId: string) => void
  onUpdate: (id: string, patch: Partial<ProjectTask>) => void
  onDelete: (id: string) => void
  onReorder: (projectId: string, ordered: ProjectTask[]) => void
  onToggleLinked: (id: string, done: boolean) => void
  statusOptions: string[]
  onAddStatus: (name: string) => void
  subColWidths: Record<string, number>
  onSubColResize: (key: string, w: number) => void
  profiles: Profile[]
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = tasks.map((t) => t.id)
    onReorder(projectId, arrayMove(tasks, ids.indexOf(active.id as string), ids.indexOf(over.id as string)))
  }
  return (
    <div className="border-l-2 border-[#00e5ff]/30 bg-sky/10 pl-6 pr-3 py-3">
      <div className="overflow-x-auto rounded border border-navy/30">
        <table className="text-xs font-mono" style={{ tableLayout: 'fixed', minWidth: '100%' }}>
          <thead className="bg-[#002745] text-[#6A9AB2] uppercase tracking-wide">
            <tr>
              <th style={{ width: 28, minWidth: 28 }} />
              <th style={{ width: 32, minWidth: 32 }} className="px-2 py-1.5 text-left">✓</th>
              {SUBTASK_COLS.map((c) => (
                <SubTaskHeaderCell key={c.key} colKey={c.key} label={c.label}
                  width={subColWidths[c.key] ?? SUBTASK_COL_DEFAULTS[c.key]}
                  onResize={onSubColResize} />
              ))}
              <th style={{ width: 32, minWidth: 32 }} />
            </tr>
          </thead>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <tbody>
                {tasks.map((t) => <SubTaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} statusOptions={statusOptions} onAddStatus={onAddStatus} subColWidths={subColWidths} profiles={profiles} />)}
                {tasks.length === 0 && (
                  <tr><td colSpan={8} className="px-2 py-2 text-inky/70">No tasks yet.</td></tr>
                )}
              </tbody>
            </SortableContext>
          </DndContext>
          {linkedTasks.length > 0 && (
            <tbody>
              <tr>
                <td colSpan={8} className="border-t-2 border-navy/20 bg-navy/5 px-3 py-1 text-[10px] font-mono uppercase tracking-widest text-inky/50">
                  Linked from meetings
                </td>
              </tr>
              {linkedTasks.map((t) => (
                <LinkedTaskRow key={t.id} task={t} subColWidths={subColWidths} onToggle={onToggleLinked} />
              ))}
            </tbody>
          )}
        </table>
      </div>
      <button onClick={() => onAdd(projectId)} className="mt-2 text-xs font-mono text-inky hover:underline">+ Add task</button>
    </div>
  )
}

function SubTaskRow({ task, onUpdate, onDelete, statusOptions, onAddStatus, subColWidths, profiles }: { task: ProjectTask; onUpdate: (id: string, patch: Partial<ProjectTask>) => void; onDelete: (id: string) => void; statusOptions: string[]; onAddStatus: (name: string) => void; subColWidths: Record<string, number>; profiles: Profile[] }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  function tdStyle(key: string): React.CSSProperties {
    const w = subColWidths[key] ?? SUBTASK_COL_DEFAULTS[key as keyof typeof SUBTASK_COL_DEFAULTS]
    return { width: w, minWidth: w, maxWidth: w, overflow: 'hidden' }
  }
  return (
    <tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={['border-t border-navy/30/50', isDragging ? 'opacity-60' : ''].join(' ')}>
      <td {...attributes} {...listeners} style={{ width: 28, minWidth: 28 }} className="cursor-grab px-1 text-center text-inky/70">⋮⋮</td>
      <td style={{ width: 32, minWidth: 32 }} className="px-2 text-center">
        <input type="checkbox" checked={task.done} className="accent-inky"
          onChange={(e) => onUpdate(task.id, { done: e.target.checked, status: e.target.checked ? 'Complete' : task.status })} />
      </td>
      <td style={tdStyle('task')}><EditableCell value={task.task_name} type="text" placeholder="Task name…" onSave={(v) => onUpdate(task.id, { task_name: v })} /></td>
      <td style={tdStyle('status')}><StatusPill value={task.status} onChange={(v) => onUpdate(task.id, { status: v })} options={statusOptions} colorOf={colorForStatus} onAddOption={onAddStatus} /></td>
      <td style={tdStyle('assignee')}><AssigneeCell taskId={task.id} value={task.assignee} profiles={profiles} onSave={(v) => onUpdate(task.id, { assignee: v || null })} /></td>
      <td style={tdStyle('due')}><EditableCell value={task.due_date} type="date" onSave={(v) => onUpdate(task.id, { due_date: v || null })} /></td>
      <td style={tdStyle('notes')}><ExpandableTextCell value={task.notes} placeholder="—" onSave={(v) => onUpdate(task.id, { notes: v || null })} /></td>
      <td style={{ width: 32, minWidth: 32 }} className="px-1 text-center"><button onClick={() => onDelete(task.id)} className="text-inky/70 hover:text-red-400">✕</button></td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
export function ProjectsModule() {
  const { projects, tasks, loading, companyId, addProject, updateProject, deleteProject, addTask, updateTask, deleteTask, reorderTasks } = useProjects()
  const { columns, setOrder, togglePin, toggleVisible, setWidth } = useProjectColumns(COLUMN_DEFS)

  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])
  useEffect(() => {
    if (!companyId) return
    ;(supabase as any).from('profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name')
      .then(({ data }: any) => setOrgProfiles((data ?? []) as Profile[]))
  }, [companyId])

  const [linkedTasks, setLinkedTasks] = useState<Task[]>([])
  useEffect(() => {
    if (!companyId) return
    ;(supabase as any).from('tasks').select('*').eq('company_id', companyId).not('project_id', 'is', null).order('created_at')
      .then(({ data }: any) => setLinkedTasks((data ?? []) as Task[]))
  }, [companyId])

  async function toggleLinkedTask(id: string, done: boolean) {
    setLinkedTasks((prev) => prev.map((t) => t.id === id ? { ...t, completed: done } : t))
    await (supabase as any).from('tasks').update({
      completed: done,
      completed_at: done ? new Date().toISOString() : null,
    }).eq('id', id)
  }

  const [subColWidths, setSubColWidthsState] = useState<Record<string, number>>(loadSubColWidths)
  function setSubColWidth(key: string, w: number) {
    setSubColWidthsState((prev) => {
      const next = { ...prev, [key]: Math.max(60, w) }
      localStorage.setItem(SUBTASK_LS_KEY, JSON.stringify(next))
      return next
    })
  }

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [groupBy, setGroupBy] = useState<'none' | 'status' | 'category'>('none')
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const focusName = useRef<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Custom statuses (shared by projects + sub-tasks), persisted per company.
  const [customStatuses, setCustomStatuses] = useAppSetting<string[]>('project_custom_statuses', [])
  const statusOptions = useMemo(() => [...STATUS_OPTIONS, ...customStatuses.filter((s) => !STATUS_OPTIONS.includes(s))], [customStatuses])
  const addStatus = (name: string) => { if (!statusOptions.includes(name)) setCustomStatuses([...customStatuses, name]) }

  const visible = useMemo(() => columns.filter((c) => c.visible), [columns])
  const ordered = useMemo(() => [...visible.filter((c) => c.pinned), ...visible.filter((c) => !c.pinned)], [visible])
  const leftOffsets = useMemo(() => {
    const o: Record<string, number> = {}
    let acc = CTRL_W
    for (const c of ordered) { if (c.pinned) { o[c.key] = acc; acc += c.width } }
    return o
  }, [ordered])
  const totalCols = ordered.length + 2 // control + data + actions

  const rows = useMemo(() => {
    let r = projects
    const q = search.trim().toLowerCase()
    if (q) {
      r = r.filter((p) => visible.some((c) => String((p as any)[c.key] ?? '').toLowerCase().includes(q)))
    }
    if (sort) {
      const { key, dir } = sort
      r = [...r].sort((a, b) => {
        const av = String((a as any)[key] ?? ''), bv = String((b as any)[key] ?? '')
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
      })
    }
    return r
  }, [projects, search, sort, visible])

  const grouped = useMemo(() => {
    if (groupBy === 'none') return [{ label: null as string | null, items: rows }]
    const map = new Map<string, Project[]>()
    for (const p of rows) {
      const k = (groupBy === 'status' ? p.status : p.category) || '(None)'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(p)
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }))
  }, [rows, groupBy])

  function toggleExpand(id: string) {
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function onHeaderSort(key: string) {
    setSort((s) => (s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }))
  }
  function onColumnDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const keys = ordered.map((c) => c.key)
    setOrder(arrayMove(keys, keys.indexOf(active.id as string), keys.indexOf(over.id as string)))
  }
  async function onNewProject() {
    const p = await addProject()
    if (p) { focusName.current = p.id; setExpanded((prev) => new Set(prev)) }
  }
  // Focus the name input of a freshly-created project.
  useEffect(() => {
    if (!focusName.current) return
    const el = document.querySelector<HTMLInputElement>(`[data-name-input="${focusName.current}"]`)
    el?.focus()
    focusName.current = null
  })

  function renderCell(p: Project, key: string) {
    const type = TYPE_OF[key]
    if (type === 'status') return <StatusPill value={p.status} onChange={(v) => updateProject(p.id, { status: v })} options={statusOptions} colorOf={colorForStatus} onAddOption={addStatus} />
    if (type === 'datetime') return <span className="px-2 text-xs font-mono text-inky">{p.last_update ? format(new Date(p.last_update), 'MMM d, h:mm a') : '—'}</span>
    if (key === 'description') return <ExpandableTextCell value={p.description} placeholder="Description…" onSave={(v) => updateProject(p.id, { description: v || null })} />
    const dataKey = key === 'project_name' ? { 'data-name-input': p.id } : {}
    return (
      <span {...dataKey as any}>
        <EditableCell value={(p as any)[key] ?? ''} type={type}
          placeholder={key === 'project_name' ? 'Project name…' : '—'}
          onSave={(v) => updateProject(p.id, { [key]: v || null } as Partial<Project>)} />
      </span>
    )
  }

  if (!companyId) return <div className="py-8 text-xs font-mono text-inky">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold uppercase tracking-wide text-navy">Projects</h1>
          <p className="mt-0.5 text-xs text-inky">Track projects and their sub-tasks</p>
        </div>
        <Button size="sm" onClick={onNewProject}>+ New Project</Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
          className="w-full sm:w-56 rounded border border-navy/30 bg-cream px-3 py-1.5 text-xs font-mono text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none" />
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}
          className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
          <option value="none">Group: None</option>
          <option value="status">Group by Status</option>
          <option value="category">Group by Category</option>
        </select>
        <div className="relative">
          <button onClick={() => setColMenuOpen((o) => !o)}
            className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy hover:text-navy">Columns ▾</button>
          {colMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColMenuOpen(false)} />
              <div className="absolute z-50 mt-1 w-48 rounded border border-navy/30 bg-cream p-2 shadow-xl">
                {columns.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs font-mono text-navy">
                    <input type="checkbox" checked={c.visible} onChange={() => toggleVisible(c.key)} className="accent-inky" />
                    {c.label}
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="py-8 text-xs font-mono text-inky">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-navy/30 py-16">
          <p className="text-sm font-mono text-inky">No projects yet</p>
          <Button size="sm" onClick={onNewProject}>+ New Project</Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-navy/30">
          <table className="border-collapse text-xs font-mono" style={{ minWidth: '100%' }}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onColumnDragEnd}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-30 border-b border-r border-navy/30 bg-navy" style={{ width: CTRL_W, minWidth: CTRL_W }} />
                  <SortableContext items={ordered.map((c) => c.key)} strategy={horizontalListSortingStrategy}>
                    {ordered.map((c) => (
                      <HeaderCell key={c.key} col={c} left={c.pinned ? leftOffsets[c.key] : null}
                        sortDir={sort?.key === c.key ? sort.dir : null}
                        onSort={() => onHeaderSort(c.key)} onTogglePin={() => togglePin(c.key)}
                        onResize={(w) => setWidth(c.key, w)} />
                    ))}
                  </SortableContext>
                  <th className="border-b border-navy/30 bg-navy px-2" />
                </tr>
              </thead>
            </DndContext>
            <tbody>
              {grouped.map((g) => (
                <GroupBlock key={g.label ?? '__all'} label={g.label} count={g.items.length} totalCols={totalCols}>
                  {g.items.map((p) => (
                    <ProjectRowFragment key={p.id} project={p} ordered={ordered} leftOffsets={leftOffsets} totalCols={totalCols}
                      expanded={expanded.has(p.id)} onToggle={() => toggleExpand(p.id)}
                      renderCell={renderCell} onDelete={() => deleteProject(p.id)}
                      tasks={tasks.filter((t) => t.project_id === p.id).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))}
                      linkedTasks={linkedTasks.filter((t) => t.project_id === p.id)}
                      onAddTask={addTask} onUpdateTask={updateTask} onDeleteTask={deleteTask} onReorderTask={reorderTasks}
                      onToggleLinked={toggleLinkedTask}
                      statusOptions={statusOptions} onAddStatus={addStatus}
                      subColWidths={subColWidths} onSubColResize={setSubColWidth} profiles={orgProfiles} />
                  ))}
                </GroupBlock>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function GroupBlock({ label, count, totalCols, children }: { label: string | null; count: number; totalCols: number; children: React.ReactNode }) {
  if (label === null) return <>{children}</>
  return (
    <>
      <tr><td colSpan={totalCols} className="sticky left-0 border-y border-navy/30 bg-sky/10 px-3 py-1.5 text-xs font-mono uppercase tracking-wide text-inky">{label} <span className="text-inky/70">· {count}</span></td></tr>
      {children}
    </>
  )
}

function ProjectRowFragment({ project, ordered, leftOffsets, totalCols, expanded, onToggle, renderCell, onDelete, tasks, linkedTasks, onAddTask, onUpdateTask, onDeleteTask, onReorderTask, onToggleLinked, statusOptions, onAddStatus, subColWidths, onSubColResize, profiles }: {
  project: Project
  ordered: { key: string; width: number; pinned: boolean }[]
  leftOffsets: Record<string, number>
  totalCols: number
  expanded: boolean
  onToggle: () => void
  renderCell: (p: Project, key: string) => React.ReactNode
  onDelete: () => void
  tasks: ProjectTask[]
  linkedTasks: Task[]
  onAddTask: (projectId: string) => void
  onUpdateTask: (id: string, patch: Partial<ProjectTask>) => void
  onDeleteTask: (id: string) => void
  onReorderTask: (projectId: string, ordered: ProjectTask[]) => void
  onToggleLinked: (id: string, done: boolean) => void
  statusOptions: string[]
  profiles: Profile[]
  onAddStatus: (name: string) => void
  subColWidths: Record<string, number>
  onSubColResize: (key: string, w: number) => void
}) {
  const taskCount = tasks.length + linkedTasks.length
  const doneCount = tasks.filter((t) => t.done).length + linkedTasks.filter((t) => t.completed).length
  return (
    <>
      <tr className="border-t border-navy/30/50 hover:bg-navy/5">
        <td className="sticky left-0 z-10 border-r border-navy/30 bg-cream text-center" style={{ width: CTRL_W, minWidth: CTRL_W }}>
          <button onClick={onToggle} className="px-2 py-1 text-inky hover:text-inky" title={expanded ? 'Collapse' : 'Expand'}>
            <span className={['inline-block transition-transform', expanded ? 'rotate-90' : ''].join(' ')}>▶</span>
          </button>
        </td>
        {ordered.map((c) => (
          <td key={c.key} style={{ width: c.width, minWidth: c.width, maxWidth: c.width, ...(c.pinned ? { position: 'sticky', left: leftOffsets[c.key], zIndex: 10 } : {}) }}
            className={['border-r border-navy/30/50 align-middle', c.pinned ? 'bg-cream' : ''].join(' ')}>
            {renderCell(project, c.key)}
          </td>
        ))}
        <td className="px-2 text-center">
          <div className="flex items-center gap-2">
            {taskCount > 0 && <span className="text-[10px] text-inky/70">{doneCount}/{taskCount}</span>}
            <button onClick={onDelete} className="text-inky/70 hover:text-red-400" title="Delete project">✕</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td />
          <td colSpan={totalCols - 1} className="p-0">
            <SubTasks projectId={project.id} tasks={tasks} linkedTasks={linkedTasks} onAdd={onAddTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} onReorder={onReorderTask} onToggleLinked={onToggleLinked} statusOptions={statusOptions} onAddStatus={onAddStatus} subColWidths={subColWidths} onSubColResize={onSubColResize} profiles={profiles} />
          </td>
        </tr>
      )}
    </>
  )
}
