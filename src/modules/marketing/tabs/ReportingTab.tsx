import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation, MarketingMonthlyPlan } from '@/types/marketing'
import { locMeta, MONTHS, calcProgress } from '@/types/marketing'

interface Props {
  locations: MarketingLocation[]
}

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1

export function ReportingTab({ locations }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const sb = supabase as any

  const [plans, setPlans] = useState<MarketingMonthlyPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [filterYear, setFilterYear] = useState(CURRENT_YEAR)
  const [filterMonth, setFilterMonth] = useState(CURRENT_MONTH)

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
    if (error) toast.error('Failed to load reporting data')
    else setPlans(data ?? [])
    setLoading(false)
  }

  const locMap = new Map(locations.map(l => [l.id, l]))

  // Aggregate by-shop progress
  const shopSummaries = plans.map(plan => {
    const loc = locMap.get(plan.location_id)
    const allTasks = (plan.campaign_assignments ?? []).flatMap(a => a.campaign_tasks ?? [])
    const progress = calcProgress(allTasks)
    return { plan, loc, ...progress }
  }).sort((a, b) => b.pct - a.pct)

  // Aggregate by-campaign progress
  const campaignMap = new Map<string, { name: string; category: string; tasks: { status: string }[]; shopCount: number }>()
  for (const plan of plans) {
    for (const a of plan.campaign_assignments ?? []) {
      const key = a.campaign_name_snapshot
      const existing = campaignMap.get(key)
      if (existing) {
        existing.tasks.push(...(a.campaign_tasks ?? []))
        existing.shopCount++
      } else {
        campaignMap.set(key, { name: a.campaign_name_snapshot, category: a.campaign_category_snapshot, tasks: [...(a.campaign_tasks ?? [])], shopCount: 1 })
      }
    }
  }
  const campaignSummaries = [...campaignMap.values()].map(c => ({ ...c, ...calcProgress(c.tasks) })).sort((a, b) => b.pct - a.pct)

  // By-region aggregate
  const regionMap = new Map<string, { tasks: { status: string }[]; shopCount: number }>()
  for (const plan of plans) {
    const loc = locMap.get(plan.location_id)
    const region = loc?.region ?? locMeta(loc!, 'market') ?? 'Unknown'
    const allTasks = (plan.campaign_assignments ?? []).flatMap(a => a.campaign_tasks ?? [])
    const existing = regionMap.get(region)
    if (existing) { existing.tasks.push(...allTasks); existing.shopCount++ }
    else regionMap.set(region, { tasks: allTasks, shopCount: 1 })
  }
  const regionSummaries = [...regionMap.entries()].map(([region, data]) => ({ region, ...data, ...calcProgress(data.tasks) })).sort((a, b) => b.pct - a.pct)

  // Overall
  const allTasks = plans.flatMap(p => (p.campaign_assignments ?? []).flatMap(a => a.campaign_tasks ?? []))
  const overall = calcProgress(allTasks)
  const completeShops = shopSummaries.filter(s => s.pct === 100).length
  const notStartedShops = shopSummaries.filter(s => s.pct === 0).length

  return (
    <div className="flex flex-col gap-6 mt-4">
      {/* Period filter */}
      <div className="flex gap-3">
        <select className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream"
          value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <select className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream"
          value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}>
          {[CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="py-8 text-center text-inky/60 font-mono text-xs">Loading…</div>
      ) : plans.length === 0 ? (
        <div className="py-10 text-center text-inky/60 font-mono text-xs border border-dashed border-sky/30 rounded-lg">
          No plans for {MONTHS[filterMonth - 1]} {filterYear}
        </div>
      ) : (
        <>
          {/* Overall summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[
              { label: 'Overall Progress', value: `${overall.pct}%`, sub: `${overall.done}/${overall.total} tasks` },
              { label: 'Total Shops', value: plans.length, sub: `with active plans` },
              { label: 'Complete', value: completeShops, sub: `shops at 100%` },
              { label: 'Not Started', value: notStartedShops, sub: `shops at 0%` },
            ].map(card => (
              <div key={card.label} className="border border-sky/30 rounded-lg p-4">
                <p className="text-xs font-mono text-inky/60">{card.label}</p>
                <p className="text-2xl font-heading font-bold text-navy mt-1">{card.value}</p>
                <p className="text-xs font-mono text-inky/40 mt-0.5">{card.sub}</p>
              </div>
            ))}
          </div>

          {/* By campaign */}
          <div>
            <h3 className="font-heading font-bold text-navy text-sm uppercase tracking-wide mb-3">Progress by Campaign</h3>
            <div className="border border-sky/20 rounded-lg overflow-hidden">
              <table className="w-full text-xs font-mono border-collapse">
                <thead>
                  <tr className="bg-navy text-cream">
                    <th className="text-left px-3 py-2 font-normal">Campaign</th>
                    <th className="text-left px-3 py-2 font-normal hidden md:table-cell">Category</th>
                    <th className="px-3 py-2 font-normal w-10 text-right">Shops</th>
                    <th className="px-3 py-2 font-normal w-40">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignSummaries.map(c => (
                    <tr key={c.name} className="border-t border-sky/10">
                      <td className="px-3 py-2.5 text-navy">{c.name}</td>
                      <td className="px-3 py-2.5 text-inky/60 hidden md:table-cell">{c.category}</td>
                      <td className="px-3 py-2.5 text-inky/60 text-right">{c.shopCount}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded bg-sky/20">
                            <div className="h-1.5 rounded"
                              style={{ width: `${c.pct}%`, backgroundColor: c.pct === 100 ? '#2ECC71' : c.pct >= 50 ? '#E67E22' : '#4F7489' }} />
                          </div>
                          <span className="text-inky/50 w-8 text-right">{c.pct}%</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* By region */}
          {regionSummaries.length > 1 && (
            <div>
              <h3 className="font-heading font-bold text-navy text-sm uppercase tracking-wide mb-3">Progress by Region / Market</h3>
              <div className="border border-sky/20 rounded-lg overflow-hidden">
                <table className="w-full text-xs font-mono border-collapse">
                  <thead>
                    <tr className="bg-navy text-cream">
                      <th className="text-left px-3 py-2 font-normal">Region</th>
                      <th className="px-3 py-2 font-normal w-10 text-right">Shops</th>
                      <th className="px-3 py-2 font-normal w-40">Progress</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regionSummaries.map(r => (
                      <tr key={r.region} className="border-t border-sky/10">
                        <td className="px-3 py-2.5 text-navy">{r.region}</td>
                        <td className="px-3 py-2.5 text-inky/60 text-right">{r.shopCount}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded bg-sky/20">
                              <div className="h-1.5 rounded"
                                style={{ width: `${r.pct}%`, backgroundColor: r.pct === 100 ? '#2ECC71' : r.pct >= 50 ? '#E67E22' : '#4F7489' }} />
                            </div>
                            <span className="text-inky/50 w-8 text-right">{r.pct}%</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* By shop — bottom performers */}
          <div>
            <h3 className="font-heading font-bold text-navy text-sm uppercase tracking-wide mb-3">
              Shop Details
              <span className="text-inky/40 font-normal normal-case ml-2 text-xs">sorted by lowest completion</span>
            </h3>
            <div className="border border-sky/20 rounded-lg overflow-hidden">
              <table className="w-full text-xs font-mono border-collapse">
                <thead>
                  <tr className="bg-navy text-cream">
                    <th className="text-left px-3 py-2 font-normal">Shop</th>
                    <th className="text-left px-3 py-2 font-normal hidden md:table-cell">Region</th>
                    <th className="px-3 py-2 font-normal w-12 text-right">Cmpgns</th>
                    <th className="px-3 py-2 font-normal w-40">Progress</th>
                    <th className="px-3 py-2 font-normal w-24">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...shopSummaries].reverse().map(s => {
                    const color = s.pct === 100 ? 'green' : s.pct > 0 ? 'orange' : 'inky'
                    const label = s.pct === 100 ? 'Complete' : s.pct > 0 ? 'In Progress' : 'Not Started'
                    return (
                      <tr key={s.plan.id} className="border-t border-sky/10">
                        <td className="px-3 py-2.5">
                          <div className="text-navy font-semibold">{s.loc?.shop_city ?? s.loc?.name ?? 'Unknown'}</div>
                          {s.loc?.location_code && <div className="text-inky/40">{s.loc.location_code}</div>}
                        </td>
                        <td className="px-3 py-2.5 text-inky/60 hidden md:table-cell">{s.loc?.region ?? ''}</td>
                        <td className="px-3 py-2.5 text-inky/60 text-right">{s.plan.campaign_assignments?.length ?? 0}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded bg-sky/20">
                              <div className="h-1.5 rounded"
                                style={{ width: `${s.pct}%`, backgroundColor: s.pct === 100 ? '#2ECC71' : s.pct >= 50 ? '#E67E22' : '#4F7489' }} />
                            </div>
                            <span className="text-inky/50 w-8 text-right">{s.pct}%</span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5"><Badge color={color}>{label}</Badge></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
