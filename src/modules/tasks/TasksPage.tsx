import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Badge, Button, Input, Modal } from '@/components/ui'
import { AssigneeComboInput } from '@/components/shared/AssigneeComboInput'
import type { Profile, Project, ProjectTask, ScheduleEvent, Task } from '@/types'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

type SortKey = 'date' | 'source' | 'title'
type TaskSource = 'project' | 'calendar' | 'meeting' | 'standalone'

interface UnifiedTask {
  key: string
  id: string
  title: string
  notes: string | null
  targetDate: string | null
  completed: boolean
  source: TaskSource
  sourceLabel: string
  projectId?: string
  createdBy: string | null
  assigneeId: string | null
  assigneeDisplay: string | null
  isPublic: boolean
}

function sourceColor(s: TaskSource): 'navy' | 'sky' | 'orange' | 'inky' {
  if (s === 'project') return 'navy'
  if (s === 'calendar') return 'sky'
  if (s === 'meeting') return 'orange'
  return 'inky'
}

function dateLabel(d: string | null): string {
  if (!d) return ''
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

function isOverdue(d: string | null, completed: boolean): boolean {
  if (!d || completed) return false
  try { return parseISO(d) < new Date(new Date().toDateString()) } catch { return false }
}

function sortTasks(tasks: UnifiedTask[], key: SortKey): UnifiedTask[] {
  return [...tasks].sort((a, b) => {
    if (key === 'date') {
      if (!a.targetDate && !b.targetDate) return 0
      if (!a.targetDate) return 1
      if (!b.targetDate) return -1
      return a.targetDate < b.targetDate ? -1 : 1
    }
    if (key === 'source') {
      const order: TaskSource[] = ['project', 'calendar', 'meeting', 'standalone']
      return order.indexOf(a.source) - order.indexOf(b.source)
    }
    return a.title.localeCompare(b.title)
  })
}

const EMPTY_FORM = {
  title: '', notes: '', target_date: '', project_id: '', assignee_input: '', is_public: false,
}

export function TasksPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myId = profile?.id ?? null

  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectTasks, setProjectTasks] = useState<ProjectTask[]>([])
  const [calendarTasks, setCalendarTasks] = useState<ScheduleEvent[]>([])
  const [standaloneTasks, setStandaloneTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  const [sort, setSort] = useAppSetting<SortKey>('tasks.sort', 'date')
  const [showCompleted, setShowCompleted] = useAppSetting<boolean>('tasks.showCompleted', false)

  const [addOpen, setAddOpen] = useState(false)
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const [editSource, setEditSource] = useState<TaskSource | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  const loadAll = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [profRes, projRes, ptRes, ctRes, stRes] = await Promise.all([
      sb.from('profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name'),
      sb.from('projects').select('id, project_name, status').eq('company_id', companyId),
      sb.from('project_tasks').select('*').eq('company_id', companyId).order('sort_order'),
      sb.from('schedule_events').select('*').eq('company_id', companyId).eq('is_checklist', true).order('start_date'),
      sb.from('tasks').select('*').eq('company_id', companyId).order('sort_order').order('created_at'),
    ])
    setOrgProfiles((profRes.data ?? []) as Profile[])
    setProjects((projRes.data ?? []) as Project[])
    setProjectTasks((ptRes.data ?? []) as ProjectTask[])
    setCalendarTasks((ctRes.data ?? []) as ScheduleEvent[])
    setStandaloneTasks((stRes.data ?? []) as Task[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { loadAll() }, [loadAll])

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p.project_name])), [projects])
  const profileById = useMemo(() => new Map(orgProfiles.map((p) => [p.id, p.full_name ?? p.email ?? p.id])), [orgProfiles])

  const openProjects = useMemo(
    () => projects.filter((p) => p.status !== 'Complete' && p.status !== 'Cancelled'),
    [projects]
  )

  const unified = useMemo<UnifiedTask[]>(() => {
    return [
      ...projectTasks.map((t) => ({
        key: `pt-${t.id}`,
        id: t.id,
        title: t.task_name,
        notes: t.notes,
        targetDate: t.due_date,
        completed: t.done,
        source: 'project' as const,
        sourceLabel: projectById.get(t.project_id) ?? 'Project',
        projectId: t.project_id,
        createdBy: null,
        assigneeId: null,
        assigneeDisplay: t.assignee ?? null,
        isPublic: true,
      })),
      ...calendarTasks.map((t) => ({
        key: `cal-${t.id}`,
        id: t.id,
        title: t.title,
        notes: t.notes ?? null,
        targetDate: t.start_date,
        completed: t.completed,
        source: 'calendar' as const,
        sourceLabel: 'Calendar',
        createdBy: null,
        assigneeId: null,
        assigneeDisplay: null,
        isPublic: true,
      })),
      ...standaloneTasks.map((t) => ({
        key: `task-${t.id}`,
        id: t.id,
        title: t.title,
        notes: t.notes,
        targetDate: t.target_date,
        completed: t.completed,
        source: (t.source === 'meeting' ? 'meeting' : 'standalone') as TaskSource,
        sourceLabel: t.source === 'meeting' ? 'Meeting' : 'Task',
        projectId: t.project_id ?? undefined,
        createdBy: t.created_by,
        assigneeId: t.assignee_id,
        assigneeDisplay: t.assignee_name ?? (t.assignee_id ? (profileById.get(t.assignee_id) ?? null) : null),
        isPublic: t.is_public,
      })),
    ]
  }, [projectTasks, calendarTasks, standaloneTasks, projectById, profileById])

  const displayed = useMemo(() => {
    const filtered = showCompleted ? unified : unified.filter((t) => !t.completed)
    return sortTasks(filtered, sort)
  }, [unified, sort, showCompleted])

  const completedCount = unified.filter((t) => t.completed).length
  const totalCount = unified.length

  async function markComplete(task: UnifiedTask, done: boolean) {
    const sb = supabase as any
    let error: { message: string } | null = null
    if (task.source === 'project') {
      ;({ error } = await sb.from('project_tasks').update({
        done, status: done ? 'Complete' : undefined,
      }).eq('id', task.id))
    } else if (task.source === 'calendar') {
      ;({ error } = await sb.from('schedule_events').update({
        completed: done,
        completed_at: done ? new Date().toISOString() : null,
        completed_by: done ? myId : null,
      }).eq('id', task.id))
    } else {
      ;({ error } = await sb.from('tasks').update({
        completed: done,
        completed_at: done ? new Date().toISOString() : null,
        completed_by: done ? myId : null,
      }).eq('id', task.id))
    }
    if (error) { toast.error(error.message); return }
    loadAll()
  }

  async function togglePublic(task: UnifiedTask) {
    if (task.createdBy !== myId) return
    const { error } = await (supabase as any).from('tasks').update({ is_public: !task.isPublic }).eq('id', task.id)
    if (error) { toast.error(error.message); return }
    loadAll()
  }

  function openAdd() {
    setEditTaskId(null)
    setEditSource(null)
    setForm({ ...EMPTY_FORM })
    setAddOpen(true)
  }

  function openEdit(task: UnifiedTask) {
    setEditTaskId(task.id)
    setEditSource(task.source)

    if (task.source === 'project') {
      const pt = projectTasks.find((t) => t.id === task.id)
      setForm({
        title: pt?.task_name ?? task.title,
        notes: pt?.notes ?? '',
        target_date: pt?.due_date ?? '',
        project_id: '',
        assignee_input: pt?.assignee ?? '',
        is_public: false,
      })
    } else if (task.source === 'calendar') {
      const ct = calendarTasks.find((t) => t.id === task.id)
      setForm({
        title: ct?.title ?? task.title,
        notes: ct?.notes ?? '',
        target_date: ct?.start_date ?? '',
        project_id: '',
        assignee_input: '',
        is_public: false,
      })
    } else {
      const raw = standaloneTasks.find((t) => t.id === task.id)
      if (!raw) return
      const assigneeInput = raw.assignee_name
        ?? (raw.assignee_id ? (profileById.get(raw.assignee_id) ?? '') : '')
      setForm({
        title: raw.title,
        notes: raw.notes ?? '',
        target_date: raw.target_date ?? '',
        project_id: raw.project_id ?? '',
        assignee_input: assigneeInput,
        is_public: raw.is_public,
      })
    }
    setAddOpen(true)
  }

  // For ownership check on standalone/meeting tasks
  const editStandaloneTask = editTaskId && (editSource === 'standalone' || editSource === 'meeting' || editSource === null)
    ? standaloneTasks.find((t) => t.id === editTaskId) ?? null
    : null
  const isEditOwner = !editStandaloneTask || editStandaloneTask.created_by === myId
  const canDelete = !!editTaskId && (editSource === 'standalone' || editSource === 'meeting')

  async function onSave() {
    if (!companyId || !form.title.trim()) return
    setSaving(true)
    const sb = supabase as any

    if (editSource === 'project' && editTaskId) {
      const { error } = await sb.from('project_tasks').update({
        task_name: form.title.trim(),
        due_date: form.target_date || null,
        notes: form.notes.trim() || null,
        assignee: form.assignee_input.trim() || null,
      }).eq('id', editTaskId)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Task updated')
    } else if (editSource === 'calendar' && editTaskId) {
      const { error } = await sb.from('schedule_events').update({
        title: form.title.trim(),
        start_date: form.target_date || undefined,
        notes: form.notes.trim() || null,
      }).eq('id', editTaskId)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Task updated')
    } else {
      const matchedProfile = form.assignee_input.trim()
        ? orgProfiles.find((p) => (p.full_name ?? p.email ?? '').toLowerCase() === form.assignee_input.trim().toLowerCase())
        : undefined
      const payload: Record<string, unknown> = {
        company_id: companyId,
        title: form.title.trim(),
        notes: form.notes.trim() || null,
        target_date: form.target_date || null,
        project_id: form.project_id || null,
        assignee_id: matchedProfile?.id ?? null,
        assignee_name: matchedProfile ? null : (form.assignee_input.trim() || null),
        is_public: form.is_public,
      }
      if (editTaskId) {
        const { error } = await sb.from('tasks').update(payload).eq('id', editTaskId)
        if (error) { toast.error(error.message); setSaving(false); return }
        toast.success('Task updated')
      } else {
        const { error } = await sb.from('tasks').insert({ ...payload, source: 'manual', created_by: myId })
        if (error) { toast.error(error.message); setSaving(false); return }
        toast.success('Task added')
      }
    }
    setSaving(false)
    setAddOpen(false)
    loadAll()
  }

  async function onDelete() {
    if (!canDelete || !editTaskId) return
    if (!confirm('Delete this task?')) return
    const { error } = await (supabase as any).from('tasks').delete().eq('id', editTaskId)
    if (error) { toast.error(error.message); return }
    toast.success('Task deleted')
    setAddOpen(false)
    loadAll()
  }

  const SORTS: { key: SortKey; label: string }[] = [
    { key: 'date', label: 'Due Date' },
    { key: 'source', label: 'Source' },
    { key: 'title', label: 'Title' },
  ]

  const dateFieldLabel =
    editSource === 'project' ? 'Due Date' :
    editSource === 'calendar' ? 'Date' :
    'Target Date'

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Tasks</h1>
          <p className="text-xs text-inky mt-0.5">
            {totalCount - completedCount} open · {completedCount} completed · from projects, calendar, and meetings
          </p>
        </div>
        <Button size="sm" onClick={openAdd}>+ Add Task</Button>
      </div>

      {/* Sort + filter controls */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs font-mono text-inky uppercase tracking-wide">Sort:</span>
        <div className="flex rounded border border-navy/30 overflow-hidden">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              className={[
                'px-3 py-1 text-xs font-mono transition-colors',
                sort === s.key ? 'bg-navy/10 text-navy font-bold' : 'text-inky hover:text-navy',
              ].join(' ')}
            >
              {s.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs font-mono text-inky cursor-pointer ml-2">
          <input
            type="checkbox"
            checked={showCompleted}
            onChange={(e) => setShowCompleted(e.target.checked)}
            className="accent-inky"
          />
          Show completed
        </label>
      </div>

      {/* Task list */}
      {loading ? (
        <div className="text-xs font-mono text-inky/50 animate-pulse py-8 text-center">Loading…</div>
      ) : displayed.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-xs font-body italic text-inky/50">No tasks{showCompleted ? '' : ' — all done!'}</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-navy/10 rounded border border-navy/20 bg-cream">
          {displayed.map((task) => {
            const overdue = isOverdue(task.targetDate, task.completed)
            const isMine = task.createdBy === myId
            const isStandaloneOrMeeting = task.source === 'standalone' || task.source === 'meeting'

            return (
              <li key={task.key} className="flex items-center gap-3 px-4 py-3 hover:bg-navy/5 group">
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={(e) => markComplete(task, e.target.checked)}
                  className="accent-inky flex-shrink-0 w-4 h-4 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <span className={['text-sm font-body', task.completed ? 'line-through text-inky/40' : 'text-navy'].join(' ')}>
                    {task.title}
                  </span>
                  {task.notes && (
                    <p className="text-xs text-inky/50 mt-0.5 truncate">{task.notes}</p>
                  )}
                </div>

                {task.assigneeDisplay && (
                  <span className="text-[10px] font-mono text-inky/60 bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5 flex-shrink-0">
                    {task.assigneeDisplay}
                  </span>
                )}

                <Badge color={sourceColor(task.source)}>
                  <span className="text-[10px]">{task.sourceLabel}</span>
                </Badge>

                {task.projectId && task.source !== 'project' && (
                  <Badge color="navy">
                    <span className="text-[10px]">{projectById.get(task.projectId) ?? 'Project'}</span>
                  </Badge>
                )}

                {/* Visibility toggle — only for task creator on standalone/meeting tasks */}
                {isStandaloneOrMeeting && isMine && (
                  <button
                    onClick={() => togglePublic(task)}
                    title={task.isPublic ? 'Visible to org — click to make private' : 'Private — click to share with org'}
                    className={['flex-shrink-0 transition-colors', task.isPublic ? 'text-sky' : 'text-inky/30 hover:text-inky/60'].join(' ')}
                  >
                    {task.isPublic ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                      </svg>
                    )}
                  </button>
                )}

                {task.targetDate ? (
                  <span className={['text-xs font-mono flex-shrink-0', overdue ? 'text-[#C0392B] font-bold' : 'text-inky/60'].join(' ')}>
                    {overdue ? '⚠ ' : ''}{dateLabel(task.targetDate)}
                  </span>
                ) : (
                  <span className="text-xs font-mono text-inky/30 flex-shrink-0">No date</span>
                )}

                <button
                  onClick={() => openEdit(task)}
                  className="text-xs font-mono text-inky/40 hover:text-navy opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                >
                  Edit
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Add / Edit task modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title={editTaskId ? 'Edit Task' : 'Add Task'}
        size="md"
      >
        <div className="flex flex-col gap-3">
          <Input
            label="Task *"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="What needs to be done?"
          />

          {/* Assignee — not shown for calendar tasks */}
          {editSource !== 'calendar' && (
            <AssigneeComboInput
              label="Assign to"
              value={form.assignee_input}
              profiles={orgProfiles}
              onChange={(name) => setForm({ ...form, assignee_input: name })}
            />
          )}

          {/* Project link — only for new or standalone/meeting tasks */}
          {(editSource === null || editSource === 'standalone' || editSource === 'meeting') && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono text-inky uppercase tracking-wide">Link to Project</label>
              <select
                value={form.project_id}
                onChange={(e) => setForm({ ...form, project_id: e.target.value })}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
              >
                <option value="">No project</option>
                {openProjects.map((p) => (
                  <option key={p.id} value={p.id}>{p.project_name}</option>
                ))}
              </select>
            </div>
          )}

          <Input
            label={dateFieldLabel}
            type="date"
            value={form.target_date}
            onChange={(e) => setForm({ ...form, target_date: e.target.value })}
          />

          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-inky uppercase tracking-wide">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={3}
              placeholder="Optional notes…"
              className="rounded border border-navy/30 bg-cream px-3 py-2 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none resize-none"
            />
          </div>

          {/* Visibility — only for new/standalone/meeting tasks, creator only */}
          {(editSource === null || editSource === 'standalone' || editSource === 'meeting') && isEditOwner && (
            <label className="flex items-center gap-2 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={form.is_public}
                onChange={(e) => setForm({ ...form, is_public: e.target.checked })}
                className="accent-inky w-4 h-4"
              />
              <span className="text-xs font-mono text-inky">Visible to entire org</span>
              <span className="text-[10px] font-mono text-inky/40">(private by default)</span>
            </label>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <div>{canDelete && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>Discard</Button>
              <Button size="sm" onClick={onSave} disabled={saving || !form.title.trim()}>
                {saving ? 'Saving…' : editTaskId ? 'Save Changes' : 'Add Task'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
