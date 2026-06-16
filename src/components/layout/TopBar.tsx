import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useDarkMode } from '@/hooks/useDarkMode'
import { EndDayModal } from '@/modules/projects/EndDayModal'
import { format } from 'date-fns'
import { differenceInDays } from 'date-fns'

interface TopBarStats {
  pendingIssues: number
  todayChecklists: number
  nextCountDays: number | null
  lastEndingValue: number | null
  activeShops: number
}

export function TopBar() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const { dark, toggle: toggleDark } = useDarkMode()
  const [endDayOpen, setEndDayOpen] = useState(false)
  const [stats, setStats] = useState<TopBarStats>({
    pendingIssues: 0,
    todayChecklists: 0,
    nextCountDays: null,
    lastEndingValue: null,
    activeShops: 0,
  })
  const [checklistOpen, setChecklistOpen] = useState(false)
  type ChecklistItem = { id: string; title: string; completed: boolean; kind: 'event' | 'task'; notes: string }
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([])
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')

  const companyId = profile?.company_id

  useEffect(() => {
    if (!companyId) return
    loadStats()
    loadTodayChecklists()

    const channel = supabase
      .channel('topbar')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'schedule_events', filter: `company_id=eq.${companyId}` }, () => { loadStats(); loadTodayChecklists() })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'monthly_ending_balances', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'locations', filter: `company_id=eq.${companyId}` }, loadStats)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'project_tasks', filter: `company_id=eq.${companyId}` }, () => loadTodayChecklists())
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [companyId])

  async function loadStats() {
    if (!companyId) return
    const today = format(new Date(), 'yyyy-MM-dd')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = supabase as any
    const [issuesRes, scheduleRes, balancesRes, locationsRes] = await Promise.all([
      sb.from('issues').select('id, status_id, issue_statuses!inner(name)').eq('company_id', companyId),
      sb.from('schedule_events').select('*').eq('company_id', companyId).gte('start_date', today).order('start_date'),
      sb.from('monthly_ending_balances').select('ending_balance, month').eq('company_id', companyId).order('month', { ascending: false }),
      sb.from('locations').select('id').eq('company_id', companyId).eq('active', true),
    ])

    const pendingIssues = issuesRes.data?.filter((i: any) =>
      i.issue_statuses?.name?.toLowerCase().includes('pending') ||
      i.issue_statuses?.name?.toLowerCase().includes('open')
    ).length ?? 0

    const nextCount = scheduleRes.data?.find(
      (e: any) => e.event_type === 'monthly_count'
    )
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
    }))
  }

  async function loadTodayChecklists() {
    if (!companyId) return
    const today = format(new Date(), 'yyyy-MM-dd')
    const sb = supabase as any
    const [ev, tk] = await Promise.all([
      sb.from('schedule_events').select('id, title, completed, notes').eq('company_id', companyId).eq('start_date', today).eq('is_checklist', true),
      sb.from('project_tasks').select('id, task_name, done, notes, due_date').eq('company_id', companyId).eq('done', false).lte('due_date', today),
    ])
    const items: ChecklistItem[] = [
      ...((ev.data ?? []) as any[]).map((e) => ({ id: e.id, title: e.title || '(untitled)', completed: !!e.completed, kind: 'event' as const, notes: e.notes ?? '' })),
      ...((tk.data ?? []) as any[]).map((t) => ({ id: t.id, title: t.task_name || '(untitled task)', completed: false, kind: 'task' as const, notes: t.notes ?? '' })),
    ]
    setChecklistItems(items)
    setStats((s) => ({ ...s, todayChecklists: items.filter((i) => !i.completed).length }))
  }

  async function toggleChecklist(item: ChecklistItem) {
    const sb = supabase as any
    if (item.kind === 'event') {
      await sb.from('schedule_events').update({
        completed: !item.completed,
        completed_at: !item.completed ? new Date().toISOString() : null,
        completed_by: profile?.id ?? null,
      }).eq('id', item.id)
    } else {
      await sb.from('project_tasks').update({ done: !item.completed }).eq('id', item.id)
    }
    loadTodayChecklists()
  }

  async function saveNotes(item: ChecklistItem) {
    const sb = supabase as any
    const table = item.kind === 'event' ? 'schedule_events' : 'project_tasks'
    await sb.from(table).update({ notes: noteDraft }).eq('id', item.id)
    setChecklistItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, notes: noteDraft } : i)))
  }

  function formatCurrency(v: number) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v)
  }

  const pills = [
    {
      label: 'Pending Issues',
      value: stats.pendingIssues,
      highlight: stats.pendingIssues > 0,
      onClick: () => navigate('/issues?tab=pending'),
    },
    {
      label: "Today's Checklist",
      value: stats.todayChecklists,
      highlight: stats.todayChecklists > 0,
      onClick: () => setChecklistOpen((v) => !v),
    },
    {
      label: 'Next Count',
      value: stats.nextCountDays !== null ? `${stats.nextCountDays}d` : '—',
      highlight: false,
      onClick: () => navigate('/schedule'),
    },
    {
      label: 'Last Ending Value',
      value: stats.lastEndingValue !== null ? formatCurrency(stats.lastEndingValue) : '—',
      highlight: false,
      onClick: () => navigate('/config'),
    },
    {
      label: 'Active Shops',
      value: stats.activeShops,
      highlight: false,
      onClick: () => navigate('/config'),
    },
  ]

  return (
    <header className="relative h-12 bg-[#002745] border-b border-[#002745]/40 flex items-center px-4 gap-4 flex-shrink-0">
      {/* Wordmark */}
      <span className="font-heading font-bold text-[#F2F1E6] text-sm tracking-widest uppercase whitespace-nowrap">
        Strickland Brothers
      </span>

      <div className="w-px h-5 bg-inky/40 flex-shrink-0" />

      {/* Stat pills */}
      <div className="flex items-center gap-2 flex-wrap flex-1 min-w-0">
        {pills.map((pill) => (
          <button
            key={pill.label}
            onClick={pill.onClick}
            className="flex items-center gap-1.5 px-3 py-1 bg-cream/10 border border-cream/20 rounded text-xs font-body hover:bg-cream/20 hover:border-cream/40 transition-all"
          >
            <span className="text-cream/60">{pill.label}:</span>
            <span className={['font-medium', pill.highlight ? 'text-sky' : 'text-cream'].join(' ')}>
              {pill.value}
            </span>
          </button>
        ))}
      </div>

      {/* End Day */}
      <button
        onClick={() => setEndDayOpen(true)}
        title="End of day check-in"
        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 rounded border border-[#F2F1E6]/20 text-[#F2F1E6]/70 hover:text-[#F2F1E6] hover:border-[#F2F1E6]/40 text-[10px] font-heading uppercase tracking-wide transition-all"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
        End Day
      </button>

      {/* Dark mode toggle */}
      <button
        onClick={toggleDark}
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        className="flex-shrink-0 w-7 h-7 flex items-center justify-center rounded text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/10 transition-all"
      >
        {dark ? (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707M17.657 17.657l-.707-.707M6.343 6.343l-.707-.707M12 7a5 5 0 100 10 5 5 0 000-10z" />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
          </svg>
        )}
      </button>

      {/* Checklist popover */}
      {checklistOpen && (
        <div className="absolute top-full right-4 mt-2 w-72 bg-cream border border-navy/40 rounded-lg shadow-xl z-30">
          <div className="px-4 py-3 border-b border-navy/20 flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">
              Today's Checklist
            </span>
            <button onClick={() => setChecklistOpen(false)} className="text-inky hover:text-navy transition-colors">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {checklistItems.length === 0 ? (
            <div className="px-4 py-3 text-xs text-inky font-body italic">No checklist items today</div>
          ) : (
            <div className="divide-y divide-navy/10 max-h-80 overflow-auto">
              {checklistItems.map((item) => (
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
              ))}
            </div>
          )}
        </div>
      )}

      <EndDayModal open={endDayOpen} onClose={() => setEndDayOpen(false)} />
    </header>
  )
}
