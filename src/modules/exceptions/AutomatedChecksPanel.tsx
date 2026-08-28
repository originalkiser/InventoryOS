// Automated Checks — system-generated exception_reports rows (metadata.source
// = 'automated', written by the run-automated-checks Edge Function) shown
// alongside their own config: check thresholds, a growable ignore list, and
// — specific to tank variance — a way to set a new accepted baseline for a
// product/location once a shop/AM resolves it, so it stops re-flagging.
//
// The actual list reuses ExceptionTable (exported from ExceptionReportingPage)
// so status/contacted/response editing behaves identically to manual reports —
// this stays one workflow, not a parallel one.
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardHeader, CardBody, Modal, Combobox, Toggle } from '@/components/ui'
import { ExceptionTable } from './ExceptionReportingPage'
import type { ExceptionReport, ExceptionConfig } from './exceptions'
import toast from 'react-hot-toast'

interface ChecksConfig {
  adjustmentThreshold: number
  zeroOnHandSaleEnabled: boolean
  tankVarianceThreshold: number
}
const DEFAULT_CONFIG: ChecksConfig = { adjustmentThreshold: 50, zeroOnHandSaleEnabled: true, tankVarianceThreshold: 50 }

const CHECK_TYPE_LABELS: Record<string, string> = {
  abnormal_adjustment: 'Abnormal Adjustment',
  zero_on_hand_sale: 'Sale With Zero On-Hand',
  tank_variance: 'Tank Monitor Variance',
}
const CHECK_TYPES = Object.keys(CHECK_TYPE_LABELS)

interface Exclusion {
  id: string
  location_id: string | null
  product_id: string | null
  check_type: string
  note: string | null
}

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-sky'

