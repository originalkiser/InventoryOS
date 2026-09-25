import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Copy, Download, Settings } from 'lucide-react'
import toast from 'react-hot-toast'
import { createColumnHelper } from '@tanstack/react-table'
import { Button, Card, CardBody, Modal, Toggle } from '@/components/ui'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { DataTable } from '@/components/shared/DataTable'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { parseWeekday, orderDayFromDelivery } from '@/lib/orderDay'
import { supabase } from '@/lib/supabase'
import { useDraft, useOrderSettings, useVendorRules, isOunceUnit, type DraftLineRow } from './useOrdersV2'
import { useVendors } from './useLookups'
import { useLastOrderedInfo } from './useLastOrderedInfo'
import { Flags } from './OrdersV2Review'
import { OrderStepper } from './OrderStepper'
import { daysOfSupply, daysBetween, nextDeliveryDate, resolveDeliveryDate } from './engine'
import { OVERRIDE_CELL, dos, dShort, money, num, copyTableToClipboard, exportTableCsv, dosAfterForQty, type TableCol } from './shared'
import type { LineFlag, OrderType, DeliverySchedule, WeekCalendar } from './types'

// The 3 simplified rollup buckets this app already uses for Month End's own
// Oil/Parts/Additives/Other breakdown (CategorySimplificationTab.tsx,
// inventory.category_simplification — company-scoped raw category -> one of
// these 3, or blank/unmapped which reads as "Other" here). Duplicated as a
// tiny local helper rather than importing that tab's own module-private
// function, since it isn't exported and this is a 4-line normalize.
const SIMPLE_CATS = ['Parts', 'Oil', 'Additives'] as const
type SimpleCat = (typeof SIMPLE_CATS)[number]
function normalizeSimpleCategory(raw: string | null | undefined): SimpleCat | null {
  const t = (raw ?? '').trim().toLowerCase()
  if (!t) return null
  return SIMPLE_CATS.find((c) => c.toLowerCase() === t) ?? null
}
const CATEGORY_ORDER = ['Oil', 'Parts', 'Additives', 'Other'] as const
type OrderCategory = (typeof CATEGORY_ORDER)[number]

const shopSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Step 3 — everything across all shops, plus the summaries that decide
 * whether the order is ready: which shops fell short of their minimum, the
 * biggest and smallest orders, and anything stocked out.
 */
