import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Card, CardHeader, CardBody, Badge, SbLoader } from '@/components/ui'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { format, endOfWeek } from 'date-fns'
import { useInventory } from '@/hooks/useInventory'
import { InventoryView } from '@/components/inventory/InventoryView'
import { FLAG_HEX } from '@/lib/flagScale'

type TileView = 'graph' | 'list'

function useTileView(tileId: string, def: TileView = 'graph'): [TileView, (v: TileView) => void] {
  const key = `dashboard_tile_view_${tileId}`
  const [view, setView] = useState<TileView>(() => (localStorage.getItem(key) as TileView) || def)
  const set = (v: TileView) => { setView(v); localStorage.setItem(key, v) }
  return [view, set]
}

function TileToggle({ view, onChange }: { view: TileView; onChange: (v: TileView) => void }) {
  const btn = (active: boolean) =>
    ['p-1 rounded transition-colors', active ? 'text-navy bg-navy/10' : 'text-inky/50 hover:text-navy'].join(' ')
  return (
    <div className="flex items-center gap-0.5 border border-navy/30 rounded p-0.5">
      <button onClick={() => onChange('graph')} className={btn(view === 'graph')} title="Graph view">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V9m4 10V5m4 14v-6M5 19h14" /></svg>
      </button>
      <button onClick={() => onChange('list')} className={btn(view === 'list')} title="List view">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
      </button>
    </div>
  )
}

