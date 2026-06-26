import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { DataTable } from '@/components/shared/DataTable'
import { VisibilitySelector, type VisibilityValue, type SlimUser } from '@/components/shared/VisibilitySelector'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { MeetingNote, Project, Task } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface MeetingLink { label: string; url: string }

const VISIBILITY_OPTIONS: { value: VisibilityValue; label: string; icon: string }[] = [
  { value: 'private', label: 'Private', icon: '🔒' },
  { value: 'department', label: 'Department', icon: '🏢' },
  { value: 'attendees', label: 'Attendees', icon: '🤝' },
  { value: 'specific_users', label: 'Specific Users', icon: '👥' },
]

const EMPTY_FORM = {
  title: 'Untitled Meeting',
  meeting_date: '',
  meeting_time: '',
  vendor: '',
  category: '',
  notes: '',
  visibility: 'private' as VisibilityValue,
  links: [] as MeetingLink[],
}
const EMPTY_TASK = { title: '', target_date: '', project_id: '' }

const col = createColumnHelper<MeetingNote>()

function ExpandableDisplay({ value, clamp = 1 }: { value: string | null; clamp?: 1 | 2 }) {
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    setCanExpand(el.scrollHeight > el.clientHeight + 1)
  })

  const text = value ?? ''
  return (
    <div className="whitespace-normal">
      <div
        ref={textRef}
        className={['text-xs font-mono', text ? 'text-navy' : 'text-inky/40', expanded ? 'whitespace-pre-wrap break-words' : clamp === 2 ? 'line-clamp-2' : 'line-clamp-1'].join(' ')}
      >
        {text || '—'}
      </div>
      {(canExpand || expanded) && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-0.5 text-[10px] font-mono text-inky hover:underline">
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-widest whitespace-nowrap">{children}</span>
      <div className="flex-1 border-t border-navy/15" />
    </div>
  )
}

function formatDateTime(date: string | null, time: string | null): string {
  if (!date) return '—'
  try {
    const d = format(new Date(date + 'T00:00:00'), 'MMM d, yyyy')
    return time ? `${d} ${time.slice(0, 5)}` : d
  } catch { return date }
}

