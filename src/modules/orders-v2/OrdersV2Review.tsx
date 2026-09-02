import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RefreshCw, ChevronRight, ChevronDown } from 'lucide-react'
import { Button, Card, CardBody, Input, SbLoader, Toggle } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  useDraft, useGenerationData, useOrderSettings, useVendorRules,
  buildGenerationInputs, eligibleLocations, draftOrderDow, shopsPerOrderDay, type DraftLineRow,
} from './useOrdersV2'
import { useVendors } from './useLookups'
import { generateOrder, nextDeliveryDate, resolveDeliveryDate, dosAfterDelivery, gallonsPerUnit, resolvedOrderType, daysOfSupply, daysBetween, unitsToTarget, capsFor, roundQty } from './engine'
import { FLAG_CLASS, FLAG_META, OVERRIDE_CELL, dos, money, num } from './shared'
import type { LineFlag, GenerationInput } from './types'

type SortKey = 'location' | 'capacity' | 'product' | 'qty' | 'dollars' | 'dos_after'

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const PO_DECISION_FLAGS: LineFlag[] = ['po_decision_override', 'po_decision_exclude', 'po_decision_combine']
/** Swaps in one of the three mutually-exclusive PO-coverage decision flags,
 * leaving covered_by_open_po (the trigger) and everything else untouched. */
function withPoDecision(flags: LineFlag[], decision: LineFlag): LineFlag[] {
  return [...flags.filter((f) => !PO_DECISION_FLAGS.includes(f)), decision]
}

/**
 * Step 2 — the working order. Generates on demand, then every edit autosaves
 * straight into the draft's lines so leaving the page loses nothing.
 */
