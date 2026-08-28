import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RefreshCw, ChevronRight, ChevronDown } from 'lucide-react'
import { Button, Card, CardBody, Input, SbLoader, Toggle } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  useDraft, useGenerationData, useOrderSettings, useVendorRules,
  buildGenerationInputs, eligibleLocations, draftOrderDow, shopsPerOrderDay, type DraftLineRow,
} from './useOrdersV2'
import { useVendors } from './useLookups'
import { generateOrder, nextDeliveryDate, resolveDeliveryDate, dosAfterDelivery, gallonsPerUnit, resolvedOrderType, daysOfSupply, daysBetween } from './engine'
import { FLAG_CLASS, FLAG_META, OVERRIDE_CELL, dos, money, num } from './shared'
import type { LineFlag, GenerationInput } from './types'

type SortKey = 'location' | 'capacity' | 'product' | 'qty' | 'dollars' | 'dos_after'

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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

  const [generating, setGenerating] = useState(false)
  const [showVmi, setShowVmi] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('location')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [skipped, setSkipped] = useState<{ location_id: string; product_id: string; reason: string }[]>([])
  const [dayCounts, setDayCounts] = useState<number[]>([0, 0, 0, 0, 0, 0, 0])
  // Every candidate the engine considered for this run, not just the ones
  // that made it onto the draft — the smoothing panel needs the shop's
  // full config (including products it decided NOT to order) to show what
  // else could be pulled in, not just what already is.
  const [allInputs, setAllInputs] = useState<GenerationInput[]>([])
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
      const inputs = buildGenerationInputs(configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand)
      setAllInputs(inputs)
      const result = generateOrder(inputs, {
        settings,
        vendor: rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name),
        orderDate: draft.order_date,
        eligibleLocationIds: eligibleLocations(days, rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays, draft.order_date, useDow),
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

      const withDelivery = result.lines.map((l) => {
        const rule = ruleByKey.get(`${l.location_id}|${l.product_id}`)
        const deliver = deliveryFor(l.location_id, draft.order_date)
        const gallons = rule ? l.qty * gallonsPerUnit(rule) : 0
        const flags = runOutKeys.has(`${l.location_id}|${l.product_id}`) && !l.flags.includes('keepfill_will_run_out')
          ? [...l.flags, 'keepfill_will_run_out' as const] : l.flags
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

  const groupDollars = useCallback(
    (ls: DraftLineRow[]) => ls.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0),
    [],
  )

  const overrideCount = useMemo(() => lines.filter((l) => l.is_override).length, [lines])
  const overridesByShop = useMemo(() => {
    const m = new Map<string, number>()
    for (const l of lines) if (l.is_override) m.set(l.location_id ?? '', (m.get(l.location_id ?? '') ?? 0) + 1)
    return m
  }, [lines])

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

  // Every candidate the engine saw for a shop/order-type, whether or not it
  // ended up on the draft — what the smoothing panel below shows per shop.
  const inputsByGroup = useMemo(() => {
    const m = new Map<string, GenerationInput[]>()
    for (const i of allInputs) {
      const k = `${i.location_id}|${resolvedOrderType(i.rule)}`
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(i)
    }
    return m
  }, [allInputs])

  // Same, but keyed by shop alone (spans every order type) — for "expand
  // this shop to everything configured for it", not just the group already
  // on screen.
  const inputsByLocation = useMemo(() => {
    const m = new Map<string, GenerationInput[]>()
    for (const i of allInputs) {
      if (!m.has(i.location_id)) m.set(i.location_id, [])
      m.get(i.location_id)!.push(i)
    }
    return m
  }, [allInputs])

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
                      <Td>
                        {l.product_id}
                        {l.added_by_smoothing && <span className="ml-1 text-[9px] text-sky" title="Added to reach the order minimum">+min</span>}
                      </Td>
                      <Td>{l.uom ?? '—'}</Td>
                      <Td align="right">{num(l.max_capacity_gallons, 0)}</Td>
                      <Td align="right">{num(l.on_hand)}</Td>
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
                      <Td><Flags flags={(l.flags ?? []) as LineFlag[]} /></Td>
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
                          <table className="w-full text-[11px] font-mono">
                            <thead><tr className="text-inky/60 uppercase">
                              <td className="py-1">Product</td><td>UOM</td>
                              <td className="text-right">Capacity</td><td className="text-right">On Hand</td>
                              <td className="text-right">Usage/Day</td><td className="text-right">DOS Now</td>
                              <td className="text-right">Qty</td><td className="text-right">DOS After</td>
                              <td className="text-right">$</td><td>Why</td>
                            </tr></thead>
                            <tbody>
                              {shopRows(locId).map((r) => (
                                <SmoothingRow key={r.line?.id ?? r.input?.product_id}
                                  input={r.input} line={r.line}
                                  onPatch={(id, qty) => patchLine(id, { qty })} onAdd={addConfiguredProduct} />
                              ))}
                            </tbody>
                          </table>
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

      {/* Per-shop smoothing transparency */}
      {[...groups.entries()].some(([, ls]) => ls.some((l) => l.triggered_smoothing || l.added_by_smoothing)) && (
        <Card><CardBody className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Smoothing detail</span>
          <p className="text-[11px] font-mono text-inky/60">
            These shops came in under their order minimum after the first pass. Expand to see every product in the
            shop's config and which one(s) triggered the top-up.
          </p>
          {[...groups.entries()]
            .filter(([, ls]) => ls.some((l) => l.triggered_smoothing || l.added_by_smoothing))
            .sort(([a], [b]) => shopLabel(a.split('|')[0]).localeCompare(shopLabel(b.split('|')[0]), undefined, { numeric: true }))
            .map(([key, ls]) => {
              const [locId, type] = key.split('|')
              const open = expanded.has(key)

              // The shop's full config for this order type — including
              // products the engine decided NOT to order — not just what
              // landed on the draft, so "what else could close the gap" is
              // visible alongside what already did.
              const candidates = inputsByGroup.get(key) ?? []
              const lineByProduct = new Map(ls.map((l) => [l.product_id, l]))
              const candidateIds = new Set(candidates.map((c) => c.product_id))
              const rows: { input?: GenerationInput; line?: DraftLineRow }[] =
                candidates.map((c) => ({ input: c, line: lineByProduct.get(c.product_id) }))
              for (const l of ls) if (!candidateIds.has(l.product_id)) rows.push({ line: l })
              // Actionable rows first (what caused the shortfall, what was
              // pulled in to close it), then everything else alphabetically.
              rows.sort((ra, rb) => {
                const rank = (r: typeof ra) => (r.line?.triggered_smoothing ? 0 : r.line?.added_by_smoothing ? 1 : 2)
                const d = rank(ra) - rank(rb)
                if (d !== 0) return d
                return (ra.line?.product_id ?? ra.input?.product_id ?? '').localeCompare(rb.line?.product_id ?? rb.input?.product_id ?? '')
              })

              return (
                <div key={key} className="rounded border border-navy/20">
                  <button onClick={() => setExpanded((p) => { const n = new Set(p); n.has(key) ? n.delete(key) : n.add(key); return n })}
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-xs font-mono text-navy hover:bg-navy/5">
                    {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                    {shopLabel(locId)} · {type} · {money(groupDollars(ls))}
                    {overridesByShop.get(locId) ? <span className="text-[#E67E22]">({overridesByShop.get(locId)} override)</span> : null}
                  </button>
                  {open && (
                    <div className="px-3 pb-2">
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
                            <SmoothingRow key={r.line?.id ?? r.input?.product_id}
                              input={r.input} line={r.line}
                              onPatch={(id, qty) => patchLine(id, { qty })} onAdd={addConfiguredProduct} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )
            })}
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
      <td className="text-right text-inky/70">{num(onHand)}</td>
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
