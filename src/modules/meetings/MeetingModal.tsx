import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { VisibilitySelector, type VisibilityValue, type SlimUser } from '@/components/shared/VisibilitySelector'
import { RichTextEditor } from '@/components/shared/RichTextEditor'
import { Button, Input, Modal } from '@/components/ui'
import type { MeetingNote, Project, Task } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface MeetingLink { label: string; url: string }

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

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <span className="text-[10px] font-mono text-inky/60 uppercase tracking-widest whitespace-nowrap">{children}</span>
      <div className="flex-1 border-t border-navy/15" />
    </div>
  )
}

interface MeetingModalProps {
  open: boolean
  onClose: () => void
  existing?: MeetingNote | null
  quick?: boolean // prefill time for a new note
  onSaved?: () => void
}

export function MeetingModal({ open, onClose, existing, quick, onSaved }: MeetingModalProps) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myId = profile?.id ?? null

  const [editId, setEditId] = useState<string | null>(null)
  const [editCreatedBy, setEditCreatedBy] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)
  const [meetingTasks, setMeetingTasks] = useState<Task[]>([])
  const [taskForm, setTaskForm] = useState({ ...EMPTY_TASK })
  const [participants, setParticipants] = useState<SlimUser[]>([])
  const [specificUsers, setSpecificUsers] = useState<SlimUser[]>([])
  const [allUsers, setAllUsers] = useState<SlimUser[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [distinctVendors, setDistinctVendors] = useState<string[]>([])
  const [distinctCategories, setDistinctCategories] = useState<string[]>([])

  const openProjects = useMemo(() => projects.filter((p) => p.status !== 'Complete' && p.status !== 'Cancelled'), [projects])
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p.project_name])), [projects])
  const isOwner = !editId || editCreatedBy === myId

  async function loadMeetingTasks(meetingId: string) {
    const { data } = await (supabase as any).schema('core').from('tasks').select('*').eq('meeting_id', meetingId).order('sort_order').order('created_at')
    setMeetingTasks((data ?? []) as Task[])
  }

  // Load supporting data (projects, users, vendor/category suggestions) on open.
  useEffect(() => {
    if (!open || !companyId) return
    const sb = supabase as any
    Promise.all([
      sb.schema('inventory').from('projects').select('id, project_name, status').eq('company_id', companyId).order('project_name'),
      sb.schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId).is('deleted_at', null).order('full_name'),
      sb.schema('inventory').from('meeting_notes').select('vendor, category').eq('company_id', companyId),
    ]).then(([projRes, usersRes, mnRes]: any[]) => {
      setProjects((projRes.data ?? []) as Project[])
      setAllUsers(((usersRes.data ?? []) as any[]).map((u) => ({ id: u.id, full_name: u.full_name, email: u.email ?? '', department: null })))
      const rows = (mnRes.data ?? []) as { vendor: string | null; category: string | null }[]
      setDistinctVendors([...new Set(rows.map((r) => r.vendor).filter(Boolean) as string[])].sort())
      setDistinctCategories([...new Set(rows.map((r) => r.category).filter(Boolean) as string[])].sort())
    })
  }, [open, companyId])

  // Seed the form each time the modal opens.
  useEffect(() => {
    if (!open) return
    setTaskForm({ ...EMPTY_TASK }); setParticipants([]); setSpecificUsers([])
    if (existing) {
      setEditId(existing.id)
      setEditCreatedBy(existing.created_by)
      const visibility: VisibilityValue = (existing as any).visibility ?? (existing.shared ? 'department' : 'private')
      setForm({
        title: existing.title, meeting_date: existing.meeting_date ?? '', meeting_time: existing.meeting_time ?? '',
        vendor: existing.vendor ?? '', category: existing.category ?? '', notes: existing.notes ?? '',
        visibility, links: ((existing as any).links ?? []) as MeetingLink[],
      })
      loadMeetingTasks(existing.id)
    } else {
      setEditId(null); setEditCreatedBy(myId)
      const now = new Date()
      setForm({ ...EMPTY_FORM, meeting_date: format(now, 'yyyy-MM-dd'), meeting_time: quick ? format(now, 'HH:mm') : '' })
      setMeetingTasks([])
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing, quick])

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
    // Best-effort: links column may not exist in all environments yet.
    if (savedId) sb.schema('inventory').from('meeting_notes').update({ links: form.links }).eq('id', savedId).then(() => {})
    setSaving(false)
    onSaved?.()
  }

  async function onDelete() {
    if (!editId || !isOwner || !confirm('Delete this meeting and its tasks?')) return
    const { error } = await (supabase as any).schema('inventory').from('meeting_notes').delete().eq('id', editId)
    if (error) { toast.error(error.message); return }
    toast.success('Meeting deleted')
    onSaved?.()
    onClose()
  }

  async function addTask() {
    if (!editId || !taskForm.title.trim() || !companyId) return
    const { error } = await (supabase as any).schema('core').from('tasks').insert({
      company_id: companyId, title: taskForm.title.trim(), target_date: taskForm.target_date || null,
      project_id: taskForm.project_id || null, source: 'meeting', meeting_id: editId, created_by: myId,
    })
    if (error) { toast.error(error.message); return }
    setTaskForm({ ...EMPTY_TASK })
    loadMeetingTasks(editId)
  }

  async function toggleTask(task: Task) {
    const done = !task.completed
    const { error } = await (supabase as any).schema('core').from('tasks').update({
      completed: done, completed_at: done ? new Date().toISOString() : null, completed_by: done ? myId : null,
    }).eq('id', task.id)
    if (error) { toast.error(error.message); return }
    if (editId) loadMeetingTasks(editId)
  }

  async function deleteTask(taskId: string) {
    await (supabase as any).schema('core').from('tasks').delete().eq('id', taskId)
    if (editId) loadMeetingTasks(editId)
  }

  return (
    <Modal open={open} onClose={onClose} title={editId ? 'Edit Meeting' : quick ? 'Quick Meeting' : 'New Meeting'} size="xl">
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Input label="Meeting Name *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="flex-1" />
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
              departments={[...new Set(allUsers.map((u) => (u as any).department).filter(Boolean) as string[])]}
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
            <input value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} list="meeting-vendors" placeholder="Type or select…"
              className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none" />
            <datalist id="meeting-vendors">{distinctVendors.map((v) => <option key={v} value={v} />)}</datalist>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-inky uppercase tracking-wide">Category</label>
            <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} list="meeting-categories" placeholder="Type or select…"
              className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none" />
            <datalist id="meeting-categories">{distinctCategories.map((c) => <option key={c} value={c} />)}</datalist>
          </div>
        </div>

        <SectionHeader>Meeting Notes</SectionHeader>
        <RichTextEditor value={form.notes} onChange={(html) => setForm({ ...form, notes: html })}
          placeholder="Meeting notes, agenda items, decisions made…" minHeight={200} disabled={!isOwner} />

        <SectionHeader>Links</SectionHeader>
        <div className="flex flex-col gap-2">
          {form.links.map((link, i) => (
            <div key={i} className="flex items-center gap-2">
              <input value={link.label} onChange={(e) => { const next = [...form.links]; next[i] = { ...next[i], label: e.target.value }; setForm({ ...form, links: next }) }}
                placeholder="Label (optional)" className="w-32 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-sky focus:outline-none" />
              <input value={link.url} onChange={(e) => { const next = [...form.links]; next[i] = { ...next[i], url: e.target.value }; setForm({ ...form, links: next }) }}
                placeholder="https://…" className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/40 focus:border-sky focus:outline-none" />
              <button onClick={() => setForm({ ...form, links: form.links.filter((_, idx) => idx !== i) })} className="text-inky/40 hover:text-[#C0392B] text-xs flex-shrink-0">✕</button>
            </div>
          ))}
          <button type="button" onClick={() => setForm({ ...form, links: [...form.links, { label: '', url: '' }] })}
            className="self-start text-xs font-mono text-inky hover:text-navy border border-navy/20 rounded px-2 py-1">+ Add Link</button>
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
            {meetingTasks.length === 0 && <p className="text-xs font-body italic text-inky/50">No action items yet.</p>}
            <ul className="flex flex-col gap-1.5">
              {meetingTasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2 group">
                  <input type="checkbox" checked={t.completed} onChange={() => toggleTask(t)} className="accent-inky flex-shrink-0" />
                  <span className={['flex-1 text-sm font-body', t.completed ? 'line-through text-inky/40' : 'text-navy'].join(' ')}>{t.title}</span>
                  {t.project_id && <span className="text-[10px] font-mono text-inky/60 bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5 flex-shrink-0">{projectById.get(t.project_id) ?? 'Project'}</span>}
                  {t.target_date && <span className="text-xs font-mono text-inky/50 flex-shrink-0">{format(new Date(t.target_date + 'T00:00:00'), 'MMM d')}</span>}
                  <button onClick={() => deleteTask(t.id)} className="text-inky/30 hover:text-[#C0392B] opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 text-xs">✕</button>
                </li>
              ))}
            </ul>
            <div className="flex items-center gap-2 pt-1">
              <input value={taskForm.title} onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addTask() }}
                placeholder="New action item…" className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:outline-none" />
              <select value={taskForm.project_id} onChange={(e) => setTaskForm({ ...taskForm, project_id: e.target.value })}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none">
                <option value="">No project</option>
                {openProjects.map((p) => <option key={p.id} value={p.id}>{p.project_name}</option>)}
              </select>
              <input type="date" value={taskForm.target_date} onChange={(e) => setTaskForm({ ...taskForm, target_date: e.target.value })}
                className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-body text-navy focus:border-sky focus:outline-none" />
              <button onClick={addTask} disabled={!taskForm.title.trim()}
                className="rounded border border-inky/30 px-3 py-1.5 text-xs font-heading text-inky hover:border-navy hover:text-navy uppercase disabled:opacity-40">Add</button>
            </div>
          </div>
        ) : (
          <p className="text-xs font-body italic text-inky/50 border-t border-navy/10 pt-3">Save the meeting first to add action items.</p>
        )}
      </div>
    </Modal>
  )
}