export function OrdersV2Review() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()
  const { settings } = useOrderSettings()
  const { rulesFor } = useVendorRules()
  const { fetchInputs } = useGenerationData()
  const { draft, lines, loading, reload, replaceLines, patchLine, addLine, removeLine, setStatus } = useDraft(draftId || null)
  // Manual raw-tank-name -> our_part_number overrides (Tank Monitors'
  // Product Mapping tab) — needed so a keep-fill product's tank reading
  // actually matches its order-config product_id (tank telemetry names
  // products however the provider does, e.g. "DMX SYN 0W20", never the
  // shop's canonical id). Same setting LocationLookupPage.tsx already
  // reads for its own on-hand display.
  const [tankProductMap] = useAppSetting<Record<string, string>>('tank_product_map', {})

  const [generating, setGenerating] = useState(false)
  const [showVmi, setShowVmi] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('location')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Collapsed by default — "Shops With No Orders" (see shopsWithNoOrders
  // below) is a review/audit list, not something that needs to be open on
  // every visit to this page.
  const [noOrdersOpen, setNoOrdersOpen] = useState(false)
  const [skipped, setSkipped] = useState<{ location_id: string; product_id: string; reason: string }[]>([])
  const [dayCounts, setDayCounts] = useState<number[]>([0, 0, 0, 0, 0, 0, 0])
  // Every candidate the engine considered for this run, not just the ones
  // that made it onto the draft — the smoothing panel needs the shop's
  // full config (including products it decided NOT to order) to show what
  // else could be pulled in, not just what already is.
  const [allInputs, setAllInputs] = useState<GenerationInput[]>([])
  // Which locations the last run even considered for this order day — null
  // means the vendor doesn't use order days at all (every location is
  // "eligible" so the distinction is meaningless). Stored from the same
  // run's own eligibleLocations() call so the "Shops With No Orders"
  // section below doesn't need to recompute it separately.
  const [eligibleLocationIds, setEligibleLocationIds] = useState<Set<string> | null>(null)
  const orderDow = draft ? draftOrderDow(draft) : new Date().getDay()

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  /** Run the engine and replace the draft's lines with the result. */
  const runGeneration = useCallback(async (dow?: number) => {
    if (!draft || !profile?.company_id) return
    const useDow = dow ?? draftOrderDow(draft)
    setGenerating(true)
    try {
      const { configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, days, schedules, calendar, history } = await fetchInputs(draft.vendor_id, settings.flag_cumulative_days)
      const inputs = buildGenerationInputs(configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, [], [], tankProductMap)
      setAllInputs(inputs)
      const eligibleIds = eligibleLocations(days, rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays, draft.order_date, useDow)
      setEligibleLocationIds(eligibleIds)
      const result = generateOrder(inputs, {
        settings,
        vendor: rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name),
        orderDate: draft.order_date,
        eligibleLocationIds: eligibleIds,
        history,
        // Keep-fill/VMI lines are always generated now (for the runway
        // check below) — the Review page's "Show VMI / keepfill" toggle
        // only controls whether they're visible in the table, and they
        // start excluded from the order total regardless (see buildLine).
        includeVmi: true,
      })

      // Days of supply at delivery uses the shop's configured delivery day.
      const deliveryDow = new Map(days.map((d) => [d.location_id, d.delivery_dow]))
      const ruleByKey = new Map(inputs.map((i) => [`${i.location_id}|${i.product_id}`, i.rule]))
      // A configured per-shop schedule wins; otherwise fall back to the
      // RelaDyne weekday from the location list. Shared by the delivery
      // math below and the keep-fill runway check further down.
      const deliveryFor = (locationId: string | null, fromDate: string) => {
        const sched = schedules.get(locationId ?? '')
        return sched
          ? resolveDeliveryDate(fromDate, sched, calendar)
          : nextDeliveryDate(fromDate, deliveryDow.get(locationId ?? '') ?? null)
      }

      // Keep-fill runway check — independent of the standard reorder
      // trigger, since a VMI product needs to last to its delivery AFTER
      // NEXT (the earliest a follow-up keep-fill order placed today could
      // realistically land) regardless of whether it's currently due for a
      // normal reorder. Checked against every VMI input, not just the ones
      // that cleared the trigger and became order lines, so a product with
      // enough days-of-supply to clear that generic threshold but not
      // enough to reach this specific date isn't missed.
      const keepfillAlerts = inputs.filter((i) => i.rule.vmi_keepfill_enabled).map((i) => {
        const deliver1 = deliveryFor(i.location_id, draft.order_date)
        const deliver2 = deliver1 ? deliveryFor(i.location_id, deliver1) : null
        const runwayDays = daysOfSupply(i.on_hand, i.daily_usage)
        const daysToDeliver2 = deliver2 ? daysBetween(draft.order_date, deliver2) : null
        return {
          location_id: i.location_id, product_id: i.product_id,
          on_hand: i.on_hand, daily_usage: i.daily_usage, runway_days: runwayDays,
          next_delivery: deliver1, delivery_after_next: deliver2,
          no_tank_data: i.on_hand == null,
          will_run_out: runwayDays != null && daysToDeliver2 != null && runwayDays < daysToDeliver2,
        }
      }).filter((a) => a.will_run_out || a.no_tank_data)
      const runOutKeys = new Set(keepfillAlerts.filter((a) => a.will_run_out).map((a) => `${a.location_id}|${a.product_id}`))
      // Flagged for a decision, never auto-resolved — see engine
      // buildGenerationInputs' pendingPoQty comment. A line here still
      // ordered its normal suggested quantity; the flag just means "an
      // open PO already has some of this outstanding, take a look."
      const openPoKeys = new Set(inputs.filter((i) => (i.pendingPoQty ?? 0) > 0).map((i) => `${i.location_id}|${i.product_id}`))

      const withDelivery = result.lines.map((l) => {
        const rule = ruleByKey.get(`${l.location_id}|${l.product_id}`)
        const deliver = deliveryFor(l.location_id, draft.order_date)
        const gallons = rule ? l.qty * gallonsPerUnit(rule) : 0
        const key = `${l.location_id}|${l.product_id}`
        let flags = l.flags
        if (runOutKeys.has(key) && !flags.includes('keepfill_will_run_out')) flags = [...flags, 'keepfill_will_run_out' as const]
        if (openPoKeys.has(key) && !flags.includes('covered_by_open_po')) flags = [...flags, 'covered_by_open_po' as const]
        return { ...l, flags, dos_after_delivery: dosAfterDelivery(l.on_hand, l.daily_usage, gallons, draft.order_date, deliver) }
      })

      await replaceLines(withDelivery)
      setSkipped(result.skipped)
      const shops = new Set(withDelivery.map((l) => l.location_id)).size
      // Cache the shop count (and keep-fill alerts) on the header so the
      // landing page / Final Review can read them without loading every
      // line or re-fetching tank data.
      setDayCounts(shopsPerOrderDay(days))
      await (supabase as any).schema('inventory').from('ov2_order_drafts')
        .update({ settings_snapshot: { ...settings, __shop_count: shops, __order_dow: useDow, __keepfill_alerts: keepfillAlerts }, status: 'review' })
        .eq('id', draft.id)
      await reload()
      toast.success(`Generated ${withDelivery.length} line${withDelivery.length !== 1 ? 's' : ''} across ${shops} shop${shops !== 1 ? 's' : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }, [draft, profile?.company_id, fetchInputs, settings, rulesFor, replaceLines, reload, vendors])

  // Generate automatically the first time a fresh draft is opened.
  useEffect(() => {
    if (draft && draft.status === 'generating' && !loading && lines.length === 0 && !generating) void runGeneration()
  }, [draft, loading, lines.length, generating, runGeneration])

  // ---- grouping + derived numbers -----------------------------------------
  const groups = useMemo(() => {
    const m = new Map<string, DraftLineRow[]>()
    for (const l of lines) {
      const k = `${l.location_id}|${l.order_type}`
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(l)
    }
    return m
  }, [lines])

  const overrideCount = useMemo(() => lines.filter((l) => l.is_override).length, [lines])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = [...lines]
    if (!showVmi) out = out.filter((l) => !(l.flags ?? []).includes('vmi_keepfill'))
    if (q) out = out.filter((l) => `${shopLabel(l.location_id)} ${l.product_id} ${l.uom ?? ''}`.toLowerCase().includes(q))
    const dir = sortDir === 'asc' ? 1 : -1
    const secondary = (a: DraftLineRow, b: DraftLineRow) => {
      switch (sortKey) {
        case 'capacity': return dir * (Number(b.max_capacity_gallons ?? 0) - Number(a.max_capacity_gallons ?? 0))
        case 'product': return dir * a.product_id.localeCompare(b.product_id)
        case 'qty': return dir * (Number(a.qty) - Number(b.qty))
        case 'dollars': return dir * ((Number(a.qty) * Number(a.unit_cost ?? 0)) - (Number(b.qty) * Number(b.unit_cost ?? 0)))
        case 'dos_after': return dir * (Number(a.dos_after ?? 0) - Number(b.dos_after ?? 0))
        default: return Number(b.max_capacity_gallons ?? 0) - Number(a.max_capacity_gallons ?? 0)
      }
    }
    return [...out].sort((a, b) => {
      // Shops always group together, in numeric order, regardless of the
      // chosen sort — that only orders products within a shop, so a
      // multi-product shop never gets scattered across the table.
      const s = shopLabel(a.location_id).localeCompare(shopLabel(b.location_id), undefined, { numeric: true })
      return s !== 0 ? s : secondary(a, b)
    })
  }, [lines, filter, sortKey, sortDir, shopLabel, showVmi])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'capacity' ? 'desc' : 'asc') }
  }

  // Alternates per shop (not per row), so multiple lines for the same shop
  // band together — makes it obvious at a glance whether adjacent rows are
  // one shop's multi-product order or a boundary between two shops.
  const bandOf = useMemo(() => {
    const m = new Map<string, boolean>()
    let prevShop: string | null = null
    let band = false
    for (const l of visible) {
      if (l.location_id !== prevShop) { band = !band; prevShop = l.location_id }
      m.set(l.id, band)
    }
    return m
  }, [visible])

  // Every candidate the engine saw for a shop, whether or not it ended up on
  // the draft — spans every order type, for "expand this shop to everything
  // configured for it" (see shopRows below).
  const inputsByLocation = useMemo(() => {
    const m = new Map<string, GenerationInput[]>()
    for (const i of allInputs) {
      if (!m.has(i.location_id)) m.set(i.location_id, [])
      m.get(i.location_id)!.push(i)
    }
    return m
  }, [allInputs])

  // Shops on the selected order day (eligibleLocationIds, from the same
  // run's own eligibleLocations() call) that ended up with no real order —
  // "real" meaning at least one included line with qty > 0; a shop whose
  // only lines are keep-fill/VMI (always generated for the runway check,
  // excluded from the order total regardless) still counts as "no orders"
  // here, since nothing on it is actually being ordered. null
  // eligibleLocationIds (vendor doesn't use order days) means this
  // distinction is meaningless, so the section doesn't show at all then.
  const shopsWithNoOrders = useMemo(() => {
    if (!eligibleLocationIds) return []
    const withOrders = new Set(lines.filter((l) => l.included && Number(l.qty) > 0).map((l) => l.location_id))
    return [...eligibleLocationIds].filter((id) => !withOrders.has(id))
      .sort((a, b) => shopLabel(a).localeCompare(shopLabel(b), undefined, { numeric: true }))
  }, [eligibleLocationIds, lines, shopLabel])

  // The specific (location, product) candidate behind a draft line — for
  // the "other case types on hand" sub-listing under the main On Hand
  // column, since own_on_hand/equivalent_products live on the generation
  // input, not the persisted line (see buildGenerationInputs).
  const inputByLineKey = useMemo(
    () => new Map(allInputs.map((i) => [`${i.location_id}|${i.product_id}`, i])),
    [allInputs],
  )

  // Three explicit choices for a line flagged covered_by_open_po — never
  // auto-resolved (see buildGenerationInputs' pendingPoQty comment).
  // "Combine" recomputes the suggested qty using the exact same targeting
  // formula the engine itself used (unitsToTarget/capsFor, now exported for
  // this), with the open PO's outstanding quantity added to on-hand first —
  // not a bespoke approximation of the real math.
  function decidePoOverride(l: DraftLineRow) {
    patchLine(l.id, { flags: withPoDecision(l.flags, 'po_decision_override'), included: true })
  }
  function decidePoExclude(l: DraftLineRow) {
    patchLine(l.id, { flags: withPoDecision(l.flags, 'po_decision_exclude'), included: false })
  }
  function decidePoCombine(l: DraftLineRow) {
    const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
    const pending = input?.pendingPoQty ?? 0
    if (!input || pending <= 0) return
    const adjusted: GenerationInput = { ...input, on_hand: Number(input.on_hand ?? 0) + pending }
    // unitsToTarget/capsFor only read ctx.settings — no need to reconstruct
    // eligibleLocationIds/history/includeVmi for this one-line recompute.
    const ctx = { settings } as unknown as Parameters<typeof unitsToTarget>[1]
    const caps = capsFor(adjusted, ctx)
    const want = unitsToTarget(adjusted, ctx)
    const newQty = roundQty(Math.min(want, caps.maxUnits), l.uom, settings.bulk_rounding_decimals, want > caps.maxUnits ? 'down' : 'nearest')
    patchLine(l.id, { qty: newQty, flags: withPoDecision(l.flags, 'po_decision_combine'), included: newQty > 0 })
  }

  async function addConfiguredProduct(input: GenerationInput, qty: number) {
    if (qty <= 0) return
    await addLine({
      location_id: input.location_id, product_id: input.product_id, order_type: resolvedOrderType(input.rule),
      uom: input.rule.uom, qty, system_qty: 0,
      unit_cost: input.rule.unit_cost, on_hand: input.on_hand, daily_usage: input.daily_usage,
      dos_before: daysOfSupply(input.on_hand, input.daily_usage),
      max_capacity_gallons: input.rule.max_capacity_gallons, quarts_per_unit: gallonsPerUnit(input.rule),
    })
  }

  // Every configured product for a shop, ordered products first (any real
  // line, whether or not it's currently included) then everything else the
  // shop is set up for but doesn't have a line yet — what the shop-name
  // expand row below shows.
  function shopRows(locId: string): { input?: GenerationInput; line?: DraftLineRow }[] {
    const candidates = inputsByLocation.get(locId) ?? []
    const shopLines = lines.filter((l) => l.location_id === locId)
    const lineByProduct = new Map(shopLines.map((l) => [l.product_id, l]))
    const candidateIds = new Set(candidates.map((c) => c.product_id))
    const rows: { input?: GenerationInput; line?: DraftLineRow }[] =
      candidates.map((c) => ({ input: c, line: lineByProduct.get(c.product_id) }))
    for (const l of shopLines) if (!candidateIds.has(l.product_id)) rows.push({ line: l })
    rows.sort((ra, rb) => {
      const rank = (r: typeof ra) => (r.line ? 0 : 1)
      const d = rank(ra) - rank(rb)
      if (d !== 0) return d
      return (ra.line?.product_id ?? ra.input?.product_id ?? '').localeCompare(rb.line?.product_id ?? rb.input?.product_id ?? '')
    })
    return rows
  }

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found. It may have been deleted.</p>

  const vendorName = vendors.byId(draft.vendor_id)?.name ?? 'All vendors'
  const usesOrderDays = rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Review Order</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendorName} · {draft.order_date}{usesOrderDays ? ` · ${DOW[orderDow]} shops` : ''} · {groups.size} shop/type group{groups.size !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="secondary" loading={generating} onClick={() => runGeneration()}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regenerate
          </Button>
          <Button size="sm" onClick={async () => { await setStatus('final_review'); navigate(`/orders-v2/draft/${draft.id}/final`) }}>
            Final Review →
          </Button>
        </div>
      </div>

      <Card><CardBody className="flex items-center gap-4 flex-wrap py-3">
        <Input placeholder="Search shop or product…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
        <label className="flex items-center gap-2 text-xs font-mono text-inky">
          <Toggle checked={showVmi} onChange={setShowVmi} size="sm" color="cyan" />
          Show VMI / keepfill
        </label>
        {usesOrderDays && (
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            Order day
            <select value={String(orderDow)} onChange={(e) => void runGeneration(Number(e.target.value))}
              className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky">
              {DOW.map((d, i) => (
                <option key={d} value={i}>{d}{dayCounts[i] ? ` (${dayCounts[i]})` : ''}</option>
              ))}
            </select>
          </label>
        )}
        <span className="text-xs font-mono text-inky">
          {lines.length} line{lines.length !== 1 ? 's' : ''}
          {overrideCount > 0 && (
            <span className="ml-2 rounded px-1.5 py-0.5 bg-[#E67E22]/15 text-[#E67E22] border border-[#E67E22]/40">
              {overrideCount} override{overrideCount !== 1 ? 's' : ''}
            </span>
          )}
        </span>
        <span className="ml-auto text-xs font-mono text-navy">
          Order total {money(lines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0))}
        </span>
      </CardBody></Card>

      {generating && <div className="py-8 flex justify-center"><SbLoader size={32} /></div>}

      {!generating && lines.length === 0 && (
        <div className="py-8 flex flex-col gap-2">
          <p className="text-xs font-mono text-inky/60">Nothing to order for this run.</p>
          {usesOrderDays && dayCounts[orderDow] === 0 ? (
            <p className="text-xs font-mono text-[#C0392B]">
              No shops have {DOW[orderDow]} as their order day
              {dayCounts.some((c) => c > 0)
                ? ` — shops per day: ${DOW.map((d, i) => (dayCounts[i] ? `${d.slice(0, 3)} ${dayCounts[i]}` : null)).filter(Boolean).join(', ')}.`
                : '. No shop has a Reladyne Delivery Day set on the location list.'}
              {' '}Switch the order day above to run a different day&apos;s shops.
            </p>
          ) : (
            <p className="text-xs font-mono text-inky/60">
              {usesOrderDays && `${dayCounts[orderDow]} shop${dayCounts[orderDow] !== 1 ? 's' : ''} order on ${DOW[orderDow]}, but none `}
              {!usesOrderDays && 'No product is '}
              below the minimum days-of-supply trigger. Check Order Settings, or that Product Usage has current
              on-hand and daily usage for these shops.
            </p>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <div className="overflow-auto rounded border border-navy/30 max-h-[calc(100vh-22rem)]">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10">
              <tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                <Th onClick={() => toggleSort('location')} active={sortKey === 'location'} dir={sortDir}>Shop</Th>
                <Th onClick={() => toggleSort('product')} active={sortKey === 'product'} dir={sortDir}>Product</Th>
                <Th>UOM</Th>
                <Th onClick={() => toggleSort('capacity')} active={sortKey === 'capacity'} dir={sortDir} align="right">Capacity</Th>
                <Th align="right">On Hand</Th>
                <Th align="right">Usage/day</Th>
                <Th align="right">DOS Now</Th>
                <Th onClick={() => toggleSort('qty')} active={sortKey === 'qty'} dir={sortDir} align="right">Qty</Th>
                <Th onClick={() => toggleSort('dos_after')} active={sortKey === 'dos_after'} dir={sortDir} align="right">DOS After</Th>
                <Th align="right">DOS @ Delivery</Th>
                <Th onClick={() => toggleSort('dollars')} active={sortKey === 'dollars'} dir={sortDir} align="right">$</Th>
                <Th>Flags</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {visible.map((l, idx) => {
                const dollars = Number(l.qty) * Number(l.unit_cost ?? 0)
                const locId = l.location_id ?? ''
                const isLastOfShop = idx === visible.length - 1 || visible[idx + 1].location_id !== l.location_id
                const shopOpen = expanded.has(locId)
                const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
                return (
                  <Fragment key={l.id}>
                    <tr className={`border-b border-navy/15 ${l.included ? '' : 'opacity-45'} ${bandOf.get(l.id) ? 'bg-navy/[0.035]' : ''}`}>
                      <td className="px-2 py-1 text-navy whitespace-nowrap">
                        <button
                          onClick={() => setExpanded((p) => { const n = new Set(p); n.has(locId) ? n.delete(locId) : n.add(locId); return n })}
                          title="Show every product configured for this shop"
                          className="inline-flex items-center gap-1 hover:underline hover:text-sky">
                          {shopOpen ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                          {shopLabel(l.location_id)}
                        </button>
                      </td>
                      <Td>{l.product_id}</Td>
                      <Td>{l.uom ?? '—'}</Td>
                      <Td align="right">{num(l.max_capacity_gallons, 0)}</Td>
                      <td className="px-2 py-1 text-right text-navy whitespace-nowrap">
                        {num(input?.own_on_hand ?? l.on_hand)}
                        {input?.equivalent_products && input.equivalent_products.length > 0 && (
                          <div className="text-[9px] text-inky/50 leading-tight font-normal">
                            {input.equivalent_products.some((e) => e.used) && (
                              <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
                            )}
                            {input.equivalent_products.map((e) => (
                              <div key={e.product_id}
                                title={e.used ? undefined : 'Not used in the order calculation — on-hand is high relative to usage here, likely stale or not actually on hand at this shop'}>
                                {e.product_id}: {num(e.on_hand)}{!e.used && ' (not used)'}
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <Td align="right">{num(l.daily_usage)}</Td>
                      <Td align="right">{dos(l.dos_before)}</Td>
                      <td className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                        <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                          onChange={(e) => patchLine(l.id, { qty: Number(e.target.value) || 0 })}
                          className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                        {l.quarts_per_unit != null && (
                          <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(l.qty) * l.quarts_per_unit, 1)} qt</div>
                        )}
                      </td>
                      <Td align="right">{dos(l.dos_after)}</Td>
                      <Td align="right">{dos(l.dos_after_delivery)}</Td>
                      <Td align="right">{money(dollars)}</Td>
                      <td className="px-2 py-1">
                        <Flags flags={(l.flags ?? []) as LineFlag[]} />
                        {(l.flags ?? []).includes('covered_by_open_po') && (
                          <PoDecisionButtons line={l} onOverride={decidePoOverride} onExclude={decidePoExclude} onCombine={decidePoCombine} />
                        )}
                      </td>
                      <Td>
                        <div className="flex items-center gap-1">
                          <button title={l.included ? 'Exclude from order' : 'Include in order'}
                            onClick={() => patchLine(l.id, { included: !l.included })}
                            className="text-[10px] border border-navy/30 rounded px-1 py-0.5 text-inky hover:border-navy">
                            {l.included ? 'Exclude' : 'Include'}
                          </button>
                          <button title="Remove line" onClick={() => removeLine(l.id)} className="text-inky/40 hover:text-[#C0392B]">✕</button>
                        </div>
                      </Td>
                    </tr>
                    {isLastOfShop && shopOpen && (
                      <tr className="border-b border-navy/15 bg-navy/[0.02]">
                        <td colSpan={13} className="px-3 py-2">
                          <p className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-1">
                            Every product configured for {shopLabel(l.location_id)}
                          </p>
                          <ShopConfiguredProductsTable
                            rows={shopRows(locId)}
                            onPatch={(id, qty) => patchLine(id, { qty })}
                            onAdd={addConfiguredProduct}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {shopsWithNoOrders.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <button onClick={() => setNoOrdersOpen((o) => !o)} className="flex items-center gap-1.5 text-left w-full hover:text-navy">
            {noOrdersOpen ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
              Shops With No Orders ({shopsWithNoOrders.length})
            </span>
          </button>
          {noOrdersOpen && (
            <div className="flex flex-col gap-2">
              <p className="text-[10px] font-mono text-inky/50">
                On {DOW[orderDow]}'s order day, but nothing ended up included in this order — expand a shop to see everything configured for it and add items if something's missing.
              </p>
              {shopsWithNoOrders.map((locId) => {
                const shopOpen = expanded.has(locId)
                return (
                  <div key={locId} className="border-t border-navy/10 pt-1.5">
                    <button
                      onClick={() => setExpanded((p) => { const n = new Set(p); n.has(locId) ? n.delete(locId) : n.add(locId); return n })}
                      className="inline-flex items-center gap-1 text-xs font-mono text-navy hover:underline hover:text-sky">
                      {shopOpen ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                      {shopLabel(locId)}
                    </button>
                    {shopOpen && (
                      <div className="mt-1">
                        <ShopConfiguredProductsTable
                          rows={shopRows(locId)}
                          onPatch={(id, qty) => patchLine(id, { qty })}
                          onAdd={addConfiguredProduct}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardBody></Card>
      )}

      {skipped.length > 0 && (
        <Card><CardBody className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Not ordered ({skipped.length})</span>
          <div className="max-h-40 overflow-auto text-[11px] font-mono text-inky/70">
            {skipped.slice(0, 300).map((s, i) => (
              <div key={i}>{shopLabel(s.location_id)} · {s.product_id} — {s.reason.replace(/_/g, ' ')}</div>
            ))}
          </div>
        </CardBody></Card>
      )}
    </div>
  )
}

function Th({ children, onClick, active, dir, align }: {
  children?: React.ReactNode; onClick?: () => void; active?: boolean; dir?: 'asc' | 'desc'; align?: 'right'
}) {
  return (
    <th className={`px-2 py-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
      {onClick ? (
        <button onClick={onClick} className="uppercase tracking-wide hover:text-navy inline-flex items-center gap-0.5">
          {children}{active && <span>{dir === 'asc' ? '▲' : '▼'}</span>}
        </button>
      ) : children}
    </th>
  )
}
function Td({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <td className={`px-2 py-1 text-navy whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>
}

/** Every configured product for one shop — shared by the main table's
 * shop-name expand row and the "Shops With No Orders" section, so both
 * "why isn't this shop ordering more" and "why isn't this shop ordering
 * anything" use the exact same product list, columns, and add-a-line
 * behavior. */
function ShopConfiguredProductsTable({ rows, onPatch, onAdd }: {
  rows: { input?: GenerationInput; line?: DraftLineRow }[]
  onPatch: (id: string, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
}) {
  return (
    <table className="w-full text-[11px] font-mono">
      <thead><tr className="text-inky/60 uppercase">
        <td className="py-1">Product</td><td>UOM</td>
        <td className="text-right">Capacity</td><td className="text-right">On Hand</td>
        <td className="text-right">Usage/Day</td><td className="text-right">DOS Now</td>
        <td className="text-right">Qty</td><td className="text-right">DOS After</td>
        <td className="text-right">$</td><td>Why</td>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <SmoothingRow key={r.line?.id ?? r.input?.product_id} input={r.input} line={r.line} onPatch={onPatch} onAdd={onAdd} />
        ))}
      </tbody>
    </table>
  )
}

/** One row in a shop's product list — an existing line (editable in place)
 * or a configured-but-not-ordered candidate (typing a qty adds it). Shared
 * by the smoothing panel and the shop-name expand row below the table. */
function SmoothingRow({ input, line, onPatch, onAdd }: {
  input?: GenerationInput; line?: DraftLineRow
  onPatch: (id: string, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
}) {
  const productId = line?.product_id ?? input?.product_id ?? ''
  const unitCost = Number(line?.unit_cost ?? input?.rule.unit_cost ?? 0)
  const uom = line?.uom ?? input?.rule.uom ?? null
  const capacity = line?.max_capacity_gallons ?? input?.rule.max_capacity_gallons ?? null
  const onHand = line?.on_hand ?? input?.on_hand ?? null
  const dailyUsage = line?.daily_usage ?? input?.daily_usage ?? null
  // A candidate with no line yet hasn't had anything ordered, so "after"
  // is just "now" until a qty is actually added.
  const dosNow = line?.dos_before ?? daysOfSupply(onHand, dailyUsage)
  const dosAfter = line?.dos_after ?? dosNow
  const why = line?.triggered_smoothing ? 'triggered smoothing'
    : line?.added_by_smoothing ? 'added to reach minimum'
    : 'not on order'
  const whyClass = line?.triggered_smoothing ? 'text-[#C0392B]'
    : line?.added_by_smoothing ? 'text-sky'
    : 'text-inky/40'

  return (
    <tr className="border-t border-navy/10">
      <td className="py-1 text-navy">{productId}</td>
      <td className="text-inky/70">{uom ?? '—'}</td>
      <td className="text-right text-inky/70">{num(capacity, 0)}</td>
      <td className="text-right text-inky/70">
        {num(input?.own_on_hand ?? onHand)}
        {input?.equivalent_products && input.equivalent_products.length > 0 && (
          <div className="text-[9px] text-inky/50 leading-tight font-normal">
            {input.equivalent_products.some((e) => e.used) && (
              <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
            )}
            {input.equivalent_products.map((e) => (
              <div key={e.product_id}
                title={e.used ? undefined : 'Not used in the order calculation — on-hand is high relative to usage here, likely stale or not actually on hand at this shop'}>
                {e.product_id}: {num(e.on_hand)}{!e.used && ' (not used)'}
              </div>
            ))}
          </div>
        )}
      </td>
      <td className="text-right text-inky/70">{num(dailyUsage)}</td>
      <td className="text-right text-inky/70">{dos(dosNow)}</td>
      <td className="text-right">
        {line ? (
          <input type="number" min={0} step={uom === 'bulk' ? 0.1 : 1} value={line.qty}
            onChange={(e) => onPatch(line.id, Number(e.target.value) || 0)}
            className="w-16 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
        ) : input ? (
          <input type="number" min={0} step={uom === 'bulk' ? 0.1 : 1} defaultValue="" placeholder="0"
            onBlur={(e) => { const v = Number(e.target.value) || 0; if (v > 0) onAdd(input, v) }}
            title="Add this product to the order"
            className="w-16 bg-transparent border border-navy/20 rounded px-1 py-0.5 text-right text-inky/60 focus:outline-none focus:ring-1 focus:ring-sky" />
        ) : null}
      </td>
      <td className="text-right text-inky/70">{dos(dosAfter)}</td>
      <td className="text-right text-navy">{money(line ? Number(line.qty) * unitCost : 0)}</td>
      <td className={whyClass}>{why}</td>
    </tr>
  )
}

export function Flags({ flags }: { flags: LineFlag[] }) {
  if (!flags?.length) return <span className="text-inky/25">—</span>
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {flags.map((f) => {
        const meta = FLAG_META[f]
        if (!meta) return null
        return (
          <span key={f} title={meta.title}
            className={`rounded border px-1 py-0.5 text-[9px] whitespace-nowrap ${FLAG_CLASS[meta.tone]}`}>
            {meta.label}
          </span>
        )
      })}
    </span>
  )
}

/** Decision row for a covered_by_open_po line — Order Anyway / Exclude /
 * Combine, whichever's already chosen (if any) highlighted. Never picks a
 * default on its own; the line just sits at its normal suggested qty until
 * someone decides. */
function PoDecisionButtons({ line, onOverride, onExclude, onCombine }: {
  line: DraftLineRow
  onOverride: (l: DraftLineRow) => void
  onExclude: (l: DraftLineRow) => void
  onCombine: (l: DraftLineRow) => void
}) {
  const flags = (line.flags ?? []) as LineFlag[]
  const chosen = PO_DECISION_FLAGS.find((f) => flags.includes(f))
  const btnCls = (active: boolean) =>
    `text-[9px] rounded border px-1 py-0.5 whitespace-nowrap ${active ? 'bg-sky text-navy border-sky' : 'border-navy/25 text-inky hover:border-navy'}`
  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      <button title="Order the full suggested quantity anyway" className={btnCls(chosen === 'po_decision_override')} onClick={() => onOverride(line)}>
        Order anyway
      </button>
      <button title="The open PO already covers this — exclude from the order" className={btnCls(chosen === 'po_decision_exclude')} onClick={() => onExclude(line)}>
        Exclude
      </button>
      <button title="Factor the open PO's outstanding quantity into on-hand and re-target the quantity" className={btnCls(chosen === 'po_decision_combine')} onClick={() => onCombine(line)}>
        Combine
      </button>
    </div>
  )
}
