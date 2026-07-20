import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Badge, Button, Input, Modal, SbLoader } from '@/components/ui'
import { AssigneeComboInput } from '@/components/shared/AssigneeComboInput'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import type { Profile, Project, ProjectTask, ScheduleEvent, Task } from '@/types'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

type SortKey = 'date' | 'source' | 'title' | 'completed'
type TaskSource = 'project' | 'calendar' | 'meeting' | 'standalone'

interface UnifiedTask {
  key: string
  id: string
  title: string
  notes: string | null
  targetDate: string | null
  completed: boolean
  completedAt: string | null
  source: TaskSource
  sourceLabel: string
  projectId?: string
  createdBy: string | null
  assigneeId: string | null
  assigneeDisplay: string | null
  isPublic: boolean
  deletedAt: string | null
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

function completedLabel(d: string | null): string {
  if (!d) return ''
  try { return format(parseISO(d), 'MMM d, yyyy h:mm a') } catch { return d }
}

function isOverdue(d: string | null, completed: boolean): boolean {
  if (!d || completed) return false
  try { return parseISO(d) < new Date(new Date().toDateString()) } catch { return false }
}

function bandLabel(targetDate: string | null): string {
  const today = new Date().toISOString().slice(0, 10)
  if (!targetDate) return 'No Date'
  if (targetDate < today) return 'Overdue'
  if (targetDate === today) return 'Today'
  const d = new Date(today)
  d.setDate(d.getDate() + 1)
  if (targetDate === d.toISOString().slice(0, 10)) return 'Tomorrow'
  try { return format(parseISO(targetDate), 'EEEE, MMM d') } catch { return targetDate }
}

function groupTasksByDate(tasks: UnifiedTask[]): { label: string; tasks: UnifiedTask[] }[] {
  const groups: { label: string; tasks: UnifiedTask[] }[] = []
  const indexMap = new Map<string, number>()
  for (const task of tasks) {
    const label = bandLabel(task.targetDate)
    if (!indexMap.has(label)) {
      indexMap.set(label, groups.length)
      groups.push({ label, tasks: [] })
    }
    groups[indexMap.get(label)!].tasks.push(task)
  }
  return groups
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
    if (key === 'completed') {
      if (!a.completedAt && !b.completedAt) return 0
      if (!a.completedAt) return 1
      if (!b.completedAt) return -1
      return b.completedAt < a.completedAt ? -1 : 1
    }
    return a.title.localeCompare(b.title)
  })
}

const EMPTY_FORM = {
  title: '', notes: '', target_date: '', project_id: '', assignee_input: '', is_public: false,
}

