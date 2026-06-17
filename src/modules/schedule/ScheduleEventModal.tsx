import { useEffect, useState } from 'react'
import { Modal, Button, Input, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Profile, ScheduleEvent } from '@/types'
import { format, parseISO, addDays, addWeeks, addMonths } from 'date-fns'
import toast from 'react-hot-toast'

const EVENT_TYPES = ['order', 'monthly_count', 'weekly_count', 'meeting', 'other']
const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'monthly']

// Safety cap so an open-ended recurrence can't insert unbounded rows.
const MAX_OCCURRENCES = 366

function stepDate(d: Date, type: string): Date {
  if (type === 'weekly') return addWeeks(d, 1)
  if (type === 'monthly') return addMonths(d, 1)
  return addDays(d, 1) // daily (and fallback)
}

// Expand a recurrence into individual occurrence dates (yyyy-MM-dd), from
// `start` through `until` inclusive. Open-ended recurrences (no until) are
// capped at one year out so we never generate forever.
function occurrenceDates(start: string, until: string | null, type: string): string[] {
  const out: string[] = []
  let d = parseISO(start)
  const horizon = until ? parseISO(until) : addMonths(parseISO(start), 12)
  while (d <= horizon && out.length < MAX_OCCURRENCES) {
    out.push(format(d, 'yyyy-MM-dd'))
    d = stepDate(d, type)
  }
  return out
}

