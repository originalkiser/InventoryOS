import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Input, Toggle, Badge, Card, CardHeader, CardBody } from '@/components/ui'
import { RECOUNT_FLAG_LABELS, RECOUNT_FLAG_DESCRIPTIONS } from '@/lib/recountEngine'
import {
  fetchPeriodEvalData, evaluateCounts, draftToConfig, fetchTankVarianceCandidates,
  type PeriodEvalData, type DraftThresholds, type TankVarianceCandidate, type EvaluatedCount,
} from './recountData'
import { locationLabel } from './countsShared'
import { ProductOnHandExceptionsPanel } from './ProductOnHandExceptionsPanel'
import { TANK_VARIANCE_KEY, UNLISTED_LIMIT_KEY, DEFAULT_TANK_VARIANCE } from '@/modules/config/tabs/CategoryExpectationsTab'
import type { RecountConfig, Location } from '@/types'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const DEFAULT_LOOKBACK = 6

function flagsToReason(flags: string[]): string {
  if (flags.includes('high_ending_balance')) return 'End balance too high'
  if (flags.includes('low_ending_balance')) return 'End balance too low'
  if (flags.includes('low_adjustments')) return 'Too few adjustments'
  if (flags.includes('high_adjustments')) return 'Too many adjustments'
  if (flags.includes('low_oil_adjustments')) return 'Too few oil adjustments'
  if (flags.includes('high_oil_adjustments')) return 'Too many oil adjustments'
  if (flags.includes('variance_vs_median')) return 'Unexpected ending balance'
  if (flags.includes('variance_vs_last_month')) return 'Unexpected ending balance'
  if (flags.includes('tank_monitor_variance')) return 'Tank monitor variance'
  if (flags.includes('unconfigured_oil')) return 'Oil on hand, not configured to order'
  return flags.join(', ')
}