export function OrdersV2FinalReview() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const loc = useLocations()
  const vendors = useVendors()
  const { profile } = useAuthStore()
  const { settings } = useOrderSettings()
  const { rulesFor } = useVendorRules()
  const { draft, lines, loading, patchLine, removeLine } = useDraft(draftId || null)
  // Same Last Ordered/Last Delivered + on-hand plausibility flag as
  // OrdersV2Review — see that hook's own header comment for scope/design.
  const lastOrderedInfo = useLastOrderedInfo(draft?.vendor_id ?? null, vendors.byId(draft?.vendor_id ?? null)?.name ?? null)

  const [openShop, setOpenShop] = useState<{ locationId: string; orderType: OrderType } | null>(null)
  // Direct ask (2026-09-24) — jump straight to the lines the engine
  // deliberately ordered past configured capacity to reach the DOS target
  // (engine.ts's exceedsCapacityForTarget), so the amount can be verified.
  const [showOnlyOverCapacity, setShowOnlyOverCapacity] = useState(false)
  const [columnManagerOpen, setColumnManagerOpen] = useState(false)

  // Per-product category (inventory.product_usage.category) -> this app's
  // own Oil/Parts/Additives simplified bucket (inventory.category_simplification,
  // see Month End's CategorySimplificationTab.tsx/OverviewTab.tsx — the same
  // rollup this app already uses elsewhere for an Oil/Parts/Additives/Other
  // breakdown). Keyed on [lines] rather than a stable product-id list, same
  // trade-off this file's own pre-existing ozProductIds effect already
  // accepts (re-fetches on every qty edit, not just when the product set
  // changes) — kept consistent with that established pattern rather than
  // introducing a different dependency shape for a second, very similar fetch.
  const [categoryByProduct, setCategoryByProduct] = useState<Map<string, string>>(new Map())
  const [simpleByCategory, setSimpleByCategory] = useState<Map<string, SimpleCat>>(new Map())
  useEffect(() => {
    if (!profile?.company_id) return
    const productIds = [...new Set(lines.map((l) => l.product_id))]
    if (!productIds.length) { setCategoryByProduct(new Map()); setSimpleByCategory(new Map()); return }
    let cancelled = false
    const sbi = supabase as any
    Promise.all([
      sbi.schema('inventory').from('product_usage').select('product_id, category')
        .eq('company_id', profile.company_id).in('product_id', productIds),
      sbi.schema('inventory').from('category_simplification').select('category, simple_category')
        .eq('company_id', profile.company_id),
    ]).then(([puRes, csRes]: any[]) => {
      if (cancelled) return
      const catMap = new Map<string, string>()
      for (const r of (puRes.data ?? []) as { product_id: string; category: string | null }[]) {
        if (r.category && !catMap.has(r.product_id)) catMap.set(r.product_id, r.category)
      }
      setCategoryByProduct(catMap)
      const simpleMap = new Map<string, SimpleCat>()
      for (const r of (csRes.data ?? []) as { category: string; simple_category: string | null }[]) {
        const s = normalizeSimpleCategory(r.simple_category)
        if (s) simpleMap.set(r.category, s)
      }
      setSimpleByCategory(simpleMap)
    })
    return () => { cancelled = true }
  }, [profile?.company_id, lines])
  const simpleCategoryOf = useCallback((productId: string): OrderCategory => {
    const raw = categoryByProduct.get(productId)
    const s = raw ? simpleByCategory.get(raw) : undefined
    return s ?? 'Other'
  }, [categoryByProduct, simpleByCategory])

  // Display-only ounce conversion for a product tracked that way (e.g.
  // HM0806, global_products.unit_of_measure = "Ounces") — same purpose as
  // OrdersV2Review's own ozProductIds, re-derived here since this page
  // doesn't otherwise fetch global_products. The underlying quarts math
  // (dos_after, dollars, capacity/minimum checks) is untouched; only the
  // qty-in-ounces annotation and Daily Usage display change.
  const [ozProductIds, setOzProductIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    const productIds = [...new Set(lines.map((l) => l.product_id))]
    if (!productIds.length) { setOzProductIds(new Set()); return }
    let cancelled = false
    ;(supabase as any).schema('inventory').from('global_products')
      .select('product_id, unit_of_measure').in('product_id', productIds)
      .then(({ data }: any) => {
        if (cancelled) return
        setOzProductIds(new Set((data ?? []).filter((g: any) => isOunceUnit(g.unit_of_measure)).map((g: any) => g.product_id)))
      })
    return () => { cancelled = true }
  }, [lines])

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  // A hand-edited qty updates DOS After the same way generation would have
  // computed it for that qty — was previously frozen at whatever
  // generation produced, silently going stale the moment someone typed a
  // different number. DOS @ Delivery is unaffected — it's existing on-hand
  // only, independent of qty (see dosAfterForQty's own comment).
  //
  // Also flips `included` the same way buildLine() itself decides it for a
  // freshly-generated line (included = units > 0), except for a genuine
  // VMI/keep-fill line — see OrdersV2Review.tsx's own patchQty for the full
  // reasoning (found live 2026-09-24 from Valvoline's new always-list-every-
  // configured-product qty:0/included:false placeholder rows).
  const patchQty = useCallback((l: DraftLineRow, qty: number) => {
    const isVmi = l.flags?.includes('vmi_keepfill')
    patchLine(l.id, { qty, dos_after: dosAfterForQty(l, qty), ...(isVmi ? {} : { included: qty > 0 }) })
  }, [patchLine])

  const vendorRules = useMemo(() => rulesFor(draft?.vendor_id ?? null, settings, vendors.byId(draft?.vendor_id ?? null)?.name),
    [rulesFor, draft?.vendor_id, settings, vendors])

  /** Per shop x order type: dollars, minimum, and whether it clears. */
  const groups = useMemo(() => {
    const m = new Map<string, { locationId: string; orderType: OrderType; lines: DraftLineRow[]; dollars: number; minimum: number }>()
    for (const l of lines) {
      if (!l.included) continue
      const key = `${l.location_id}|${l.order_type}`
      if (!m.has(key)) {
        m.set(key, {
          locationId: l.location_id ?? '', orderType: l.order_type, lines: [], dollars: 0,
          minimum: vendorRules.minimums[l.order_type]?.dollars
            ?? (l.order_type === 'bulk' ? settings.order_minimum_dollars_bulk : settings.order_minimum_dollars_package),
        })
      }
      const g = m.get(key)!
      g.lines.push(l)
      g.dollars += Number(l.qty) * Number(l.unit_cost ?? 0)
    }
    return [...m.values()]
  }, [lines, vendorRules, settings])

  const fallouts = useMemo(() => groups.filter((g) => g.dollars < g.minimum), [groups])
  const ranked = useMemo(() => [...groups].sort((a, b) => b.dollars - a.dollars), [groups])
  const top3 = ranked.slice(0, 3)
  const bottom3 = ranked.slice(-3).reverse()

  // RelaDyne-only (see OrdersV2Settings.tsx) — a shop with no delivery day
  // set falls back to '—' rather than a guess. loc.byId already has this —
  // no new fetch needed for THIS fallback (deliveryFor's own else-branch,
  // below, uses it too).
  const deliveryDowOf = useCallback((id: string | null) => parseWeekday(loc.byId(id ?? '')?.reladyne_delivery_day as string | undefined), [loc])
  const orderDayOf = useCallback((id: string | null) => orderDayFromDelivery(loc.byId(id ?? '')?.reladyne_delivery_day as string | undefined) || '—', [loc])

  // Per-shop delivery schedules (Valvoline and anything else that isn't a
  // single company-wide weekday) + the uploaded A/B week calendar — direct
  // feedback 2026-09-25 ("add the delivery date column to Final Review
  // too"). Found while wiring this up: this page's own outOfStock/
  // deliveryDowOf were RelaDyne-only from the start (this page's own prior
  // comment said so outright — "a non-RelaDyne vendor... has neither an
  // order day nor a computable delivery date here"), so Out of Stock's own
  // days-to-delivery/quarts-needed numbers were silently always null for
  // Valvoline. A small standalone fetch (not the full fetchInputs — this
  // page already has `lines` via useDraft and doesn't need configs/usage/
  // etc.) mirrors OrdersV2Review.tsx's own deliveryLookup/deliveryFor/
  // describeSchedule exactly, so both pages agree.
  const [scheduleLookup, setScheduleLookup] = useState<{ schedules: Map<string, DeliverySchedule>; calendar: WeekCalendar }>({ schedules: new Map(), calendar: new Map() })
  useEffect(() => {
    if (!draft?.vendor_id) { setScheduleLookup({ schedules: new Map(), calendar: new Map() }); return }
    let cancelled = false
    const sb = supabase as any
    Promise.all([
      sb.schema('inventory').from('ov2_location_schedules').select('*').eq('vendor_id', draft.vendor_id),
      sb.schema('inventory').from('ov2_delivery_calendar').select('week_start, week_label').eq('vendor_id', draft.vendor_id),
    ]).then(([{ data: schedRows }, { data: calRows }]: any[]) => {
      if (cancelled) return
      const schedules = new Map<string, DeliverySchedule>()
      for (const r of (schedRows ?? [])) {
        schedules.set(r.location_id, {
          type: r.schedule_type, delivery_dow: r.delivery_dow,
          week_a_dow: r.week_a_dow, week_b_dow: r.week_b_dow,
          lead_business_days: Number(r.lead_business_days ?? 4),
        })
      }
      const calendar: WeekCalendar = new Map((calRows ?? []).map((c: any) => [String(c.week_start).slice(0, 10), c.week_label as 'A' | 'B']))
      setScheduleLookup({ schedules, calendar })
    })
    return () => { cancelled = true }
  }, [draft?.vendor_id])
  const deliveryFor = useCallback((locationId: string | null, fromDate: string): string | null => {
    const sched = scheduleLookup.schedules.get(locationId ?? '')
    return sched
      ? resolveDeliveryDate(fromDate, sched, scheduleLookup.calendar)
      : nextDeliveryDate(fromDate, deliveryDowOf(locationId))
  }, [scheduleLookup, deliveryDowOf])
  const describeSchedule = useCallback((locationId: string | null): string | null => {
    const sched = scheduleLookup.schedules.get(locationId ?? '')
    if (sched) {
      if (sched.type === 'plus_business_days') return `+${sched.lead_business_days} business days`
      if (sched.type === 'week_ab') {
        return `A: ${sched.week_a_dow == null ? '—' : DOW[sched.week_a_dow]} · B: ${sched.week_b_dow == null ? '—' : DOW[sched.week_b_dow]} (${sched.lead_business_days}d lead)`
      }
      return `${sched.delivery_dow == null ? '—' : DOW[sched.delivery_dow]} weekly (${sched.lead_business_days}d lead)`
    }
    const dow = deliveryDowOf(locationId)
    return dow != null ? `${DOW[dow]} (Reladyne delivery day)` : null
  }, [scheduleLookup, deliveryDowOf])

  const outOfStock = useMemo(() => {
    const rows = lines.filter((l) => (l.flags ?? []).includes('stocked_out' as LineFlag)).map((l) => {
      const deliver = draft ? deliveryFor(l.location_id, draft.order_date) : null
      const daysToDelivery = draft && deliver ? daysBetween(draft.order_date, deliver) : null
      // How many quarts would it take to bridge this shop to its upcoming
      // delivery on current on-hand/usage — on-hand is already ~0 here (the
      // whole point of "out of stock"), so this is essentially the usage
      // expected between now and delivery, less whatever's still on hand.
      const quartsNeeded = daysToDelivery != null
        ? Math.max(0, Number(l.daily_usage ?? 0) * daysToDelivery - Number(l.on_hand ?? 0))
        : null
      return { line: l, orderDay: orderDayOf(l.location_id), quartsNeeded }
    })
    return rows.sort((a, b) => shopSort(shopLabel(a.line.location_id), shopLabel(b.line.location_id)))
  }, [lines, draft, deliveryFor, orderDayOf, shopLabel])

  // Cached at generation time (OrdersV2Review.tsx) from the tank monitor's
  // on-hand — a keep-fill product needing attention regardless of whether
  // it cleared the standard reorder trigger and became a line at all.
  const keepfillAlertsRaw = useMemo(() => ((draft?.settings_snapshot as any)?.__keepfill_alerts ?? []) as {
    location_id: string; product_id: string; on_hand: number | null; daily_usage: number | null
    runway_days: number | null; next_delivery: string | null; delivery_after_next: string | null
    no_tank_data: boolean; will_run_out: boolean
  }[], [draft?.settings_snapshot])
  // Red: will run dry before the UPCOMING delivery — the most urgent case,
  // nothing but a keep-fill order today prevents a real stockout. Orange:
  // covered until the upcoming delivery, but won't last to the one after
  // it — still needs a keep-fill order placed soon, just not today.
  // Every row here already cleared the generation-time filter (will_run_out
  // vs the FURTHER of the two dates, or no tank data at all), so every one
  // lands in exactly one of these tiers — see the comment on that filter in
  // OrdersV2Review.tsx for why next_delivery <= delivery_after_next makes
  // that guarantee hold.
  const keepfillAlerts = useMemo(() => {
    const rows = keepfillAlertsRaw
      .filter((a) => !!a.location_id)
      .map((a) => {
        const daysToNext = draft && a.next_delivery ? daysBetween(draft.order_date, a.next_delivery) : null
        const daysToAfterNext = draft && a.delivery_after_next ? daysBetween(draft.order_date, a.delivery_after_next) : null
        const tier: 'red' | 'orange' | 'unknown' = a.no_tank_data
          ? 'unknown'
          : a.runway_days != null && daysToNext != null && a.runway_days < daysToNext
            ? 'red'
            : 'orange'
        return { alert: a, tier, orderDay: orderDayOf(a.location_id) }
      })
    return rows.sort((a, b) => shopSort(shopLabel(a.alert.location_id), shopLabel(b.alert.location_id)))
  }, [keepfillAlertsRaw, draft, orderDayOf, shopLabel])

  const outOfStockCols: TableCol<(typeof outOfStock)[number]>[] = [
    { label: 'Shop', get: (r) => shopLabel(r.line.location_id) },
    { label: 'Order Day', get: (r) => r.orderDay },
    { label: 'Product', get: (r) => r.line.product_id },
    { label: 'Usage/day', get: (r) => num(r.line.daily_usage), align: 'right' },
    { label: 'Order Qty', get: (r) => num(r.line.qty), align: 'right' },
    { label: 'DOS After Delivery', get: (r) => dos(r.line.dos_after_delivery), align: 'right' },
    { label: 'Qt Needed to Bridge', get: (r) => (r.quartsNeeded != null ? num(r.quartsNeeded, 1) : '—'), align: 'right' },
  ]
  const copyOutOfStock = async () => {
    const ok = await copyTableToClipboard(`Out of Stock — ${vendors.byId(draft?.vendor_id ?? null)?.name ?? ''} ${draft?.order_date ?? ''}`, outOfStockCols, outOfStock)
    ok ? toast.success('Copied to clipboard') : toast.error('Copy failed')
  }
  const exportOutOfStock = () => exportTableCsv(`out-of-stock-${draft?.order_date ?? ''}`, outOfStockCols, outOfStock)

  const keepfillCols: TableCol<(typeof keepfillAlerts)[number]>[] = [
    { label: 'Shop', get: (r) => shopLabel(r.alert.location_id) },
    { label: 'Order Day', get: (r) => r.orderDay },
    { label: 'Product', get: (r) => r.alert.product_id },
    { label: 'On Hand', get: (r) => (r.alert.on_hand != null ? num(r.alert.on_hand) : '—'), align: 'right' },
    { label: 'Usage/day', get: (r) => num(r.alert.daily_usage), align: 'right' },
    { label: 'Runway (days)', get: (r) => (r.alert.runway_days != null ? num(r.alert.runway_days, 1) : '—'), align: 'right' },
    { label: 'Next Delivery', get: (r) => (r.alert.next_delivery ? dShort(r.alert.next_delivery) : '—') },
    { label: 'Issue', get: (r) => (r.alert.no_tank_data ? 'No tank monitor data' : r.tier === 'red' ? 'Will run dry before upcoming delivery' : 'Will run dry before next delivery after that') },
  ]
  const copyKeepfill = async () => {
    const ok = await copyTableToClipboard(`Keep-fill / VMI Needs Attention — ${vendors.byId(draft?.vendor_id ?? null)?.name ?? ''} ${draft?.order_date ?? ''}`, keepfillCols, keepfillAlerts)
    ok ? toast.success('Copied to clipboard') : toast.error('Copy failed')
  }
  const exportKeepfill = () => exportTableCsv(`keepfill-needs-attention-${draft?.order_date ?? ''}`, keepfillCols, keepfillAlerts)

  const total = useMemo(
    () => lines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0),
    [lines],
  )

  // Summary totals by Oil/Parts/Additives/Other (2026-09-24 ask) — cases
  // (qty), gallons, quarts, and $ ordered, only counting INCLUDED lines
  // (matches `total`/the group dollars above, which also only ever count
  // what's actually going on the order). "Cases" here is just each line's
  // own qty — for a bulk line that reads as gallons/qty-of-the-bulk-unit
  // rather than a literal case count, since this app doesn't have a
  // separate "case count" concept for bulk; flagged as an assumption.
  const categoryTotals = useMemo(() => {
    const blank = () => ({ cases: 0, gallons: 0, quarts: 0, dollars: 0 })
    const totals: Record<OrderCategory, { cases: number; gallons: number; quarts: number; dollars: number }> = {
      Oil: blank(), Parts: blank(), Additives: blank(), Other: blank(),
    }
    for (const l of lines) {
      if (!l.included) continue
      const t = totals[simpleCategoryOf(l.product_id)]
      const qty = Number(l.qty) || 0
      const per = Number(l.quarts_per_unit ?? 0)
      t.cases += qty
      t.quarts += qty * per
      t.gallons += (qty * per) / 4
      t.dollars += qty * Number(l.unit_cost ?? 0)
    }
    return totals
  }, [lines, simpleCategoryOf])
  const categoryGrandTotal = useMemo(() => {
    const g = { cases: 0, gallons: 0, quarts: 0, dollars: 0 }
    for (const cat of CATEGORY_ORDER) {
      g.cases += categoryTotals[cat].cases
      g.gallons += categoryTotals[cat].gallons
      g.quarts += categoryTotals[cat].quarts
      g.dollars += categoryTotals[cat].dollars
    }
    return g
  }, [categoryTotals])

  const dataForTable = useMemo(
    () => (showOnlyOverCapacity ? lines.filter((l) => (l.flags ?? []).includes('exceeded_capacity_for_dos_target' as LineFlag)) : lines),
    [lines, showOnlyOverCapacity],
  )

  const col = useMemo(() => createColumnHelper<DraftLineRow>(), [])
  const columns = useMemo(() => [
    col.accessor((l) => shopLabel(l.location_id), {
      id: 'shop', header: 'Shop', sortingFn: 'alphanumeric',
      cell: (i) => (
        <button onClick={() => setOpenShop({ locationId: i.row.original.location_id ?? '', orderType: i.row.original.order_type })}
          className="text-navy hover:underline">{i.getValue()}</button>
      ),
    }),
    col.accessor('product_id', { id: 'product', header: 'Product' }),
    col.accessor((l) => l.uom ?? '—', { id: 'uom', header: 'UOM' }),
    col.display({
      id: 'last_ordered', header: 'Last Ordered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
        return info.lastOrderDate ? (
          <>
            <div>{dShort(info.lastOrderDate)} · {num(info.lastOrderQty, 1)}{info.lastOrderUom ? ` ${info.lastOrderUom}` : ''}</div>
            {info.eta && <div className="text-[9px] text-inky/50">ETA {dShort(info.eta)}</div>}
          </>
        ) : '—'
      },
    }),
    col.display({
      id: 'last_delivered', header: 'Last Delivered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
        return (
          <>
            {info.lastDeliveredDate
              ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)}${info.lastDeliveredUnit === 'gal' ? ' gal' : ''}`
              : '—'}
            {info.onHandCheck && !info.onHandCheck.withinRange && (
              <div className="text-[9px] text-[#C0392B] font-bold"
                title={`Based on the last delivery, on hand was expected to be roughly ${num(info.onHandCheck.expected)} (${num(info.onHandCheck.low)}–${num(info.onHandCheck.high)})`}>
                ⚠ On hand may be off
              </div>
            )}
          </>
        )
      },
    }),
    col.display({
      id: 'delivery_date', header: 'Delivery', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const dd = draft ? deliveryFor(l.location_id, draft.order_date) : null
        const sd = describeSchedule(l.location_id)
        return (
          <>
            <div>{dd ? dShort(dd) : '—'}</div>
            {sd && <div className="text-[9px] text-inky/50">{sd}</div>}
          </>
        )
      },
    }),
    col.accessor('qty', {
      id: 'qty', header: 'Qty', meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        return (
          <div className={l.is_override ? OVERRIDE_CELL : ''}>
            <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
              onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
              className="w-16 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
            {l.quarts_per_unit != null && (
              <div className="text-[10px] text-inky/50 mt-0.5">
                {ozProductIds.has(l.product_id)
                  ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)}oz`
                  : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`}
              </div>
            )}
          </div>
        )
      },
    }),
    col.accessor('dos_after', { id: 'dos_after', header: 'DOS After', cell: (i) => <span className="text-right block">{dos(i.getValue())}</span> }),
    col.accessor('dos_after_delivery', { id: 'dos_at_delivery', header: 'DOS @ Delivery', cell: (i) => <span className="text-right block">{dos(i.getValue())}</span> }),
    col.accessor((l) => Number(l.qty) * Number(l.unit_cost ?? 0), { id: 'dollars', header: '$', cell: (i) => <span className="text-right block">{money(i.getValue())}</span> }),
    col.display({
      id: 'flags', header: 'Flags', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        return (
          <>
            <Flags flags={(l.flags ?? []) as LineFlag[]} />
            {l.note && <div className="text-[10px] font-mono text-inky/60 italic mt-0.5">{l.note}</div>}
          </>
        )
      },
    }),
  ], [col, shopLabel, lastOrderedInfo, draft, deliveryFor, describeSchedule, patchQty, ozProductIds])

  const TABLE_KEY = 'orders-v2.final-review-lines'
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(dataForTable, columns, {
    persistKey: TABLE_KEY,
    initialPageSize: 50,
    initialSorting: [{ id: 'shop', desc: false }],
    initialColumnPinning: { left: ['shop'], right: [] },
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  const allColItems: ColItem[] = useMemo(
    () => table.getAllLeafColumns().map((c) => ({ id: c.id, label: String(c.columnDef.header ?? c.id) })),
    [table],
  )
  const shownOrder = useMemo(() => {
    const ids = table.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return ids
    const known = columnOrder.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !known.includes(id))]
  }, [table, columnOrder])
  function applyShownColumns(shown: string[]) {
    setColumnOrder(shown)
    const vis: Record<string, boolean> = {}
    for (const c of allColItems) vis[c.id] = shown.includes(c.id)
    table.setColumnVisibility(vis)
  }
  function resetColumns() {
    setColumnOrder([])
    table.setColumnVisibility({})
    table.setColumnSizing({})
    setColumnPinning({ left: ['shop'], right: [] })
  }

  // Alternates per shop (not per row) — makes it obvious at a glance whether
  // adjacent rows are one shop's multi-product order or a boundary between
  // two shops. Computed off the table's own current sorted/filtered/
  // paginated row order (table.getRowModel().rows — exactly what DataTable
  // is about to render), not a hand-sorted array, since rows are now
  // genuinely sortable by any column. Grouping is only guaranteed
  // contiguous under the default Shop sort; re-sorting by another column is
  // an accepted trade-off of making this table sortable at all — the band
  // still alternates on every shop change in whatever order is on screen,
  // it just won't read as a clean "one band per shop" grouping anymore.
  const pageRows = table.getRowModel().rows
  const bandOf = new Map<string, boolean>()
  {
    let prevShop: string | null = null
    let band = false
    for (const r of pageRows) {
      const shopId = r.original.location_id
      if (shopId !== prevShop) { band = !band; prevShop = shopId }
      bandOf.set(r.original.id, band)
    }
  }

  if (loading) {
    return (
      <LoadingProgress
        fraction={null}
        countText="Loading final review…"
        messages={['Checking order minimums…', 'Rounding up fallouts…', 'Sorting shops…']}
      />
    )
  }
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found.</p>

  const modalLines = openShop
    ? lines.filter((l) => l.location_id === openShop.locationId && l.order_type === openShop.orderType)
    : []
  const openMinimum = openShop
    ? (vendorRules.minimums[openShop.orderType]?.dollars
      ?? (openShop.orderType === 'bulk' ? settings.order_minimum_dollars_bulk : settings.order_minimum_dollars_package))
    : 0
  const modalTotal = modalLines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0)
  const modalBelowMin = openMinimum > 0 && modalTotal < openMinimum

  return (
    <div className="flex flex-col gap-4">
      <OrderStepper draftId={draft.id} current="final" />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Button size="sm" variant="muted" onClick={() => navigate(`/orders-v2/draft/${draft.id}`)} className="mb-1">← Review</Button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Final Review</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendors.byId(draft.vendor_id)?.name ?? 'All vendors'} · {groups.length} order{groups.length !== 1 ? 's' : ''} · {money(total)}
          </p>
        </div>
        <Button size="sm" onClick={() => navigate(`/orders-v2/draft/${draft.id}/export`)}>
          Continue to Export →
        </Button>
      </div>

      {/* Summaries */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Under minimum after smoothing</span>
          <span className={`text-2xl font-heading font-bold ${fallouts.length ? 'text-[#C0392B]' : 'text-navy'}`}>{fallouts.length}</span>
          {fallouts.length > 0 && (
            <div className="max-h-24 overflow-auto text-[11px] font-mono text-inky/70 mt-1">
              {fallouts.map((g) => (
                <button key={`${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
                  className="block text-left hover:text-navy hover:underline">
                  {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)} of {money(g.minimum)}
                </button>
              ))}
            </div>
          )}
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Largest orders</span>
          {top3.map((g) => (
            <button key={`t-${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
              className="text-left text-[11px] font-mono text-navy hover:underline">
              {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)}
            </button>
          ))}
          {top3.length === 0 && <span className="text-[11px] font-mono text-inky/40">—</span>}
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Smallest orders</span>
          {bottom3.map((g) => (
            <button key={`b-${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
              className="text-left text-[11px] font-mono text-navy hover:underline">
              {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)}
            </button>
          ))}
          {bottom3.length === 0 && <span className="text-[11px] font-mono text-inky/40">—</span>}
        </CardBody></Card>
      </div>

      {/* Order totals by category — 2026-09-24 ask. Counts only lines
          currently included in the order, same convention as `total` above. */}
      <Card><CardBody className="flex flex-col gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Order totals by category</span>
        <div className="overflow-auto rounded border border-navy/20">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
              <th className="text-left px-2 py-1">Category</th>
              <th className="text-right px-2 py-1">Cases</th>
              <th className="text-right px-2 py-1">Gallons</th>
              <th className="text-right px-2 py-1">Quarts</th>
              <th className="text-right px-2 py-1">$</th>
            </tr></thead>
            <tbody>
              {CATEGORY_ORDER.map((cat) => (
                <tr key={cat} className="border-b border-navy/10">
                  <td className="px-2 py-1 text-navy">{cat}</td>
                  <td className="px-2 py-1 text-right text-navy">{num(categoryTotals[cat].cases)}</td>
                  <td className="px-2 py-1 text-right text-navy">{num(categoryTotals[cat].gallons, 1)}</td>
                  <td className="px-2 py-1 text-right text-navy">{num(categoryTotals[cat].quarts, 1)}</td>
                  <td className="px-2 py-1 text-right text-navy">{money(categoryTotals[cat].dollars)}</td>
                </tr>
              ))}
              <tr className="border-b border-navy/10 bg-navy/[0.04] font-bold">
                <td className="px-2 py-1 text-navy">Grand Total</td>
                <td className="px-2 py-1 text-right text-navy">{num(categoryGrandTotal.cases)}</td>
                <td className="px-2 py-1 text-right text-navy">{num(categoryGrandTotal.gallons, 1)}</td>
                <td className="px-2 py-1 text-right text-navy">{num(categoryGrandTotal.quarts, 1)}</td>
                <td className="px-2 py-1 text-right text-navy">{money(categoryGrandTotal.dollars)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-[10px] font-mono text-inky/50">
          "Other" covers anything not mapped to Oil/Parts/Additives in Config → Category Simplification (Month End),
          including any product with no usage category recorded at all. "Cases" is each line's own ordered qty —
          for a bulk line that reads as its own order unit, not a literal case count.
        </p>
      </CardBody></Card>

      {outOfStock.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Out of stock ({outOfStock.length})</span>
            <div className="flex gap-1.5">
              <button onClick={() => copyOutOfStock()} title="Copy table"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button onClick={() => exportOutOfStock()} title="Export CSV"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
          <p className="text-[11px] font-mono text-inky/60">Nothing on hand at generation time — shown separately since these are the most urgent lines.</p>
          <div className="overflow-auto max-h-56 rounded border border-navy/20">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Order Day</th>
                <th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">Usage/day</th><th className="text-right px-2 py-1">Order Qty</th>
                <th className="text-right px-2 py-1">DOS After Delivery</th>
                <th className="text-right px-2 py-1">Qt Needed to Bridge</th>
              </tr></thead>
              <tbody>
                {outOfStock.map(({ line: l, orderDay, quartsNeeded }) => (
                  <tr key={l.id} className="border-b border-navy/10">
                    <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{orderDay}</td>
                    <td className="px-2 py-1 text-navy">{l.product_id}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.daily_usage)}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.qty)}</td>
                    <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after_delivery)}</td>
                    <td className="px-2 py-1 text-right text-navy">{quartsNeeded != null ? num(quartsNeeded, 1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}

      {keepfillAlerts.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Keep-fill / VMI needs attention ({keepfillAlerts.length})</span>
            <div className="flex gap-1.5">
              <button onClick={() => copyKeepfill()} title="Copy table"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button onClick={() => exportKeepfill()} title="Export CSV"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
          <p className="text-[11px] font-mono text-inky/60">
            Vendor-managed inventory, tracked by tank monitor — not included in this order's total by default.
            <span className="text-[#C0392B] font-bold"> Red</span> won&apos;t last to the UPCOMING delivery —
            needs a keep-fill order now. <span className="text-[#E67E22] font-bold">Orange</span> makes it to the
            upcoming delivery but not the one after — plan a keep-fill order soon. Consider a keep-fill order to
            RelaDyne before then.
          </p>
          <div className="overflow-auto max-h-56 rounded border border-[#C0392B]/30">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Order Day</th>
                <th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">On Hand</th><th className="text-right px-2 py-1">Usage/day</th>
                <th className="text-right px-2 py-1">Runway (days)</th><th className="text-left px-2 py-1">Next Delivery</th>
                <th className="text-left px-2 py-1">Issue</th>
              </tr></thead>
              <tbody>
                {keepfillAlerts.map(({ alert: a, tier, orderDay }, i) => (
                  <tr key={`${a.location_id}|${a.product_id}|${i}`}
                    className={`border-b border-navy/10 ${tier === 'red' ? 'bg-[#C0392B]/10' : tier === 'orange' ? 'bg-[#E67E22]/10' : ''}`}>
                    <td className="px-2 py-1 text-navy">{shopLabel(a.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{orderDay}</td>
                    <td className="px-2 py-1 text-navy">{a.product_id}</td>
                    <td className="px-2 py-1 text-right text-navy">{a.on_hand != null ? num(a.on_hand) : '—'}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(a.daily_usage)}</td>
                    <td className="px-2 py-1 text-right text-navy">{a.runway_days != null ? num(a.runway_days, 1) : '—'}</td>
                    <td className="px-2 py-1 text-navy">{a.next_delivery ? dShort(a.next_delivery) : '—'}</td>
                    <td className={`px-2 py-1 font-bold ${tier === 'red' ? 'text-[#C0392B]' : tier === 'orange' ? 'text-[#E67E22]' : 'text-inky'}`}>
                      {a.no_tank_data ? 'No tank monitor data' : tier === 'red' ? 'Will run dry before upcoming delivery' : 'Will run dry before next delivery after that'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={`Final Review - ${vendors.byId(draft.vendor_id)?.name ?? 'order'} ${draft.order_date}`}
        getRowClassName={(l) => [l.included ? '' : 'opacity-45', bandOf.get(l.id) ? 'bg-navy/[0.035]' : ''].filter(Boolean).join(' ')}
        hideColumnControl
        actions={
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-mono text-inky whitespace-nowrap">
              <Toggle checked={showOnlyOverCapacity} onChange={setShowOnlyOverCapacity} size="sm" color="cyan" />
              Show only over-capacity lines
            </label>
            <button onClick={() => setColumnManagerOpen(true)}
              className="inline-flex items-center gap-1 text-[10px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy hover:text-navy whitespace-nowrap">
              <Settings className="w-3 h-3" /> Manage Columns
            </button>
          </div>
        }
      />
      <ColumnManagerModal
        open={columnManagerOpen}
        onClose={() => setColumnManagerOpen(false)}
        all={allColItems.filter((c) => c.id !== 'select')}
        shown={shownOrder.filter((id) => id !== 'select')}
        onChange={applyShownColumns}
        onReset={resetColumns}
        pinned={columnPinning.left ?? []}
        onPinChange={(left) => setColumnPinning({ left, right: [] })}
      />

      {/* Per-shop editor */}
      <Modal open={!!openShop} onClose={() => setOpenShop(null)}
        title={openShop ? `${shopLabel(openShop.locationId)} — ${openShop.orderType}` : ''} size="lg">
        {openShop && (
          <div className="flex flex-col gap-3">
            <div className="overflow-auto max-h-80 rounded border border-navy/20">
              <table className="w-full text-xs font-mono">
                <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                  <th className="text-left px-2 py-1">Product</th><th className="text-right px-2 py-1">Qty</th>
                  <th className="text-right px-2 py-1">Daily Usage</th>
                  <th className="text-right px-2 py-1">$</th><th className="text-right px-2 py-1">DOS After</th><th />
                </tr></thead>
                <tbody>
                  {modalLines.map((l) => (
                    <tr key={l.id} className={`border-b border-navy/10 ${l.included ? '' : 'opacity-45'}`}>
                      <td className="px-2 py-1 text-navy">{l.product_id}</td>
                      <td className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                        <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                          onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
                          className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                        {l.quarts_per_unit != null && (
                          <div className="text-[10px] text-inky/50 mt-0.5">
                            {ozProductIds.has(l.product_id)
                              ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)}oz`
                              : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right text-navy">{num(ozProductIds.has(l.product_id) && l.daily_usage != null ? l.daily_usage * 32 : l.daily_usage)}</td>
                      <td className="px-2 py-1 text-right text-navy">{money(Number(l.qty) * Number(l.unit_cost ?? 0))}</td>
                      <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after)}</td>
                      <td className="px-2 py-1 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => patchLine(l.id, { included: !l.included })}
                            className="text-[10px] border border-navy/30 rounded px-1 py-0.5 text-inky hover:border-navy">
                            {l.included ? 'Exclude' : 'Include'}
                          </button>
                          <button onClick={() => removeLine(l.id)} className="text-inky/40 hover:text-[#C0392B]">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span
                className={modalBelowMin ? 'text-[#C0392B] font-bold' : 'text-inky'}
                title={modalBelowMin ? `Order Total: ${money(modalTotal)}, -${money(openMinimum - modalTotal)} from minimum` : undefined}
              >
                Order total {money(modalTotal)}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setOpenShop(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
