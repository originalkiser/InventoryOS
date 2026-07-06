import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation, MarketingMonthlyPlan, MarketingCampaignAssignment } from '@/types/marketing'
import { locMeta, MONTHS, calcProgress } from '@/types/marketing'
import { ExecutionDetailModal } from '../modals/ExecutionDetailModal'

interface Props {
  locations: MarketingLocation[]
}

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1

export function ExecutionTab({ locations }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const sb = supabase as any

  const [plans, setPlans] = useState<MarketingMonthlyPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [filterYear, setFilterYear] = useState(CURRENT_YEAR)
  const [filterMonth, setFilterMonth] = useState(CURRENT_MONTH)
  const [filterLocation, setFilterLocation] = useState('')
  const [filterCategory, setFilterCategory] = useState('')
  const [activeDetail, setActiveDetail] = useState<{ plan: MarketingMonthlyPlan; assignment: MarketingCampaignAssignment } | null>(null)

  useEffect(() => {
    if (!companyId) return
    load()
  }, [companyId, filterYear, filterMonth]) // eslint-disable-line

  async function load() {
    setLoading(true)
    const { data, error } = await sb.schema('marketing').from('monthly_plans')
      .select('*, campaign_assignments(*, campaign_tasks(*))')
      .eq('company_id', companyId)
      .eq('plan_year', filterYear)
      .eq('plan_month', filterMonth)
      .order('created_at')
    if (error) toast.error('Failed to load execution data')
    else setPlans(data ?? [])
    setLoading(false)
  }

  const locMap = new Map(locations.map(l => [l.id, l]))

  // Flatten to assignment rows
  const rows: Array<{ plan: MarketingMonthlyPlan; loc: MarketingLocation | undefined; assignment: MarketingCampaignAssignment }> = []
  for (const plan of plans) {
    const loc = locMap.get(plan.location_id)
    for (const assignment of plan.campaign_assignments ?? []) {
      if (filterLocation) {
        const term = filterLocation.toLowerCase()
        const matches = loc?.name.toLowerCase().includes(term) || (loc?.shop_city ?? '').toLowerCase().includes(term)
        if (!matches) continue
      }
      if (filterCategory && assignment.campaign_category_snapshot !== filterCategory) continue
      rows.push({ plan, loc, assignment })
    }
  }

  const categories = [...new Set((plans.flatMap(p => p.campaign_assignments ?? []).map(a => a.campaign_category_snapshot)))]

  function handleAssignmentUpdated(planId: string, updated: MarketingCampaignAssignment) {
    setPlans(ps => ps.map(p => p.id !== planId ? p : {
      ...p,
      campaign_assignments: (p.campaign_assignments ?? []).map(a => a.id === updated.id ? updated : a),
    }))
    if (activeDetail?.assignment.id === updated.id) {
      setActiveDetail(d => d ? { ...d, assignment: updated } : null)
    }
  }

  return (
    <div className="flex flex-col gap-4 mt-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream"
          value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream"
          value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}>
          {[CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <input className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream w-44"
          placeholder="Filter by shop…" value={filterLocation} onChange={e => setFilterLocation(e.target.value)} />
        <select className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream"
          value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
          <option value="">All Campaigns</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-xs font-mono text-inky/60 ml-auto">{rows.length} rows</span>
      </div>

      {loading ? (
        <div className="py-8 text-center text-inky/60 font-mono text-xs">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="py-10 text-center text-inky/60 font-mono text-xs border border-dashed border-sky/30 rounded-lg">
          No campaigns found for {MONTHS[filterMonth - 1]} {filterYear}
        </div>
      ) : (
        <div className="border border-sky/20 rounded-lg overflow-hidden">
          <table className="w-full text-xs font-mono border-collapse">
            <thead>
              <tr className="bg-navy text-cream">
                <th className="text-left px-3 py-2 font-normal">Shop</th>
                <th className="text-left px-3 py-2 font-normal">Campaign</th>
                <th className="text-left px-3 py-2 font-normal hidden md:table-cell">Category</th>
                <th className="px-3 py-2 font-normal w-40">Progress</th>
                <th className="px-3 py-2 font-normal w-24">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ plan, loc, assignment }) => {
                const { done, total, pct } = calcProgress(assignment.campaign_tasks ?? [])
                const statusLabel = pct === 100 ? 'Complete' : pct > 0 ? 'In Progress' : 'Not Started'
                const statusColor = pct === 100 ? 'green' : pct > 0 ? 'orange' : 'inky'
                return (
                  <tr
                    key={`${plan.id}-${assignment.id}`}
                    className="border-t border-sky/20 hover:bg-sky/5 cursor-pointer"
                    onClick={() => setActiveDetail({ plan, assignment })}
                  >
                    <td className="px-3 py-2.5">
                      <div className="text-navy font-semibold">{loc?.shop_city ?? loc?.name ?? 'Unknown'}</div>
                      {loc && <div className="text-inky/60">{loc.name}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-navy">{assignment.campaign_name_snapshot}</td>
                    <td className="px-3 py-2.5 text-inky/60 hidden md:table-cell">{assignment.campaign_category_snapshot}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded bg-sky/20">
                          <div className="h-1.5 rounded"
                            style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#2ECC71' : pct >= 50 ? '#E67E22' : '#4F7489' }} />
                        </div>
                        <span className="text-inky/50 w-8 text-right">{pct}%</span>
                      </div>
                      <div className="text-inky/60 mt-0.5">{done}/{total} tasks</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge color={statusColor}>{statusLabel}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeDetail && (
        <ExecutionDetailModal
          locationName={locMap.get(activeDetail.plan.location_id)?.name ?? 'Unknown Shop'}
          planMonth={`${MONTHS[activeDetail.plan.plan_month - 1]} ${activeDetail.plan.plan_year}`}
          assignment={activeDetail.assignment}
          onClose={() => setActiveDetail(null)}
          onUpdated={updated => handleAssignmentUpdated(activeDetail.plan.id, updated)}
        />
      )}
    </div>
  )
}
