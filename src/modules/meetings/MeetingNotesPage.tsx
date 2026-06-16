import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { MeetingNote, Task } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const EMPTY_FORM = { title: 'Untitled Meeting', meeting_date: '', meeting_time: '', vendor: '', category: '', notes: '' }
const EMPTY_TASK = { title: '', target_date: '' }

const col = createColumnHelper<MeetingNote>()

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

  const [meetings, setMeetings] = useState<MeetingNote[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [saving, setSaving] = useState(false)

  // Tasks within the open meeting
  const [meetingTasks, setMeetingTasks] = useState<Task[]>([])
  const [taskForm, setTaskForm] = useState({ ...EMPTY_TASK })

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const { data, error } = await (supabase as any)
      .from('meeting_notes')
      .select('*')
      .eq('company_id', companyId)
      .order('meeting_date', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
    if (error) toast.error(error.message)
    else setMeetings((data ?? []) as MeetingNote[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  async function loadMeetingTasks(meetingId: string) {
    const { data } = await (supabase as any)
      .from('tasks')
      .select('*')
      .eq('meeting_id', meetingId)
      .order('sort_order')
      .order('created_at')
    setMeetingTasks((data ?? []) as Task[])
  }

  function openNew() {
    setEditId(null)
    setForm({ ...EMPTY_FORM, meeting_date: format(new Date(), 'yyyy-MM-dd') })
    setMeetingTasks([])
    setTaskForm({ ...EMPTY_TASK })
    setModalOpen(true)
  }

  function openEdit(m: MeetingNote) {
    setEditId(m.id)
    setForm({
      title: m.title,
      meeting_date: m.meeting_date ?? '',
      meeting_time: m.meeting_time ?? '',
      vendor: m.vendor ?? '',
      category: m.category ?? '',
      notes: m.notes ?? '',
    })
    setTaskForm({ ...EMPTY_TASK })
    loadMeetingTasks(m.id)
    setModalOpen(true)
  }

  async function onSave() {
    if (!companyId || !form.title.trim()) return
    setSaving(true)
    const payload = {
      company_id: companyId,
      title: form.title.trim(),
      meeting_date: form.meeting_date || null,
      meeting_time: form.meeting_time || null,
      vendor: form.vendor.trim() || null,
      category: form.category.trim() || null,
      notes: form.notes || null,
      created_by: profile?.id ?? null,
    }
    const sb = supabase as any
    if (editId) {
      const { error } = await sb.from('meeting_notes').update(payload).eq('id', editId)
      if (error) { toast.error(error.message); setSaving(false); return }
      toast.success('Meeting saved')
    } else {
      const { data, error } = await sb.from('meeting_notes').insert(payload).select().single()
      if (error) { toast.error(error.message); setSaving(false); return }
      setEditId(data.id)
      toast.success('Meeting created')
    }
    setSaving(false)
    load()
  }

  async function onDelete() {
    if (!editId || !confirm('Delete this meeting and its tasks?')) return
    const { error } = await (supabase as any).from('meeting_notes').delete().eq('id', editId)
    if (error) { toast.error(error.message); return }
    toast.success('Meeting deleted')
    setModalOpen(false)
    setEditId(null)
    load()
  }

  async function addTask() {
    if (!editId || !taskForm.title.trim()) return
    if (!companyId) return
    const { error } = await (supabase as any).from('tasks').insert({
      company_id: companyId,
      title: taskForm.title.trim(),
      target_date: taskForm.target_date || null,
      source: 'meeting',
      meeting_id: editId,
      created_by: profile?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    setTaskForm({ ...EMPTY_TASK })
    loadMeetingTasks(editId)
  }

  async function toggleTask(task: Task) {
    const done = !task.completed
    const { error } = await (supabase as any).from('tasks').update({
      completed: done,
      completed_at: done ? new Date().toISOString() : null,
      completed_by: done ? (profile?.id ?? null) : null,
    }).eq('id', task.id)
    if (error) { toast.error(error.message); return }
    if (editId) loadMeetingTasks(editId)
  }

  async function deleteTask(taskId: string) {
    await (supabase as any).from('tasks').delete().eq('id', taskId)
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
    col.accessor('title', { header: 'Meeting' }),
    col.accessor('meeting_date', {
      header: 'Date',
      cell: (i) => formatDateTime(i.getValue(), (i.row.original as MeetingNote).meeting_time),
    }),
    col.accessor('vendor', { header: 'Vendor', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('category', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('notes', {
      header: 'Notes',
      cell: (i) => {
        const n = i.getValue()
        return n ? <span className="text-inky/70">{n.slice(0, 60)}{n.length > 60 ? '…' : ''}</span> : '—'
      },
    }),
    {
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => (
        <button onClick={() => openEdit(i.row.original as MeetingNote)}
          className="text-xs font-mono text-inky hover:underline">Open</button>
      ),
    },
  ], []) // eslint-disable-line react-hooks/exhaustive-deps

  const { table, globalFilter, setGlobalFilter } = useTable(meetings, columns)

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Meeting Notes</h1>
          <p className="text-xs text-inky mt-0.5">Record meetings, notes, and action items by vendor or category.</p>
        </div>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="meeting_notes.csv"
        exportData={meetings}
        loading={loading}
        actions={<Button size="sm" onClick={openNew}>+ New Meeting</Button>}
      />

      <Modal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditId(null); load() }}
        title={editId ? 'Edit Meeting' : 'New Meeting'}
        size="xl"
      >
        <div className="flex flex-col gap-4">
          {/* Header fields */}
          <Input
            label="Meeting Name *"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input label="Date" type="date" value={form.meeting_date} onChange={(e) => setForm({ ...form, meeting_date: e.target.value })} />
            <Input label="Time" type="time" value={form.meeting_time} onChange={(e) => setForm({ ...form, meeting_time: e.target.value })} />
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

          {/* Notes */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-inky uppercase tracking-wide">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              rows={8}
              placeholder="Meeting notes, agenda items, decisions made…"
              className="rounded border border-navy/30 bg-cream px-3 py-2 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none resize-y"
            />
          </div>

          {/* Save/Delete row */}
          <div className="flex items-center justify-between gap-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete Meeting</Button>}</div>
            <Button size="sm" onClick={onSave} disabled={saving || !form.title.trim()}>
              {saving ? 'Saving…' : editId ? 'Save Changes' : 'Create Meeting'}
            </Button>
          </div>

          {/* Tasks section — only shown after meeting is saved (has an id) */}
          {editId && (
            <div className="border-t border-navy/20 pt-4 flex flex-col gap-3">
              <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Action Items</h3>

              {meetingTasks.length === 0 && (
                <p className="text-xs font-body italic text-inky/50">No tasks yet.</p>
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

              {/* Add task inline */}
              <div className="flex items-center gap-2 pt-1">
                <input
                  value={taskForm.title}
                  onChange={(e) => setTaskForm({ ...taskForm, title: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter') addTask() }}
                  placeholder="New action item…"
                  className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:outline-none"
                />
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
          )}
          {!editId && (
            <p className="text-xs font-body italic text-inky/50 border-t border-navy/10 pt-3">
              Save the meeting first to add action items.
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}