function ProfileMultiPicker({
  profiles,
  selected,
  onChange,
}: {
  profiles: Profile[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')

  const filtered = profiles.filter((p) =>
    !search || (p.full_name ?? p.email ?? '').toLowerCase().includes(search.toLowerCase())
  )

  function toggle(id: string) {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-mono text-inky uppercase tracking-wide">Assigned To</label>

      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {selected.map((id) => {
            const p = profiles.find((x) => x.id === id)
            return (
              <span
                key={id}
                className="flex items-center gap-1 text-[10px] font-mono bg-[#00e5ff]/10 border border-[#00e5ff]/30 rounded px-1.5 py-0.5 text-navy"
              >
                {p?.full_name ?? p?.email ?? id}
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="text-inky/50 hover:text-red-400 leading-none"
                >
                  ×
                </button>
              </span>
            )
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-left text-xs font-mono border border-navy/30 rounded px-3 py-2 bg-cream text-inky hover:border-[#00e5ff]/60"
      >
        {open ? 'Close picker ↑' : `${selected.length ? 'Edit' : 'Assign'} people…`}
      </button>

      {open && (
        <div className="border border-navy/30 rounded bg-cream shadow-sm flex flex-col max-h-44 overflow-hidden">
          <input
            autoFocus
            placeholder="Search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="border-b border-navy/20 px-3 py-1.5 text-xs font-mono bg-cream text-navy placeholder-inky/40 focus:outline-none"
          />
          <div className="overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-xs font-mono text-inky/50">No matches</p>
            ) : (
              filtered.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => toggle(p.id)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[#00e5ff]/5 text-left"
                >
                  <span className={`w-3 h-3 rounded border flex-shrink-0 flex items-center justify-center text-[8px] font-bold ${selected.includes(p.id) ? 'bg-[#00e5ff] border-[#00e5ff] text-navy' : 'border-navy/40'}`}>
                    {selected.includes(p.id) ? '✓' : ''}
                  </span>
                  <span className="text-xs font-mono text-navy truncate">{p.full_name ?? p.email}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

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
  const [assignedTo, setAssignedTo] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const [applyToSeries, setApplyToSeries] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])

  useEffect(() => {
    if (!profile?.company_id) return
    ;(supabase as any).from('profiles').select('id, full_name, email').eq('company_id', profile.company_id).order('full_name')
      .then(({ data }: any) => setOrgProfiles((data ?? []) as Profile[]))
  }, [profile?.company_id])

  useEffect(() => {
    setApplyToSeries(false)
    if (existing) {
      setTitle(existing.title)
      setEventType(EVENT_TYPES.includes(existing.event_type) ? existing.event_type : 'other')
      setCustomType(EVENT_TYPES.includes(existing.event_type) ? '' : existing.event_type)
      setStartDate(existing.start_date)
      setEndDate(existing.end_date ?? '')
      setRecurrence((existing.recurrence as any)?.type ?? 'none')
      setIsChecklist(existing.is_checklist)
      setCompleted(existing.completed)
      setAssignedTo(existing.assigned_to ?? [])
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
      setAssignedTo([])
      setNotes('')
    }
  }, [existing, defaultDate, open])

  const resolvedEventType = eventType === 'other' && customType.trim() ? customType.trim() : eventType

  // An existing row that belongs to a generated series. Its recurrence is locked
  // (edit/delete the whole series instead), so it's edited as a single occurrence.
  const isSeriesMember = !!existing?.series_id
  // We materialize a series only when creating, or converting a standalone event.
  const willGenerateSeries = recurrence !== 'none' && !isSeriesMember

  async function save() {
    if (!profile?.company_id || !title.trim() || !startDate) {
      toast.error('Title and start date are required')
      return
    }
    setSaving(true)

    const base = {
      company_id: profile.company_id,
      title: title.trim(),
      event_type: resolvedEventType,
      is_checklist: isChecklist,
      assigned_to: isChecklist && assignedTo.length ? assignedTo : null,
      notes: notes || null,
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any

    // Recurring: explode into one row per occurrence so it shows up everywhere
    // (calendar, dashboard, top-bar reminders). end_date is the "repeat until".
    if (willGenerateSeries) {
      const dates = occurrenceDates(startDate, endDate || null, recurrence)
      if (dates.length === 0) {
        toast.error('No occurrences fall in that range')
        setSaving(false)
        return
      }
      const seriesId = crypto.randomUUID()
      const rows = dates.map((d) => ({
        ...base,
        start_date: d,
        end_date: d, // each occurrence is a single day
        recurrence: { type: recurrence, until: endDate || null },
        series_id: seriesId,
        completed: false,
        completed_at: null,
        completed_by: null,
      }))

      // Converting an existing standalone event into a series: drop the original.
      let error: { message: string } | null = null
      if (existing?.id) {
        const del = await sb.from('schedule_events').delete().eq('id', existing.id)
        error = del.error
      }
      if (!error) {
        const ins = await sb.from('schedule_events').insert(rows)
        error = ins.error
      }

      if (error) toast.error(error.message)
      else {
        const capped = rows.length >= MAX_OCCURRENCES && !endDate
        toast.success(`Scheduled ${rows.length} occurrence${rows.length > 1 ? 's' : ''}${capped ? ' (capped — set an end date for more)' : ''}`)
        onSaved(); onClose()
      }
      setSaving(false)
      return
    }

    // Editing a single occurrence but propagating shared attributes to the whole
    // series. Per-occurrence fields (dates, completion) stay row-specific.
    if (isSeriesMember && applyToSeries && existing?.series_id) {
      const shared = { ...base }
      const seriesUpdate = await sb.from('schedule_events').update(shared).eq('series_id', existing.series_id)
      let error = seriesUpdate.error
      if (!error) {
        // This occurrence still gets its own date/completion changes.
        const own = await sb.from('schedule_events').update({
          start_date: startDate,
          end_date: endDate || null,
          completed,
          completed_at: completed ? (existing.completed_at ?? new Date().toISOString()) : null,
          completed_by: completed ? (existing.completed_by ?? profile.id) : null,
        }).eq('id', existing.id)
        error = own.error
      }
      if (error) toast.error(error.message)
      else { toast.success('Updated all occurrences'); onSaved(); onClose() }
      setSaving(false)
      return
    }

    // Non-recurring, or editing a single occurrence within a series.
    const payload: Partial<ScheduleEvent> = {
      ...base,
      start_date: startDate,
      end_date: endDate || null,
      recurrence: isSeriesMember ? (existing?.recurrence ?? null) : null,
      series_id: existing?.series_id ?? null,
      completed,
      completed_at: completed ? (existing?.completed_at ?? new Date().toISOString()) : null,
      completed_by: completed ? (existing?.completed_by ?? profile.id) : null,
    }

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

  async function deleteSeries() {
    if (!existing?.series_id) return
    if (!confirm('Delete every occurrence in this recurring series?')) return
    setDeleting(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from('schedule_events').delete().eq('series_id', existing.series_id)
    if (error) toast.error(error.message)
    else { toast.success('Series deleted'); onSaved(); onClose() }
    setDeleting(false)
  }

  return (
    <Modal open={open} onClose={onClose} title={existing ? 'Edit Event' : 'Add Event'} size="lg">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Input label="Title *" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Event title..." />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Event Type</label>
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="bg-cream border border-navy/30 rounded px-3 py-2 text-sm font-mono text-navy focus:outline-none focus:border-[#00e5ff]"
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
          <label className="text-xs font-mono text-inky uppercase tracking-wide">Recurrence</label>
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value)}
            disabled={isSeriesMember}
            className="bg-cream border border-navy/30 rounded px-3 py-2 text-sm font-mono text-navy focus:outline-none focus:border-[#00e5ff] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {RECURRENCE_OPTIONS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
          </select>
          {willGenerateSeries && (
            <p className="text-[10px] font-mono text-inky">Generates one task per {recurrence === 'daily' ? 'day' : recurrence === 'weekly' ? 'week' : 'month'} until the repeat-until date.</p>
          )}
          {isSeriesMember && (
            <p className="text-[10px] font-mono text-inky">Part of a recurring series — recurrence is locked. Use “Delete Series” to remove all.</p>
          )}
        </div>

        <Input label="Start Date *" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        <Input
          label={willGenerateSeries ? 'Repeat Until' : 'End Date'}
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />

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

        {isChecklist && (
          <div className="col-span-2">
            <ProfileMultiPicker
              profiles={orgProfiles}
              selected={assignedTo}
              onChange={setAssignedTo}
            />
          </div>
        )}

        <div className="col-span-2">
          <label className="text-xs font-mono text-inky uppercase tracking-wide block mb-1">Notes</label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full bg-cream border border-navy/30 rounded px-3 py-2 text-sm font-mono text-navy placeholder-inky/50 focus:outline-none focus:border-[#00e5ff] resize-none"
          />
        </div>

        {isSeriesMember && (
          <div className="col-span-2 flex flex-col gap-1 border-t border-navy/30 pt-3">
            <Toggle
              checked={applyToSeries}
              onChange={setApplyToSeries}
              label="Apply changes to all occurrences"
              color="cyan"
            />
            <p className="text-[10px] font-mono text-inky">
              {applyToSeries
                ? 'Title, type, notes, and checklist flag update across the whole series. This occurrence keeps its own date and completion.'
                : 'Off — changes apply to this occurrence only.'}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-4">
        {existing?.id ? (
          <div className="flex gap-2">
            <Button variant="danger" size="sm" loading={deleting} onClick={deleteEvent}>
              Delete{isSeriesMember ? ' This' : ''}
            </Button>
            {isSeriesMember && (
              <Button variant="danger" size="sm" loading={deleting} onClick={deleteSeries}>
                Delete Series
              </Button>
            )}
          </div>
        ) : <div />}
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={save}>{willGenerateSeries ? 'Schedule Series' : applyToSeries ? 'Update All' : 'Save Event'}</Button>
        </div>
      </div>
    </Modal>
  )
}