// Purge deleted tasks older than 30 days (client-side lazy purge).
async function purgeExpired(companyId: string) {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  await (supabase as any).schema('core').from('tasks').delete().eq('company_id', companyId).lt('deleted_at', cutoff).not('deleted_at', 'is', null)
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
  const [deletedTasks, setDeletedTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)

  const [sort, setSort] = useAppSetting<SortKey>('tasks.sort', 'date')
  const [showCompleted, setShowCompleted] = useAppSetting<boolean>('tasks.showCompleted', false)
  const [showDeleted, setShowDeleted] = useState(false)

  const [addOpen, setAddOpen] = useState(false)
  const [editTaskId, setEditTaskId] = useState<string | null>(null)
  const [editSource, setEditSource] = useState<TaskSource | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  // Assignee confirmation before checking off another user's task
  const [pendingComplete, setPendingComplete] = useState<{ task: UnifiedTask; done: boolean } | null>(null)

  // Tasks checked off during this visit stay visible (marked done) until the
  // user leaves and returns — the set resets on remount, so on the next visit
  // they filter into the completed section normally.
  const [sessionCompleted, setSessionCompleted] = useState<Set<string>>(new Set())

  // Delete confirmation modal
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; source: TaskSource; title: string } | null>(null)

  const loadAll = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    void purgeExpired(companyId)
    const sb = supabase as any
    const [profRes, projRes, ptRes, ctRes, stRes, delRes] = await Promise.all([
      sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name'),
      sb.schema('inventory').from('projects').select('id, project_name, status').eq('company_id', companyId),
      sb.schema('inventory').from('project_tasks').select('*').eq('company_id', companyId).order('sort_order'),
      sb.schema('platform').from('schedule_events').select('*').eq('company_id', companyId).eq('is_checklist', true).order('start_date'),
      sb.schema('core').from('tasks').select('*').eq('company_id', companyId).is('deleted_at', null).or(`created_by.eq.${myId},assignee_id.eq.${myId},is_public.eq.true`).order('sort_order').order('created_at'),
      sb.schema('core').from('tasks').select('*').eq('company_id', companyId).not('deleted_at', 'is', null).or(`created_by.eq.${myId},assignee_id.eq.${myId},is_public.eq.true`).order('deleted_at', { ascending: false }),
    ])
    setOrgProfiles((profRes.data ?? []) as Profile[])
    setProjects((projRes.data ?? []) as Project[])
    setProjectTasks((ptRes.data ?? []) as ProjectTask[])
    setCalendarTasks((ctRes.data ?? []) as ScheduleEvent[])
    setStandaloneTasks((stRes.data ?? []) as Task[])
    setDeletedTasks((delRes.data ?? []) as Task[])
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
        completedAt: null,
        source: 'project' as const,
        sourceLabel: projectById.get(t.project_id) ?? 'Project',
        projectId: t.project_id,
        createdBy: null,
        assigneeId: null,
        assigneeDisplay: t.assignee ?? null,
        isPublic: true,
        deletedAt: null,
      })),
      ...calendarTasks
        .filter((t) => {
          const ev = t as any
          if (!ev.created_by) return true
          if (ev.created_by === myId) return true
          return (ev.assigned_to ?? []).includes(myId)
        })
        .map((t) => ({
          key: `cal-${t.id}`,
          id: t.id,
          title: t.title,
          notes: t.notes ?? null,
          targetDate: t.start_date,
          completed: t.completed,
          completedAt: t.completed_at ?? null,
          source: 'calendar' as const,
          sourceLabel: 'Calendar',
          createdBy: (t as any).created_by ?? null,
          assigneeId: null,
          assigneeDisplay: null,
          isPublic: !(t as any).created_by,
          deletedAt: null,
        })),
      ...standaloneTasks.map((t) => ({
        key: `task-${t.id}`,
        id: t.id,
        title: t.title,
        notes: t.notes,
        targetDate: t.target_date,
        completed: t.completed,
        completedAt: t.completed_at ?? null,
        source: (t.source === 'meeting' ? 'meeting' : 'standalone') as TaskSource,
        sourceLabel: t.source === 'meeting' ? 'Meeting' : 'Task',
        projectId: t.project_id ?? undefined,
        createdBy: t.created_by,
        assigneeId: t.assignee_id,
        assigneeDisplay: t.assignee_name ?? (t.assignee_id ? (profileById.get(t.assignee_id) ?? null) : null),
        isPublic: t.is_public,
        deletedAt: t.deleted_at ?? null,
      })),
    ]
  }, [projectTasks, calendarTasks, standaloneTasks, projectById, profileById])

  const displayed = useMemo(() => {
    const filtered = showCompleted
      ? unified
      : unified.filter((t) => !t.completed || sessionCompleted.has(t.key))
    return sortTasks(filtered, sort)
  }, [unified, sort, showCompleted, sessionCompleted])

  const completedCount = unified.filter((t) => t.completed).length
  const totalCount = unified.length

  function handleCheckboxChange(task: UnifiedTask, done: boolean) {
    // If marking complete and task is assigned to a different user, confirm first
    if (done && task.assigneeId && task.assigneeId !== myId) {
      setPendingComplete({ task, done })
      return
    }
    void markComplete(task, done)
  }

  // Reflect completion in local state so the row updates in place (checked +
  // strikethrough) without a full refetch/loader flash.
  function applyLocalComplete(task: UnifiedTask, done: boolean) {
    const nowIso = new Date().toISOString()
    if (task.source === 'project') {
      setProjectTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done } : t)))
    } else if (task.source === 'calendar') {
      setCalendarTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, completed: done, completed_at: done ? nowIso : null } : t)))
    } else {
      setStandaloneTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, completed: done, completed_at: done ? nowIso : null, completed_by: done ? myId : null } : t)))
    }
  }

  async function markComplete(task: UnifiedTask, done: boolean) {
    const sb = supabase as any
    // Optimistic: update the row in place and keep it visible for this visit.
    applyLocalComplete(task, done)
    setSessionCompleted((prev) => {
      const next = new Set(prev)
      if (done) next.add(task.key)
      else next.delete(task.key)
      return next
    })

    let error: { message: string } | null = null
    if (task.source === 'project') {
      ;({ error } = await sb.schema('inventory').from('project_tasks').update({
        done, status: done ? 'Complete' : undefined,
      }).eq('id', task.id))
    } else if (task.source === 'calendar') {
      ;({ error } = await sb.schema('platform').from('schedule_events').update({
        completed: done,
        completed_at: done ? new Date().toISOString() : null,
        completed_by: done ? myId : null,
      }).eq('id', task.id))
    } else {
      ;({ error } = await sb.schema('core').from('tasks').update({
        completed: done,
        completed_at: done ? new Date().toISOString() : null,
        completed_by: done ? myId : null,
      }).eq('id', task.id))
    }
    // On failure, reconcile with the server (undoes the optimistic change).
    if (error) { toast.error(error.message); loadAll(); return }
  }

  async function togglePublic(task: UnifiedTask) {
    if (task.createdBy !== myId) return
    const { error } = await (supabase as any).schema('core').from('tasks').update({ is_public: !task.isPublic }).eq('id', task.id)
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
      const { error } = await sb.schema('inventory').from('project_tasks').update({
        task_name: form.title.trim(),
        due_date: form.target_date || null,
        notes: form.notes.trim() || null,
        assignee: form.assignee_input.trim() || null,
      }).eq('id', editTaskId)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Task updated')
    } else if (editSource === 'calendar' && editTaskId) {
      const { error } = await sb.schema('platform').from('schedule_events').update({
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
        const { error } = await sb.schema('core').from('tasks').update(payload).eq('id', editTaskId)
        if (error) { toast.error(error.message); setSaving(false); return }
        toast.success('Task updated')
      } else {
        const { error } = await sb.schema('core').from('tasks').insert({ ...payload, source: 'manual', created_by: myId })
        if (error) { toast.error(error.message); setSaving(false); return }
        toast.success('Task added')
      }
    }
    setSaving(false)
    setAddOpen(false)
    loadAll()
  }

  function onDeleteClick() {
    if (!canDelete || !editTaskId) return
    const task = unified.find((t) => t.id === editTaskId)
    setAddOpen(false)
    setDeleteTarget({ id: editTaskId, source: editSource ?? 'standalone', title: task?.title ?? 'this task' })
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    const { error } = await (supabase as any).schema('core').from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', deleteTarget.id)
    if (error) { toast.error(error.message); return }
    toast.success('Task moved to deleted items')
    setDeleteTarget(null)
    loadAll()
  }

  async function restoreTask(id: string) {
    const { error } = await (supabase as any).schema('core').from('tasks').update({ deleted_at: null }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Task restored')
    loadAll()
  }

  async function hardDeleteTask(id: string) {
    const { error } = await (supabase as any).schema('core').from('tasks').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Task permanently deleted')
    loadAll()
  }

  const SORTS: { key: SortKey; label: string }[] = [
    { key: 'date', label: 'Due Date' },
    { key: 'source', label: 'Source' },
    { key: 'title', label: 'Title' },
    { key: 'completed', label: 'Completed' },
  ]

  const dateFieldLabel =
    editSource === 'project' ? 'Due Date' :
    editSource === 'calendar' ? 'Date' :
    'Target Date'

  return (
    <div className="flex flex-col gap-6 p-3 sm:p-6">
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
        {deletedTasks.length > 0 && (
          <button
            onClick={() => setShowDeleted((v) => !v)}
            className="ml-auto text-xs font-mono text-inky/60 hover:text-navy underline decoration-dotted"
          >
            {showDeleted ? 'Hide deleted' : `Show deleted (${deletedTasks.length})`}
          </button>
        )}
      </div>

      {/* Deleted tasks panel */}
      {showDeleted && deletedTasks.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50/40">
          <div className="px-4 py-2 border-b border-red-200">
            <span className="text-xs font-mono text-red-600 uppercase tracking-wide font-bold">Deleted Tasks</span>
            <span className="text-[10px] font-mono text-red-400 ml-2">— auto-purge after 30 days</span>
          </div>
          <ul className="divide-y divide-red-100">
            {deletedTasks.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm font-body text-inky/60 line-through">{t.title}</span>
                <span className="text-[10px] font-mono text-inky/40">
                  {t.deleted_at ? format(parseISO(t.deleted_at), 'MMM d, yyyy') : ''}
                </span>
                <button
                  onClick={() => restoreTask(t.id)}
                  className="text-xs font-mono text-sky hover:underline"
                >
                  Restore
                </button>
                <button
                  onClick={() => { if (confirm('Permanently delete this task?')) hardDeleteTask(t.id) }}
                  className="text-xs font-mono text-red-400 hover:underline"
                >
                  Delete Forever
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Task list */}
      {loading ? (
        <div className="py-8 flex justify-center"><SbLoader size={40} /></div>
      ) : displayed.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-xs font-body italic text-inky/50">No tasks{showCompleted ? '' : ' — all done!'}</p>
        </div>
      ) : (
        <ul className="flex flex-col divide-y divide-navy/10 rounded border border-navy/20 bg-cream overflow-hidden">
          {(sort === 'date' ? groupTasksByDate(displayed) : [{ label: '', tasks: displayed }]).map(({ label, tasks: group }) => (
            <Fragment key={label || '__flat'}>
              {label && (
                <li className={[
                  'px-4 py-1.5 flex items-center gap-2',
                  label === 'Overdue' ? 'bg-red-50/70' :
                  label === 'Today' ? 'bg-sky/10' :
                  label === 'No Date' ? 'bg-inky/5' :
                  'bg-navy/[0.04]',
                ].join(' ')}>
                  <span className={[
                    'text-[10px] font-mono uppercase tracking-widest font-bold',
                    label === 'Overdue' ? 'text-red-500' :
                    label === 'Today' ? 'text-sky' :
                    'text-navy/50',
                  ].join(' ')}>
                    {label === 'Overdue' && '⚠ '}{label}
                  </span>
                  <span className="text-[10px] font-mono text-inky/30">{group.length} task{group.length !== 1 ? 's' : ''}</span>
                </li>
              )}
              {group.map((task) => {
                const overdue = isOverdue(task.targetDate, task.completed)
                const isMine = task.createdBy === myId
                const isStandaloneOrMeeting = task.source === 'standalone' || task.source === 'meeting'
                return (
                  <li key={task.key} className="flex items-start gap-3 px-4 py-3 hover:bg-navy/5 group">
                    <input
                      type="checkbox"
                      checked={task.completed}
                      onChange={(e) => handleCheckboxChange(task, e.target.checked)}
                      className="accent-inky flex-shrink-0 w-4 h-4 cursor-pointer mt-0.5"
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap group/title">
                        <span className={['text-sm font-body', task.completed ? 'line-through text-inky/40' : 'text-navy'].join(' ')}>
                          {task.title}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); openEdit(task) }}
                          title="Edit task"
                          className="opacity-0 group-hover/title:opacity-100 transition-opacity p-0.5 rounded hover:bg-navy/10 text-inky/60 hover:text-navy flex-shrink-0"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        <Badge color={sourceColor(task.source)}>
                          <span className="text-[10px]">{task.sourceLabel}</span>
                        </Badge>
                        {task.projectId && task.source !== 'project' && (
                          <Badge color="navy">
                            <span className="text-[10px]">{projectById.get(task.projectId) ?? 'Project'}</span>
                          </Badge>
                        )}
                      </div>

                      {task.notes && (
                        <p className="text-xs text-inky/50 mt-0.5 truncate">{task.notes}</p>
                      )}

                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        {task.assigneeDisplay && (
                          <span className="text-[10px] font-mono text-inky/60 bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5">
                            {task.assigneeDisplay}
                          </span>
                        )}
                        {task.completed && task.completedAt ? (
                          <span className="text-[11px] font-mono text-green-600">
                            ✓ {completedLabel(task.completedAt)}
                          </span>
                        ) : task.targetDate ? (
                          <span className={['text-[11px] font-mono', overdue ? 'text-[#C0392B] font-bold' : 'text-inky/60'].join(' ')}>
                            {overdue ? '⚠ ' : ''}{dateLabel(task.targetDate)}
                          </span>
                        ) : (
                          <span className="text-[11px] font-mono text-inky/30">No date</span>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isStandaloneOrMeeting && isMine && (
                        <button
                          onClick={() => togglePublic(task)}
                          title={task.isPublic ? 'Visible to org — click to make private' : 'Private — click to share with org'}
                          className={['transition-colors', task.isPublic ? 'text-sky' : 'text-inky/30 hover:text-inky/60'].join(' ')}
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
                    </div>
                  </li>
                )
              })}
            </Fragment>
          ))}
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

          {editSource !== 'calendar' && (
            <AssigneeComboInput
              label="Assign to"
              value={form.assignee_input}
              profiles={orgProfiles}
              onChange={(name) => setForm({ ...form, assignee_input: name })}
            />
          )}

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
            <RichTextEditor
              value={form.notes}
              onChange={(html) => setForm({ ...form, notes: html })}
              placeholder="Optional notes…"
              minHeight={100}
            />
          </div>

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
            <div>{canDelete && <Button variant="danger" size="sm" onClick={onDeleteClick}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAddOpen(false)}>Discard</Button>
              <Button size="sm" onClick={onSave} disabled={saving || !form.title.trim()}>
                {saving ? 'Saving…' : editTaskId ? 'Save Changes' : 'Add Task'}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Assignee confirmation */}
      {pendingComplete && (
        <Modal
          open
          onClose={() => setPendingComplete(null)}
          title="Mark Complete?"
          size="sm"
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm font-body text-navy">
              This task is assigned to <span className="font-bold">{pendingComplete.task.assigneeDisplay}</span>. Mark it as complete anyway?
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPendingComplete(null)}>Cancel</Button>
              <Button size="sm" onClick={() => { void markComplete(pendingComplete.task, pendingComplete.done); setPendingComplete(null) }}>
                Yes, Mark Complete
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <Modal open onClose={() => setDeleteTarget(null)} title="Delete Task?" size="sm">
          <div className="flex flex-col gap-4">
            <p className="text-sm font-body text-navy">
              Delete <span className="font-bold">"{deleteTarget.title}"</span>?
            </p>
            <p className="text-xs font-mono text-inky/70">The task will be kept for 30 days and can be restored before that.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={confirmDelete}>Delete</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
