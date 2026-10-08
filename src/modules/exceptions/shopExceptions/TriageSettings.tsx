// Thresholds for the five automatic exceptions plus the ignore list (a product, optionally at one shop, never flagged for a given check).
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardBody, CardHeader, Combobox, Toggle } from '@/components/ui'

interface ChecksConfig {
  adjustmentThreshold: number
  zeroOnHandSaleEnabled: boolean
  duplicateToleranceQts: number
  poGraceDays: number
  poSuppliers: string[]
  trackFrom: string
  poMoveDaysLate: number
  poMoveDaysCreated: number
}
const DEFAULT_CONFIG: ChecksConfig = { adjustmentThreshold: 50, zeroOnHandSaleEnabled: true, duplicateToleranceQts: 40, poGraceDays: 2, poSuppliers: ['RelaDyne', 'Valvoline'], trackFrom: '2026-10-07', poMoveDaysLate: 14, poMoveDaysCreated: 0 }
const SUPPLIERS = ['RelaDyne', 'Valvoline']

// check_type values the Edge Function reads exclusions with.
const CHECK_TYPE_LABELS: Record<string, string> = {
  zero_on_hand_sale: 'Selling at zero on hand',
  abnormal_adjustment: 'Large adjustments (+ and −)',
  duplicate_case_types: 'Duplicate case types',
}
const CHECK_TYPES = Object.keys(CHECK_TYPE_LABELS)
interface Exclusion { id: string; location_id: string | null; product_id: string | null; check_type: string; note: string | null }

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-sky'

export function TriageSettings() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [saved, save] = useAppSetting<ChecksConfig>('automated_checks_config', DEFAULT_CONFIG)
  const cfg: ChecksConfig = { ...DEFAULT_CONFIG, ...saved }
  const [exclusions, setExclusions] = useState<Exclusion[]>([])
  const [allShops, setAllShops] = useState(true)
  const [locationId, setLocationId] = useState('')
  const [checkType, setCheckType] = useState(CHECK_TYPES[0])
  const [productId, setProductId] = useState('')
  const [note, setNote] = useState('')

  const load = async () => {
    if (!companyId) return
    const { data } = await (supabase as any).schema('inventory').from('automated_check_exclusions').select('*').eq('company_id', companyId)
    setExclusions((data ?? []) as Exclusion[])
  }
  useEffect(() => { void load() }, [companyId])

  async function add() {
    if (!productId.trim() || (!allShops && !locationId)) return
    const { error } = await (supabase as any).schema('inventory').from('automated_check_exclusions').insert({
      company_id: companyId, location_id: allShops ? null : locationId, product_id: productId.trim(), check_type: checkType, note: note.trim() || null, created_by: profile?.id ?? null,
    })
    if (error) { toast.error(error.message); return }
    setProductId(''); setNote(''); void load()
  }
  async function remove(id: string) {
    await (supabase as any).schema('inventory').from('automated_check_exclusions').delete().eq('id', id)
    void load()
  }
  const num = (k: keyof ChecksConfig, v: string) => save({ ...cfg, [k]: Math.max(0, Number(v) || 0) })

  return (
    <Card>
      <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Thresholds & ignore list</span></CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Large adjustment (qts)
            <input type="number" className={fieldCls} value={cfg.adjustmentThreshold} onChange={(e) => num('adjustmentThreshold', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">An adjustment bigger than this in a day, up or down.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Duplicate case types — "close" (qts)
            <input type="number" className={fieldCls} value={cfg.duplicateToleranceQts} onChange={(e) => num('duplicateToleranceQts', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">Within this many qts of each other = high; further apart = low.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">PO grace (days)
            <input type="number" className={fieldCls} value={cfg.poGraceDays} onChange={(e) => num('poGraceDays', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">Days past the expected delivery before a PO is flagged.</span>
          </label>
          <div className="flex flex-col gap-1.5 text-[10px] font-mono text-inky uppercase tracking-wide">
            Selling at zero on hand
            <Toggle checked={cfg.zeroOnHandSaleEnabled} onChange={(v) => save({ ...cfg, zeroOnHandSaleEnabled: v })} color="green" size="sm" label={cfg.zeroOnHandSaleEnabled ? 'On' : 'Off'} />
            <span className="mt-1">PO suppliers checked</span>
            <div className="flex gap-3 normal-case tracking-normal">
              {SUPPLIERS.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-xs text-navy cursor-pointer">
                  <input type="checkbox" className="accent-sky" checked={cfg.poSuppliers.includes(s)} onChange={(e) => save({ ...cfg, poSuppliers: e.target.checked ? [...new Set([...cfg.poSuppliers, s])] : cfg.poSuppliers.filter((x) => x !== s) })} />{s}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Track activity from
            <input type="date" className={fieldCls} value={cfg.trackFrom} onChange={(e) => e.target.value && save({ ...cfg, trackFrom: e.target.value })} />
            <span className="normal-case tracking-normal text-inky/60">Nothing dated before this is flagged: adjustments, sales at zero, and POs due before it.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Move a PO to Late POs after (days late)
            <input type="number" className={fieldCls} value={cfg.poMoveDaysLate} onChange={(e) => num('poMoveDaysLate', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">0 = off. Counted from the expected delivery day.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">...or after (days since created)
            <input type="number" className={fieldCls} value={cfg.poMoveDaysCreated} onChange={(e) => num('poMoveDaysCreated', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">0 = off. Whichever limit is hit first moves it. It leaves the shop's triage and goes to the Late POs - Not Received tab, where you close it.</span>
          </label>
        </div>
        <p className="text-[10px] font-mono text-inky/60 -mt-2">Changes apply on the next run. Priorities are fixed: zero on hand and large negative adjustments are high, POs and large positive adjustments medium, duplicate case types high or low by quantity.</p>

        <div className="border-t border-navy/10 pt-3 flex flex-col gap-3">
          <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Ignore list</span>
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/70">
                <input type="checkbox" className="accent-sky" checked={allShops} onChange={(e) => { setAllShops(e.target.checked); if (e.target.checked) setLocationId('') }} />All shops
              </label>
              {!allShops && <div className="w-44"><Combobox options={loc.options} value={locationId} onChange={setLocationId} placeholder="Shop…" /></div>}
            </div>
            <select value={checkType} onChange={(e) => setCheckType(e.target.value)} className={fieldCls}>
              {CHECK_TYPES.map((ct) => <option key={ct} value={ct}>{CHECK_TYPE_LABELS[ct]}</option>)}
            </select>
            <input value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="Product ID" className={`${fieldCls} w-36`} />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${fieldCls} flex-1 min-w-[140px]`} />
            <Button size="sm" onClick={() => void add()} disabled={!productId.trim() || (!allShops && !locationId)}>Add</Button>
          </div>
          {exclusions.length === 0 ? <p className="text-xs font-mono text-inky/40 italic">Nothing ignored yet.</p> : (
            <div className="flex flex-col gap-1">
              {exclusions.map((x) => (
                <div key={x.id} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1 text-xs font-mono">
                  <span className="text-navy w-40 truncate">{x.location_id ? loc.labelOf(x.location_id) : 'All shops'}</span>
                  <span className="text-navy w-28 truncate">{x.product_id}</span>
                  <span className="text-inky/60 w-48 truncate">{CHECK_TYPE_LABELS[x.check_type] ?? x.check_type}</span>
                  <span className="text-inky/60 flex-1 truncate">{x.note || '—'}</span>
                  <button onClick={() => void remove(x.id)} className="text-inky/50 hover:text-[#C0392B] text-sm leading-none flex-shrink-0">×</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  )
}
