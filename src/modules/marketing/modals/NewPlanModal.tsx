import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingLocation, MarketingCampaignTemplate } from '@/types/marketing'
import { MONTHS } from '@/types/marketing'

interface Props {
  locations: MarketingLocation[]
  filterMonth: number
  filterYear: number
  existingPlanLocationIds: string[]
  onClose: () => void
  onCreated: () => void
}

export function NewPlanModal({ locations, filterMonth, filterYear, existingPlanLocationIds, onClose, onCreated }: Props) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id
  const userId = profile?.id
  const sb = supabase as any

  const [templates, setTemplates] = useState<MarketingCampaignTemplate[]>([])
  const [loadingTemplates, setLoadingTemplates] = useState(true)
  const [selectedLocIds, setSelectedLocIds] = useState<string[]>([])
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<string[]>([])
  const [month, setMonth] = useState(filterMonth)
  const [year, setYear] = useState(filterYear)
  const [saving, setSaving] = useState(false)
  const [locSearch, setLocSearch] = useState('')

  const CURRENT_YEAR = new Date().getFullYear()

  useEffect(() => {
    loadTemplates()
  }, []) // eslint-disable-line

  async function loadTemplates() {
    setLoadingTemplates(true)
    const { data } = await sb.schema('marketing').from('campaign_templates')
      .select('*, campaign_template_tasks(*)')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('sort_order')
    setTemplates(data ?? [])
    if (data?.length) setSelectedTemplateIds(data.map((t: MarketingCampaignTemplate) => t.id))
    setLoadingTemplates(false)
  }

  function toggleLoc(id: string) {
    setSelectedLocIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])
  }

  function toggleTemplate(id: string) {
    setSelectedTemplateIds(ids => ids.includes(id) ? ids.filter(i => i !== id) : [...ids, id])
  }

  // Filter out locations that already have a plan for this month/year
  const existingSet = new Set(existingPlanLocationIds)
  // When month/year changes, we can't filter by existing easily without a re-fetch — just show a warning if selected
  const available = locations.filter(l => {
    if (locSearch) {
      const t = locSearch.toLowerCase()
      return l.name.toLowerCase().includes(t) || (l.location_code ?? '').toLowerCase().includes(t)
    }
    return true
  })

  async function create() {
    if (selectedLocIds.length === 0) { toast.error('Select at least one shop'); return }
    if (selectedTemplateIds.length === 0) { toast.error('Select at least one campaign'); return }
    setSaving(true)

    const chosenTemplates = templates.filter(t => selectedTemplateIds.includes(t.id))
    let successCount = 0
    let skipCount = 0

    for (const locId of selectedLocIds) {
      // Upsert plan
      const { data: plan, error: planErr } = await sb.schema('marketing').from('monthly_plans')
        .upsert({ company_id: companyId, location_id: locId, plan_month: month, plan_year: year, created_by: userId, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'company_id,location_id,plan_month,plan_year' })
        .select('id')
        .single()
      if (planErr || !plan) { skipCount++; continue }

      // Get existing assignments to avoid duplicates
      const { data: existing } = await sb.schema('marketing').from('campaign_assignments')
        .select('campaign_template_id')
        .eq('monthly_plan_id', plan.id)
      const existingTplIds = new Set((existing ?? []).map((a: { campaign_template_id: string }) => a.campaign_template_id))

      for (let si = 0; si < chosenTemplates.length; si++) {
        const tpl = chosenTemplates[si]
        if (existingTplIds.has(tpl.id)) continue

        const { data: assignment, error: aErr } = await sb.schema('marketing').from('campaign_assignments')
          .insert({ monthly_plan_id: plan.id, campaign_template_id: tpl.id, campaign_name_snapshot: tpl.name, campaign_category_snapshot: tpl.category, sort_order: si, created_by: userId })
          .select('id')
          .single()
        if (aErr || !assignment) continue

        const tasks = (tpl.campaign_template_tasks ?? []).map((tt, j) => ({
          campaign_assignment_id: assignment.id,
          template_task_id: tt.id,
          task_name_snapshot: tt.name,
          task_description_snapshot: tt.description,
          status: 'not_started',
          is_required: tt.is_required,
          sort_order: j,
          created_by: userId,
        }))
        if (tasks.length) await sb.schema('marketing').from('campaign_tasks').insert(tasks)
      }
      successCount++
    }

    setSaving(false)
    if (successCount > 0) toast.success(`Created/updated ${successCount} plan${successCount > 1 ? 's' : ''}`)
    if (skipCount > 0) toast.error(`${skipCount} shop(s) failed`)
    onCreated()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto py-8">
      <div className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col gap-5 p-6">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-navy dark:text-cream">New Monthly Plan</h2>
          <button onClick={onClose} className="text-inky/40 hover:text-navy dark:hover:text-cream text-xl">✕</button>
        </div>

        {/* Month/year */}
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-xs font-mono text-inky/60 block mb-1">Month</label>
            <select className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy dark:text-cream"
              value={month} onChange={e => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="w-28">
            <label className="text-xs font-mono text-inky/60 block mb-1">Year</label>
            <select className="w-full border border-sky/30 rounded px-3 py-2 text-sm font-mono bg-white dark:bg-[#122b40] text-navy dark:text-cream"
              value={year} onChange={e => setYear(Number(e.target.value))}>
              {[CURRENT_YEAR - 1, CURRENT_YEAR, CURRENT_YEAR + 1].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {/* Location picker */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-mono text-inky/60">Shops ({selectedLocIds.length} selected)</label>
            <div className="flex gap-3 text-xs font-mono text-inky/50">
              <button onClick={() => setSelectedLocIds(available.map(l => l.id))} className="hover:text-navy dark:hover:text-cream">All</button>
              <button onClick={() => setSelectedLocIds([])} className="hover:text-navy dark:hover:text-cream">None</button>
            </div>
          </div>
          <input className="w-full border border-sky/30 rounded px-3 py-1.5 text-xs font-mono bg-white dark:bg-[#122b40] text-navy dark:text-cream placeholder:text-inky/40 mb-2 focus:outline-none focus:ring-1 focus:ring-sky"
            placeholder="Search shops…" value={locSearch} onChange={e => setLocSearch(e.target.value)} />
          <div className="border border-sky/20 rounded max-h-40 overflow-y-auto bg-white dark:bg-[#122b40]">
            {available.map(loc => {
              const alreadyHas = existingSet.has(loc.id)
              return (
                <label key={loc.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-sky/10 cursor-pointer text-xs font-mono">
                  <input type="checkbox" checked={selectedLocIds.includes(loc.id)} onChange={() => toggleLoc(loc.id)} />
                  <span className="text-navy dark:text-cream">{loc.name}</span>
                  {loc.location_code && <span className="text-inky/50">{loc.location_code}</span>}
                  {alreadyHas && <Badge color="orange">Existing</Badge>}
                </label>
              )
            })}
          </div>
        </div>

        {/* Campaign picker */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs font-mono text-inky/60">Campaigns ({selectedTemplateIds.length} selected)</label>
            <div className="flex gap-3 text-xs font-mono text-inky/50">
              <button onClick={() => setSelectedTemplateIds(templates.map(t => t.id))} className="hover:text-navy dark:hover:text-cream">All</button>
              <button onClick={() => setSelectedTemplateIds([])} className="hover:text-navy dark:hover:text-cream">None</button>
            </div>
          </div>
          {loadingTemplates ? (
            <div className="text-xs font-mono text-inky/60 py-3">Loading templates…</div>
          ) : templates.length === 0 ? (
            <div className="text-xs font-mono text-inky/60 py-3">No templates found. Create them in the Campaign Templates tab first.</div>
          ) : (
            <div className="border border-sky/20 rounded max-h-40 overflow-y-auto bg-white dark:bg-[#122b40]">
              {templates.map(tpl => (
                <label key={tpl.id} className="flex items-center gap-2 px-3 py-1.5 hover:bg-sky/10 cursor-pointer text-xs font-mono">
                  <input type="checkbox" checked={selectedTemplateIds.includes(tpl.id)} onChange={() => toggleTemplate(tpl.id)} />
                  <span className="text-navy dark:text-cream">{tpl.name}</span>
                  <span className="text-inky/50">{tpl.category}</span>
                  <span className="text-inky/40">· {tpl.campaign_template_tasks?.length ?? 0} tasks</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={create} disabled={saving}>
            {saving ? 'Creating…' : `Create for ${selectedLocIds.length} Shop${selectedLocIds.length !== 1 ? 's' : ''}`}
          </Button>
        </div>
      </div>
    </div>
  )
}