export function AutomatedChecksPanel({
  rows, config, shopLabel, regionalDirector, companyId, onSet, onEdit, onQuick,
}: {
  rows: ExceptionReport[]
  config: ExceptionConfig
  shopLabel: (id: string | null) => string
  regionalDirector: (id: string | null) => string
  companyId: string | null
  onSet: (r: ExceptionReport, patch: Partial<ExceptionReport>) => void
  onEdit: (r: ExceptionReport) => void
  onQuick: (r: ExceptionReport, opts: { responseDate?: string | null; status?: string | null }) => void
}) {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const [checksConfig, setChecksConfig] = useAppSetting<ChecksConfig>('automated_checks_config', DEFAULT_CONFIG)
  const [exclusions, setExclusions] = useState<Exclusion[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [baselineRow, setBaselineRow] = useState<ExceptionReport | null>(null)

  const [excLocationId, setExcLocationId] = useState('')
  const [excAllShops, setExcAllShops] = useState(true)
  const [excProductId, setExcProductId] = useState('')
  const [excCheckType, setExcCheckType] = useState(CHECK_TYPES[0])
  const [excNote, setExcNote] = useState('')

  const loadExclusions = async () => {
    if (!companyId) return
    const { data } = await (supabase as any).schema('inventory').from('automated_check_exclusions')
      .select('*').eq('company_id', companyId)
    setExclusions((data ?? []) as Exclusion[])
  }
  useEffect(() => { loadExclusions() }, [companyId])

  async function addExclusion() {
    if (!excProductId.trim() || (!excAllShops && !excLocationId)) return
    const { error } = await (supabase as any).schema('inventory').from('automated_check_exclusions').insert({
      company_id: companyId,
      location_id: excAllShops ? null : excLocationId,
      product_id: excProductId.trim(),
      check_type: excCheckType,
      note: excNote.trim() || null,
      created_by: profile?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    setExcProductId(''); setExcNote(''); loadExclusions()
  }
  async function removeExclusion(id: string) {
    await (supabase as any).schema('inventory').from('automated_check_exclusions').delete().eq('id', id)
    loadExclusions()
  }

  const counts = CHECK_TYPES.reduce<Record<string, number>>((acc, ct) => {
    acc[ct] = rows.filter((r) => (r.metadata as any)?.check_type === ct && !(r.status ?? '').toLowerCase().includes('closed')).length
    return acc
  }, {})

  const openTankVariance = rows.filter((r) => (r.metadata as any)?.check_type === 'tank_variance' && !(r.status ?? '').toLowerCase().includes('closed'))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-wrap gap-2">
          {CHECK_TYPES.map((ct) => (
            <span key={ct} className="text-xs font-mono px-2.5 py-1 rounded-full border border-navy/30 bg-cream">
              <span className="text-navy font-bold">{counts[ct]}</span> <span className="text-inky">{CHECK_TYPE_LABELS[ct]}</span>
            </span>
          ))}
        </div>
        <button onClick={() => setSettingsOpen((v) => !v)} className="text-xs font-mono text-inky/60 hover:text-navy underline">
          {settingsOpen ? 'Hide' : 'Thresholds & Ignore List'}
        </button>
      </div>

      {settingsOpen && (
        <Card>
          <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Thresholds & Ignore List</span></CardHeader>
          <CardBody className="flex flex-col gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Adjustment threshold</label>
                <input type="number" value={checksConfig.adjustmentThreshold}
                  onChange={(e) => setChecksConfig({ ...checksConfig, adjustmentThreshold: Number(e.target.value) || 0 })}
                  className={fieldCls} />
                <p className="text-[10px] font-mono text-inky/50">Flag when |adjustment| exceeds this in a day.</p>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Tank variance threshold (qts)</label>
                <input type="number" value={checksConfig.tankVarianceThreshold}
                  onChange={(e) => setChecksConfig({ ...checksConfig, tankVarianceThreshold: Number(e.target.value) || 0 })}
                  className={fieldCls} />
                <p className="text-[10px] font-mono text-inky/50">Default — overridden per product/location once set below.</p>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Sale-with-zero-on-hand</label>
                <Toggle checked={checksConfig.zeroOnHandSaleEnabled}
                  onChange={(v) => setChecksConfig({ ...checksConfig, zeroOnHandSaleEnabled: v })}
                  color="green" size="sm" label={checksConfig.zeroOnHandSaleEnabled ? 'On' : 'Off'} />
              </div>
            </div>
            <p className="text-[10px] font-mono text-inky/50 -mt-2">
              Abnormal Receipt isn't available yet — Droptop's receiving change_type still needs to be confirmed via a diagnostic pull.
            </p>

            <div className="border-t border-navy/10 pt-3 flex flex-col gap-3">
              <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Ignore List</span>
              <div className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/70">
                    <input type="checkbox" checked={excAllShops} onChange={(e) => { setExcAllShops(e.target.checked); if (e.target.checked) setExcLocationId('') }} className="accent-sky" />
                    All shops
                  </label>
                  {!excAllShops && <div className="w-44"><Combobox options={loc.options} value={excLocationId} onChange={setExcLocationId} placeholder="Shop…" /></div>}
                </div>
                <select value={excCheckType} onChange={(e) => setExcCheckType(e.target.value)} className={fieldCls}>
                  {CHECK_TYPES.map((ct) => <option key={ct} value={ct}>{CHECK_TYPE_LABELS[ct]}</option>)}
                </select>
                <input value={excProductId} onChange={(e) => setExcProductId(e.target.value)} placeholder="Product ID" className={`${fieldCls} w-36`} />
                <input value={excNote} onChange={(e) => setExcNote(e.target.value)} placeholder="Note (optional)" className={`${fieldCls} flex-1 min-w-[140px]`} />
                <Button size="sm" onClick={addExclusion} disabled={!excProductId.trim() || (!excAllShops && !excLocationId)}>Add</Button>
              </div>
              {exclusions.length === 0 ? (
                <p className="text-xs font-mono text-inky/40 italic">Nothing ignored yet.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {exclusions.map((e) => (
                    <div key={e.id} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1 text-xs font-mono">
                      <span className="text-navy w-40 truncate">{e.location_id ? loc.labelOf(e.location_id) : 'All Shops'}</span>
                      <span className="text-navy w-28 truncate">{e.product_id}</span>
                      <span className="text-inky/60 w-40 truncate">{CHECK_TYPE_LABELS[e.check_type] ?? e.check_type}</span>
                      <span className="text-inky/60 flex-1 truncate">{e.note || '—'}</span>
                      <button onClick={() => removeExclusion(e.id)} className="text-inky/50 hover:text-red-500 text-sm leading-none flex-shrink-0">×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardBody>
        </Card>
      )}

      {openTankVariance.length > 0 && (
        <Card className="border-[#E67E22]/40">
          <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Tank Variance — Needs a Baseline Decision</span></CardHeader>
          <CardBody className="flex flex-col gap-2">
            <p className="text-[11px] font-mono text-inky/60">
              After a shop/AM confirms a variance is a real new baseline (not a problem), set it here so it stops re-flagging.
            </p>
            {openTankVariance.map((r) => {
              const m = r.metadata as any
              return (
                <div key={r.id} className="flex items-center gap-3 rounded border border-navy/15 px-2 py-1.5 text-xs font-mono">
                  <span className="text-navy w-40 truncate">{shopLabel(r.location_id)}</span>
                  <span className="text-navy w-28 truncate">{m?.product_id}</span>
                  <span className="text-inky/60 flex-1">
                    Tank {m?.tank_on_hand} vs Droptop {m?.droptop_on_hand} (Δ{m?.variance_qts?.toFixed?.(1) ?? m?.variance_qts})
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => setBaselineRow(r)}>Set Baseline</Button>
                </div>
              )
            })}
          </CardBody>
        </Card>
      )}

      {rows.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-8">No automated flags yet. Run Automated Checks from Config → Data Connections, or wait for its daily schedule.</p>
      ) : (
        <ExceptionTable rows={rows} config={config} shopLabel={shopLabel} regionalDirector={regionalDirector}
          companyId={companyId} onSet={onSet} onEdit={onEdit} onQuick={onQuick} />
      )}

      <BaselineModal
        row={baselineRow}
        companyId={companyId}
        onClose={() => setBaselineRow(null)}
        onSaved={() => { setBaselineRow(null) }}
      />
    </div>
  )
}

function BaselineModal({ row, companyId, onClose, onSaved }: {
  row: ExceptionReport | null
  companyId: string | null
  onClose: () => void
  onSaved: () => void
}) {
  const { profile } = useAuthStore()
  const [variance, setVariance] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (row) { setVariance(String((row.metadata as any)?.variance_qts ?? '')); setNote('') }
  }, [row])

  if (!row) return null
  const m = row.metadata as any

  async function save() {
    const v = Number(variance)
    if (!variance.trim() || isNaN(v) || v < 0) { toast.error('Enter a valid variance'); return }
    setSaving(true)
    const { error } = await (supabase as any).schema('inventory').from('tank_variance_overrides').upsert({
      company_id: companyId,
      location_id: row!.location_id,
      product_id: m.product_id,
      tank_serials: m.tank_serial ? [m.tank_serial] : [],
      variance_qts: v,
      note: note.trim() || null,
      set_by: profile?.id ?? null,
      set_at: new Date().toISOString(),
    }, { onConflict: 'company_id,location_id,product_id' })
    setSaving(false)
    if (error) { toast.error(error.message); return }
    toast.success('New baseline set')
    onSaved()
  }

  return (
    <Modal open={!!row} onClose={onClose} title="Set New Variance Baseline" size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-mono text-inky/70">
          {m.product_id} — current variance was {m.variance_qts?.toFixed?.(1) ?? m.variance_qts} qts (threshold {m.threshold}).
        </p>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">New accepted variance (qts)</label>
          <input type="number" min={0} value={variance} onChange={(e) => setVariance(e.target.value)} className={fieldCls} />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Note (optional)</label>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Confirmed with shop — tank runs low" className={fieldCls} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={save}>Save Baseline</Button>
        </div>
      </div>
    </Modal>
  )
}
