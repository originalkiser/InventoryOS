import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation, MarketingMonthlyPlan } from '@/types/marketing'
import { locMeta, MONTHS, calcProgress } from '@/types/marketing'
import { NewPlanModal } from '../modals/NewPlanModal'
import { ImportPlansModal } from '../modals/ImportPlansModal'
import { PlanDetailModal } from '../modals/PlanDetailModal'

interface Props {
  locations: MarketingLocation[]
  isAdmin: boolean
}

const CURRENT_YEAR = new Date().getFullYear()
const CURRENT_MONTH = new Date().getMonth() + 1

export function MonthlyPlansTab({ locations, isAdmin }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const userId = profile?.id
  const sb = supabase as any

  const [plans, setPlans] = useState<MarketingMonthlyPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [filterYear, setFilterYear] = useState(CURRENT_YEAR)
  const [filterMonth, setFilterMonth] = useState(CURRENT_MONTH)
  const [filterLocation, setFilterLocation] = useState('')
  const [showNewPlan, setShowNewPlan] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<MarketingMonthlyPlan | null>(null)

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
    if (error) toast.error('Failed to load plans')
    else setPlans(data ?? [])
    setLoading(false)
  }

  const locMap = new Map(locations.map(l => [l.id, l]))

  const filtered = filterLocation
    ? plans.filter(p => {
        const loc = locMap.get(p.location_id)
        if (!loc) return false
        const term = filterLocation.toLowerCase()
        return loc.name.toLowerCase().includes(term) || (loc.shop_city ?? '').toLowerCase().includes(term)
      })
    : plans

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
        <input className="border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-cream w-48"
          placeholder="Filter by shop…" value={filterLocation} onChange={e => setFilterLocation(e.target.value)} />
        <div className="ml-auto flex gap-2">
          {isAdmin && <Button size="sm" variant="secondary" onClick={() => setShowImport(true)}>Import</Button>}
          {isAdmin && <Button size="sm" variant="primary" onClick={() => setShowNewPlan(true)}>+ New Plan</Button>}
        </div>
      </div>

      {loading ? (
        <div className="py-8 text-center text-inky/60 font-mono text-xs">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="py-10 text-center text-inky/60 font-mono text-xs border border-dashed border-sky/30 rounded-lg">
          No plans for {MONTHS[filterMonth - 1]} {filterYear}
          {isAdmin && <div className="mt-3"><Button size="sm" variant="secondary" onClick={() => setShowNewPlan(true)}>Create Plan</Button></div>}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map(plan => {
            const loc = locMap.get(plan.location_id)
            const allTasks = (plan.campaign_assignments ?? []).flatMap(a => a.campaign_tasks ?? [])
            const { done, total, pct } = calcProgress(allTasks)
            return (
              <button
                key={plan.id}
                className="border border-sky/30 rounded-lg p-4 flex items-center justify-between gap-4 w-full text-left hover:border-sky/60 hover:shadow-sm transition-all cursor-pointer"
                onClick={() => setSelectedPlan(plan)}
              >
                <div className="flex flex-col gap-1 min-w-0">
                  <span className="font-heading font-bold text-navy text-sm">{loc?.shop_city ?? loc?.name ?? 'Unknown Shop'}</span>
                  <div className="flex items-center gap-2 text-xs font-mono text-inky/60">
                    <span>{loc?.name ?? ''}</span>
                    {loc && <span>{loc.region ?? locMeta(loc, 'market')}</span>}
                  </div>
                  <div className="flex items-center gap-2 text-xs font-mono text-inky/60">
                    <span>{plan.campaign_assignments?.length ?? 0} campaigns</span>
                    <span>·</span>
                    <span>{done}/{total} tasks</span>
                  </div>
                </div>

                <div className="flex items-center gap-4 shrink-0">
                  <div className="w-32">
                    <div className="flex justify-between text-xs font-mono text-inky/60 mb-1">
                      <span>Progress</span>
                      <span>{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded bg-sky/20">
                      <div className="h-1.5 rounded transition-all"
                        style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#2ECC71' : pct >= 50 ? '#E67E22' : '#4F7489' }} />
                    </div>
                  </div>
                  <Badge color={pct === 100 ? 'green' : pct > 0 ? 'orange' : 'inky'}>
                    {pct === 100 ? 'Complete' : pct > 0 ? 'In Progress' : 'Not Started'}
                  </Badge>
                  <span className="text-inky/30 text-sm">›</span>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {showNewPlan && (
        <NewPlanModal
          locations={locations}
          filterMonth={filterMonth}
          filterYear={filterYear}
          existingPlanLocationIds={plans.map(p => p.location_id)}
          onClose={() => setShowNewPlan(false)}
          onCreated={() => { setShowNewPlan(false); load() }}
        />
      )}

      {showImport && (
        <ImportPlansModal
          locations={locations}
          filterMonth={filterMonth}
          filterYear={filterYear}
          onClose={() => setShowImport(false)}
          onImported={() => { setShowImport(false); load() }}
        />
      )}

      {selectedPlan && (
        <PlanDetailModal
          plan={selectedPlan}
          location={locMap.get(selectedPlan.location_id)}
          isAdmin={isAdmin}
          onClose={() => setSelectedPlan(null)}
          onUpdated={updated => {
            setPlans(ps => ps.map(p => p.id === updated.id ? updated : p))
            setSelectedPlan(updated)
          }}
          onDeleted={id => {
            setPlans(ps => ps.filter(p => p.id !== id))
            setSelectedPlan(null)
          }}
        />
      )}
    </div>
  )
}
