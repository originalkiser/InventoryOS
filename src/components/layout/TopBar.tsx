import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useDarkMode } from '@/hooks/useDarkMode'
import { useLocations } from '@/hooks/useLocations'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { FloatingPanel, type PanelMode } from '@/components/shared/FloatingPanel'
import { EndDayModal } from '@/modules/projects/EndDayModal'
import { format, differenceInDays, endOfWeek, endOfMonth, parseISO } from 'date-fns'
import type { Profile } from '@/types'

interface TopBarStats {
  pendingIssues: number
  todayChecklists: number
  nextCountDays: number | null
  lastEndingValue: number | null
  activeShops: number
  pendingOrders: number
  overdueTasks: number
  countProgressPct: number | null
  recountNeeded: number
  formsDue: number
}

// ── Pill definitions ──────────────────────────────────────────────────────────

const ALL_PILL_KEYS = [
  'open_issues', 'tasks_due_today', 'next_count_date', 'ending_balance', 'shop_count',
  'pending_orders', 'overdue_tasks', 'monthly_count_pct', 'recount_needed', 'forms_due',
] as const
type PillKey = typeof ALL_PILL_KEYS[number]

const PILL_LABELS: Record<PillKey, string> = {
  open_issues:       'Issues',
  tasks_due_today:   "Today's Tasks",
  next_count_date:   'Next Count',
  ending_balance:    'Ending',
  shop_count:        'Shops',
  pending_orders:    'Pending Orders',
  overdue_tasks:     'Overdue',
  monthly_count_pct: 'Count Progress',
  recount_needed:    'Recounts',
  forms_due:         'Forms Due',
}

const DEFAULT_PILL_ORDER: PillKey[] = [...ALL_PILL_KEYS]
const DEFAULT_HIDDEN: PillKey[] = []
const PILL_PREFS_KEY = 'sbnet:dashboard:pill_prefs'
const DB_PILL_KEY = 'dashboard.pills'

interface PillPrefs { order: PillKey[]; hidden: PillKey[] }

function loadLocalPillPrefs(): PillPrefs {
  try {
    const raw = localStorage.getItem(PILL_PREFS_KEY)
    if (raw) return JSON.parse(raw)
  } catch {}
  return { order: DEFAULT_PILL_ORDER, hidden: DEFAULT_HIDDEN }
}

