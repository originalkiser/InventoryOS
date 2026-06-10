import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Card, CardHeader, CardBody, Badge } from '@/components/ui'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { format, startOfWeek, endOfWeek } from 'date-fns'

interface DashStats {
  openIssuesByCategory: { name: string; count: number }[]
  upcomingEvents: Array<{ id: string; title: string; start_date: string; event_type: string }>
  recentOrders: Array<{ id: string; status: string; created_at: string }>
  activeShops: number
  submittedThisMonth: number
  totalShops: number
}

const EVENT_COLORS: Record<string, string> = {
  monthly_count: '#00e5ff',
  weekly_count: '#39ff14',
  order: '#ffb300',
  meeting: '#ff00ff',
  other: '#6b7280',
}

const ORDER_STATUS_COLOR: Record<string, 'cyan' | 'green' | 'amber' | 'gray'> = {
  draft: 'gray',
  pending: 'amber',
  exported: 'cyan',
  fulfilled: 'green',
}

export function DashboardPage() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const [stats, setStats] = useState<DashStats>({
    openIssuesByCategory: [],
    upcomingEvents: [],
    recentOrders: [],
    activeShops: 0,
    submittedThisMonth: 0,
    totalShops: 0,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile?.company_id) return
    loadStats()
  }, [profile?.company_id])

  async function loadStats() {
    const cid = profile!.company_id!
    const today = format(new Date(), 'yyyy-MM-dd')
    const weekEnd = format(endOfWeek(new Date()), 'yyyy-MM-dd')
    const monthStart = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd')

    const [issuesRes, eventsRes, ordersRes, locsRes, monthCountsRes] = await Promise.all([
      supabase.from('issues').select('id, issue_categories(name), issue_statuses(name)').eq('company_id', cid),
      supabase.from('schedule_events').select('id, title, start_date, event_type').eq('company_id', cid).gte('start_date', today).lte('start_date', weekEnd).order('start_date').limit(10),
      supabase.from('order_sessions').select('id, status, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(5),
      supabase.from('locations').select('id, active').eq('company_id', cid),
      supabase.from('monthly_counts').select('location_id').eq('company_id', cid).gte('count_date', monthStart),
    ])

    // Issues by category (open only)
    const openIssues = (issuesRes.data ?? []).filter((i: any) => {
      const s = i.issue_statuses?.name?.toLowerCase() ?? ''
      return !s.includes('resolved') && !s.includes('closed')
    })
    const byCat: Record<string, number> = {}
    openIssues.forEach((i: any) => {
      const cat = i.issue_categories?.name ?? 'Uncategorized'
      byCat[cat] = (byCat[cat] ?? 0) + 1
    })
    const openIssuesByCategory = Object.entries(byCat)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)

    const locs = locsRes.data ?? []
    const activeShops = locs.filter((l: any) => l.active).length
    const submittedLocIds = new Set((monthCountsRes.data ?? []).map((m: any) => m.location_id))
    const submittedThisMonth = submittedLocIds.size

    setStats({
      openIssuesByCategory,
      upcomingEvents: eventsRes.data ?? [],
      recentOrders: ordersRes.data ?? [],
      activeShops,
      submittedThisMonth,
      totalShops: locs.length,
    })
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <span className="text-gray-500 font-mono text-sm">Loading dashboard...</span>
      </div>
    )
  }

  const notSubmitted = stats.totalShops - stats.submittedThisMonth
  const completionPct = stats.totalShops > 0
    ? Math.round((stats.submittedThisMonth / stats.totalShops) * 100)
    : 0

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-white tracking-wide uppercase">Dashboard</h1>
        <p className="text-xs text-gray-500 mt-0.5">
          {format(new Date(), 'EEEE, MMMM d, yyyy')}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Card glow="cyan" onClick={() => navigate('/config')} className="p-4">
          <div className="text-xs text-gray-500 font-mono uppercase tracking-wide mb-1">Active Shops</div>
          <div className="text-2xl font-bold text-[#00e5ff]">{stats.activeShops}</div>
        </Card>
        <Card glow="green" className="p-4">
          <div className="text-xs text-gray-500 font-mono uppercase tracking-wide mb-1">Count Completion</div>
          <div className="text-2xl font-bold text-[#39ff14]">{completionPct}%</div>
          <div className="text-xs text-gray-600 font-mono mt-1">{stats.submittedThisMonth}/{stats.totalShops} submitted</div>
        </Card>
        <Card glow="magenta" onClick={() => navigate('/issues?tab=pending')} className="p-4">
          <div className="text-xs text-gray-500 font-mono uppercase tracking-wide mb-1">Open Issues</div>
          <div className="text-2xl font-bold text-[#ff00ff]">
            {stats.openIssuesByCategory.reduce((s, c) => s + c.count, 0)}
          </div>
        </Card>
        <Card glow="amber" className="p-4">
          <div className="text-xs text-gray-500 font-mono uppercase tracking-wide mb-1">Not Submitted</div>
          <div className="text-2xl font-bold text-[#ffb300]">{notSubmitted}</div>
          <div className="text-xs text-gray-600 font-mono mt-1">this month</div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Issues by Category */}
        <Card>
          <CardHeader>
            <span className="text-xs font-mono font-semibold text-gray-400 uppercase tracking-wide">
              Open Issues by Category
            </span>
          </CardHeader>
          <CardBody>
            {stats.openIssuesByCategory.length === 0 ? (
              <p className="text-xs text-gray-600 font-mono">No open issues</p>
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={stats.openIssuesByCategory} layout="vertical" margin={{ left: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={110} tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'monospace' }} />
                  <Tooltip
                    contentStyle={{ background: '#161820', border: '1px solid #2a2d3e', borderRadius: '4px', fontFamily: 'monospace', fontSize: '11px', color: '#e5e7eb' }}
                  />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {stats.openIssuesByCategory.map((_, i) => (
                      <Cell key={i} fill={['#ff00ff', '#00e5ff', '#ffb300', '#39ff14'][i % 4]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>

        {/* Upcoming events */}
        <Card>
          <CardHeader>
            <span className="text-xs font-mono font-semibold text-gray-400 uppercase tracking-wide">
              Events This Week
            </span>
          </CardHeader>
          <CardBody className="p-0">
            {stats.upcomingEvents.length === 0 ? (
              <p className="px-5 py-4 text-xs text-gray-600 font-mono">No events this week</p>
            ) : (
              <div className="divide-y divide-[#2a2d3e]">
                {stats.upcomingEvents.map((e) => (
                  <div key={e.id} className="flex items-center justify-between px-5 py-2.5"
                    onClick={() => navigate('/schedule')} style={{ cursor: 'pointer' }}>
                    <div>
                      <div className="text-xs font-mono text-gray-200">{e.title}</div>
                      <div className="text-xs text-gray-600">{format(new Date(e.start_date + 'T00:00:00'), 'EEE, MMM d')}</div>
                    </div>
                    <Badge color={e.event_type === 'monthly_count' ? 'cyan' : e.event_type === 'weekly_count' ? 'green' : e.event_type === 'order' ? 'amber' : 'gray'}>
                      {e.event_type.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Recent orders */}
        <Card>
          <CardHeader>
            <span className="text-xs font-mono font-semibold text-gray-400 uppercase tracking-wide">
              Recent Orders
            </span>
          </CardHeader>
          <CardBody className="p-0">
            {stats.recentOrders.length === 0 ? (
              <p className="px-5 py-4 text-xs text-gray-600 font-mono">No orders yet</p>
            ) : (
              <div className="divide-y divide-[#2a2d3e]">
                {stats.recentOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between px-5 py-2.5">
                    <span className="text-xs font-mono text-gray-400">
                      {format(new Date(o.created_at), 'MMM d, h:mm a')}
                    </span>
                    <Badge color={ORDER_STATUS_COLOR[o.status] ?? 'gray'}>
                      {o.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Not submitted this month */}
        <Card>
          <CardHeader>
            <span className="text-xs font-mono font-semibold text-gray-400 uppercase tracking-wide">
              Monthly Count Progress
            </span>
          </CardHeader>
          <CardBody>
            <div className="flex flex-col gap-3">
              <div className="flex justify-between text-xs font-mono text-gray-400">
                <span>Submitted</span>
                <span className="text-[#39ff14]">{stats.submittedThisMonth} / {stats.totalShops}</span>
              </div>
              <div className="w-full h-2 bg-[#2a2d3e] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#39ff14] rounded-full transition-all duration-500"
                  style={{ width: `${completionPct}%` }}
                />
              </div>
              <p className="text-xs text-gray-600 font-mono">
                {notSubmitted} shop{notSubmitted !== 1 ? 's' : ''} not yet submitted for{' '}
                {format(new Date(), 'MMMM yyyy')}
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