export function MeetingNotesPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myId = profile?.id ?? null
  const [searchParams, setSearchParams] = useSearchParams()
  const quickTriggered = useRef(false)

  const [meetings, setMeetings] = useState<MeetingNote[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [editCreatedBy, setEditCreatedBy] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  const [meetingTasks, setMeetingTasks] = useState<Task[]>([])
  const [taskForm, setTaskForm] = useState({ ...EMPTY_TASK })

  const [participants, setParticipants] = useState<SlimUser[]>([])
  const [specificUsers, setSpecificUsers] = useState<SlimUser[]>([])
  const [allUsers, setAllUsers] = useState<SlimUser[]>([])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [meetRes, projRes, usersRes] = await Promise.all([
      sb.schema('inventory').from('meeting_notes').select('*').eq('company_id', companyId)
        .order('meeting_date', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false }),
      sb.schema('inventory').from('projects').select('id, project_name, status').eq('company_id', companyId).order('project_name'),
      sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name'),
    ])
    if (meetRes.error) toast.error(meetRes.error.message)
    else setMeetings((meetRes.data ?? []) as MeetingNote[])
    setProjects((projRes.data ?? []) as Project[])
    setAllUsers(
      ((usersRes.data ?? []) as { id: string; full_name: string | null; email: string | null }[])
        .map((u) => ({ id: u.id, full_name: u.full_name, email: u.email ?? '' }))
    )
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  const openProjects = useMemo(
    () => projects.filter((p) => p.status !== 'Complete' && p.status !== 'Cancelled'),
    [projects]
  )
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p.project_name])), [projects])

  async function loadMeetingTasks(meetingId: string) {
    const { data } = await (supabase as any)
      .schema('inventory').from('tasks').select('*').eq('meeting_id', meetingId)
      .order('sort_order').order('created_at')
    setMeetingTasks((data ?? []) as Task[])
  }

  function openNew(quick = false) {
    setEditId(null)
    setEditCreatedBy(myId)
    const now = new Date()
    setForm({
      ...EMPTY_FORM,
      meeting_date: format(now, 'yyyy-MM-dd'),
      meeting_time: quick ? format(now, 'HH:mm') : '',
    })
    setMeetingTasks([])
    setTaskForm({ ...EMPTY_TASK })
    setParticipants([])
    setSpecificUsers([])
    setModalOpen(true)
  }

  // Auto-open a quick meeting if navigated to with ?quick=1
  useEffect(() => {
    if (searchParams.get('quick') === '1' && !quickTriggered.current) {
      quickTriggered.current = true
      setSearchParams({}, { replace: true })
      openNew(true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  const openEdit = useCallback((m: MeetingNote) => {
    setEditId(m.id)
    setEditCreatedBy(m.created_by)
    setParticipants([])
    setSpecificUsers([])
    const visibility: VisibilityValue = (m as any).visibility ?? (m.shared ? 'department' : 'private')
    setForm({
      title: m.title,
      meeting_date: m.meeting_date ?? '',
      meeting_time: m.meeting_time ?? '',
      vendor: m.vendor ?? '',
      category: m.category ?? '',
      notes: m.notes ?? '',
      visibility,
      links: ((m as any).links ?? []) as MeetingLink[],
    })
    setTaskForm({ ...EMPTY_TASK })
    loadMeetingTasks(m.id)
    setModalOpen(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const isOwner = !editId || editCreatedBy === myId

  async function onSave() {
    if (!companyId || !form.title.trim()) return
    setSaving(true)
    const corePayload = {
      company_id: companyId,
      title: form.title.trim(),
      meeting_date: form.meeting_date || null,
      meeting_time: form.meeting_time || null,
      vendor: form.vendor.trim() || null,
      category: form.category.trim() || null,
      notes: form.notes || null,
      visibility: isOwner ? form.visibility : undefined,
      shared: isOwner ? form.visibility !== 'private' : undefined,
    }
    const sb = supabase as any
    let savedId = editId
    if (editId) {
      const { error } = await sb.schema('inventory').from('meeting_notes').update(corePayload).eq('id', editId)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Meeting saved')
    } else {
      const { data, error } = await sb.schema('inventory').from('meeting_notes').insert({ ...corePayload, created_by: myId }).select().single()
      if (error) { toast.error(error.message); setSaving(false); return }
      savedId = data.id
      setEditId(data.id)
      setEditCreatedBy(myId)
      toast.success('Meeting created')
    }
    // Best-effort: save links separately (column may not exist in all environments yet)
    if (savedId) {
      sb.schema('inventory').from('meeting_notes')
        .update({ links: form.links })
        .eq('id', savedId)
        .then(() => {})
    }
    setSaving(false)
    load()
  }

  async function onDelete() {
    if (!editId || !isOwner || !confirm('Delete this meeting and its tasks?')) return
    const { error } = await (supabase as any).schema('inventory').from('meeting_notes').delete().eq('id', editId)
    if (error) { toast.error(error.message); return }
    toast.success('Meeting deleted')
    setModalOpen(false)
    setEditId(null)
    load()
  }

  async function addTask() {
    if (!editId || !taskForm.title.trim() || !companyId) return
    const { error } = await (supabase as any).schema('inventory').from('tasks').insert({
      company_id: companyId,
      title: taskForm.title.trim(),
      target_date: taskForm.target_date || null,
      project_id: taskForm.project_id || null,
      source: 'meeting',
      meeting_id: editId,
      created_by: myId,
    })
    if (error) { toast.error(error.message); return }
    setTaskForm({ ...EMPTY_TASK })
    loadMeetingTasks(editId)
  }

  async function toggleTask(task: Task) {
    const done = !task.completed
    const { error } = await (supabase as any).schema('inventory').from('tasks').update({
      completed: done,
      completed_at: done ? new Date().toISOString() : null,
      completed_by: done ? myId : null,
    }).eq('id', task.id)
    if (error) { toast.error(error.message); return }
    if (editId) loadMeetingTasks(editId)
  }

  async function deleteTask(taskId: string) {
    await (supabase as any).schema('inventory').from('tasks').delete().eq('id', taskId)
    if (editId) loadMeetingTasks(editId)
  }

  const distinctCategories = useMemo(
    () => Array.from(new Set(meetings.map((m) => m.category).filter(Boolean))).sort() as string[],
    [meetings]
  )
  const distinctVendors = useMemo(
    () => Array.from(new Set(meetings.map((m) => m.vendor).filter(Boolean))).sort() as string[],
    [meetings]
  )

  const columns = useMemo(() => [
    col.accessor('title', {
      header: 'Meeting',
      meta: { noClip: true },
      cell: (i) => (
        <div className="flex items-center gap-1.5 group/title">
          <ExpandableDisplay value={i.getValue()} />
          <button
            onClick={(e) => { e.stopPropagation(); openEdit(i.row.original as MeetingNote) }}
            title="Edit meeting"
            className="opacity-0 group-hover/title:opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded hover:bg-navy/10 text-inky/60 hover:text-navy"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        </div>
      ),
    }),
    col.accessor('meeting_date', {
      header: 'Date',
      cell: (i) => formatDateTime(i.getValue(), (i.row.original as MeetingNote).meeting_time),
    }),
    col.accessor('vendor', { header: 'Vendor', meta: { noClip: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} /> }),
    col.accessor('category', { header: 'Category', meta: { noClip: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} /> }),
    col.accessor('shared', {
      header: 'Visibility',
      cell: (i) => {
        const vis: VisibilityValue = (i.row.original as any).visibility ?? (i.getValue() ? 'department' : 'private')
        const opt = VISIBILITY_OPTIONS.find((o) => o.value === vis)
        return (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded text-inky/70 bg-navy/5 whitespace-nowrap">
            {opt?.icon} {opt?.label ?? 'Private'}
          </span>
        )
      },
    }),
    col.accessor('notes', { header: 'Notes', meta: { noClip: true }, cell: (i) => <ExpandableDisplay value={i.getValue() ?? null} clamp={2} /> }),
  ], [openEdit]) // eslint-disable-line react-hooks/exhaustive-deps

  const { table, globalFilter, setGlobalFilter } = useTable(meetings, columns)

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Meeting Notes</h1>
          <p className="text-xs text-inky mt-0.5">Your meetings are private by default — share individual meetings with the org as needed.</p>
        </div>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="meeting_notes.csv"
        exportData={meetings}
        loading={loading}
        actions={<Button size="sm" onClick={() => openNew()}>+ New Meeting</Button>}
      />

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditId(null); load() }}
        title={editId ? 'Edit Meeting' : 'New Meeting'}
        size="xl"
      >
        <div className="flex flex-col gap-4">
          <div className="flex items-start gap-3">
            <Input
              label="Meeting Name *"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              className="flex-1"
            />
            {/* Visibility selector — four-option, only creator can change */}
            <div className="flex-shrink-0">
              <VisibilitySelector
                value={form.visibility}
                onChange={(v) => setForm({ ...form, visibility: v })}
                participants={participants}
                onParticipantsChange={setParticipants}
                specificUsers={specificUsers}
                onSpecificUsersChange={setSpecificUsers}
                allUsers={allUsers}
                departmentName={(profile as any)?.department ?? null}
                departments={
                  isAdminOrDeveloper(profile?.role)
                    ? [...new Set(allUsers.map((u) => (u as any).department).filter(Boolean) as string[])]
                    : (profile as any)?.department ? [(profile as any).department] : undefined
                }
                label="Visibility"
                disabled={!isOwner}
              />
            </div>
          </div>

          <SectionHeader>Meeting Details</SectionHeader>
          <div className="grid grid-cols-2 gap-3">
            <Input label="Meeting Date" type="date" value={form.meeting_date} onChange={(e) => setForm({ ...form, meeting_date: e.target.value })} />
            <Input label="Meeting Time" type="time" value={form.meeting_time} onChange={(e) => setForm({ ...form, meeting_time: e.target.value })} />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono text-inky uppercase tracking-wide">Vendor</label>
              <input
                value={form.vendor}
                onChange={(e) => setForm({ ...form, vendor: e.target.value })}
                list="meeting-vendors"
                placeholder="Type or select…"
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
              />
              <datalist id="meeting-vendors">
                {distinctVendors.map((v) => <option key={v} value={v} />)}
              </datalist>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-mono text-inky uppercase tracking-wide">Category</label>
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                list="meeting-categories"
                placeholder="Type or select…"
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
              />
              <datalist id="meeting-categories">
                {distinctCategories.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
          </div>

          <SectionHeader>Meeting Notes</SectionHeader>
          <RichTextEditor
            value={form.notes}
            onChange={(html) => setForm({ ...form, notes: html })}
            placeholder="Meeting notes, agenda items, decisions made…"
            minHeight={200}
            disabled={!isOwner}
          />

          {/* Links */}
          <SectionHeader>Links</SectionHeader>
          <div className="flex flex-col gap-2">
            {form.links.map((link, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  value={link.label}
                  onChange={(e) => {
                    const next = [...form.links]
                    next[i] = { ...next[i], label: e.target.value }
                    setForm({ ...form, links: next })
                  }}
                  placeholder="Label (optional)"
                  className="w-32 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-sky focus:outline-none"
                />
                <input
                  value={link.url}
                  onChange={(e) => {
                    const next = [...form.links]
                    next[i] = { ...next[i], url: e.target.value }
                    setForm({ ...form, links: next })
                  }}
                  placeholder="https://…"
                  className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-sky focus:outline-none"
                />
                <button
                  onClick={() => setForm({ ...form, links: form.links.filter((_, idx) => idx !== i) })}
                  className="text-inky/40 hover:text-[#C0392B] text-xs flex-shrink-0"
                >✕</button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setForm({ ...form, links: [...form.links, { label: '', url: '' }] })}
              className="self-start text-xs font-mono text-inky hover:text-navy border border-navy/20 rounded px-2 py-1"
            >
              + Add Link
            </button>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div>{editId && isOwner && <Button variant="danger" size="sm" onClick={onDelete}>Delete Meeting</Button>}</div>
            <Button size="sm" onClick={onSave} disabled={saving || !form.title.trim()}>
              {saving ? 'Saving…' : editId ? 'Save Changes' : 'Create Meeting'}
            </Button>
          </div>

          {editId ? (
            <div className="flex flex-col gap-3">
              <SectionHeader>Action Items</SectionHeader>
              {meetingTasks.length === 0 && (
                <p className="text-xs font-body italic text-inky/50">No action items yet.</p>
              )}
              <ul className="flex flex-col gap-1.5">
                {meetingTasks.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 group">
                    <input
                      type="checkbox"
                      checked={t.completed}
                      onChange={() => toggleTask(t)}
                      className="accent-inky flex-shrink-0"
                    />
                    <span className={['flex-1 text-sm font-body', t.completed ? 'line-through text-inky/40' : 'text-navy'].join(' ')}>
                      {t.title}
                    </span>
                    {t.project_id && (
                      <span className="text-[10px] font-mono text-inky/60 bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5 flex-shrink-0">
                        {projectById.get(t.project_id) ?? 'Project'}
                      </span>
                    )}
                    {t.target_date && (
                      <span className="text-xs font-mono text-inky/50 flex-shrink-0">
                        {format(new Date(t.target_date + 'T00:00:00'), 'MMM d')}
                      </span>
                    )}
                    <button
                      onClick={() => deleteTask(t.id)}
                      className="text-inky/30 hover:text-[#C0392B] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-xs"
                    >✕</button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-2 pt-1">
                <input
                  value={taskForm.title}
                  onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTask() }}
                  placeholder="New action item…"
                  className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:outline-none"
                />
                <select
                  value={taskForm.project_id}
                  onChange={(e) => setTaskForm({ ...taskForm, project_id: e.target.value })}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none"
                >
                  <option value="">No project</option>
                  {openProjects.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name}</option>
                  ))}
                </select>
                <input
                  type="date"
                  value={taskForm.target_date}
                  onChange={(e) => setTaskForm({ ...taskForm, target_date: e.target.value })}
                  className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none"
                />
                <button
                  onClick={addTask}
                  disabled={!taskForm.title.trim()}
                  className="rounded border border-inky/30 px-3 py-1.5 text-xs font-heading text-inky hover:border-navy hover:text-navy uppercase disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            </div>
          ) : (
            <p className="text-xs font-body italic text-inky/50 border-t border-navy/10 pt-3">
              Save the meeting first to add action items.
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}
