import { useEffect, useState, useCallback } from 'react'
import { Calendar, dateFnsLocalizer, type View } from 'react-big-calendar'
import { format, parse, startOfWeek, getDay } from 'date-fns'
import { enUS } from 'date-fns/locale'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui'
import { ScheduleEventModal } from './ScheduleEventModal'
import type { ScheduleEvent } from '@/types'
import toast from 'react-hot-toast'

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
  resource: ScheduleEvent
}

export function SchedulePage() {
  const { profile } = useAuthStore()
  const [events, setEvents] = useState<ScheduleEvent[]>([])
  const [view, setView] = useState<View>('month')
  const [date, setDate] = useState(new Date())
  const [modalOpen, setModalOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<ScheduleEvent | null>(null)
  const [selectedSlot, setSelectedSlot] = useState<Date | null>(null)

  useEffect(() => {
    if (!profile?.company_id) return
    loadEvents()
    const channel = supabase
      .channel('schedule-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_events', filter: `company_id=eq.${profile.company_id}` },
        () => loadEvents()
      )
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [profile?.company_id])

  async function loadEvents() {
    if (!profile?.company_id) return
    const { data, error } = await supabase
      .from('schedule_events')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('start_date')
    if (error) toast.error('Failed to load schedule')
    else setEvents(data ?? [])
  }

  const calendarEvents: CalendarEvent[] = events.map((e) => ({
    id: e.id,
    title: e.title + (e.is_checklist && e.completed ? ' ✓' : ''),
    start: new Date(e.start_date + 'T00:00:00'),
    end: new Date((e.end_date ?? e.start_date) + 'T23:59:59'),
    resource: e,
  }))

  const eventStyleGetter = (event: CalendarEvent) => {
    const e = event.resource
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
        color: color,
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
    setEditEvent(event.resource)
    setSelectedSlot(null)
    setModalOpen(true)
  }, [])

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Schedule</h1>
          <p className="text-xs text-inky mt-0.5">Events, checklists, and recurring tasks</p>
        </div>
        <Button size="sm" onClick={() => { setEditEvent(null); setSelectedSlot(new Date()); setModalOpen(true) }}>
          + Add Event
        </Button>
      </div>

      <div className="flex-1 min-h-0" style={{ minHeight: '600px' }}>
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