function numOrNull(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

// Drops any (location, product) pair marked hidden from a shop-keyed map —
// used to make hidden products stop driving flags/recount generation while
// leaving the raw map (still used for display) untouched.
function omitHiddenProducts<T extends { product_id: string }>(
  map: Map<string, T[]>,
  hidden: Map<string, Set<string>>,
): Map<string, T[]> {
  if (hidden.size === 0) return map
  const out = new Map<string, T[]>()
  for (const [locId, rows] of map) {
    const hiddenSet = hidden.get(locId)
    const remaining = hiddenSet ? rows.filter((r) => !hiddenSet.has(r.product_id)) : rows
    // Omit the key entirely once nothing's left, so .has(locId) correctly
    // reads as "no longer flagged" instead of "flagged with zero products."
    if (remaining.length > 0) out.set(locId, remaining)
  }
  return out
}

// Which flag source hit a product in the preview table's Products cell, and
// the color used to border that chip — restricted to the CLAUDE.md-approved
// off-palette colors (red/green/orange) since none of the brand tokens are
// distinct enough from each other for this purpose.
type FlagType = 'exception' | 'tank' | 'oil'
const FLAG_COLORS: Record<FlagType, string> = {
  exception: '#C0392B', // sb-red — product/category range exception
  tank: '#2ECC71',      // sb-green — tank monitor variance
  oil: '#E67E22',       // sb-orange — oil on hand, not configured to order
}
const FLAG_ORDER: FlagType[] = ['exception', 'tank', 'oil']

// A product hit by more than one flag type gets its border split into equal
// color segments (one per flag) via a hard-stop border-image gradient,
// instead of picking just one color to show.
function splitBorderStyle(types: Set<FlagType>): React.CSSProperties {
  const active = FLAG_ORDER.filter((t) => types.has(t))
  if (active.length === 0) return { borderWidth: 1, borderStyle: 'solid', borderColor: 'rgba(0,39,69,0.2)' }
  if (active.length === 1) return { borderWidth: 2, borderStyle: 'solid', borderColor: FLAG_COLORS[active[0]] }
  const step = 100 / active.length
  const stops = active.map((t, i) => `${FLAG_COLORS[t]} ${i * step}% ${(i + 1) * step}%`).join(', ')
  return { borderWidth: 2, borderStyle: 'solid', borderImage: `linear-gradient(to right, ${stops}) 1` }
}

// Same three flag colors as the product-chip borders above, so a shop's
// Flags badges visually match the product(s) driving each one. Hover a
// badge for the full explanation — the label itself stays short.
const FLAG_BADGE_COLOR: Record<string, 'red' | 'green' | 'orange' | 'amber'> = {
  tank_monitor_variance: 'green',
  unconfigured_oil: 'orange',
  product_range_exception: 'red',
}
function FlagBadge({ flag }: { flag: string }) {
  const color = FLAG_BADGE_COLOR[flag] ?? (flag.startsWith('variance') || flag.startsWith('high') ? 'red' : 'amber')
  return (
    <span title={RECOUNT_FLAG_DESCRIPTIONS[flag]}>
      <Badge color={color}>{RECOUNT_FLAG_LABELS[flag] ?? flag}</Badge>
    </span>
  )
}

const FLAG_TYPE_TO_FLAG_KEY: Record<FlagType, string> = {
  exception: 'product_range_exception',
  tank: 'tank_monitor_variance',
  oil: 'unconfigured_oil',
}

// Same base-product-id convention as get_product_expectation_exceptions'
// oil case-type inference: a trailing run of letters marks the case type
// (bulk/drum/package variant), the leading part is the product family.
function baseProductId(id: string): string {
  const stripped = id.replace(/[A-Z]+$/i, '')
  return stripped || id
}

// Fetches "equivalent" on-hand — other case types of the same product family
// at the same shop/period — only when actually hovered, scoped to one
// location via the composite index on count_products, rather than loading
// every product's siblings up front.
function ProductChip({
  productId, qty, types, hidden, locationId, companyId, countMonth, onToggleHide,
}: {
  productId: string
  qty: number
  types: Set<FlagType>
  hidden: boolean
  locationId: string | null
  companyId: string
  countMonth: string
  onToggleHide: () => void
}) {
  const [equiv, setEquiv] = useState<{ product_id: string; on_hand: number }[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [show, setShow] = useState(false)

  async function loadEquiv() {
    if (equiv != null || loading || !locationId) return
    setLoading(true)
    const base = baseProductId(productId)
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('count_products')
      .select('product_id, on_hand, created_at')
      .eq('company_id', companyId).eq('count_month', countMonth).eq('location_id', locationId)
      .ilike('product_id', `${base}%`)
      .order('created_at', { ascending: false })
      .limit(200)
    const latest = new Map<string, number>()
    for (const r of (data ?? []) as { product_id: string; on_hand: number | null }[]) {
      if (!latest.has(r.product_id)) latest.set(r.product_id, r.on_hand ?? 0)
    }
    latest.delete(productId)
    setEquiv([...latest.entries()].map(([product_id, on_hand]) => ({ product_id, on_hand })).sort((a, b) => a.product_id.localeCompare(b.product_id)))
    setLoading(false)
  }

  return (
    <span className="relative inline-block" onMouseEnter={() => { setShow(true); loadEquiv() }} onMouseLeave={() => setShow(false)}>
      <button
        onClick={onToggleHide}
        style={hidden ? undefined : splitBorderStyle(types)}
        className={[
          'rounded px-1.5 py-0.5 transition-colors',
          hidden ? 'border border-navy/10 text-inky/30 line-through hover:text-inky/60' : 'text-inky hover:text-[#C0392B]',
        ].join(' ')}
      >
        {productId} <span className="opacity-70">({fmt(qty)})</span>
      </button>
      {show && (
        <div className="absolute z-50 top-full left-0 mt-1 min-w-[180px] max-w-[260px] rounded border border-navy/30 bg-cream dark:bg-[#0e2638] shadow-xl px-2 py-1.5 text-[11px] font-mono text-navy dark:text-[#F2F1E6]">
          <div className="text-inky/70 mb-1">
            {hidden ? 'Hidden from this recount' : `Flagged by: ${[...types].map((t) => RECOUNT_FLAG_LABELS[FLAG_TYPE_TO_FLAG_KEY[t]]).join(', ')}`}
          </div>
          <div className="text-inky/50 uppercase tracking-wide text-[9px] mb-1 pt-1 border-t border-navy/10">Other case types on hand</div>
          {loading ? (
            <span className="text-inky/50 italic">Loading…</span>
          ) : !equiv || equiv.length === 0 ? (
            <span className="text-inky/50 italic">None found</span>
          ) : (
            <div className="flex flex-col gap-0.5">
              {equiv.map((r) => (
                <div key={r.product_id} className="flex justify-between gap-3">
                  <span>{r.product_id}</span>
                  <span className="font-bold">{fmt(r.on_hand)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  )
}

interface ProductExceptionRow {
  location_id: string
  product_id: string
  category: string | null
  basis: string
  on_hand: number
  expected_limit: number
}

interface OilOnHandRow {
  location_id: string
  product_id: string
  category: string | null
  on_hand: number
}

export function RecountLogicTab() {
  const { profile } = useAuthStore()
  const { getCountMonth, setRecountConfig } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [configId, setConfigId] = useState<string | null>(null)

  // Rule enable toggles
  const [adjEnabled, setAdjEnabled] = useState(false)
  const [oilAdjEnabled, setOilAdjEnabled] = useState(false)
  const [balEnabled, setBalEnabled] = useState(false)
  const [varMedEnabled, setVarMedEnabled] = useState(false)
  const [varLastEnabled, setVarLastEnabled] = useState(false)
  const [tankVarEnabled, setTankVarEnabled] = useState(false)
  const [oilCheckEnabled, setOilCheckEnabled] = useState(false)
  // Master switch: skip Adjustment Count / Oil Adjustment Count / Ending
  // Balance / Variance vs Median / Variance vs Last Month entirely,
  // regardless of each rule's own toggle/thresholds above (kept, not
  // cleared, so turning this back off restores them as they were).
  const [ignoreEndingBalance, setIgnoreEndingBalance] = useState(false)

  // Threshold inputs (strings)
  const [lowAdj, setLowAdj] = useState('')
  const [highAdj, setHighAdj] = useState('')
  const [lowOilAdj, setLowOilAdj] = useState('')
  const [highOilAdj, setHighOilAdj] = useState('')
  const [lowBal, setLowBal] = useState('')
  const [highBal, setHighBal] = useState('')
  const [varMed, setVarMed] = useState('')
  const [varLast, setVarLast] = useState('')
  const [tankVarQts, setTankVarQts] = useState('')
  const [lookback, setLookback] = useState(String(DEFAULT_LOOKBACK))

  // Per-rule threshold types
  const [varMedThresholdType, setVarMedThresholdType] = useState<'percentage' | 'dollar'>('percentage')
  const [varLastThresholdType, setVarLastThresholdType] = useState<'percentage' | 'dollar'>('percentage')
  // Retained (hidden) global settings — still saved so existing data isn't lost
  const [compMethod] = useState<'median' | 'mean'>('median')
  const [eligibleCountTypes] = useState<string[]>([])
  const [completionMaxAdj] = useState('')

  const [evalData, setEvalData] = useState<PeriodEvalData | null>(null)
  const [tankCandidates, setTankCandidates] = useState<TankVarianceCandidate[]>([])
  const [productExceptions, setProductExceptions] = useState<ProductExceptionRow[]>([])
  const [oilOnHandRows, setOilOnHandRows] = useState<OilOnHandRow[]>([])
  const [tankProductMap] = useAppSetting<Record<string, string>>('tank_product_map', {})
  const [tankVariance] = useAppSetting<number>(TANK_VARIANCE_KEY, DEFAULT_TANK_VARIANCE)
  const [unlistedLimit] = useAppSetting<number | null>(UNLISTED_LIMIT_KEY, null)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [autoSaveStatus, setAutoSaveStatus] = useState<'idle' | 'pending' | 'saved'>('idle')

  // Per-period workflow state: hide one product from a shop's recount
  // consideration, dismiss a whole shop for this period, or set it aside to
  // revisit later — all persisted so the whole team sees the same state.
  const [hiddenProducts, setHiddenProducts] = useState<Map<string, Set<string>>>(new Map())
  const [excludedShops, setExcludedShops] = useState<Set<string>>(new Set())
  const [flaggedLaterShops, setFlaggedLaterShops] = useState<Set<string>>(new Set())
  const [varianceRedThreshold, setVarianceRedThreshold] = useState('7500')
  const [flaggedLaterExpanded, setFlaggedLaterExpanded] = useState(false)
  const hasLoadedRef = useRef(false)
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout>>()

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
      setOilAdjEnabled(c.oil_low_adj_threshold != null || c.oil_high_adj_threshold != null)
      setBalEnabled(c.low_balance_threshold != null || c.high_balance_threshold != null)
      setVarMedEnabled(c.variance_to_median_pct != null)
      setVarLastEnabled(c.variance_to_last_month_pct != null)
      setTankVarEnabled(c.tank_variance_qts_threshold != null)
      setTankVarQts(c.tank_variance_qts_threshold?.toString() ?? '')
      setOilCheckEnabled(c.oil_check_enabled ?? false)
      setIgnoreEndingBalance(c.ignore_ending_balance ?? false)
      setLowAdj(c.low_adj_threshold?.toString() ?? '')
      setHighAdj(c.high_adj_threshold?.toString() ?? '')
      setLowOilAdj(c.oil_low_adj_threshold?.toString() ?? '')
      setHighOilAdj(c.oil_high_adj_threshold?.toString() ?? '')
      setLowBal(c.low_balance_threshold?.toString() ?? '')
      setHighBal(c.high_balance_threshold?.toString() ?? '')
      setVarMed(c.variance_to_median_pct?.toString() ?? '')
      setVarLast(c.variance_to_last_month_pct?.toString() ?? '')
      setLookback((c.median_months_lookback ?? DEFAULT_LOOKBACK).toString())
      const legacyTT = (c as any).threshold_type ?? 'percentage'
      setVarMedThresholdType((c as any).var_med_threshold_type ?? legacyTT)
      setVarLastThresholdType((c as any).var_last_threshold_type ?? legacyTT)
      hasLoadedRef.current = true
    })()
  }, [companyId])

  // Auto-save debounced at 1.5s after any threshold change
  useEffect(() => {
    if (!hasLoadedRef.current || !companyId) return
    setAutoSaveStatus('pending')
    clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(async () => {
      const id = await saveLogic()
      if (id) {
        setAutoSaveStatus('saved')
        setTimeout(() => setAutoSaveStatus('idle'), 2000)
      } else {
        setAutoSaveStatus('idle')
      }
    }, 1500)
    return () => clearTimeout(autoSaveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adjEnabled, oilAdjEnabled, balEnabled, varMedEnabled, varLastEnabled, tankVarEnabled,
      oilCheckEnabled, ignoreEndingBalance,
      lowAdj, highAdj, lowOilAdj, highOilAdj, lowBal, highBal, varMed, varLast, tankVarQts,
      lookback, varMedThresholdType, varLastThresholdType])

  // Load period data for the live preview (once per period)
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    fetchPeriodEvalData(companyId, countMonth).then((d) => { if (!cancelled) setEvalData(d) })
    return () => { cancelled = true }
  }, [companyId, countMonth])

  // VMI tank readings vs. this period's counted on-hand — fetched once per
  // period; which pairs actually exceed the (possibly draft) threshold is
  // computed below so the preview still updates live as it's edited.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    fetchTankVarianceCandidates(companyId, countMonth, tankProductMap).then((d) => { if (!cancelled) setTankCandidates(d) })
    return () => { cancelled = true }
  }, [companyId, countMonth, tankProductMap])

  // Category-simplification / expected-on-hand exceptions — fetched once per
  // period (not just at generate time) so the live preview can show exactly
  // which flagged shops have a specific product driving the issue vs. which
  // need manual review, and Apply & Generate uses this same data rather than
  // a separate re-fetch that could disagree with what the preview showed.
  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    ;(supabase as any).rpc('get_product_expectation_exceptions', {
      p_company_id: companyId, p_count_month: countMonth,
      p_tank_variance: tankVariance ?? DEFAULT_TANK_VARIANCE, p_unlisted_limit: unlistedLimit ?? null,
    }).then(({ data, error }: any) => {
      if (cancelled) return
      if (error) { toast.error(`Could not load product exceptions — manual review split will be incomplete (${error.message})`); return }
      setProductExceptions((data ?? []) as ProductExceptionRow[])
    })
    return () => { cancelled = true }
  }, [companyId, countMonth, tankVariance, unlistedLimit])

  // Engine-oil on-hand with no location_order_config row for that shop —
  // fetched whenever the toggle is on, same "once per period" shape as the
  // fetches above. get_unconfigured_oil_on_hand already excludes anything
  // listed in product_on_hand_exceptions server-side.
  useEffect(() => {
    if (!companyId || !oilCheckEnabled) { setOilOnHandRows([]); return }
    let cancelled = false
    ;(supabase as any).rpc('get_unconfigured_oil_on_hand', {
      p_company_id: companyId, p_count_month: countMonth,
    }).then(({ data, error }: any) => {
      if (cancelled) return
      if (error) { toast.error(`Could not load unconfigured oil on-hand (${error.message})`); return }
      setOilOnHandRows((data ?? []) as OilOnHandRow[])
    })
    return () => { cancelled = true }
  }, [companyId, countMonth, oilCheckEnabled])

  // Per-period preview workflow state (hidden products, excluded shops,
  // flagged-for-later shops) — persisted so the whole team sees the same
  // state, not just whoever last touched the page.
  const loadPreviewActions = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await (supabase as any)
      .schema('inventory').from('recount_preview_actions')
      .select('location_id, product_id, action')
      .eq('company_id', companyId)
      .eq('count_month', countMonth)
    if (error) { toast.error(`Could not load recount workflow state (${error.message})`); return }
    const hidden = new Map<string, Set<string>>()
    const excluded = new Set<string>()
    const later = new Set<string>()
    for (const r of (data ?? []) as { location_id: string; product_id: string | null; action: string }[]) {
      if (r.action === 'hidden_product' && r.product_id) {
        if (!hidden.has(r.location_id)) hidden.set(r.location_id, new Set())
        hidden.get(r.location_id)!.add(r.product_id)
      } else if (r.action === 'excluded_shop') excluded.add(r.location_id)
      else if (r.action === 'flagged_later') later.add(r.location_id)
    }
    setHiddenProducts(hidden)
    setExcludedShops(excluded)
    setFlaggedLaterShops(later)
  }, [companyId, countMonth])
  useEffect(() => { loadPreviewActions() }, [loadPreviewActions])

  async function addPreviewAction(locationId: string, action: 'hidden_product' | 'excluded_shop' | 'flagged_later', productId: string | null = null) {
    if (!companyId) return
    const { error } = await (supabase as any).schema('inventory').from('recount_preview_actions')
      .upsert({ company_id: companyId, count_month: countMonth, location_id: locationId, product_id: productId, action, created_by: profile?.id ?? null },
        { onConflict: 'company_id,count_month,location_id,product_id,action' })
    if (error) { toast.error(error.message); return }
    await loadPreviewActions()
  }
  async function removePreviewAction(locationId: string, action: 'hidden_product' | 'excluded_shop' | 'flagged_later', productId: string | null = null) {
    if (!companyId) return
    const sb = (supabase as any).schema('inventory').from('recount_preview_actions')
      .delete().eq('company_id', companyId).eq('count_month', countMonth).eq('location_id', locationId).eq('action', action)
    const { error } = productId ? await sb.eq('product_id', productId) : await sb.is('product_id', null)
    if (error) { toast.error(error.message); return }
    await loadPreviewActions()
  }
  function toggleHideProduct(locationId: string, productId: string) {
    const isHidden = hiddenProducts.get(locationId)?.has(productId) ?? false
    if (isHidden) removePreviewAction(locationId, 'hidden_product', productId)
    else addPreviewAction(locationId, 'hidden_product', productId)
  }

  const lookbackN = numOrNull(lookback) ?? DEFAULT_LOOKBACK
  const tankVarThreshold = tankVarEnabled ? numOrNull(tankVarQts) : null

  // Shops with at least one VMI product whose tank reading is off from its
  // counted on-hand by more than the threshold. Gated to eligible shops —
  // count_products can exist (a Product Detail upload) for a shop that never
  // submitted a Monthly count or got marked accepted, and that shop should
  // stay off the recount list entirely, not get flagged from data with no
  // count behind it.
  const tankVarByShop = useMemo(() => {
    const m = new Map<string, TankVarianceCandidate[]>()
    if (tankVarThreshold == null || !evalData) return m
    for (const c of tankCandidates) {
      if (!evalData.eligibleLocationIds.has(c.location_id)) continue
      if (Math.abs(c.diff) <= tankVarThreshold) continue
      if (!m.has(c.location_id)) m.set(c.location_id, [])
      m.get(c.location_id)!.push(c)
    }
    return m
  }, [tankCandidates, tankVarThreshold, evalData])

  // Product-level expected-on-hand exceptions, same eligibility gate as tank
  // variance above. Enrichment only (per design) — never flags a shop on its
  // own, only supplies the "specific product" detail for shops the rules
  // above already flagged, and determines the manual-review split below.
  const exceptionsByShop = useMemo(() => {
    const m = new Map<string, ProductExceptionRow[]>()
    if (!evalData) return m
    for (const r of productExceptions) {
      if (!evalData.eligibleLocationIds.has(r.location_id)) continue
      if (!m.has(r.location_id)) m.set(r.location_id, [])
      m.get(r.location_id)!.push(r)
    }
    return m
  }, [productExceptions, evalData])

  // Engine-oil on-hand not configured to order, same eligibility gate as the
  // others. Independent flag — same as tank variance, not enrichment-only —
  // since "on hand at this shop with no order config" is itself a specific,
  // actionable product-level finding, not just a detail to attach to a flag
  // some other rule already raised.
  const oilFlagsByShop = useMemo(() => {
    const m = new Map<string, OilOnHandRow[]>()
    if (!evalData || !oilCheckEnabled) return m
    for (const r of oilOnHandRows) {
      if (!evalData.eligibleLocationIds.has(r.location_id)) continue
      if (!m.has(r.location_id)) m.set(r.location_id, [])
      m.get(r.location_id)!.push(r)
    }
    return m
  }, [oilOnHandRows, evalData, oilCheckEnabled])

  // "Effective" versions of the three maps above with hidden products
  // removed — used for flag/manual-review logic and recount generation, so
  // a hidden product stops driving anything. The raw maps above stay
  // untouched so the Products cell can still show a hidden product (dimmed,
  // click to restore) rather than making it disappear silently.
  const effTankVarByShop = useMemo(() => omitHiddenProducts(tankVarByShop, hiddenProducts), [tankVarByShop, hiddenProducts])
  const effExceptionsByShop = useMemo(() => omitHiddenProducts(exceptionsByShop, hiddenProducts), [exceptionsByShop, hiddenProducts])
  const effOilFlagsByShop = useMemo(() => omitHiddenProducts(oilFlagsByShop, hiddenProducts), [oilFlagsByShop, hiddenProducts])

  // Draft thresholds derived from current (unsaved) form state
  const draft: DraftThresholds = useMemo(() => ({
    low_adj_threshold: adjEnabled ? numOrNull(lowAdj) : null,
    high_adj_threshold: adjEnabled ? numOrNull(highAdj) : null,
    oil_low_adj_threshold: oilAdjEnabled ? numOrNull(lowOilAdj) : null,
    oil_high_adj_threshold: oilAdjEnabled ? numOrNull(highOilAdj) : null,
    low_balance_threshold: balEnabled ? numOrNull(lowBal) : null,
    high_balance_threshold: balEnabled ? numOrNull(highBal) : null,
    variance_to_median_pct: varMedEnabled ? numOrNull(varMed) : null,
    variance_to_last_month_pct: varLastEnabled ? numOrNull(varLast) : null,
    median_months_lookback: lookbackN,
    var_med_threshold_type: varMedThresholdType,
    var_last_threshold_type: varLastThresholdType,
  }), [adjEnabled, oilAdjEnabled, balEnabled, varMedEnabled, varLastEnabled, lowAdj, highAdj, lowOilAdj, highOilAdj, lowBal, highBal, varMed, varLast, lookbackN, varMedThresholdType, varLastThresholdType])

  // Pipeline over eligible shops only:
  //   1. Initial checks (adjustment count, ending balance, variance vs
  //      median/last month) — evaluateCounts, over this period's Monthly
  //      counts. Skipped entirely (flags cleared, but rows kept so tank/oil
  //      flags below still have somewhere to attach) when ignoreEndingBalance
  //      is on.
  //   2. Tank monitor variance, 3. unconfigured oil, and 4. product-range
  //      exceptions — each merged onto a shop's stage-1 entry if it has one,
  //      each contributing its own flag (tank_monitor_variance /
  //      unconfigured_oil / product_range_exception) so a shop hit by more
  //      than one still shows every applicable flag, not just one. For an
  //      eligible shop with no Monthly count row (accepted via Mark Counted,
  //      or a count_type mismatch) but a real tank/oil/exception finding,
  //      these are the only stages that can flag it, so it gets one shared
  //      synthetic entry rather than being silently dropped (or duplicated
  //      across separate ones).
  const evaluated = useMemo(() => {
    if (!evalData) return []
    const rawBase = evaluateCounts(evalData.counts, evalData.histByLoc, draftToConfig(draft), lookbackN)
    const base = ignoreEndingBalance ? rawBase.map((e) => ({ ...e, flags: [] as string[] })) : rawBase

    const withFlags = base.map((e) => {
      if (!e.locationId) return e
      const extra: string[] = []
      if (effTankVarByShop.has(e.locationId)) extra.push('tank_monitor_variance')
      if (effOilFlagsByShop.has(e.locationId)) extra.push('unconfigured_oil')
      if (effExceptionsByShop.has(e.locationId)) extra.push('product_range_exception')
      return extra.length ? { ...e, flags: [...e.flags, ...extra] } : e
    })

    const coveredLocIds = new Set(withFlags.map((e) => e.locationId).filter((id): id is string => !!id))
    const onlyLocIds = new Set(
      [...effTankVarByShop.keys(), ...effOilFlagsByShop.keys(), ...effExceptionsByShop.keys()]
        .filter((id) => !coveredLocIds.has(id) && evalData.eligibleLocationIds.has(id))
    )
    const synthetic: EvaluatedCount[] = [...onlyLocIds].map((locId) => {
      const flags: string[] = []
      if (effTankVarByShop.has(locId)) flags.push('tank_monitor_variance')
      if (effOilFlagsByShop.has(locId)) flags.push('unconfigured_oil')
      if (effExceptionsByShop.has(locId)) flags.push('product_range_exception')
      return { count: null, locationId: locId, prev: null, median: 0, varVsLastMonth: 0, varVsMedian: 0, flags }
    })
    return [...withFlags, ...synthetic]
  }, [evalData, draft, lookbackN, effTankVarByShop, effOilFlagsByShop, effExceptionsByShop, ignoreEndingBalance])

  const flagged = evaluated.filter((e) => e.flags.length > 0)

  // Split for generation: a flagged shop with no specific product driving it
  // (no tank-variance product, no unconfigured-oil product, no product-range
  // exception) can't say what to recount, so it's routed to manual review
  // instead of auto-generating an untargeted "Oil Recount". A
  // tank_monitor_variance or unconfigured_oil flag always implies product
  // detail by construction, so this split only ever pulls in shops flagged
  // purely by the dollar/count rules.
  // Excluded shops drop out of consideration entirely for this period.
  // Flagged-for-later shops move to their own section instead of either list
  // below, so they aren't forgotten but also aren't cluttering the active
  // preview or getting swept into Apply & Generate.
  const { flaggedWithProducts, manualReview, flaggedLater } = useMemo(() => {
    const withP: EvaluatedCount[] = []
    const manual: EvaluatedCount[] = []
    const later: EvaluatedCount[] = []
    for (const e of flagged) {
      if (e.locationId && excludedShops.has(e.locationId)) continue
      if (e.locationId && flaggedLaterShops.has(e.locationId)) { later.push(e); continue }
      const hasProduct = !!e.locationId && (
        (effTankVarByShop.get(e.locationId)?.length ?? 0) > 0 ||
        (effExceptionsByShop.get(e.locationId)?.length ?? 0) > 0 ||
        (effOilFlagsByShop.get(e.locationId)?.length ?? 0) > 0
      )
      ;(hasProduct ? withP : manual).push(e)
    }
    return { flaggedWithProducts: withP, manualReview: manual, flaggedLater: later }
  }, [flagged, effTankVarByShop, effExceptionsByShop, effOilFlagsByShop, excludedShops, flaggedLaterShops])
  const totalShops = evaluated.length

  async function saveLogic(): Promise<string | null> {
    if (!companyId) return null
    // Oil adjustment thresholds live behind migration 20260807 — save them
    // best-effort so an unapplied migration can't break the core recount config.
    const { oil_low_adj_threshold, oil_high_adj_threshold, ...core } = draft
    const payload = {
      company_id: companyId,
      ...core,
      var_med_threshold_type: varMedThresholdType,
      var_last_threshold_type: varLastThresholdType,
      threshold_type: varMedThresholdType,
      comparison_method: compMethod,
      eligible_count_types: eligibleCountTypes,
      completion_max_adjustment: numOrNull(completionMaxAdj),
    }
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
    // best-effort: columns from migrations that may not have run in prod yet
    if (savedId) {
      sb.schema('inventory').from('recount_config')
        .update({
          oil_low_adj_threshold, oil_high_adj_threshold, tank_variance_qts_threshold: tankVarThreshold,
          ignore_ending_balance: ignoreEndingBalance, oil_check_enabled: oilCheckEnabled,
        })
        .eq('id', savedId)
        .then(() => {})
    }
    setRecountConfig({
      id: savedId!, ...payload, oil_low_adj_threshold, oil_high_adj_threshold, tank_variance_qts_threshold: tankVarThreshold,
      ignore_ending_balance: ignoreEndingBalance, oil_check_enabled: oilCheckEnabled,
    } as unknown as RecountConfig)
    return savedId
  }

  async function handleSave() {
    setSaving(true)
    const id = await saveLogic()
    setSaving(false)
    if (id) toast.success('Recount logic saved')
  }

  function buildRecountRow(e: EvaluatedCount, today: string) {
    const catFlags = effExceptionsByShop.get(e.locationId!) ?? []
    const tankFlags = effTankVarByShop.get(e.locationId!) ?? []
    const oilFlags = effOilFlagsByShop.get(e.locationId!) ?? []
    const productFlags = [
      ...catFlags.map((x) => ({ source: 'category_limit' as const, product_id: x.product_id, category: x.category, basis: x.basis, reason: `${x.on_hand} on hand > ${x.expected_limit} ${x.basis} limit` })),
      ...tankFlags.map((x) => ({ source: 'tank_variance' as const, product_id: x.product_id, category: null, basis: 'tank_variance', reason: `tank ${x.tank_qts.toFixed(1)} qt vs ${x.on_hand.toFixed(1)} on hand (${x.diff > 0 ? '+' : ''}${x.diff.toFixed(1)} qt)` })),
      ...oilFlags.map((x) => ({ source: 'unconfigured_oil' as const, product_id: x.product_id, category: x.category, basis: 'unconfigured_oil', reason: `${x.on_hand} qt on hand, not configured to order at this shop` })),
    ]
    const requestedProducts = productFlags.map((p) => `${p.product_id} (${p.reason})`)
    return {
      company_id: companyId,
      location_id: e.locationId,
      recount_type: requestedProducts.length > 0 ? 'Partial Recount Products' : 'Oil Recount',
      requested_products: requestedProducts,
      request_date: today,
      recount_fields: {
        count_month: countMonth,
        source: 'auto',
        flags: e.flags,
        recount_reason: flagsToReason(e.flags),
        product_flags: productFlags,
      },
      completed_flags: [false],
      completed_dates: [null],
      recount_status: 'open',
    }
  }

  // Shared by the bulk "Apply & Generate" button and a single row's "Push to
  // Recounts" — same skip-if-already-exists behavior either way.
  async function generateForShops(shops: EvaluatedCount[]): Promise<{ created: number; alreadyHad: number }> {
    const withLoc = shops.filter((e) => e.locationId)
    if (withLoc.length === 0) return { created: 0, alreadyHad: 0 }

    const sb = supabase as any
    const { data: existing } = await sb.schema('inventory').from('recount_requests')
      .select('location_id, recount_fields')
      .eq('company_id', companyId)
      .filter('recount_fields->>count_month', 'eq', countMonth)
      .filter('recount_fields->>source', 'eq', 'auto')
    const already = new Set((existing ?? []).map((r: any) => r.location_id))

    const today = format(new Date(), 'yyyy-MM-dd')
    const rows = withLoc.filter((e) => !already.has(e.locationId)).map((e) => buildRecountRow(e, today))
    if (rows.length === 0) return { created: 0, alreadyHad: withLoc.length }

    const { error } = await sb.schema('inventory').from('recount_requests').insert(rows)
    if (error) throw new Error(error.message)
    return { created: rows.length, alreadyHad: withLoc.length - rows.length }
  }

  async function handleApplyGenerate() {
    if (!companyId) return
    setGenerating(true)
    try {
      const id = await saveLogic()
      if (!id) return

      // Only shops with a specific product driving the flag generate a
      // recount here — the rest (flagged, but nothing product-specific to
      // point at) show in the Manual Review section below instead.
      if (flaggedWithProducts.filter((e) => e.locationId).length === 0) {
        toast(manualReview.length > 0
          ? `No shops ready to auto-generate — ${manualReview.length} need manual review below`
          : 'No shops flagged for this period', { icon: 'ℹ️' })
        return
      }

      const { created } = await generateForShops(flaggedWithProducts)
      if (created === 0) toast('All flagged shops already have recounts for this period', { icon: 'ℹ️' })
      else toast.success(`Generated ${created} recount${created === 1 ? '' : 's'} → see Recounts tab`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to generate recounts')
    } finally {
      setGenerating(false)
    }
  }

  async function handlePushOne(e: EvaluatedCount) {
    try {
      const { created, alreadyHad } = await generateForShops([e])
      if (created === 0) toast(alreadyHad > 0 ? 'This shop already has a recount for this period' : 'Nothing to push', { icon: 'ℹ️' })
      else toast.success('Recount created → see Recounts tab')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create recount')
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
          title="Oil Adjustment Count"
          enabled={oilAdjEnabled}
          onToggle={setOilAdjEnabled}
          preview={oilAdjPreview(lowOilAdj, highOilAdj)}
        >
          <div className="grid grid-cols-2 gap-3">
            <Input label="Low (flag if fewer)" value={lowOilAdj} onChange={(e) => setLowOilAdj(e.target.value)} placeholder="blank = off" />
            <Input label="High (flag if more)" value={highOilAdj} onChange={(e) => setHighOilAdj(e.target.value)} placeholder="blank = off" />
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
            ? `Flag shops whose ending balance differs from their ${lookbackN}-month median by more than ${varMed}${varMedThresholdType === 'percentage' ? '%' : ' dollars'}.`
            : 'Disabled — set a threshold to enable.'}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Threshold Type</span>
              <div className="flex gap-1">
                {(['percentage', 'dollar'] as const).map((t) => (
                  <button key={t} onClick={() => setVarMedThresholdType(t)}
                    className={['flex-1 px-2 py-1 rounded border text-xs font-mono transition-colors', varMedThresholdType === t ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
                    {t === 'percentage' ? '% Percentage' : '$ Dollar'}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label={varMedThresholdType === 'percentage' ? 'Variance %' : 'Variance $ Amount'}
              value={varMed}
              onChange={(e) => setVarMed(e.target.value)}
              placeholder="e.g. 15"
            />
          </div>
        </RuleCard>

        <RuleCard
          title="Variance vs Last Month"
          enabled={varLastEnabled}
          onToggle={setVarLastEnabled}
          preview={varLastEnabled && varLast.trim()
            ? `Flag shops whose ending balance differs from last month by more than ${varLast}${varLastThresholdType === 'percentage' ? '%' : ' dollars'}.`
            : 'Disabled — set a threshold to enable.'}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Threshold Type</span>
              <div className="flex gap-1">
                {(['percentage', 'dollar'] as const).map((t) => (
                  <button key={t} onClick={() => setVarLastThresholdType(t)}
                    className={['flex-1 px-2 py-1 rounded border text-xs font-mono transition-colors', varLastThresholdType === t ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy/60'].join(' ')}>
                    {t === 'percentage' ? '% Percentage' : '$ Dollar'}
                  </button>
                ))}
              </div>
            </div>
            <Input
              label={varLastThresholdType === 'percentage' ? 'Variance %' : 'Variance $ Amount'}
              value={varLast}
              onChange={(e) => setVarLast(e.target.value)}
              placeholder="e.g. 20"
            />
          </div>
        </RuleCard>

        <RuleCard
          title="Tank Monitor Variance"
          enabled={tankVarEnabled}
          onToggle={setTankVarEnabled}
          preview={tankVarEnabled && tankVarQts.trim()
            ? `Flag shops where a VMI tank's reading differs from its counted on-hand by more than ${tankVarQts} quarts.`
            : 'Disabled — set a threshold to enable. VMI tanks only (keep_fill), compared to this period\'s counted on-hand.'}
        >
          <Input label="Variance (quarts)" value={tankVarQts} onChange={(e) => setTankVarQts(e.target.value)} placeholder="e.g. 50" />
        </RuleCard>

        <RuleCard
          title="Oil On Hand — Not Configured to Order"
          enabled={oilCheckEnabled}
          onToggle={setOilCheckEnabled}
          preview={oilCheckEnabled
            ? 'Flag shops with engine oil on hand this period that has no location_order_config row — i.e. oil they\'re counting but not configured to order. Exceptions below are excluded.'
            : 'Disabled.'}
        >
          <p className="text-xs font-mono text-inky/60">Engine oil only. No threshold — any unconfigured oil with on-hand &gt; 0 flags the shop and product.</p>
        </RuleCard>

        <CollapsibleCard
          title="Median Lookback & Ending-Balance Rules"
          borderClassName={ignoreEndingBalance ? 'border-[#E67E22]/50' : ''}
          headerRight={<Toggle checked={ignoreEndingBalance} onChange={setIgnoreEndingBalance} color="amber" size="sm" label={ignoreEndingBalance ? 'Ignoring' : 'Normal'} />}
        >
          <Input
            label="Median Lookback (months)"
            value={lookback}
            onChange={(e) => setLookback(e.target.value)}
            hint={`Median over trailing ${lookbackN} months`}
          />
          <p className="text-xs font-mono text-inky leading-relaxed border-l-2 border-[#00e5ff]/30 pl-2">
            When "Ignoring" is on, Adjustment Count, Oil Adjustment Count, Ending Balance, Variance vs Median, and
            Variance vs Last Month stop flagging shops entirely — only Tank Monitor Variance, Oil On Hand, and product
            range exceptions can still flag a recount. Each rule's own toggle/thresholds are kept, not cleared.
          </p>
        </CollapsibleCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProductOnHandExceptionsPanel />
      </div>

      <Card>
        <CardBody className="flex items-center justify-end flex-wrap gap-4">
          <div className="flex items-center gap-3">
            {autoSaveStatus === 'pending' && (
              <span className="text-[10px] font-mono text-inky/50 animate-pulse">Auto-saving…</span>
            )}
            {autoSaveStatus === 'saved' && (
              <span className="text-[10px] font-mono text-green-600">✓ Saved</span>
            )}
            <Button loading={generating} onClick={handleApplyGenerate}>Apply &amp; Generate Recounts</Button>
          </div>
        </CardBody>
      </Card>

      {/* Flagged for later — set aside from either list below to revisit;
          same columns/actions as Live Preview, collapsed to 3 rows by default. */}
      <Card className="border-sky/40">
        <CardHeader className="flex items-center justify-between">
          <button onClick={() => setFlaggedLaterExpanded((v) => !v)} className="text-xs font-mono text-navy uppercase tracking-wide hover:text-navy/70 transition-colors inline-flex items-center gap-1.5">
            Flagged for Later {flaggedLaterExpanded ? '▾' : '▸'}
          </button>
          <span className="text-xs font-mono text-inky">{flaggedLater.length} shop{flaggedLater.length === 1 ? '' : 's'}</span>
        </CardHeader>
        <CardBody>
          {flaggedLater.length === 0 ? (
            <p className="text-xs font-mono text-inky/60">Nothing set aside right now.</p>
          ) : (
            <>
              <div className="overflow-auto max-h-[calc(100vh-300px)] rounded border border-navy/30">
                <RecountPreviewTable
                  rows={flaggedLaterExpanded ? flaggedLater : flaggedLater.slice(0, 3)}
                  locations={evalData?.locations ?? []}
                  companyId={companyId}
                  countMonth={countMonth}
                  tankVarByShop={tankVarByShop}
                  exceptionsByShop={exceptionsByShop}
                  oilFlagsByShop={oilFlagsByShop}
                  hiddenProducts={hiddenProducts}
                  varianceRedThreshold={numOrNull(varianceRedThreshold) ?? 7500}
                  onToggleHide={toggleHideProduct}
                  onExclude={(locId) => addPreviewAction(locId, 'excluded_shop')}
                  onPushOne={handlePushOne}
                  onToggleLater={(locId) => removePreviewAction(locId, 'flagged_later')}
                  laterActionLabel="Restore"
                />
              </div>
              {flaggedLater.length > 3 && (
                <button onClick={() => setFlaggedLaterExpanded((v) => !v)} className="mt-2 text-[11px] font-mono text-inky/60 hover:text-navy underline">
                  {flaggedLaterExpanded ? 'Show fewer' : `Show all ${flaggedLater.length}`}
                </button>
              )}
            </>
          )}
        </CardBody>
      </Card>

      {/* Live preview — shops that would actually generate a recount */}
      <Card>
        <CardHeader className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-mono text-inky uppercase tracking-wide">Live Preview — {format(parseISO(countMonth), 'MMMM yyyy')}</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/70 uppercase tracking-wide">
              Red above $
              <input
                value={varianceRedThreshold}
                onChange={(e) => setVarianceRedThreshold(e.target.value)}
                className="w-20 rounded border border-navy/30 bg-cream px-1.5 py-0.5 text-xs font-mono text-navy focus:border-sky focus:outline-none"
              />
            </label>
            <span className="text-xs font-mono">
              <span className="text-orange-600">{flaggedWithProducts.length}</span>
              <span className="text-inky"> of {totalShops} eligible shops would generate a recount</span>
            </span>
          </div>
        </CardHeader>
        <CardBody>
          {!evalData ? (
            <p className="text-xs font-mono text-inky">Loading period data…</p>
          ) : flaggedWithProducts.length === 0 ? (
            <p className="text-xs font-mono text-inky/70">No shops flag with a specific product under the current rules.</p>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-300px)] rounded border border-navy/30">
              <RecountPreviewTable
                rows={flaggedWithProducts}
                locations={evalData.locations}
                companyId={companyId}
                countMonth={countMonth}
                tankVarByShop={tankVarByShop}
                exceptionsByShop={exceptionsByShop}
                oilFlagsByShop={oilFlagsByShop}
                hiddenProducts={hiddenProducts}
                varianceRedThreshold={numOrNull(varianceRedThreshold) ?? 7500}
                onToggleHide={toggleHideProduct}
                onExclude={(locId) => addPreviewAction(locId, 'excluded_shop')}
                onPushOne={handlePushOne}
                onToggleLater={(locId) => addPreviewAction(locId, 'flagged_later')}
                laterActionLabel="Flag for Later"
              />
            </div>
          )}
        </CardBody>
      </Card>

      {/* Flagged, but no specific product to point at — not auto-generated;
          left here for a human to look at the shop directly. */}
      <Card className="border-[#E67E22]/40">
        <CardHeader className="flex items-center justify-between">
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Needs Manual Review — No Specific Product Identified</span>
          <span className="text-xs font-mono">
            <span className="text-[#E67E22]">{manualReview.length}</span>
            <span className="text-inky"> shop{manualReview.length === 1 ? '' : 's'}</span>
          </span>
        </CardHeader>
        <CardBody>
          <p className="text-[11px] font-mono text-inky/60 mb-3">
            These shops flagged on ending balance/adjustment/variance rules, but neither a tank monitor mismatch nor a
            product-range exception points at a specific product — Apply &amp; Generate skips them. Add a recount by
            hand from the Recounts tab if one's warranted.
          </p>
          {!evalData ? (
            <p className="text-xs font-mono text-inky">Loading period data…</p>
          ) : manualReview.length === 0 ? (
            <p className="text-xs font-mono text-inky/70">Nothing needs manual review right now.</p>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-400px)] rounded border border-navy/30">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0">
                  <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left">Location</th>
                    <th className="px-3 py-2 text-right">Adj Count</th>
                    <th className="px-3 py-2 text-right">Ending</th>
                    <th className="px-3 py-2 text-right">Prev</th>
                    <th className="px-3 py-2 text-right">Median</th>
                    <th className="px-3 py-2 text-left">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {manualReview.map((e) => (
                    <tr key={e.count?.id ?? e.locationId} className="border-b border-navy/30/50">
                      <td className="px-3 py-2 text-navy">{locationLabel(e.locationId, evalData.locations)}</td>
                      <td className="px-3 py-2 text-right text-inky">{e.count?.total_adjustments ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-navy">{e.count ? fmt(e.count.ending_inventory_cost) : '—'}</td>
                      <td className="px-3 py-2 text-right text-inky">{fmt(e.prev)}</td>
                      <td className="px-3 py-2 text-right text-inky">{fmt(e.median)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {e.flags.map((f) => <FlagBadge key={f} flag={f} />)}
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

// Shared by Live Preview and Flagged for Later — same columns, same
// per-row actions, so a shop looks identical wherever it currently sits.
function RecountPreviewTable({
  rows, locations, companyId, countMonth, tankVarByShop, exceptionsByShop, oilFlagsByShop, hiddenProducts,
  varianceRedThreshold, onToggleHide, onExclude, onPushOne, onToggleLater, laterActionLabel,
}: {
  rows: EvaluatedCount[]
  locations: Location[]
  companyId: string
  countMonth: string
  tankVarByShop: Map<string, TankVarianceCandidate[]>
  exceptionsByShop: Map<string, ProductExceptionRow[]>
  oilFlagsByShop: Map<string, OilOnHandRow[]>
  hiddenProducts: Map<string, Set<string>>
  varianceRedThreshold: number
  onToggleHide: (locationId: string, productId: string) => void
  onExclude: (locationId: string) => void
  onPushOne: (e: EvaluatedCount) => void
  onToggleLater: (locationId: string) => void
  laterActionLabel: string
}) {
  return (
    <table className="w-full text-xs font-mono">
      <thead className="sticky top-0">
        <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
          <th className="px-3 py-2 text-left">Location</th>
          <th className="px-3 py-2 text-right">Adj Count</th>
          <th className="px-3 py-2 text-right">Ending</th>
          <th className="px-3 py-2 text-right">Prev</th>
          <th className="px-3 py-2 text-right">Var vs Prev</th>
          <th className="px-3 py-2 text-right">Median</th>
          <th className="px-3 py-2 text-left">Flags</th>
          <th className="px-3 py-2 text-left">Products</th>
          <th className="px-3 py-2 text-left">Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const varVsPrev = e.count?.ending_inventory_cost != null && e.prev != null ? e.count.ending_inventory_cost - e.prev : null
          const isRed = varVsPrev != null && Math.abs(varVsPrev) > varianceRedThreshold
          const productMap = new Map<string, { qty: number; types: Set<FlagType> }>()
          const addProduct = (id: string, qty: number, type: FlagType) => {
            const cur = productMap.get(id)
            if (cur) cur.types.add(type)
            else productMap.set(id, { qty, types: new Set([type]) })
          }
          ;(exceptionsByShop.get(e.locationId ?? '') ?? []).forEach((x) => addProduct(x.product_id, x.on_hand, 'exception'))
          ;(tankVarByShop.get(e.locationId ?? '') ?? []).forEach((x) => addProduct(x.product_id, x.on_hand, 'tank'))
          ;(oilFlagsByShop.get(e.locationId ?? '') ?? []).forEach((x) => addProduct(x.product_id, x.on_hand, 'oil'))
          const products = [...productMap.entries()].map(([id, v]) => ({ id, qty: v.qty, types: v.types }))
          const hiddenSet = (e.locationId && hiddenProducts.get(e.locationId)) || new Set<string>()
          return (
            <tr key={e.count?.id ?? e.locationId} className="border-b border-navy/30/50">
              <td className="px-3 py-2 text-navy">{locationLabel(e.locationId, locations)}</td>
              <td className="px-3 py-2 text-right text-inky">{e.count?.total_adjustments ?? '—'}</td>
              <td className="px-3 py-2 text-right text-navy">{e.count ? fmt(e.count.ending_inventory_cost) : '—'}</td>
              <td className="px-3 py-2 text-right text-inky">{fmt(e.prev)}</td>
              <td className={`px-3 py-2 text-right ${isRed ? 'text-[#C0392B] font-bold' : 'text-inky'}`}>
                {varVsPrev == null ? '—' : `${varVsPrev >= 0 ? '+' : ''}${fmt(varVsPrev)}`}
              </td>
              <td className="px-3 py-2 text-right text-inky">{fmt(e.median)}</td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {e.flags.map((f) => <FlagBadge key={f} flag={f} />)}
                </div>
              </td>
              <td className="px-3 py-2 text-inky">
                {products.length === 0 ? '—' : (
                  <div className="flex flex-wrap gap-1">
                    {products.map((p) => (
                      <ProductChip
                        key={p.id}
                        productId={p.id}
                        qty={p.qty}
                        types={p.types}
                        hidden={hiddenSet.has(p.id)}
                        locationId={e.locationId}
                        companyId={companyId}
                        countMonth={countMonth}
                        onToggleHide={() => e.locationId && onToggleHide(e.locationId, p.id)}
                      />
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => e.locationId && onExclude(e.locationId)} className="text-[10px] font-mono text-inky/60 hover:text-[#C0392B] underline">Exclude</button>
                  <button onClick={() => onPushOne(e)} className="text-[10px] font-mono text-inky/60 hover:text-navy underline">Push to Recounts</button>
                  <button onClick={() => e.locationId && onToggleLater(e.locationId)} className="text-[10px] font-mono text-inky/60 hover:text-navy underline">{laterActionLabel}</button>
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function adjPreview(low: string, high: string): string {
  const parts: string[] = []
  if (low.trim()) parts.push(`fewer than ${low}`)
  if (high.trim()) parts.push(`more than ${high}`)
  if (!parts.length) return 'Set a low and/or high adjustment count to enable.'
  return `Flag shops with ${parts.join(' or ')} adjustments.`
}

function oilAdjPreview(low: string, high: string): string {
  const parts: string[] = []
  if (low.trim()) parts.push(`fewer than ${low}`)
  if (high.trim()) parts.push(`more than ${high}`)
  if (!parts.length) return 'Set a low and/or high oil adjustment count to enable.'
  return `Flag shops with ${parts.join(' or ')} oil adjustments.`
}

function balPreview(low: string, high: string): string {
  const parts: string[] = []
  if (low.trim()) parts.push(`below ${low}`)
  if (high.trim()) parts.push(`above ${high}`)
  if (!parts.length) return 'Set a low and/or high ending balance to enable.'
  return `Flag shops with ending balance ${parts.join(' or ')}.`
}

// Shared collapsible-card shell — all the configurable check tiles at the
// top of Recount Logic use this so they can be collapsed to save vertical
// space; each defaults closed since there are many of them on one screen.
function CollapsibleCard({
  title, headerRight, children, defaultCollapsed = true, borderClassName = '',
}: {
  title: string
  headerRight?: React.ReactNode
  children: React.ReactNode
  defaultCollapsed?: boolean
  borderClassName?: string
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <Card className={borderClassName}>
      <CardHeader className="flex items-center justify-between">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 text-xs font-mono text-navy uppercase tracking-wide hover:text-navy/70 transition-colors"
        >
          <span className={`inline-block text-[10px] transition-transform ${collapsed ? '' : 'rotate-90'}`}>▸</span>
          {title}
        </button>
        {headerRight}
      </CardHeader>
      {!collapsed && <CardBody className="flex flex-col gap-3">{children}</CardBody>}
    </Card>
  )
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
    <CollapsibleCard
      title={title}
      headerRight={<Toggle checked={enabled} onChange={onToggle} color="green" size="sm" label={enabled ? 'On' : 'Off'} />}
    >
      <div className={enabled ? '' : 'opacity-40 pointer-events-none'}>{children}</div>
      <p className="text-xs font-mono text-inky leading-relaxed border-l-2 border-[#00e5ff]/30 pl-2">
        {preview}
      </p>
    </CollapsibleCard>
  )
}