function CompactList({ columns, rows }: { columns: string[]; rows: (string | number)[][] }) {
  if (rows.length === 0) return <p className="px-1 py-2 text-xs text-inky font-body italic">No data</p>
  return (
    <div className="overflow-auto max-h-[200px] rounded border border-inky/20">
      <table className="w-full text-xs font-body">
        <thead className="bg-navy text-cream font-heading uppercase tracking-wide sticky top-0">
          <tr>{columns.map((c) => <th key={c} className="px-3 py-1.5 text-left">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i % 2 === 0 ? 'bg-cream' : 'bg-[#ECEBD8]'}>
              {r.map((cell, j) => <td key={j} className="px-3 py-1.5 text-navy">{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface DashStats {
  openIssuesByCategory: { name: string; count: number }[]
  upcomingEvents: Array<{ id: string; title: string; start_date: string; event_type: string }>
  recentOrders: Array<{ id: string; status: string; created_at: string }>
  activeShops: number
  submittedThisMonth: number
  totalShops: number
}

// Brand palette for chart bars: navy, inky, sky in rotation
const CHART_COLORS = ['#002745', '#4F7489', '#B7E0DE']

const ORDER_STATUS_COLOR: Record<string, 'sky' | 'green' | 'orange' | 'inky'> = {
  draft:     'inky',
  pending:   'orange',
  exported:  'sky',
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

  const [issuesView, setIssuesView] = useTileView('issues_by_category', 'graph')
  const [eventsView, setEventsView] = useTileView('events_week', 'list')
  const [ordersView, setOrdersView] = useTileView('recent_orders', 'list')
  const [countView, setCountView] = useTileView('count_progress', 'graph')
  const [invView, setInvView] = useTileView('inventory', 'list')
  const inv = useInventory()

  useEffect(() => {
    if (!profile?.company_id) return
    loadStats()
  }, [profile?.company_id])

  async function loadStats() {
    const cid = profile!.company_id!
    const today = format(new Date(), 'yyyy-MM-dd')
    const weekEnd = format(endOfWeek(new Date()), 'yyyy-MM-dd')
    const monthStart = format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), 'yyyy-MM-dd')

    const sb = supabase as any
    const [issuesRes, eventsRes, ordersRes, locsRes, monthCountsRes] = await Promise.all([
      sb.schema('inventory').from('issues').select('id, issue_categories(name), issue_statuses(name)').eq('company_id', cid),
      sb.schema('platform').from('schedule_events').select('id, title, start_date, event_type').eq('company_id', cid).gte('start_date', today).lte('start_date', weekEnd).order('start_date').limit(10),
      sb.schema('inventory').from('order_sessions').select('id, status, created_at').eq('company_id', cid).order('created_at', { ascending: false }).limit(5),
      sb.schema('core').from('locations').select('id, active').eq('company_id', cid),
      sb.schema('inventory').from('counts').select('location_id').eq('company_id', cid).gte('count_date', monthStart),
    ])

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

    setStats({
      openIssuesByCategory,
      upcomingEvents: eventsRes.data ?? [],
      recentOrders: ordersRes.data ?? [],
      activeShops,
      submittedThisMonth: submittedLocIds.size,
      totalShops: locs.length,
    })
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <SbLoader />
      </div>
    )
  }

  const notSubmitted = stats.totalShops - stats.submittedThisMonth
  const completionPct = stats.totalShops > 0
    ? Math.round((stats.submittedThisMonth / stats.totalShops) * 100)
    : 0

  const flaggedByShop = Object.entries(inv.rows.filter((r) => r.flag === 'red' || r.flag === 'amber').reduce((m, r) => { m[r.location_label] = (m[r.location_label] ?? 0) + 1; return m }, {} as Record<string, number>))
    .map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8)

  const countBy = (arr: { event_type?: string; status?: string }[], field: 'event_type' | 'status') =>
    Object.entries(arr.reduce((m, x) => { const k = (x as any)[field] ?? '—'; m[k] = (m[k] ?? 0) + 1; return m }, {} as Record<string, number>))
      .map(([name, count]) => ({ name, count }))
  const eventsByType = countBy(stats.upcomingEvents, 'event_type')
  const ordersByStatus = countBy(stats.recentOrders, 'status')

  // Shared Recharts tooltip style
  const tooltipStyle = { background: '#F2F1E6', border: '1px solid rgba(0,39,69,0.3)', borderRadius: '4px', fontFamily: '"DM Mono", monospace', fontSize: '11px', color: '#002745' }
  const axisTickProps = { fill: '#4F7489', fontSize: 11, fontFamily: '"DM Mono", monospace' }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-heading font-bold text-navy tracking-wide uppercase">Dashboard</h1>
        <p className="text-xs text-inky font-body mt-0.5">
          {format(new Date(), 'EEEE, MMMM d, yyyy')}
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card onClick={() => navigate('/config')} className="p-4 hover:border-navy cursor-pointer">
          <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Active Shops</div>
          <div className="text-2xl font-heading font-bold text-navy">{stats.activeShops}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Count Completion</div>
          <div className="text-2xl font-heading font-bold text-navy">{completionPct}%</div>
          <div className="text-xs text-inky/70 font-body mt-1">{stats.submittedThisMonth}/{stats.totalShops} submitted</div>
        </Card>
        <Card onClick={() => navigate('/issues?tab=pending')} className="p-4 hover:border-navy cursor-pointer">
          <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Open Issues</div>
          <div className="text-2xl font-heading font-bold text-navy">
            {stats.openIssuesByCategory.reduce((s, c) => s + c.count, 0)}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Not Submitted</div>
          <div className="text-2xl font-heading font-bold text-navy">{notSubmitted}</div>
          <div className="text-xs text-inky/70 font-body mt-1">this month</div>
        </Card>
      </div>

      {/* Inventory Health callout */}
      <Card>
        <CardHeader><span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Inventory Health</span></CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Critical Shops</div>
              <div className="text-2xl font-heading font-bold" style={{ color: FLAG_HEX.red }}>{inv.stats.shopsWithCritical}</div>
            </div>
            <div>
              <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Products Tracked</div>
              <div className="text-2xl font-heading font-bold text-navy">{inv.stats.totalProducts}</div>
              <div className="text-xs text-inky/70 font-body mt-1">{inv.stats.flaggedProducts} flagged</div>
            </div>
            <div>
              <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Avg Flagged / Shop</div>
              <div className="text-2xl font-heading font-bold text-inky">{inv.stats.avgFlaggedPerShop}</div>
            </div>
            <div>
              <div className="text-xs text-inky font-heading uppercase tracking-wide mb-1">Worst Shop</div>
              <div className="text-sm font-heading font-bold text-navy truncate">{inv.stats.worstShop}</div>
              <div className="text-xs text-inky/70 font-body mt-1">{inv.stats.worstCount} flagged</div>
            </div>
          </div>
        </CardBody>
      </Card>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {/* Inventory days-of-supply */}
        <Card className="col-span-1 sm:col-span-2">
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Inventory · Days of Supply</span>
            <TileToggle view={invView} onChange={setInvView} />
          </CardHeader>
          <CardBody>
            {invView === 'graph' ? (
              flaggedByShop.length === 0 ? <p className="text-xs text-inky font-body italic">No flagged products</p> : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={flaggedByShop} layout="vertical" margin={{ left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={140} tick={axisTickProps} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>{flaggedByShop.map((_, i) => <Cell key={i} fill={FLAG_HEX.red} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              )
            ) : (
              <InventoryView maxHeight="320px" />
            )}
          </CardBody>
        </Card>

        {/* Issues by Category */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Open Issues by Category</span>
            <TileToggle view={issuesView} onChange={setIssuesView} />
          </CardHeader>
          <CardBody>
            {stats.openIssuesByCategory.length === 0 ? (
              <p className="text-xs text-inky font-body italic">No open issues</p>
            ) : issuesView === 'list' ? (
              <CompactList columns={['Category', 'Open']} rows={stats.openIssuesByCategory.map((c) => [c.name, c.count])} />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={stats.openIssuesByCategory} layout="vertical" margin={{ left: 0 }}>
                  <XAxis type="number" hide />
                  <YAxis type="category" dataKey="name" width={110} tick={axisTickProps} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {stats.openIssuesByCategory.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardBody>
        </Card>

        {/* Events This Week */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Events This Week</span>
            <TileToggle view={eventsView} onChange={setEventsView} />
          </CardHeader>
          <CardBody className="p-0">
            {stats.upcomingEvents.length === 0 ? (
              <p className="px-5 py-4 text-xs text-inky font-body italic">No events this week</p>
            ) : eventsView === 'graph' ? (
              <div className="p-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={eventsByType} layout="vertical" margin={{ left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={110} tick={axisTickProps} tickFormatter={(v) => String(v).replace(/_/g, ' ')} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                      {eventsByType.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="divide-y divide-inky/10">
                {stats.upcomingEvents.map((e) => (
                  <div key={e.id} className="flex items-center justify-between px-5 py-2.5 cursor-pointer hover:bg-sky/10"
                    onClick={() => navigate('/schedule')}>
                    <div>
                      <div className="text-xs font-body text-navy">{e.title}</div>
                      <div className="text-xs text-inky/70 font-body">{format(new Date(e.start_date + 'T00:00:00'), 'EEE, MMM d')}</div>
                    </div>
                    <Badge color={e.event_type === 'weekly_count' ? 'green' : e.event_type === 'order' ? 'orange' : 'inky'}>
                      {e.event_type.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Recent Orders</span>
            <TileToggle view={ordersView} onChange={setOrdersView} />
          </CardHeader>
          <CardBody className="p-0">
            {stats.recentOrders.length === 0 ? (
              <p className="px-5 py-4 text-xs text-inky font-body italic">No orders yet. Add one to get started.</p>
            ) : ordersView === 'graph' ? (
              <div className="p-4">
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={ordersByStatus} layout="vertical" margin={{ left: 0 }}>
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" width={90} tick={axisTickProps} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                      {ordersByStatus.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="divide-y divide-inky/10">
                {stats.recentOrders.map((o) => (
                  <div key={o.id} className="flex items-center justify-between px-5 py-2.5">
                    <span className="text-xs font-body text-inky">
                      {format(new Date(o.created_at), 'MMM d, h:mm a')}
                    </span>
                    <Badge color={ORDER_STATUS_COLOR[o.status] ?? 'inky'}>
                      {o.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Monthly Count Progress */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <span className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Monthly Count Progress</span>
            <TileToggle view={countView} onChange={setCountView} />
          </CardHeader>
          <CardBody>
            {countView === 'list' ? (
              <CompactList columns={['Metric', 'Count']} rows={[['Submitted', stats.submittedThisMonth], ['Not Submitted', notSubmitted], ['Total Shops', stats.totalShops]]} />
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex justify-between text-xs font-body text-inky">
                  <span>Submitted</span>
                  <span className="text-navy font-medium">{stats.submittedThisMonth} / {stats.totalShops}</span>
                </div>
                <div className="w-full h-2 bg-inky/20 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-navy rounded-full transition-all duration-500"
                    style={{ width: `${completionPct}%` }}
                  />
                </div>
                <p className="text-xs text-inky/70 font-body">
                  {notSubmitted} shop{notSubmitted !== 1 ? 's' : ''} not yet submitted for{' '}
                  {format(new Date(), 'MMMM yyyy')}
                </p>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}
