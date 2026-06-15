import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
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
  const [openNote, setOpenNote] = useState<string | null>(null) // item id with notes expanded
  const [noteDraft, setNoteDraft] = useState('')

  const companyId = profile?.company_id

  useEffect(() => {
    if (!companyId) return
    loadStats()
    loadTodayChecklists()

    // Real-time subscriptions
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

    // Preserve todayChecklists (owned by loadTodayChecklists, which also counts
    // project tasks) rather than clobbering it with the schedule-only count.
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
    // Schedule checklist items for today + incomplete project tasks due today/overdue.
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
      color: stats.pendingIssues > 0 ? 'text-[#ff00ff]' : 'text-gray-500',
      onClick: () => navigate('/issues?tab=pending'),
    },
    {
      label: "Today's Checklist",
      value: stats.todayChecklists,
      color: stats.todayChecklists > 0 ? 'text-[#ffb300]' : 'text-gray-500',
      onClick: () => setChecklistOpen((v) => !v),
    },
    {
      label: 'Next Count',
      value: stats.nextCountDays !== null ? `${stats.nextCountDays}d` : '—',
      color: 'text-[#00e5ff]',
      onClick: () => navigate('/schedule'),
    },
    {
      label: 'Last Ending Value',
      value: stats.lastEndingValue !== null ? formatCurrency(stats.lastEndingValue) : '—',
      color: 'text-[#39ff14]',
      onClick: () => navigate('/config'),
    },
    {
      label: 'Active Shops',
      value: stats.activeShops,
      color: 'text-gray-300',
      onClick: () => navigate('/config'),
    },
  ]

  return (
    <header className="relative h-14 bg-[#161820] border-b border-[#2a2d3e] flex items-center px-4 gap-3 flex-shrink-0">
      <div className="flex items-center gap-2 flex-wrap flex-1">
        {pills.map((pill) => (
          <button
            key={pill.label}
            onClick={pill.onClick}
            className="flex items-center gap-1.5 px-3 py-1 bg-[#0f1117] border border-[#2a2d3e] rounded text-xs font-mono hover:border-gray-500 transition-all"
          >
            <span className="text-gray-500">{pill.label}:</span>
            <span className={['font-semibold', pill.color].join(' ')}>{pill.value}</span>
          </button>
        ))}
      </div>

      {/* Checklist popover */}
      {checklistOpen && (
        <div className="absolute top-full right-4 mt-2 w-72 bg-[#161820] border border-[#2a2d3e] rounded-lg shadow-xl z-30">
          <div className="px-4 py-3 border-b border-[#2a2d3e] flex items-center justify-between">
            <span className="text-xs font-mono font-semibold text-[#ffb300] uppercase tracking-wide">
              Today's Checklist
            </span>
            <button onClick={() => setChecklistOpen(false)} className="text-gray-500 hover:text-white">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          {checklistItems.length === 0 ? (
            <div className="px-4 py-3 text-xs text-gray-500 font-mono">No checklist items today</div>
          ) : (
            <div className="divide-y divide-[#2a2d3e] max-h-80 overflow-auto">
              {checklistItems.map((item) => (
                <div key={`${item.kind}-${item.id}`} className="px-4 py-2.5">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={item.completed}
                      onChange={() => toggleChecklist(item)}
                      className="accent-[#00e5ff]"
                    />
                    <button
                      onClick={() => { setOpenNote((o) => (o === item.id ? null : item.id)); setNoteDraft(item.notes) }}
                      className={['flex-1 text-left text-xs font-mono hover:text-white', item.completed ? 'text-gray-600 line-through' : 'text-gray-300'].join(' ')}
                      title="Open to add notes"
                    >
                      {item.title}
                      {item.kind === 'task' && <span className="ml-1.5 text-[10px] text-[#00e5ff]">· project</span>}
                      {item.notes && <span className="ml-1 text-gray-600">✎</span>}
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
                      className="mt-2 w-full resize-y rounded border border-[#2a2d3e] bg-[#0f1117] px-2 py-1 text-xs font-mono text-gray-200 placeholder-gray-600 focus:border-[#00e5ff] focus:outline-none"
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </header>
  )
}