// Sortable row inside the pill config popover
function SortablePillRow({ id, label, visible, onToggle }: {
  id: string; label: string; visible: boolean; onToggle: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-1.5 rounded select-none ${isDragging ? 'opacity-50 bg-[#F2F1E6]/5' : 'hover:bg-[#F2F1E6]/5'}`}
    >
      <span
        {...attributes}
        {...listeners}
        className="text-[#F2F1E6]/20 hover:text-[#F2F1E6]/50 cursor-grab active:cursor-grabbing flex-shrink-0"
        title="Drag to reorder"
      >
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 4a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 8a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 12a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 16a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
      </span>
      <input
        type="checkbox"
        checked={visible}
        onChange={onToggle}
        className="accent-navy w-3.5 h-3.5 rounded flex-shrink-0"
      />
      <span className="text-xs font-mono text-[#F2F1E6]/80 truncate">{label}</span>
    </div>
  )
}

interface TopBarProps {
  mobile: boolean
  onMobileMenuOpen: () => void
  tasksMode: PanelMode
  tasksWidth: number
  tasksTopOffset: number
  tasksSidebarWidth: number
  onTasksModeChange: (m: PanelMode) => void
  onTasksWidthChange: (w: number) => void
  onToggleTasks: () => void
  onOpenTasks: () => void
}

type TaskRange = 'today' | 'week' | 'month'
const TASK_RANGES: { key: TaskRange; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'This Week' },
  { key: 'month', label: 'This Month' },
]

export function TopBar({
  mobile, onMobileMenuOpen,
  tasksMode, tasksWidth, tasksTopOffset, tasksSidebarWidth,
  onTasksModeChange, onTasksWidthChange, onToggleTasks, onOpenTasks,
}: TopBarProps) {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  useDarkMode() // keep dark-mode class applied
  const { locations } = useLocations()
  const { isExcluded } = useLocationExclusions()
  const [endDayOpen, setEndDayOpen] = useState(false)
  const [eodGlow, setEodGlow] = useState(false)
  const [stats, setStats] = useState<TopBarStats>({
    pendingIssues: 0,
    todayChecklists: 0,
    nextCountDays: null,
    lastEndingValue: null,
    activeShops: 0,
    pendingOrders: 0,
    overdueTasks: 0,
    countProgressPct: null,
    recountNeeded: 0,
    formsDue: 0,
  })
  // ── Pill prefs ─────────────────────────────────────────────────────────────
  const [pillPrefs, setPillPrefs] = useState<PillPrefs>(loadLocalPillPrefs)
  const [pillConfigOpen, setPillConfigOpen] = useState(false)
  const pillConfigRef = useRef<HTMLDivElement>(null)
  const pillSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const allPillPrefsRef = useRef<Record<string, unknown>>({})
  // Tasks panel visibility/mode/width are owned by AppShell (props) so the
  // bottom FAB can toggle it alongside Meeting / Lookup / Inventory.
  const checklistOpen = tasksMode !== 'hidden'
  const [filterUserId, setFilterUserId] = useState('')
  const [taskRange, setTaskRange] = useState<TaskRange>(() => (localStorage.getItem('tasks.range') as TaskRange) || 'today')
  const taskRangeRef = useRef<TaskRange>(taskRange)
  type ChecklistItem = { id: string; title: string; completed: boolean; kind: 'event' | 'task' | 'standalone'; notes: string; assignedTo: string[] | null; date: string | null; startTime?: string | null; reminderMinutes?: number | null }
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([])
  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const checklistItemsRef = useRef<ChecklistItem[]>([])
  // Quick add-task form inside the panel
  const [addingTask, setAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDate, setNewTaskDate] = useState('')

  const companyId = profile?.company_id

  useEffect(() => {
    if (!companyId) return
    ;(supabase as any).schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name')
      .then(({ data }: any) => setOrgProfiles((data ?? []) as Profile[]))
  }, [companyId])

  // Keep ref in sync so reminder interval has closure access without re-creating on each state change
  useEffect(() => { checklistItemsRef.current = checklistItems }, [checklistItems])

  // EOD reminder: poll every 60 s, auto-open once per day and keep button glowing until reviewed.
  useEffect(() => {
    if (!profile?.eod_review_enabled || !profile?.eod_review_time) return
    const eodHHMM = profile.eod_review_time.slice(0, 5)
    const tz = profile.popup_timezone ?? 'America/Chicago'

    function todayKey() {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    }
    function currentHHMM() {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
      const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
      const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
      return `${h}:${m}`
    }

    function check() {
      const isPast = currentHHMM() >= eodHHMM
      const dk = todayKey()
      const reviewed = !!localStorage.getItem(`eod_reviewed_${dk}`)
      setEodGlow(isPast && !reviewed)
      if (isPast && !reviewed && !localStorage.getItem(`eod_prompted_${dk}`)) {
        localStorage.setItem(`eod_prompted_${dk}`, '1')
        setEndDayOpen(true)
      }
    }

    check()
    const id = setInterval(check, 60_000)
    return () => clearInterval(id)
  }, [profile?.eod_review_enabled, profile?.eod_review_time, profile?.popup_timezone])

  // Checklist event reminders: open Today's Tasks N minutes before a timed checklist event starts.
  // Uses checklistItemsRef so the interval closure always sees fresh data without re-creating.
  useEffect(() => {
    if (profile?.task_popups_enabled === false) return
    const tz = profile?.popup_timezone ?? 'America/Chicago'

    function todayKey() {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    }
    function currentHHMM() {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(new Date())
      const h = parts.find((p) => p.type === 'hour')?.value ?? '00'
      const m = parts.find((p) => p.type === 'minute')?.value ?? '00'
      return `${h}:${m}`
    }

    function checkReminders() {
      const hhmm = currentHHMM()
      const dk = todayKey()
      const [nowH, nowM] = hhmm.split(':').map(Number)
      const nowTotal = nowH * 60 + nowM
      for (const item of checklistItemsRef.current) {
        if (item.kind !== 'event' || !item.startTime || item.reminderMinutes == null || item.completed) continue
        const mins = item.reminderMinutes
        if (mins <= 0) continue
        const [sh, sm] = item.startTime.split(':').map(Number)
        const startTotal = sh * 60 + sm
        const reminderTotal = Math.max(0, startTotal - mins)
        if (nowTotal >= reminderTotal && nowTotal < startTotal) {
          const key = `reminder_${item.id}_${dk}`
          if (!localStorage.getItem(key)) {
            localStorage.setItem(key, '1')
            onOpenTasks()
          }
        }
      }
    }

    checkReminders()
    const remId = setInterval(checkReminders, 60_000)
    return () => clearInterval(remId)
  }, [profile?.popup_timezone, profile?.task_popups_enabled])

  useEffect(() => {
    if (!companyId) return
    loadStats()
    loadTodayChecklists()

    const channel = supabase
      .channel('topbar')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'issues', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'schedule_events', filter: `company_id=eq.${companyId}` }, () => { loadStats(); loadTodayChecklists() })
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'monthly_ending_balances', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'core', table: 'locations', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'project_tasks', filter: `company_id=eq.${companyId}` }, () => { loadStats(); loadTodayChecklists() })
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [companyId])

  // Load pill prefs from DB on mount
  useEffect(() => {
    if (!profile?.id) return
    ;(supabase as any).schema('platform').from('user_profiles')
      .select('column_prefs')
      .eq('id', profile.id)
      .maybeSingle()
      .then(({ data }: any) => {
        if (data?.column_prefs) {
          allPillPrefsRef.current = data.column_prefs
          const dbPrefs = data.column_prefs[DB_PILL_KEY]
          if (dbPrefs?.order) {
            const prefs: PillPrefs = {
              order: dbPrefs.order ?? DEFAULT_PILL_ORDER,
              hidden: dbPrefs.hidden ?? DEFAULT_HIDDEN,
            }
            setPillPrefs(prefs)
            localStorage.setItem(PILL_PREFS_KEY, JSON.stringify(prefs))
          }
        }
      })
      .catch(() => {})
  }, [profile?.id])

  // Click-outside to close pill config popover
  useEffect(() => {
    if (!pillConfigOpen) return
    function onDown(e: MouseEvent) {
      if (pillConfigRef.current && !pillConfigRef.current.contains(e.target as Node)) {
        setPillConfigOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [pillConfigOpen])

  function savePillPrefs(prefs: PillPrefs) {
    setPillPrefs(prefs)
    localStorage.setItem(PILL_PREFS_KEY, JSON.stringify(prefs))
    clearTimeout(pillSaveTimerRef.current)
    pillSaveTimerRef.current = setTimeout(async () => {
      if (!profile?.id) return
      const merged = { ...allPillPrefsRef.current, [DB_PILL_KEY]: prefs }
      allPillPrefsRef.current = merged
      await (supabase as any).schema('platform').from('user_profiles')
        .update({ column_prefs: merged })
        .eq('id', profile.id)
    }, 800)
  }

  const pillDndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  function handlePillDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = pillPrefs.order.indexOf(active.id as PillKey)
    const newIdx = pillPrefs.order.indexOf(over.id as PillKey)
    savePillPrefs({ ...pillPrefs, order: arrayMove(pillPrefs.order, oldIdx, newIdx) })
  }

  function togglePillHidden(key: PillKey) {
    const hidden = pillPrefs.hidden.includes(key)
      ? pillPrefs.hidden.filter((k) => k !== key)
      : [...pillPrefs.hidden, key]
    savePillPrefs({ ...pillPrefs, hidden })
  }

  function resetPillPrefs() {
    savePillPrefs({ order: DEFAULT_PILL_ORDER, hidden: DEFAULT_HIDDEN })
  }

  async function loadStats() {
    if (!companyId) { console.warn('[TopBar] loadStats: companyId is null, skipping'); return }
    const today = format(new Date(), 'yyyy-MM-dd')
    const sb = supabase as any
    const safe = (p: any) => Promise.resolve(p).catch((e: unknown) => { console.error('[TopBar] query threw:', e); return { data: null, error: null } })
    const [issuesRes, scheduleRes, balancesRes, locationsRes, ordersRes, tasksRes, formsDueRes, recountRes] = await Promise.all([
      safe(sb.schema('platform').from('issues').select('id').eq('company_id', companyId).is('deleted_at', null)),
      safe(sb.schema('platform').from('schedule_events').select('id, title, start_date, event_type').eq('company_id', companyId).gte('start_date', today).order('start_date')),
      safe(sb.schema('inventory').from('monthly_ending_balances').select('ending_balance, month').eq('company_id', companyId).order('month', { ascending: false })),
      safe(sb.schema('core').from('locations').select('id, active').eq('company_id', companyId)),
      safe(sb.schema('inventory').from('order_sessions').select('id').eq('company_id', companyId).eq('status', 'pending')),
      safe(sb.schema('inventory').from('project_tasks').select('id, due_date').eq('company_id', companyId).eq('done', false).lt('due_date', today)),
      safe(sb.schema('forms').from('assignments').select('id, forms!inner(company_id)').eq('forms.company_id', companyId).lte('due_date', today).eq('is_completed', false)),
      safe(sb.schema('inventory').from('recount_requests').select('id').eq('company_id', companyId).eq('recount_status', 'open')),
    ])
    console.log('[TopBar] issues:', issuesRes.data?.length ?? null, issuesRes.error?.message ?? null, '| locs:', locationsRes.data?.length ?? null, locationsRes.error?.message ?? null, '| bal:', balancesRes.data?.length ?? null, balancesRes.error?.message ?? null)

    const pendingIssues = issuesRes.data?.length ?? 0

    const nextCount = scheduleRes.data?.find((e: any) => e.event_type === 'monthly_count' && e.start_date > today)
    const nextCountDays = nextCount
      ? differenceInDays(new Date(nextCount.start_date), new Date())
      : null

    const latestMonth = balancesRes.data?.[0]?.month
    const lastEndingValue = latestMonth
      ? (balancesRes.data ?? [])
          .filter((b: any) => b.month === latestMonth)
          .reduce((sum: number, b: any) => sum + (b.ending_balance ?? 0), 0)
      : null

    setStats((s) => ({
      ...s,
      pendingIssues,
      nextCountDays,
      lastEndingValue,
      activeShops: (locationsRes.data ?? []).filter((l: any) => l.active).length,
      pendingOrders: ordersRes.data?.length ?? 0,
      overdueTasks: tasksRes.data?.length ?? 0,
      formsDue: formsDueRes.data?.length ?? 0,
      recountNeeded: recountRes.data?.length ?? 0,
    }))
  }

  async function loadTodayChecklists() {
    if (!companyId) return
    const today = format(new Date(), 'yyyy-MM-dd')
    const range = taskRangeRef.current
    // Upper bound on due/target date. Overdue items always show (they fall
    // at/below any of these); a wider range pulls in more upcoming work.
    const rangeEnd =
      range === 'week' ? format(endOfWeek(new Date()), 'yyyy-MM-dd')
      : range === 'month' ? format(endOfMonth(new Date()), 'yyyy-MM-dd')
      : today
    const sb = supabase as any
    const [ev, tk, st] = await Promise.all([
      sb.schema('platform').from('schedule_events').select('id, title, completed, notes, assigned_to, start_date, start_time, reminder_minutes').eq('company_id', companyId).eq('is_checklist', true).gte('start_date', today).lte('start_date', rangeEnd),
      sb.schema('inventory').from('project_tasks').select('id, task_name, done, notes, due_date').eq('company_id', companyId).eq('done', false).lte('due_date', rangeEnd),
      sb.schema('core').from('tasks').select('id, title, notes, target_date, completed, assignee_id, assignee_name').eq('company_id', companyId).eq('completed', false).lte('target_date', rangeEnd).is('deleted_at', null),
    ])
    const items: ChecklistItem[] = [
      ...((ev.data ?? []) as any[]).map((e) => ({ id: e.id, title: e.title || '(untitled)', completed: !!e.completed, kind: 'event' as const, notes: e.notes ?? '', assignedTo: e.assigned_to ?? null, date: e.start_date ?? null, startTime: e.start_time ?? null, reminderMinutes: e.reminder_minutes ?? null })),
      ...((tk.data ?? []) as any[]).map((t) => ({ id: t.id, title: t.task_name || '(untitled task)', completed: false, kind: 'task' as const, notes: t.notes ?? '', assignedTo: null, date: t.due_date ?? null })),
      ...((st.data ?? []) as any[]).map((t) => ({ id: t.id, title: t.title || '(untitled task)', completed: false, kind: 'standalone' as const, notes: t.notes ?? '', assignedTo: t.assignee_id ? [t.assignee_id] : null, date: t.target_date ?? null })),
    ]
    // Sort by date (undated last), then keep a stable order.
    items.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'))
    setChecklistItems(items)
    // Pill stays a today/overdue count regardless of the panel's range.
    setStats((s) => ({ ...s, todayChecklists: items.filter((i) => !i.completed && i.date != null && i.date <= today).length }))
  }

  // Reload the panel when the date range changes.
  useEffect(() => {
    taskRangeRef.current = taskRange
    localStorage.setItem('tasks.range', taskRange)
    if (companyId) loadTodayChecklists()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskRange])

  async function createTaskFromPanel() {
    const title = newTaskTitle.trim()
    if (!companyId || !title) return
    const { error } = await (supabase as any).schema('core').from('tasks').insert({
      company_id: companyId,
      title,
      target_date: newTaskDate || format(new Date(), 'yyyy-MM-dd'),
      source: 'manual',
      created_by: profile?.id ?? null,
      is_public: false,
    })
    if (error) { console.error('[TopBar] create task failed:', error.message); return }
    setNewTaskTitle(''); setNewTaskDate(''); setAddingTask(false)
    loadTodayChecklists()
  }

  async function toggleChecklist(item: ChecklistItem) {
    const sb = supabase as any
    if (item.kind === 'event') {
      await sb.schema('platform').from('schedule_events').update({
        completed: !item.completed,
        completed_at: !item.completed ? new Date().toISOString() : null,
        completed_by: profile?.id ?? null,
      }).eq('id', item.id)
    } else if (item.kind === 'standalone') {
      await sb.schema('core').from('tasks').update({
        completed: !item.completed,
        completed_at: !item.completed ? new Date().toISOString() : null,
        completed_by: !item.completed ? (profile?.id ?? null) : null,
      }).eq('id', item.id)
    } else {
      await sb.schema('inventory').from('project_tasks').update({ done: !item.completed }).eq('id', item.id)
    }
    loadTodayChecklists()
  }

  async function saveNotes(item: ChecklistItem) {
    const sb = supabase as any
    const query = item.kind === 'event'
      ? sb.schema('platform').from('schedule_events')
      : item.kind === 'standalone'
        ? sb.schema('core').from('tasks')
        : sb.schema('inventory').from('project_tasks')
    await query.update({ notes: noteDraft }).eq('id', item.id)
    setChecklistItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, notes: noteDraft } : i)))
  }

  function formatCurrency(v: number) {
    if (mobile) {
      if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
      if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`
    }
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
  }

  // Shops count reflects the user's location exclusions once locations load;
  // falls back to the raw active-count query before then.
  const visibleShops = locations.length
    ? locations.filter((l) => l.active && !isExcluded(l)).length
    : stats.activeShops

  const ALL_PILLS: Record<PillKey, { label: string; value: string | number; highlight?: boolean; accent?: string; onClick: () => void }> = {
    open_issues: {
      label: 'Issues',
      value: stats.pendingIssues,
      highlight: stats.pendingIssues > 0,
      onClick: () => navigate('/issues?tab=pending'),
    },
    tasks_due_today: {
      label: "Today's Tasks",
      value: stats.todayChecklists,
      highlight: stats.todayChecklists > 0,
      onClick: onToggleTasks,
    },
    next_count_date: {
      label: 'Next Count',
      value: stats.nextCountDays !== null ? `${stats.nextCountDays}d` : '—',
      onClick: () => navigate('/schedule'),
    },
    ending_balance: {
      label: 'Ending',
      value: stats.lastEndingValue !== null ? formatCurrency(stats.lastEndingValue) : '—',
      onClick: () => navigate('/config'),
    },
    shop_count: {
      label: 'Shops',
      value: visibleShops,
      onClick: () => navigate('/locations'),
    },
    pending_orders: {
      label: 'Pending Orders',
      value: stats.pendingOrders,
      highlight: stats.pendingOrders > 0,
      onClick: () => navigate('/orders'),
    },
    overdue_tasks: {
      label: 'Overdue',
      value: stats.overdueTasks,
      accent: stats.overdueTasks > 0 ? 'text-red-400' : undefined,
      onClick: () => navigate('/tasks'),
    },
    monthly_count_pct: {
      label: 'Count Progress',
      value: stats.countProgressPct !== null ? `${stats.countProgressPct}%` : '—',
      onClick: () => navigate('/monthend'),
    },
    recount_needed: {
      label: 'Recounts',
      value: stats.recountNeeded,
      accent: stats.recountNeeded > 0 ? 'text-amber-400' : undefined,
      onClick: () => navigate('/monthend'),
    },
    forms_due: {
      label: 'Forms Due',
      value: stats.formsDue,
      highlight: stats.formsDue > 0,
      onClick: () => navigate('/forms'),
    },
  }

  // Apply user order and visibility prefs
  const visiblePills = pillPrefs.order
    .filter((key) => !pillPrefs.hidden.includes(key) && ALL_PILL_KEYS.includes(key))
    .map((key) => ({ key, ...ALL_PILLS[key] }))

  return (
    <header className="relative min-h-[3rem] bg-[#002745] border-b border-[#002745]/40 flex items-center px-3 gap-2 flex-shrink-0 flex-wrap py-1.5">
      {/* Mobile hamburger */}
      {mobile ? (
        <button
          onClick={onMobileMenuOpen}
          className="flex-shrink-0 w-8 h-8 flex items-center justify-center text-[#F2F1E6]/70 hover:text-[#F2F1E6] transition-colors"
          aria-label="Open navigation"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      ) : (
        <>
          <span className="font-heading font-bold text-[#F2F1E6] text-sm tracking-widest uppercase whitespace-nowrap">
            Strickland Brothers
          </span>
          <div className="w-px h-5 bg-inky/40 flex-shrink-0" />
        </>
      )}

      {/* Stat pills — scrollable on mobile, wrapping on desktop */}
      <div className={[
        'flex items-center gap-2 flex-1 min-w-0',
        mobile ? 'overflow-x-auto flex-nowrap' : 'flex-wrap',
      ].join(' ')}>
        {visiblePills.map((pill) => (
          <button
            key={pill.key}
            onClick={pill.onClick}
            title={pill.label}
            className="flex items-center gap-1 px-2 py-1 bg-[#F2F1E6]/10 border border-[#F2F1E6]/20 rounded text-xs font-body hover:bg-[#F2F1E6]/20 hover:border-[#F2F1E6]/40 transition-all flex-shrink-0 whitespace-nowrap min-w-[100px]"
          >
            <span className="text-[#F2F1E6]/60 text-[10px]">{pill.label}:</span>
            <span className={['font-medium', pill.accent ?? (pill.highlight ? 'text-sky' : 'text-[#F2F1E6]')].join(' ')}>
              {pill.value}
            </span>
          </button>
        ))}

        {/* Pill config gear */}
        <div className="relative flex-shrink-0" ref={pillConfigRef}>
          <button
            onClick={() => setPillConfigOpen((v) => !v)}
            title="Customize pills"
            className="flex items-center justify-center w-6 h-6 rounded text-[#F2F1E6]/30 hover:text-[#F2F1E6]/70 hover:bg-[#F2F1E6]/10 transition-all"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          {pillConfigOpen && (
            <div className="absolute left-0 top-full mt-1 z-40 w-52 bg-[#002745] border border-[#F2F1E6]/20 rounded shadow-xl p-2 flex flex-col gap-1">
              <div className="px-1 pb-1 border-b border-[#F2F1E6]/10 mb-0.5">
                <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Customize Pills</span>
              </div>
              <DndContext sensors={pillDndSensors} collisionDetection={closestCenter} onDragEnd={handlePillDragEnd}>
                <SortableContext items={pillPrefs.order} strategy={verticalListSortingStrategy}>
                  {pillPrefs.order.filter((k) => ALL_PILL_KEYS.includes(k)).map((key) => (
                    <SortablePillRow
                      key={key}
                      id={key}
                      label={PILL_LABELS[key]}
                      visible={!pillPrefs.hidden.includes(key)}
                      onToggle={() => togglePillHidden(key)}
                    />
                  ))}
                </SortableContext>
              </DndContext>
              <div className="border-t border-[#F2F1E6]/10 mt-1 pt-1">
                <button
                  onClick={resetPillPrefs}
                  className="w-full text-left px-2 py-1 text-[10px] font-mono text-[#F2F1E6]/40 hover:text-[#F2F1E6]/80 transition-colors rounded hover:bg-[#F2F1E6]/5"
                >
                  Reset to Default
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* End Day */}
      <button
        onClick={() => setEndDayOpen(true)}
        title="End of day check-in"
        className={[
          'flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded border text-[10px] font-heading uppercase tracking-wide transition-all',
          eodGlow
            ? 'border-orange-500/70 text-orange-400 shadow-[0_0_10px_2px_rgba(249,115,22,0.45)] animate-pulse'
            : 'border-[#F2F1E6]/20 text-[#F2F1E6]/70 hover:text-[#F2F1E6] hover:border-[#F2F1E6]/40',
        ].join(' ')}
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
        {!mobile && 'End Day'}
      </button>

      {/* Tasks — draggable / pinnable floating panel */}
      {checklistOpen && (
        <FloatingPanel
          title="Tasks"
          prefix="todaysTasks"
          mode={tasksMode}
          width={tasksWidth}
          mobile={mobile}
          topOffset={tasksTopOffset}
          sidebarWidth={tasksSidebarWidth}
          onModeChange={onTasksModeChange}
          onWidthChange={onTasksWidthChange}
          onClose={() => onTasksModeChange('hidden')}
          headerActions={
            <select
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
              onMouseDown={(e) => e.stopPropagation()}
              className="text-[10px] font-mono border border-[#F2F1E6]/30 rounded px-1.5 py-0.5 bg-[#1a5c87] text-[#F2F1E6] focus:outline-none focus:border-sky max-w-[110px] truncate"
            >
              <option value="">All</option>
              {orgProfiles.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>
              ))}
            </select>
          }
        >
          {/* Range selector + add task */}
          <div className="flex items-center gap-2 mb-2">
            <div className="flex rounded border border-navy/30 overflow-hidden">
              {TASK_RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setTaskRange(r.key)}
                  className={[
                    'px-2 py-1 text-[10px] font-mono transition-colors',
                    taskRange === r.key ? 'bg-navy/10 text-navy font-bold' : 'text-inky hover:text-navy',
                  ].join(' ')}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setAddingTask((v) => !v); setNewTaskTitle(''); setNewTaskDate('') }}
              className="ml-auto text-[10px] font-mono text-navy hover:text-sky uppercase tracking-wide"
              title="Add a task"
            >
              {addingTask ? '✕ Cancel' : '＋ Add task'}
            </button>
          </div>

          {addingTask && (
            <div className="flex flex-col gap-1.5 mb-2 p-2 rounded border border-navy/20 bg-navy/[0.03]">
              <input
                autoFocus
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') createTaskFromPanel(); if (e.key === 'Escape') setAddingTask(false) }}
                placeholder="What needs to be done?"
                className="w-full rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
              />
              <div className="flex items-center gap-2">
                <input
                  type="date"
                  value={newTaskDate}
                  onChange={(e) => setNewTaskDate(e.target.value)}
                  className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none"
                />
                <button
                  onClick={createTaskFromPanel}
                  disabled={!newTaskTitle.trim()}
                  className="ml-auto rounded bg-navy px-3 py-1 text-[10px] font-heading uppercase tracking-wide text-cream hover:bg-inky disabled:opacity-40"
                >
                  Add
                </button>
              </div>
              <span className="text-[10px] font-mono text-inky/40">Defaults to today if no date is set.</span>
            </div>
          )}

          {(() => {
            const today = format(new Date(), 'yyyy-MM-dd')
            const visible = filterUserId
              ? checklistItems.filter((i) => i.kind === 'task' || i.kind === 'standalone' || i.assignedTo?.includes(filterUserId))
              : checklistItems
            const rangeWord = taskRange === 'today' ? 'today' : taskRange === 'week' ? 'this week' : 'this month'
            return visible.length === 0 ? (
              <div className="py-3 text-xs text-inky font-body italic">
                {filterUserId ? `No items assigned to that person ${rangeWord}` : `No tasks ${rangeWord}`}
              </div>
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-navy/10 -mx-3">
                {visible.map((item) => {
                  const assigneeNames = (item.assignedTo ?? [])
                    .map((id) => orgProfiles.find((p) => p.id === id))
                    .filter(Boolean)
                    .map((p) => p!.full_name ?? p!.email ?? '')
                  const overdue = item.date != null && item.date < today && !item.completed
                  const dateLabel = item.date == null ? null
                    : item.date === today ? 'Today'
                    : format(parseISO(item.date), 'MMM d')
                  return (
                    <div key={`${item.kind}-${item.id}`} className="px-3 py-2.5">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={item.completed}
                          onChange={() => toggleChecklist(item)}
                          className="accent-inky"
                        />
                        <button
                          onClick={() => { setOpenNote((o) => (o === item.id ? null : item.id)); setNoteDraft(item.notes) }}
                          className={['flex-1 text-left text-xs font-body hover:text-navy', item.completed ? 'text-inky/40 line-through' : 'text-navy'].join(' ')}
                          title="Open to add notes"
                        >
                          {item.title}
                          {item.kind === 'task' && <span className="ml-1.5 text-[10px] text-inky">· project</span>}
                          {item.kind === 'standalone' && <span className="ml-1.5 text-[10px] text-inky">· task</span>}
                          {item.notes && <span className="ml-1 text-inky/60">✎</span>}
                        </button>
                        {dateLabel && (
                          <span className={['text-[10px] font-mono flex-shrink-0', overdue ? 'text-[#C0392B] font-bold' : 'text-inky/50'].join(' ')}>
                            {overdue ? '⚠ ' : ''}{dateLabel}
                          </span>
                        )}
                      </div>
                      {assigneeNames.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1 ml-6">
                          {assigneeNames.map((name) => (
                            <span key={name} className="text-[10px] font-mono text-inky/60 bg-navy/5 border border-navy/20 rounded px-1.5 py-0.5">
                              {name}
                            </span>
                          ))}
                        </div>
                      )}
                      {openNote === item.id && (
                        <textarea
                          autoFocus
                          value={noteDraft}
                          onChange={(e) => setNoteDraft(e.target.value)}
                          onBlur={() => saveNotes(item)}
                          rows={2}
                          placeholder="Add a note…"
                          className="mt-2 w-full resize-y rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-body text-navy placeholder-inky/50 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })()}
        </FloatingPanel>
      )}

      <EndDayModal
        open={endDayOpen}
        onClose={() => setEndDayOpen(false)}
        onSaved={() => {
          const tz = profile?.popup_timezone ?? 'America/Chicago'
          const dk = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
          localStorage.setItem(`eod_reviewed_${dk}`, '1')
          setEodGlow(false)
        }}
      />
    </header>
  )
}
