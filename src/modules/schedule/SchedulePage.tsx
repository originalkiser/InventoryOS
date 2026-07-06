import { useCallback, useEffect, useState } from 'react'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { enUS } from 'date-fns/locale'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui'
import { ScheduleEventModal } from './ScheduleEventModal'
import type { CompanyHoliday, ScheduleEvent } from '@/types'
import toast from 'react-hot-toast'
import {
  normalizeBlockedDays,
  formatBlockedDayLabel,
  upsertBlockedDay,
  removeBlockedDay,
} from '@/utils/blockedDays'

const localizer = dateFnsLocalizer({
  format,
  parse,
  startOfWeek: () => startOfWeek(new Date(), { weekStartsOn: 0 }),
  getDay,
  locales: { 'en-US': enUS },
})

interface CalendarEvent {
  id: string
  title: string
  start: Date
  end: Date
  allDay?: boolean
  resource: ScheduleEvent | { markerType: 'holiday' | 'blocked'; date: string; note?: string }
}

export function SchedulePage() {
  const { profile, setProfile } = useAuthStore()
  const [events, setEvents] = useState<ScheduleEvent[]>([])
  const [view, setView] = useState<View>('month')
  const [date, setDate] = useState(new Date())
  const [modalOpen, setModalOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<ScheduleEvent | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<Date | null>(null)

  // Holiday + blocked-day overlay
  const [companyHolidays, setCompanyHolidays] = useState<CompanyHoliday[]>([])
  const [showHolidays, setShowHolidays] = useState(true)
  const [showBlocked, setShowBlocked] = useState(true)
  const [showBlockedMgr, setShowBlockedMgr] = useState(false)
  const [showList, setShowList] = useState(false)
  const [newBlockedDate, setNewBlockedDate] = useState('')
  const [newBlockedNote, setNewBlockedNote] = useState('')
  const [savingBlocked, setSavingBlocked] = useState(false)

  const normalizedBlocked = normalizeBlockedDays(profile?.blocked_days)

  useEffect(() => {
    if (!profile?.company_id) return
    loadEvents()
    loadHolidays()
    const channel = supabase
      .channel('schedule-rt')
      .on('postgres_changes', {
        event: '*',
        schema: 'platform',
        table: 'schedule_events',
        filter: `company_id=eq.${profile.company_id}`,
      }, () => loadEvents())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [profile?.company_id])

  async function loadEvents() {
    if (!profile?.company_id || !profile?.id) return
    const myId = profile.id
    const { data, error } = await (supabase as any)
      .schema('platform').from('schedule_events')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('start_date')
    if (error) toast.error('Failed to load calendar')
    else {
      const visible = (data ?? []).filter((e: any) => {
        const v = e.visibility as string | null
        // If created_by is set (migration applied), use it as the source-of-truth for private events
        if (e.created_by) {
          if (v === 'attendees' || v === 'specific_users') {
            return (e.assigned_to ?? []).includes(myId)
          }
          return e.created_by === myId || (e.assigned_to ?? []).includes(myId)
        }
        // Pre-migration: still scope attendee/specific events by assigned_to
        if (v === 'attendees' || v === 'specific_users') {
          return (e.assigned_to ?? []).includes(myId)
        }
        // Department + private without created_by: visible to all (need migration for full privacy)
        return true
      })
      setEvents(visible)
    }
  }

  async function loadHolidays() {
    if (!profile?.company_id) return
    const { data } = await (supabase as any)
      .schema('core').from('company_holidays')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('date')
    setCompanyHolidays(data ?? [])
  }

  async function addBlockedDay() {
    if (!newBlockedDate || !profile?.id) return
    setSavingBlocked(true)
    const updated = upsertBlockedDay(normalizedBlocked, {
      date: newBlockedDate,
      ...(newBlockedNote.trim() ? { note: newBlockedNote.trim() } : {}),
    })
    const { data, error } = await (supabase as any)
      .schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { toast.error('Failed to save blocked day'); setSavingBlocked(false); return }
    setProfile({ ...profile, ...data })
    setNewBlockedDate('')
    setNewBlockedNote('')
    setSavingBlocked(false)
  }

  async function deleteBlockedDay(date: string) {
    if (!profile?.id) return
    const updated = removeBlockedDay(normalizedBlocked, date)
    const { data, error } = await (supabase as any)
      .schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { toast.error('Failed to remove'); return }
    setProfile({ ...profile, ...data })
  }

  // Combine real events with holiday / blocked-day markers
  const calendarEvents: CalendarEvent[] = [
    ...events.map((e): CalendarEvent => {
      const evAllDay = (e as any).is_all_day !== false
      const evStartTime = (e as any).start_time as string | null
      const evEndTime = (e as any).end_time as string | null
      const endDateStr = e.end_date ?? e.start_date
      return {
        id: e.id,
        title: e.title + (e.is_checklist && e.completed ? ' ✓' : ''),
        start: evAllDay
          ? new Date(e.start_date + 'T00:00:00')
          : new Date(`${e.start_date}T${evStartTime ?? '00:00'}:00`),
        end: evAllDay
          ? new Date(endDateStr + 'T23:59:59')
          : new Date(`${endDateStr}T${evEndTime ?? '23:59'}:00`),
        allDay: evAllDay,
        resource: e,
      }
    }),
    ...(showHolidays
      ? companyHolidays.map((h): CalendarEvent => ({
          id: `holiday-${h.id}`,
          title: h.name,
          start: new Date(h.date + 'T00:00:00'),
          end: new Date(h.date + 'T23:59:59'),
          allDay: true,
          resource: { markerType: 'holiday' as const, date: h.date },
        }))
      : []),
    ...(showBlocked
      ? normalizedBlocked.map((bd): CalendarEvent => ({
          id: `blocked-${bd.date}`,
          title: bd.note ? `Blocked: ${bd.note}` : 'Blocked',
          start: new Date(bd.date + 'T00:00:00'),
          end: new Date(bd.date + 'T23:59:59'),
          allDay: true,
          resource: { markerType: 'blocked' as const, date: bd.date, note: bd.note },
        }))
      : []),
  ]

  const eventStyleGetter = (event: CalendarEvent) => {
    const r = event.resource as any
    if (r?.markerType === 'holiday') {
      return {
        style: {
          backgroundColor: 'rgba(230,126,34,0.15)',
          border: '1px solid rgba(230,126,34,0.45)',
          color: '#E67E22',
          fontSize: '11px',
          fontFamily: '"DM Mono", monospace',
          borderRadius: '4px',
        },
      }
    }
    if (r?.markerType === 'blocked') {
      return {
        style: {
          backgroundColor: 'rgba(192,57,43,0.12)',
          border: '1px solid rgba(192,57,43,0.35)',
          color: '#C0392B',
          fontSize: '11px',
          fontFamily: '"DM Mono", monospace',
          borderRadius: '4px',
        },
      }
    }
    const e = r as ScheduleEvent
    const colors: Record<string, string> = {
      monthly_count: '#00e5ff',
      weekly_count: '#39ff14',
      order: '#ffb300',
      meeting: '#ff00ff',
      other: '#6b7280',
    }
    const color = colors[e.event_type] ?? colors.other
    return {
      style: {
        backgroundColor: `${color}20`,
        border: `1px solid ${color}60`,
        color,
        fontSize: '11px',
        fontFamily: 'JetBrains Mono, monospace',
        borderRadius: '4px',
        opacity: e.completed ? 0.5 : 1,
      },
    }
  }

  const onSelectSlot = useCallback(({ start }: { start: Date }) => {
    setSelectedSlot(start)
    setEditEvent(null)
    setModalOpen(true)
  }, [])

  const onSelectEvent = useCallback((event: CalendarEvent) => {
    const r = event.resource as any
    if (r?.markerType) return  // holiday / blocked markers — no modal
    setEditEvent(r as ScheduleEvent)
    setSelectedSlot(null)
    setModalOpen(true)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Calendar</h1>
          <p className="text-xs text-inky mt-0.5">Events, checklists, and recurring tasks</p>
        </div>
        <Button
          size="sm"
          onClick={() => { setEditEvent(null); setSelectedSlot(new Date()); setModalOpen(true) }}
        >
          + Add Event
        </Button>
      </div>

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setShowHolidays((v) => !v)}
          className={[
            'text-xs font-mono rounded border px-2.5 py-1 transition-colors',
            showHolidays
              ? 'border-[#E67E22]/60 bg-[#E67E22]/10 text-[#E67E22]'
              : 'border-navy/20 text-inky hover:border-navy/40',
          ].join(' ')}
        >
          Holidays {showHolidays ? 'on' : 'off'}
        </button>
        <button
          onClick={() => setShowBlocked((v) => !v)}
          className={[
            'text-xs font-mono rounded border px-2.5 py-1 transition-colors',
            showBlocked
              ? 'border-[#C0392B]/60 bg-[#C0392B]/10 text-[#C0392B]'
              : 'border-navy/20 text-inky hover:border-navy/40',
          ].join(' ')}
        >
          Blocked {showBlocked ? 'on' : 'off'}
        </button>
        <button
          onClick={() => setShowList((v) => !v)}
          className={[
            'text-xs font-mono rounded border px-2.5 py-1 transition-colors',
            showList
              ? 'border-sky/60 bg-sky/10 text-navy'
              : 'border-navy/20 text-inky hover:border-navy/40',
          ].join(' ')}
        >
          List {showList ? '▴' : '▾'}
        </button>
        <button
          onClick={() => setShowBlockedMgr((v) => !v)}
          className="ml-auto text-xs font-mono text-inky hover:text-navy border border-navy/20 rounded px-2.5 py-1 hover:border-navy/40 transition-colors"
        >
          {showBlockedMgr ? 'Hide blocked days ▴' : 'Manage blocked days ▾'}
        </button>
      </div>

      {/* Blocked-day manager (collapsible) */}
      {showBlockedMgr && (
        <div className="rounded-lg border border-navy/20 bg-cream dark:bg-navy/20 p-4 flex flex-col gap-3">
          <p className="text-[10px] font-mono text-inky uppercase tracking-wide">
            My Blocked Days &mdash; tasks won&apos;t push to these dates
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Date</label>
              <input
                type="date"
                value={newBlockedDate}
                onChange={(e) => setNewBlockedDate(e.target.value)}
                className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-1.5 text-navy focus:border-[#00e5ff] focus:outline-none"
              />
            </div>
            <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
              <label className="text-[10px] font-mono text-inky uppercase tracking-wide">
                Note (optional)
              </label>
              <input
                type="text"
                value={newBlockedNote}
                onChange={(e) => setNewBlockedNote(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addBlockedDay()}
                placeholder="e.g. Vacation"
                className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-1.5 text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none"
              />
            </div>
            <Button size="sm" onClick={addBlockedDay} loading={savingBlocked} disabled={!newBlockedDate}>
              + Add
            </Button>
          </div>
          {normalizedBlocked.length === 0 ? (
            <p className="text-[10px] font-mono text-inky/50 italic">No blocked days yet.</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-44 overflow-y-auto">
              {normalizedBlocked.map((bd) => (
                <div key={bd.date} className="flex items-center justify-between gap-3">
                  <span className="text-xs font-mono text-navy flex-1">
                    {formatBlockedDayLabel(bd)}
                  </span>
                  <button
                    onClick={() => deleteBlockedDay(bd.date)}
                    className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] transition-colors flex-shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Holidays + blocked days list */}
      {showList && (
        <div className="rounded-lg border border-navy/20 bg-cream dark:bg-navy/20 p-4 flex flex-col gap-3">
          <p className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/80 uppercase tracking-widest">
            Holidays &amp; Blocked Days
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Company holidays */}
            <div>
              <p className="text-[10px] font-mono text-[#E67E22] uppercase tracking-wide mb-2">Company Holidays</p>
              {companyHolidays.length === 0 ? (
                <p className="text-[10px] font-mono text-inky/50 italic">No company holidays configured.</p>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                  {companyHolidays.map((h) => (
                    <div key={h.id} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-[#E67E22]/80 w-24 flex-shrink-0">
                        {format(new Date(h.date + 'T00:00:00'), 'EEE, MMM d')}
                      </span>
                      <span className="text-xs font-mono text-navy dark:text-[#F2F1E6] truncate">{h.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Personal blocked days */}
            <div>
              <p className="text-[10px] font-mono text-[#C0392B] uppercase tracking-wide mb-2">My Blocked Days</p>
              {normalizedBlocked.length === 0 ? (
                <p className="text-[10px] font-mono text-inky/50 italic">No blocked days set.</p>
              ) : (
                <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto">
                  {normalizedBlocked.map((bd) => (
                    <div key={bd.date} className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-[#C0392B]/80 w-24 flex-shrink-0">
                        {format(new Date(bd.date + 'T00:00:00'), 'EEE, MMM d')}
                      </span>
                      <span className="text-xs font-mono text-navy dark:text-[#F2F1E6] truncate">
                        {bd.note || '—'}
                      </span>
                      <button
                        onClick={() => deleteBlockedDay(bd.date)}
                        className="text-[10px] font-mono text-inky/40 hover:text-[#C0392B] transition-colors flex-shrink-0 ml-auto"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Calendar — explicit pixel height so react-big-calendar month/agenda rows render */}
      <div style={{ height: 'calc(100vh - 240px)', minHeight: '560px' }}>
        <style>{`
          .rbc-calendar { background: #F2F1E6; color: #002745; font-family: 'DM Mono', monospace; border-radius: 8px; border: 1px solid rgba(0,39,69,0.2); }
          .rbc-header { background: #002745; border-color: rgba(0,39,69,0.2) !important; padding: 8px 4px; font-size: 11px; color: #F2F1E6; text-transform: uppercase; letter-spacing: 0.07em; font-family: 'Chakra Petch', sans-serif; font-weight: 700; }
          .rbc-month-view, .rbc-time-view, .rbc-agenda-view { border-color: rgba(0,39,69,0.15); }
          .rbc-day-bg { border-color: rgba(0,39,69,0.1) !important; }
          .rbc-off-range-bg { background: #ECEBD8; }
          .rbc-today { background: rgba(183,224,222,0.25) !important; }
          .rbc-date-cell { color: #4F7489; font-size: 11px; padding: 4px; font-family: 'DM Mono', monospace; }
          .rbc-date-cell.rbc-current { color: #002745; font-weight: 700; }
          .rbc-toolbar { padding: 12px; border-bottom: 1px solid rgba(0,39,69,0.15); background: #F2F1E6; }
          .rbc-toolbar button { color: #002745; background: transparent; border: 1px solid rgba(0,39,69,0.3); border-radius: 4px; font-family: 'Chakra Petch', sans-serif; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 10px; cursor: pointer; transition: all 0.15s; }
          .rbc-toolbar button:hover { border-color: #002745; background: rgba(0,39,69,0.05); }
          .rbc-toolbar button.rbc-active { border-color: #002745; color: #F2F1E6; background: #002745; }
          .rbc-toolbar-label { color: #002745; font-size: 13px; font-weight: 700; font-family: 'Chakra Petch', sans-serif; text-transform: uppercase; letter-spacing: 0.05em; }
          .rbc-show-more { color: #4F7489; font-size: 10px; background: transparent; }
          .rbc-event { border-radius: 3px; }
          .rbc-agenda-view table { background: #F2F1E6; }
          .rbc-agenda-date-cell, .rbc-agenda-time-cell { color: #4F7489; font-family: 'DM Mono', monospace; font-size: 11px; }
          .rbc-agenda-event-cell { color: #002745; font-family: 'DM Mono', monospace; font-size: 12px; }
        `}</style>
        <Calendar
          localizer={localizer}
          events={calendarEvents}
          view={view}
          date={date}
          onView={setView}
          onNavigate={setDate}
          selectable
          onSelectSlot={onSelectSlot}
          onSelectEvent={onSelectEvent}
          eventPropGetter={eventStyleGetter}
          style={{ height: '100%' }}
        />
      </div>

      <ScheduleEventModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditEvent(null) }}
        existing={editEvent}
        defaultDate={selectedSlot}
        onSaved={loadEvents}
      />
    </div>
  )
}
