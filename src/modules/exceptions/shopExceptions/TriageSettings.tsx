// Thresholds for the five automatic exceptions plus the ignore list (a product, optionally at one shop, never flagged for a given check).
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardBody, CardHeader, Combobox, MultiSelectDropdown, Toggle } from '@/components/ui'
import { ExceptionTile, TYPE_META, TYPE_ORDER, type ShopExceptionType } from './shopExceptionTypes'

interface ChecksConfig {
  adjustmentThreshold: number
  zeroOnHandSaleEnabled: boolean
  duplicateToleranceQts: number
  poGraceDays: number
  poSuppliers: string[]
  trackFrom: string
  poMoveDaysLate: number
  poMoveDaysCreated: number
  adjustmentThresholdNegative?: number
  zeroOnHandRecentDays: number
  categories: string[]
  enabled: Partial<Record<ShopExceptionType, boolean>>
  severity: Partial<Record<ShopExceptionType, number>>
}
const DEFAULT_CONFIG: ChecksConfig = { adjustmentThreshold: 50, zeroOnHandSaleEnabled: true, duplicateToleranceQts: 40, poGraceDays: 2, poSuppliers: ['RelaDyne', 'Valvoline'], trackFrom: '2026-10-07', poMoveDaysLate: 14, poMoveDaysCreated: 0, zeroOnHandRecentDays: 3, categories: ['Engine Oil', 'Engine Oil Additive'], enabled: {}, severity: {} }
// Matches the Edge Function's own defaults (BASE_SEVERITY in detect.ts).
const DEFAULT_SEVERITY: Record<ShopExceptionType, number> = { po_late: 2, zero_sales: 3, adj_positive: 2, adj_negative: 3, duplicate_case: 3 }
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
  const isOn = (t: ShopExceptionType) => cfg.enabled?.[t] ?? (t === 'zero_sales' ? cfg.zeroOnHandSaleEnabled : true)
  const sevOf = (t: ShopExceptionType) => cfg.severity?.[t] ?? DEFAULT_SEVERITY[t]
  // The categories on file (plus anything already selected) for the picker.
  const [allCategories, setAllCategories] = useState<string[]>([])
  useEffect(() => {
    if (!companyId) return
    void (async () => {
      const { data } = await (supabase as any).rpc('get_product_usage_category_counts')
      setAllCategories(((data ?? []) as { category: string }[]).map((r) => r.category).filter(Boolean).sort())
    })()
  }, [companyId])
  const categoryOptions = [...new Set([...allCategories, ...(cfg.categories ?? [])])].sort().map((value) => ({ value }))

  return (
    <Card>
      <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Thresholds & ignore list</span></CardHeader>
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Checks</span>
          {TYPE_ORDER.map((t) => (
            <div key={t} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-navy/15 px-3 py-2">
              <span className="flex items-center gap-2 w-60 flex-none">
                <ExceptionTile type={t} size={26} />
                <span className="text-xs font-body font-bold text-navy">{TYPE_META[t].label}</span>
              </span>
              <Toggle checked={isOn(t)} onChange={(v) => save({ ...cfg, enabled: { ...cfg.enabled, [t]: v } })} color="green" size="sm" label={isOn(t) ? 'On' : 'Off'} />
              <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky uppercase tracking-wide">Priority
                <select className={fieldCls} value={sevOf(t)} onChange={(e) => save({ ...cfg, severity: { ...cfg.severity, [t]: Number(e.target.value) } })}>
                  <option value={3}>High</option><option value={2}>Medium</option><option value={1}>Low</option>
                </select>
              </label>
              <span className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-mono text-navy ${isOn(t) ? '' : 'opacity-40 pointer-events-none'}`}>
                {t === 'zero_sales' && <label className="flex items-center gap-1.5">Sold within the last <input type="number" className={`${fieldCls} w-16`} value={cfg.zeroOnHandRecentDays} onChange={(e) => num('zeroOnHandRecentDays', e.target.value)} /> days</label>}
                {t === 'adj_positive' && <label className="flex items-center gap-1.5">More than <input type="number" className={`${fieldCls} w-20`} value={cfg.adjustmentThreshold} onChange={(e) => num('adjustmentThreshold', e.target.value)} /> qts up in a day</label>}
                {t === 'adj_negative' && <label className="flex items-center gap-1.5">More than <input type="number" className={`${fieldCls} w-20`} value={cfg.adjustmentThresholdNegative ?? cfg.adjustmentThreshold} onChange={(e) => num('adjustmentThresholdNegative', e.target.value)} /> qts down in a day</label>}
                {t === 'duplicate_case' && <label className="flex items-center gap-1.5">Only when within <input type="number" className={`${fieldCls} w-20`} value={cfg.duplicateToleranceQts} onChange={(e) => num('duplicateToleranceQts', e.target.value)} /> qts of each other</label>}
                {t === 'po_late' && (
                  <>
                    <label className="flex items-center gap-1.5">Flag <input type="number" className={`${fieldCls} w-16`} value={cfg.poGraceDays} onChange={(e) => num('poGraceDays', e.target.value)} /> days after the expected delivery</label>
                    {SUPPLIERS.map((sp) => (
                      <label key={sp} className="flex items-center gap-1.5 cursor-pointer">
                        <input type="checkbox" className="accent-sky" checked={cfg.poSuppliers.includes(sp)} onChange={(e) => save({ ...cfg, poSuppliers: e.target.checked ? [...new Set([...cfg.poSuppliers, sp])] : cfg.poSuppliers.filter((x) => x !== sp) })} />{sp}
                      </label>
                    ))}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Track activity from
            <input type="date" className={fieldCls} value={cfg.trackFrom} onChange={(e) => e.target.value && save({ ...cfg, trackFrom: e.target.value })} />
            <span className="normal-case tracking-normal text-inky/60">Nothing dated before this is flagged: adjustments, sales at zero, and POs due before it.</span>
          </label>
          <div className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Product categories checked
            <MultiSelectDropdown options={categoryOptions} selected={cfg.categories} onChange={(v) => v.length && save({ ...cfg, categories: v })} placeholder="Categories" showAllOption={false} countNoun="categories" />
            <span className="normal-case tracking-normal text-inky/60">Adjustments and sales at zero only look at these (duplicates look at what each shop orders).</span>
          </div>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">Move a PO to Late POs after (days late)
            <input type="number" className={fieldCls} value={cfg.poMoveDaysLate} onChange={(e) => num('poMoveDaysLate', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">0 = off. Counted from the expected delivery day.</span>
          </label>
          <label className="flex flex-col gap-1 text-[10px] font-mono text-inky uppercase tracking-wide">...or after (days since created)
            <input type="number" className={fieldCls} value={cfg.poMoveDaysCreated} onChange={(e) => num('poMoveDaysCreated', e.target.value)} />
            <span className="normal-case tracking-normal text-inky/60">0 = off. Whichever limit is hit first moves it. It leaves the shop's triage and goes to the Late POs - Not Received tab, where you close it.</span>
          </label>
        </div>
        <p className="text-[10px] font-mono text-inky/60 -mt-2">Every change here is read by the checks on their next run (Run checks now, or the Data Connections schedule). Turning a check off resolves its open exceptions on that run.</p>

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
