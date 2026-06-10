import { useEffect, useState } from 'react'
import { Modal, Button, Input, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { ScheduleEvent } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const EVENT_TYPES = ['order', 'monthly_count', 'weekly_count', 'meeting', 'other']
const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'monthly']

interface ScheduleEventModalProps {
  open: boolean
  onClose: () => void
  existing?: ScheduleEvent | null
  defaultDate?: Date | null
  onSaved: () => void
}

export function ScheduleEventModal({
  open, onClose, existing, defaultDate, onSaved,
}: ScheduleEventModalProps) {
  const { profile } = useAuthStore()
  const [title, setTitle] = useState('')
  const [eventType, setEventType] = useState('other')
  const [customType, setCustomType] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [recurrence, setRecurrence] = useState('none')
  const [isChecklist, setIsChecklist] = useState(false)
  const [completed, setCompleted] = useState(false)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (existing) {
      setTitle(existing.title)
      setEventType(EVENT_TYPES.includes(existing.event_type) ? existing.event_type : 'other')
      setCustomType(EVENT_TYPES.includes(existing.event_type) ? '' : existing.event_type)
      setStartDate(existing.start_date)
      setEndDate(existing.end_date ?? '')
      setRecurrence((existing.recurrence as any)?.type ?? 'none')
      setIsChecklist(existing.is_checklist)
      setCompleted(existing.completed)
      setNotes(existing.notes ?? '')
    } else {
      setTitle('')
      setEventType('other')
      setCustomType('')
      setStartDate(defaultDate ? format(defaultDate, 'yyyy-MM-dd') : '')
      setEndDate('')
      setRecurrence('none')
      setIsChecklist(false)
      setCompleted(false)
      setNotes('')
    }
  }, [existing, defaultDate, open])

  const resolvedEventType = eventType === 'other' && customType.trim() ? customType.trim() : eventType

  async function save() {
    if (!profile?.company_id || !title.trim() || !startDate) {
      toast.error('Title and start date are required')
      return
    }
    setSaving(true)
    const payload: Partial<ScheduleEvent> = {
      company_id: profile.company_id,
      title: title.trim(),
      event_type: resolvedEventType,
      start_date: startDate,
      end_date: endDate || null,
      recurrence: recurrence !== 'none' ? { type: recurrence } : null,
      is_checklist: isChecklist,
      completed,
      completed_at: completed ? (existing?.completed_at ?? new Date().toISOString()) : null,
      completed_by: completed ? (existing?.completed_by ?? profile.id) : null,
      notes: notes || null,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any
    const { error } = existing?.id
      ? await sb.from('schedule_events').update(payload).eq('id', existing.id)
      : await sb.from('schedule_events').insert(payload)

    if (error) toast.error(error.message)
    else { toast.success('Saved'); onSaved(); onClose() }
    setSaving(false)
  }

  async function deleteEvent() {
    if (!existing?.id) return
    setDeleting(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('schedule_events').delete().eq('id', existing.id)
    if (error) toast.error(error.message)
    else { toast.success('Deleted'); onSaved(); onClose() }
    setDeleting(false)
  }

  return (
    <Modal open={open} onClose={onClose} title={existing ? 'Edit Event' : 'Add Event'} size="lg">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Input label="Title *" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title..." />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">Event Type</label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-[#00e5ff]"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>
            ))}
          </select>
          {eventType === 'other' && (
            <Input placeholder="Custom type..." value={customType} onChange={(e) => setCustomType(e.target.value)} />
          )}
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">Recurrence</label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            className="bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-[#00e5ff]"
          >
            {RECURRENCE_OPTIONS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
          </select>
        </div>

        <Input label="Start Date *" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <Input label="End Date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />

        <div className="flex flex-col gap-2">
          <Toggle
            checked={isChecklist}
            onChange={setIsChecklist}
            label="Is Checklist Task"
            color="amber"
          />
          {isChecklist && (
            <Toggle
              checked={completed}
              onChange={setCompleted}
              label="Mark as Complete"
              color="green"
            />
          )}
        </div>

        <div className="col-span-2">
          <label className="text-xs font-mono text-gray-400 uppercase tracking-wide block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full bg-[#0f1117] border border-[#2a2d3e] rounded px-3 py-2 text-sm font-mono text-white placeholder-gray-600 focus:outline-none focus:border-[#00e5ff] resize-none"
          />
        </div>
      </div>

      <div className="flex items-center justify-between mt-4">
        {existing?.id ? (
          <Button variant="danger" size="sm" loading={deleting} onClick={deleteEvent}>
            Delete
          </Button>
        ) : <div />}
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={save}>Save Event</Button>
        </div>
      </div>
    </Modal>
  )
}
