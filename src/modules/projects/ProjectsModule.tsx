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
import type { Project, ProjectTask } from '@/types'

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

const STATUS_OPTIONS = ['Not Started', 'In Progress', 'Blocked', 'Complete']
const STATUS_COLOR: Record<string, 'gray' | 'cyan' | 'red' | 'green'> = {
  'Not Started': 'gray', 'In Progress': 'cyan', 'Blocked': 'red', 'Complete': 'green',
}
const CTRL_W = 64

// ---------------------------------------------------------------------------
function StatusPill({ value, onChange, options = STATUS_OPTIONS, colorOf }: {
  value: string | null
  onChange: (v: string) => void
  options?: string[]
  colorOf?: (s: string) => 'gray' | 'cyan' | 'red' | 'green' | 'amber' | 'magenta'
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const v = value ?? 'Not Started'
  const color = (s: string) => (colorOf ? colorOf(s) : (STATUS_COLOR[s] ?? 'gray'))
  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      setRect({ left: r.left, top: r.bottom + 4 })
    }
    setOpen((o) => !o)
  }
  return (
    <>
      <button ref={btnRef} onClick={toggle}><Badge color={color(v)}>{v}</Badge></button>
      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          {/* fixed so the menu isn't clipped by the grid's overflow container */}
          <div className="fixed z-[61] w-44 rounded border border-[#2a2d3e] bg-[#161820] py-1 shadow-xl" style={{ left: rect.left, top: rect.top }}>
            {options.map((s) => (
              <button key={s} onClick={() => { onChange(s); setOpen(false) }} className="flex w-full items-center px-2 py-1 hover:bg-white/5">
                <Badge color={color(s)}>{s}</Badge>
              </button>
            ))}
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
      className="w-full bg-transparent px-2 py-1 text-xs font-mono text-gray-200 placeholder-gray-600 rounded border border-transparent hover:border-[#2a2d3e] focus:border-[#00e5ff] focus:bg-[#0f1117] focus:outline-none"
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
      className={['relative select-none border-b border-r border-[#2a2d3e] bg-[#161820] px-1 py-2 text-left', isDragging ? 'opacity-60' : ''].join(' ')}>
      <div className="flex items-center gap-1">
        <span {...attributes} {...listeners} className="cursor-grab text-gray-600 hover:text-gray-300" title="Drag to reorder">⋮⋮</span>
        <button onClick={onSort} className="flex-1 truncate text-left text-[11px] font-mono uppercase tracking-wide text-gray-400 hover:text-white">
          {col.label}{sortDir ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
        <button onClick={onTogglePin} title={col.pinned ? 'Unpin' : 'Pin to left'}
          className={['px-0.5 text-xs', col.pinned ? 'text-[#ffb300]' : 'text-gray-600 hover:text-gray-300'].join(' ')}>📌</button>
      </div>
      <span onMouseDown={startResize} className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-[#00e5ff]/40" />
    </th>
  )
}

// ---------------------------------------------------------------------------
function SubTasks({ projectId, tasks, onAdd, onUpdate, onDelete, onReorder }: {
  projectId: string
  tasks: ProjectTask[]
  onAdd: (projectId: string) => void
  onUpdate: (id: string, patch: Partial<ProjectTask>) => void
  onDelete: (id: string) => void
  onReorder: (projectId: string, ordered: ProjectTask[]) => void
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const ids = tasks.map((t) => t.id)
    onReorder(projectId, arrayMove(tasks, ids.indexOf(active.id as string), ids.indexOf(over.id as string)))
  }
  return (
    <div className="border-l-2 border-[#00e5ff]/30 bg-[#0d0f15] pl-6 pr-3 py-3">
      <div className="overflow-hidden rounded border border-[#2a2d3e]">
        <table className="w-full text-xs font-mono">
          <thead className="bg-[#161820] text-gray-500 uppercase tracking-wide">
            <tr>
              <th className="w-8" />
              <th className="w-8 px-2 py-1.5 text-left">✓</th>
              <th className="px-2 py-1.5 text-left">Task</th>
              <th className="w-32 px-2 py-1.5 text-left">Status</th>
              <th className="w-32 px-2 py-1.5 text-left">Assignee</th>
              <th className="w-32 px-2 py-1.5 text-left">Due</th>
              <th className="px-2 py-1.5 text-left">Notes</th>
              <th className="w-8" />
            </tr>
          </thead>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              <tbody>
                {tasks.map((t) => <SubTaskRow key={t.id} task={t} onUpdate={onUpdate} onDelete={onDelete} />)}
                {tasks.length === 0 && (
                  <tr><td colSpan={8} className="px-2 py-2 text-gray-600">No tasks yet.</td></tr>
                )}
              </tbody>
            </SortableContext>
          </DndContext>
        </table>
      </div>
      <button onClick={() => onAdd(projectId)} className="mt-2 text-xs font-mono text-[#00e5ff] hover:underline">+ Add task</button>
    </div>
  )
}

function SubTaskRow({ task, onUpdate, onDelete }: { task: ProjectTask; onUpdate: (id: string, patch: Partial<ProjectTask>) => void; onDelete: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: task.id })
  return (
    <tr ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={['border-t border-[#2a2d3e]/50', isDragging ? 'opacity-60' : ''].join(' ')}>
      <td {...attributes} {...listeners} className="cursor-grab px-1 text-center text-gray-600">⋮⋮</td>
      <td className="px-2 text-center">
        <input type="checkbox" checked={task.done} className="accent-[#39ff14]"
          onChange={(e) => onUpdate(task.id, { done: e.target.checked, status: e.target.checked ? 'Complete' : task.status })} />
      </td>
      <td><EditableCell value={task.task_name} type="text" placeholder="Task name…" onSave={(v) => onUpdate(task.id, { task_name: v })} /></td>
      <td><StatusPill value={task.status} onChange={(v) => onUpdate(task.id, { status: v })} /></td>
      <td><EditableCell value={task.assignee} type="text" placeholder="—" onSave={(v) => onUpdate(task.id, { assignee: v })} /></td>
      <td><EditableCell value={task.due_date} type="date" onSave={(v) => onUpdate(task.id, { due_date: v || null })} /></td>
      <td><EditableCell value={task.notes} type="text" placeholder="—" onSave={(v) => onUpdate(task.id, { notes: v })} /></td>
      <td className="px-1 text-center"><button onClick={() => onDelete(task.id)} className="text-gray-600 hover:text-red-400">✕</button></td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
export function ProjectsModule() {
  const { projects, tasks, loading, companyId, addProject, updateProject, deleteProject, addTask, updateTask, deleteTask, reorderTasks } = useProjects()
  const { columns, setOrder, togglePin, toggleVisible, setWidth } = useProjectColumns(COLUMN_DEFS)

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [groupBy, setGroupBy] = useState<'none' | 'status' | 'category'>('none')
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const focusName = useRef<string | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

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
    if (type === 'status') return <StatusPill value={p.status} onChange={(v) => updateProject(p.id, { status: v })} />
    if (type === 'datetime') return <span className="px-2 text-xs font-mono text-gray-500">{p.last_update ? format(new Date(p.last_update), 'MMM d, h:mm a') : '—'}</span>
    const dataKey = key === 'project_name' ? { 'data-name-input': p.id } : {}
    return (
      <span {...dataKey as any}>
        <EditableCell value={(p as any)[key] ?? ''} type={type}
          placeholder={key === 'project_name' ? 'Project name…' : '—'}
          onSave={(v) => updateProject(p.id, { [key]: v || null } as Partial<Project>)} />
      </span>
    )
  }

  if (!companyId) return <div className="py-8 text-xs font-mono text-gray-500">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold uppercase tracking-wide text-white">Projects</h1>
          <p className="mt-0.5 text-xs text-gray-500">Track projects and their sub-tasks</p>
        </div>
        <Button size="sm" onClick={onNewProject}>+ New Project</Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
          className="w-56 rounded border border-[#2a2d3e] bg-[#0f1117] px-3 py-1.5 text-xs font-mono text-white placeholder-gray-600 focus:border-[#00e5ff] focus:outline-none" />
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)}
          className="rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1.5 text-xs font-mono text-white focus:border-[#00e5ff] focus:outline-none">
          <option value="none">Group: None</option>
          <option value="status">Group by Status</option>
          <option value="category">Group by Category</option>
        </select>
        <div className="relative">
          <button onClick={() => setColMenuOpen((o) => !o)}
            className="rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1.5 text-xs font-mono text-gray-300 hover:text-white">Columns ▾</button>
          {colMenuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setColMenuOpen(false)} />
              <div className="absolute z-50 mt-1 w-48 rounded border border-[#2a2d3e] bg-[#161820] p-2 shadow-xl">
                {columns.map((c) => (
                  <label key={c.key} className="flex cursor-pointer items-center gap-2 px-1 py-1 text-xs font-mono text-gray-300">
                    <input type="checkbox" checked={c.visible} onChange={() => toggleVisible(c.key)} className="accent-[#00e5ff]" />
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
        <div className="py-8 text-xs font-mono text-gray-500">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded border border-dashed border-[#2a2d3e] py-16">
          <p className="text-sm font-mono text-gray-400">No projects yet</p>
          <Button size="sm" onClick={onNewProject}>+ New Project</Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-[#2a2d3e]">
          <table className="border-collapse text-xs font-mono" style={{ minWidth: '100%' }}>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onColumnDragEnd}>
              <thead>
                <tr>
                  <th className="sticky left-0 z-30 border-b border-r border-[#2a2d3e] bg-[#161820]" style={{ width: CTRL_W, minWidth: CTRL_W }} />
                  <SortableContext items={ordered.map((c) => c.key)} strategy={horizontalListSortingStrategy}>
                    {ordered.map((c) => (
                      <HeaderCell key={c.key} col={c} left={c.pinned ? leftOffsets[c.key] : null}
                        sortDir={sort?.key === c.key ? sort.dir : null}
                        onSort={() => onHeaderSort(c.key)} onTogglePin={() => togglePin(c.key)}
                        onResize={(w) => setWidth(c.key, w)} />
                    ))}
                  </SortableContext>
                  <th className="border-b border-[#2a2d3e] bg-[#161820] px-2" />
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
                      onAddTask={addTask} onUpdateTask={updateTask} onDeleteTask={deleteTask} onReorderTask={reorderTasks} />
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
      <tr><td colSpan={totalCols} className="sticky left-0 border-y border-[#2a2d3e] bg-[#0d0f15] px-3 py-1.5 text-xs font-mono uppercase tracking-wide text-gray-400">{label} <span className="text-gray-600">· {count}</span></td></tr>
      {children}
    </>
  )
}

function ProjectRowFragment({ project, ordered, leftOffsets, totalCols, expanded, onToggle, renderCell, onDelete, tasks, onAddTask, onUpdateTask, onDeleteTask, onReorderTask }: {
  project: Project
  ordered: { key: string; width: number; pinned: boolean }[]
  leftOffsets: Record<string, number>
  totalCols: number
  expanded: boolean
  onToggle: () => void
  renderCell: (p: Project, key: string) => React.ReactNode
  onDelete: () => void
  tasks: ProjectTask[]
  onAddTask: (projectId: string) => void
  onUpdateTask: (id: string, patch: Partial<ProjectTask>) => void
  onDeleteTask: (id: string) => void
  onReorderTask: (projectId: string, ordered: ProjectTask[]) => void
}) {
  const taskCount = tasks.length
  const doneCount = tasks.filter((t) => t.done).length
  return (
    <>
      <tr className="border-t border-[#2a2d3e]/50 hover:bg-white/[0.02]">
        <td className="sticky left-0 z-10 border-r border-[#2a2d3e] bg-[#0f1117] text-center" style={{ width: CTRL_W, minWidth: CTRL_W }}>
          <button onClick={onToggle} className="px-2 py-1 text-gray-500 hover:text-[#00e5ff]" title={expanded ? 'Collapse' : 'Expand'}>
            <span className={['inline-block transition-transform', expanded ? 'rotate-90' : ''].join(' ')}>▶</span>
          </button>
        </td>
        {ordered.map((c) => (
          <td key={c.key} style={{ width: c.width, minWidth: c.width, maxWidth: c.width, ...(c.pinned ? { position: 'sticky', left: leftOffsets[c.key], zIndex: 10 } : {}) }}
            className={['border-r border-[#2a2d3e]/50 align-middle', c.pinned ? 'bg-[#0f1117]' : ''].join(' ')}>
            {renderCell(project, c.key)}
          </td>
        ))}
        <td className="px-2 text-center">
          <div className="flex items-center gap-2">
            {taskCount > 0 && <span className="text-[10px] text-gray-600">{doneCount}/{taskCount}</span>}
            <button onClick={onDelete} className="text-gray-600 hover:text-red-400" title="Delete project">✕</button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td />
          <td colSpan={totalCols - 1} className="p-0">
            <SubTasks projectId={project.id} tasks={tasks} onAdd={onAddTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} onReorder={onReorderTask} />
          </td>
        </tr>
      )}
    </>
  )
}
