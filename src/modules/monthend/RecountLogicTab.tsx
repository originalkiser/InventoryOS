import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { Button, Input, Toggle, Badge, Card, CardHeader, CardBody } from '@/components/ui'
import { RECOUNT_FLAG_LABELS } from '@/lib/recountEngine'
import {
  fetchPeriodEvalData, evaluateCounts, draftToConfig,
  type PeriodEvalData, type DraftThresholds,
} from './recountData'
import { locationLabel } from './countsShared'
import type { RecountConfig } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const DEFAULT_LOOKBACK = 6

function flagsToReason(flags: string[]): string {
  if (flags.includes('high_ending_balance')) return 'End balance too high'
  if (flags.includes('low_ending_balance')) return 'End balance too low'
  if (flags.includes('low_adjustments')) return 'Too few adjustments'
  if (flags.includes('high_adjustments')) return 'Too many adjustments'
  if (flags.includes('variance_vs_median')) return 'Unexpected ending balance'
  if (flags.includes('variance_vs_last_month')) return 'Unexpected ending balance'
  return flags.join(', ')
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

export function RecountLogicTab() {
  const { profile } = useAuthStore()
  const { getCountMonth, setRecountConfig } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [configId, setConfigId] = useState<string | null>(null)

  // Rule enable toggles
  const [adjEnabled, setAdjEnabled] = useState(false)
  const [balEnabled, setBalEnabled] = useState(false)
  const [varMedEnabled, setVarMedEnabled] = useState(false)
  const [varLastEnabled, setVarLastEnabled] = useState(false)

  // Threshold inputs (strings)
  const [lowAdj, setLowAdj] = useState('')
  const [highAdj, setHighAdj] = useState('')
  const [lowBal, setLowBal] = useState('')
  const [highBal, setHighBal] = useState('')
  const [varMed, setVarMed] = useState('')
  const [varLast, setVarLast] = useState('')
  const [lookback, setLookback] = useState(String(DEFAULT_LOOKBACK))

  const [evalData, setEvalData] = useState<PeriodEvalData | null>(null)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)

  // Load existing config
  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      const { data } = await (supabase as any)
        .schema('inventory').from('recount_config').select('*').eq('company_id', companyId).maybeSingle()
      const c = data as RecountConfig | null
      if (!c) return
      setConfigId(c.id)
      setAdjEnabled(c.low_adj_threshold != null || c.high_adj_threshold != null)
      setBalEnabled(c.low_balance_threshold != null || c.high_balance_threshold != null)
      setVarMedEnabled(c.variance_to_median_pct != null)
      setVarLastEnabled(c.variance_to_last_month_pct != null)
      setLowAdj(c.low_adj_threshold?.toString() ?? '')
      setHighAdj(c.high_adj_threshold?.toString() ?? '')
      setLowBal(c.low_balance_threshold?.toString() ?? '')
      setHighBal(c.high_balance_threshold?.toString() ?? '')
      setVarMed(c.variance_to_median_pct?.toString() ?? '')
      setVarLast(c.variance_to_last_month_pct?.toString() ?? '')
      setLookback((c.median_months_lookback ?? DEFAULT_LOOKBACK).toString())
    })()
  }, [companyId])

  // Load period data for the live preview (once per period)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    fetchPeriodEvalData(companyId, countMonth).then((d) => { if (!cancelled) setEvalData(d) })
    return () => { cancelled = true }
  }, [companyId, countMonth])

  const lookbackN = numOrNull(lookback) ?? DEFAULT_LOOKBACK

  // Draft thresholds derived from current (unsaved) form state
  const draft: DraftThresholds = useMemo(() => ({
    low_adj_threshold: adjEnabled ? numOrNull(lowAdj) : null,
    high_adj_threshold: adjEnabled ? numOrNull(highAdj) : null,
    low_balance_threshold: balEnabled ? numOrNull(lowBal) : null,
    high_balance_threshold: balEnabled ? numOrNull(highBal) : null,
    variance_to_median_pct: varMedEnabled ? numOrNull(varMed) : null,
    variance_to_last_month_pct: varLastEnabled ? numOrNull(varLast) : null,
    median_months_lookback: lookbackN,
  }), [adjEnabled, balEnabled, varMedEnabled, varLastEnabled, lowAdj, highAdj, lowBal, highBal, varMed, varLast, lookbackN])

  // Live evaluation against the draft rules
  const evaluated = useMemo(() => {
    if (!evalData) return []
    return evaluateCounts(evalData.counts, evalData.histByLoc, draftToConfig(draft), lookbackN)
  }, [evalData, draft, lookbackN])

  const flagged = evaluated.filter((e) => e.flags.length > 0)
  const totalShops = evaluated.length

  async function saveLogic(): Promise<string | null> {
    if (!companyId) return null
    const payload = { company_id: companyId, ...draft }
    const sb = supabase as any
    let savedId = configId
    if (configId) {
      const { error } = await sb.schema('inventory').from('recount_config').update(payload).eq('id', configId)
      if (error) { toast.error(error.message); return null }
    } else {
      const { data, error } = await sb.schema('inventory').from('recount_config').insert(payload).select().single()
      if (error) { toast.error(error.message); return null }
      savedId = data.id
      setConfigId(data.id)
    }
    setRecountConfig({ id: savedId!, ...payload } as RecountConfig)
    return savedId
  }

  async function handleSave() {
    setSaving(true)
    const id = await saveLogic()
    setSaving(false)
    if (id) toast.success('Recount logic saved')
  }

  async function handleApplyGenerate() {
    if (!companyId) return
    setGenerating(true)
    try {
      const id = await saveLogic()
      if (!id) return

      const flaggedWithLoc = flagged.filter((e) => e.locationId)
      if (flaggedWithLoc.length === 0) {
        toast('No shops flagged for this period', { icon: 'ℹ️' })
        return
      }

      // Skip locations that already have an auto recount for this period
      const sb = supabase as any
      const { data: existing } = await sb
        .schema('inventory').from('recount_requests')
        .select('location_id, recount_fields')
        .eq('company_id', companyId)
        .filter('recount_fields->>count_month', 'eq', countMonth)
        .filter('recount_fields->>source', 'eq', 'auto')
      const already = new Set((existing ?? []).map((r: any) => r.location_id))

      const today = format(new Date(), 'yyyy-MM-dd')
      const rows = flaggedWithLoc
        .filter((e) => !already.has(e.locationId))
        .map((e) => ({
          company_id: companyId,
          location_id: e.locationId,
          recount_type: 'Oil Recount',
          requested_products: [],
          request_date: today,
          recount_fields: {
            count_month: countMonth,
            source: 'auto',
            flags: e.flags,
            recount_reason: flagsToReason(e.flags),
          },
          completed_flags: [false],
          completed_dates: [null],
          recount_status: 'open',
        }))

      if (rows.length === 0) {
        toast('All flagged shops already have recounts for this period', { icon: 'ℹ️' })
        return
      }

      const { error } = await sb.schema('inventory').from('recount_requests').insert(rows)
      if (error) toast.error(error.message)
      else toast.success(`Generated ${rows.length} recount${rows.length === 1 ? '' : 's'} → see Recounts tab`)
    } finally {
      setGenerating(false)
    }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <RuleCard
          title="Adjustment Count"
          enabled={adjEnabled}
          onToggle={setAdjEnabled}
          preview={adjPreview(lowAdj, highAdj)}
        >
          <div className="grid grid-cols-2 gap-3">
            <Input label="Low (flag if fewer)" value={lowAdj} onChange={(e) => setLowAdj(e.target.value)} placeholder="blank = off" />
            <Input label="High (flag if more)" value={highAdj} onChange={(e) => setHighAdj(e.target.value)} placeholder="blank = off" />
          </div>
        </RuleCard>

        <RuleCard
          title="Ending Balance"
          enabled={balEnabled}
          onToggle={setBalEnabled}
          preview={balPreview(lowBal, highBal)}
        >
          <div className="grid grid-cols-2 gap-3">
            <Input label="Low (flag if below)" value={lowBal} onChange={(e) => setLowBal(e.target.value)} placeholder="blank = off" />
            <Input label="High (flag if above)" value={highBal} onChange={(e) => setHighBal(e.target.value)} placeholder="blank = off" />
          </div>
        </RuleCard>

        <RuleCard
          title="Variance vs Median"
          enabled={varMedEnabled}
          onToggle={setVarMedEnabled}
          preview={varMedEnabled && varMed.trim()
            ? `Flag shops whose ending balance differs from their ${lookbackN}-month median by more than ${varMed}%.`
            : 'Disabled — set a percentage to enable.'}
        >
          <Input label="Variance %" value={varMed} onChange={(e) => setVarMed(e.target.value)} placeholder="e.g. 15" />
        </RuleCard>

        <RuleCard
          title="Variance vs Last Month"
          enabled={varLastEnabled}
          onToggle={setVarLastEnabled}
          preview={varLastEnabled && varLast.trim()
            ? `Flag shops whose ending balance differs from last month by more than ${varLast}%.`
            : 'Disabled — set a percentage to enable.'}
        >
          <Input label="Variance %" value={varLast} onChange={(e) => setVarLast(e.target.value)} placeholder="e.g. 20" />
        </RuleCard>
      </div>

      <Card>
        <CardBody className="flex items-end justify-between flex-wrap gap-4">
          <div className="w-40">
            <Input
              label="Median Lookback (months)"
              value={lookback}
              onChange={(e) => setLookback(e.target.value)}
              hint={`Median over trailing ${lookbackN} months`}
            />
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" loading={saving} onClick={handleSave}>Save Logic</Button>
            <Button loading={generating} onClick={handleApplyGenerate}>Apply &amp; Generate Recounts</Button>
          </div>
        </CardBody>
      </Card>

      {/* Live preview */}
      <Card>
        <CardHeader className="flex items-center justify-between">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Live Preview — {format(new Date(countMonth), 'MMMM yyyy')}</span>
          <span className="text-xs font-mono">
            <span className="text-orange-600">{flagged.length}</span>
            <span className="text-inky"> of {totalShops} shops would flag</span>
          </span>
        </CardHeader>
        <CardBody>
          {!evalData ? (
            <p className="text-xs font-mono text-inky">Loading period data…</p>
          ) : flagged.length === 0 ? (
            <p className="text-xs font-mono text-inky/70">No shops flag under the current rules.</p>
          ) : (
            <div className="overflow-auto rounded border border-navy/30">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-right">Ending</th>
                    <th className="px-3 py-2 text-right">Prev</th>
                    <th className="px-3 py-2 text-right">Median</th>
                    <th className="px-3 py-2 text-left">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {flagged.map((e) => (
                    <tr key={e.count.id} className="border-b border-navy/30/50">
                      <td className="px-3 py-2 text-navy">{locationLabel(e.locationId, evalData.locations)}</td>
                      <td className="px-3 py-2 text-right text-navy">{fmt(e.count.ending_inventory_cost)}</td>
                      <td className="px-3 py-2 text-right text-inky">{fmt(e.prev)}</td>
                      <td className="px-3 py-2 text-right text-inky">{fmt(e.median)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {e.flags.map((f) => (
                            <Badge key={f} color={f.startsWith('variance') || f.startsWith('high') ? 'red' : 'amber'}>
                              {RECOUNT_FLAG_LABELS[f] ?? f}
                            </Badge>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

function fmt(v: number | null | undefined) {
  return v === null || v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

function adjPreview(low: string, high: string): string {
  const parts: string[] = []
  if (low.trim()) parts.push(`fewer than ${low}`)
  if (high.trim()) parts.push(`more than ${high}`)
  if (!parts.length) return 'Set a low and/or high adjustment count to enable.'
  return `Flag shops with ${parts.join(' or ')} adjustments.`
}

function balPreview(low: string, high: string): string {
  const parts: string[] = []
  if (low.trim()) parts.push(`below ${low}`)
  if (high.trim()) parts.push(`above ${high}`)
  if (!parts.length) return 'Set a low and/or high ending balance to enable.'
  return `Flag shops with ending balance ${parts.join(' or ')}.`
}

function RuleCard({
  title, enabled, onToggle, preview, children,
}: {
  title: string
  enabled: boolean
  onToggle: (v: boolean) => void
  preview: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">{title}</span>
        <Toggle checked={enabled} onChange={onToggle} color="green" size="sm" label={enabled ? 'On' : 'Off'} />
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>{children}</div>
        <p className="text-xs font-mono text-inky leading-relaxed border-l-2 border-[#00e5ff]/30 pl-2">
          {preview}
        </p>
      </CardBody>
    </Card>
  )
}
