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
import { EndDayModal } from '@/modules/projects/EndDayModal'
import { format } from 'date-fns'
import { differenceInDays } from 'date-fns'
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
}

export function TopBar({ mobile, onMobileMenuOpen }: TopBarProps) {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  useDarkMode() // keep dark-mode class applied
  const [endDayOpen, setEndDayOpen] = useState(false)
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
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [filterUserId, setFilterUserId] = useState('')
  type ChecklistItem = { id: string; title: string; completed: boolean; kind: 'event' | 'task'; notes: string; assignedTo: string[] | null }
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([])
  const [orgProfiles, setOrgProfiles] = useState<Profile[]>([])
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const companyId = profile?.company_id

  useEffect(() => {
    if (!companyId) return
    ;(supabase as any).schema('platform').from('user_profiles').select('id, full_name, email').eq('company_id', companyId).order('full_name')
      .then(({ data }: any) => setOrgProfiles((data ?? []) as Profile[]))
  }, [companyId])

  useEffect(() => {
    if (!companyId) return
    loadStats()
    loadTodayChecklists()

    const channel = supabase
      .channel('topbar')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'issues', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'schedule_events', filter: `company_id=eq.${companyId}` }, () => { loadStats(); loadTodayChecklists() })
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'ending_balances', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'core', table: 'locations', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'project_tasks', filter: `company_id=eq.${companyId}` }, () => loadTodayChecklists())
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
    if (!companyId) return
    const today = format(new Date(), 'yyyy-MM-dd')

    const sb = supabase as any
    const [issuesRes, scheduleRes, balancesRes, locationsRes, ordersRes, tasksRes, formsDueRes, recountRes] = await Promise.all([
      sb.schema('inventory').from('issues').select('id, status_id, issue_statuses!inner(name)').eq('company_id', companyId),
      sb.schema('platform').from('schedule_events').select('*').eq('company_id', companyId).gte('start_date', today).order('start_date'),
      sb.schema('inventory').from('ending_balances').select('ending_balance, month').eq('company_id', companyId).order('month', { ascending: false }),
      sb.schema('core').from('locations').select('id').eq('company_id', companyId).eq('active', true),
      sb.schema('inventory').from('order_sessions').select('id').eq('company_id', companyId).eq('status', 'pending').catch(() => ({ data: [] })),
      sb.schema('inventory').from('project_tasks').select('id, due_date').eq('company_id', companyId).eq('done', false).lt('due_date', today).catch(() => ({ data: [] })),
      sb.schema('forms').from('assignments').select('id').eq('company_id', companyId).lte('due_date', today).eq('completed', false).catch(() => ({ data: [] })),
      sb.schema('inventory').from('recount_requests').select('id').eq('company_id', companyId).eq('status', 'pending').catch(() => ({ data: [] })),
    ])

    const pendingIssues = issuesRes.data?.filter((i: any) =>
      i.issue_statuses?.name?.toLowerCase().includes('pending') ||
      i.issue_statuses?.name?.toLowerCase().includes('open')
    ).length ?? 0

    const nextCount = scheduleRes.data?.find((e: any) => e.event_type === 'monthly_count')
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
      activeShops: locationsRes.data?.length ?? 0,
      pendingOrders: ordersRes.data?.length ?? 0,
      overdueTasks: tasksRes.data?.length ?? 0,
      formsDue: formsDueRes.data?.length ?? 0,
      recountNeeded: recountRes.data?.length ?? 0,
    }))
  }

  async function loadTodayChecklists() {
    if (!companyId) return
    const today = format(new Date(), 'yyyy-MM-dd')
    const sb = supabase as any
    const [ev, tk] = await Promise.all([
      sb.schema('platform').from('schedule_events').select('id, title, completed, notes, assigned_to').eq('company_id', companyId).eq('start_date', today).eq('is_checklist', true),
      sb.schema('inventory').from('project_tasks').select('id, task_name, done, notes, due_date').eq('company_id', companyId).eq('done', false).lte('due_date', today),
    ])
    const items: ChecklistItem[] = [
      ...((ev.data ?? []) as any[]).map((e) => ({ id: e.id, title: e.title || '(untitled)', completed: !!e.completed, kind: 'event' as const, notes: e.notes ?? '', assignedTo: e.assigned_to ?? null })),
      ...((tk.data ?? []) as any[]).map((t) => ({ id: t.id, title: t.task_name || '(untitled task)', completed: false, kind: 'task' as const, notes: t.notes ?? '', assignedTo: null })),
    ]
    setChecklistItems(items)
    setStats((s) => ({ ...s, todayChecklists: items.filter((i) => !i.completed).length }))
  }

  async function toggleChecklist(item: ChecklistItem) {
    const sb = supabase as any
    if (item.kind === 'event') {
      await sb.schema('platform').from('schedule_events').update({
        completed: !item.completed,
        completed_at: !item.completed ? new Date().toISOString() : null,
        completed_by: profile?.id ?? null,
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
      onClick: () => setChecklistOpen((v) => !v),
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
      value: stats.activeShops,
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
    <header className="relative h-12 bg-[#002745] border-b border-[#002745]/40 flex items-center px-3 gap-2 flex-shrink-0">
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
        'flex items-center gap-1.5 flex-1 min-w-0',
        mobile ? 'overflow-x-auto' : 'gap-2 flex-wrap',
      ].join(' ')}>
        {visiblePills.map((pill) => (
          <button
            key={pill.key}
            onClick={pill.onClick}
            title={pill.label}
            className="flex items-center gap-1 px-2 py-1 bg-[#F2F1E6]/10 border border-[#F2F1E6]/20 rounded text-xs font-body hover:bg-[#F2F1E6]/20 hover:border-[#F2F1E6]/40 transition-all flex-shrink-0 whitespace-nowrap"
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
        className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded border border-[#F2F1E6]/20 text-[#F2F1E6]/70 hover:text-[#F2F1E6] hover:border-[#F2F1E6]/40 text-[10px] font-heading uppercase tracking-wide transition-all"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
        {!mobile && 'End Day'}
      </button>

      {/* Checklist popover */}
      {checklistOpen && (
        <div className="absolute top-full right-3 mt-2 w-80 max-w-[calc(100vw-1.5rem)] bg-cream border border-navy/40 rounded-lg shadow-xl z-30">
          <div className="px-4 py-3 border-b border-navy/20 flex items-center justify-between gap-2">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">
              Today's Tasks
            </span>
            <div className="flex items-center gap-2 ml-auto">
              <select
                value={filterUserId}
                onChange={(e) => setFilterUserId(e.target.value)}
                className="text-[10px] font-mono border border-navy/20 rounded px-1.5 py-0.5 bg-cream text-inky focus:outline-none focus:border-[#00e5ff]/60 max-w-[110px] truncate"
              >
                <option value="">All</option>
                {orgProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.full_name ?? p.email}</option>
                ))}
              </select>
              <button onClick={() => setChecklistOpen(false)} className="text-inky hover:text-navy transition-colors">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          {(() => {
            const visible = filterUserId
              ? checklistItems.filter((i) => i.assignedTo?.includes(filterUserId))
              : checklistItems
            return visible.length === 0 ? (
              <div className="px-4 py-3 text-xs text-inky font-body italic">
                {filterUserId ? 'No items assigned to that person today' : 'No checklist items today'}
              </div>
            ) : (
              <div className="divide-y divide-navy/10 max-h-80 overflow-auto">
                {visible.map((item) => {
                  const assigneeNames = (item.assignedTo ?? [])
                    .map((id) => orgProfiles.find((p) => p.id === id))
                    .filter(Boolean)
                    .map((p) => p!.full_name ?? p!.email ?? '')
                  return (
                    <div key={`${item.kind}-${item.id}`} className="px-4 py-2.5">
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
                          {item.notes && <span className="ml-1 text-inky/60">✎</span>}
                        </button>
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
        </div>
      )}

      <EndDayModal open={endDayOpen} onClose={() => setEndDayOpen(false)} />
    </header>
  )
}
