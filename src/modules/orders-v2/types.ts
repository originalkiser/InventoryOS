// Orders v2 — shared types. Kept free of React/Supabase imports so the
// generation engine (engine.ts) stays a pure, testable module.

export type OrderType = 'package' | 'bulk'
export type DraftStatus = 'generating' | 'review' | 'final_review' | 'exported' | 'cancelled'

// Bulk is dispensed and can be ordered fractionally; everything else ships
// in discrete units and must be whole.
export const DISCRETE_UOMS = ['bay_box', 'case', 'drum'] as const
export const UOM_OPTIONS = [...DISCRETE_UOMS, 'bulk'] as const
export type Uom = (typeof UOM_OPTIONS)[number]
export const UOM_LABELS: Record<string, string> = {
  bay_box: 'Bay Box', case: 'Case', drum: 'Drum', bulk: 'Bulk',
}
export const isBulkUom = (uom: string | null | undefined) => (uom ?? '').toLowerCase() === 'bulk'
export const orderTypeOf = (uom: string | null | undefined): OrderType => (isBulkUom(uom) ? 'bulk' : 'package')

// Best-effort canonicalization of a location_order_config's own free-text
// UOM label (e.g. "Bay. Boxes", "55 Gallon Drums") down to one of this
// app's own fixed Uom values, so it matches whatever a vendor's own
// case-type minimum was actually configured against (DISCRETE_UOMS/
// UOM_OPTIONS — picked from a fixed dropdown, never free text). A plain
// whitespace-only normalization left punctuation in ("Bay. Boxes" ->
// "bay._boxes"), which silently never matched the configured "bay_box"
// minimum key — found live 2026-09-24: a real Valvoline 6-bay-box minimum
// that never flagged despite genuinely being under it on every shop.
// Falls back to the old whitespace-only normalization for anything not
// recognizably one of the 3 discrete types, so bulk/other products
// already relying on their own raw label are untouched.
export function normalizeConfigUom(raw: string): string {
  const v = String(raw ?? '').toLowerCase()
  if (!v) return ''
  if (/box/.test(v)) return 'bay_box'
  if (/drum/.test(v)) return 'drum'
  if (/\bcase\b/.test(v)) return 'case'
  return v.replace(/\s+/g, '_')
}

// How an order minimum is expressed. 'dollars' and 'units_per_order' are
// both floors on the whole shop/order-type total (smoothed the same way,
// just counted in different currency — dollars vs. cases/units); the
// per-product variants are floors on each line instead (e.g. bulk must be
// at least N gallons of each product ordered).
export type MinimumType = 'dollars' | 'units_per_order' | 'units_per_product' | 'gallons_per_product'
export const MINIMUM_TYPE_LABELS: Record<MinimumType, string> = {
  dollars: '$ total for the order',
  units_per_order: 'units/cases total for the order',
  units_per_product: 'units per product',
  gallons_per_product: 'gallons per product',
}

export interface OrderMinimum {
  type: MinimumType
  dollars: number
  qty: number | null
}

export interface OrderSettings {
  days_of_supply_target: number
  days_of_supply_min_trigger: number
  // Soft ceiling — pass 1 respects it, smoothing may exceed it to reach a minimum.
  days_of_supply_max: number
  order_minimum_dollars_package: number
  order_minimum_dollars_bulk: number
  package_minimum_type: MinimumType
  package_minimum_qty: number | null
  bulk_minimum_type: MinimumType
  bulk_minimum_qty: number | null
  // Smoothing guard only: a product above this DOS is never pulled onto an
  // order purely to reach a minimum. It does not block a genuinely-due product.
  skip_order_if_dos_over: number
  // Repeat-ordering check. Sums the days of supply ordered across EVERY
  // order in the window: if we've sent 45+ days of supply in the last 30
  // days and the product still reads as low, either the shop isn't updating
  // on-hand or deliveries aren't arriving. Cumulative on purpose — a single
  // large order is not what we're looking for.
  flag_cumulative_days: number
  flag_cumulative_dos_over: number
  // Bulk order quantities round to the nearest multiple of this many
  // gallons (up when seeking a target/minimum, down when a hard cap binds —
  // same 'dir' convention as everywhere else). Replaces the old
  // decimal-places approach, which could land a bulk order on an arbitrary
  // fractional gallon figure no vendor actually ships in. 1 = whole
  // gallons. Cases/drums/bay boxes always order in whole units regardless.
  bulk_rounding_increment: number
  // A bulk per-product minimum (e.g. 55 real gallons — a drum) isn't always
  // worth rounding a shortfall up to, since the vendor won't ship a partial
  // drum anyway: a line whose own calculated demand is below this many real
  // gallons is skipped entirely (not ordered) rather than bumped to the
  // full minimum — UNLESS the shop's current days of supply is already
  // below bulk_urgent_dos_threshold, meaning it would likely run low again
  // before the next order cycle regardless, in which case the drum is
  // ordered early anyway. Only applies to bulk per-product minimums
  // (min.type 'gallons_per_product'/'units_per_product' on a bulk group) —
  // package per-product floors, and the dollar/units-per-order minimums,
  // are unaffected.
  bulk_round_up_threshold_gal: number
  bulk_urgent_dos_threshold: number
  // Direct ask (2026-09-24, widened to per-vendor 2026-09-25): when a shop's
  // configured physical capacity is what's holding a line short of
  // days_of_supply_target, order the full amount needed to reach the target
  // anyway rather than clamping to capacity (flagged — see
  // 'exceeded_capacity_for_dos_target' in engine.ts). Off by default per
  // vendor — a HUGE amount of this engine's own test suite (and every
  // downstream minimum/smoothing pass) is built on capacity being the one
  // truly hard, never-exceeded ceiling, so this is deliberately opt-in
  // rather than a blanket change to that guarantee. Only affects Pass 1's
  // own initial sizing toward the DOS target — per-product/case-type/dollar
  // minimums (Pass 2) still never exceed capacity, on or off.
  //
  // vendor_id -> enabled. Per-vendor (not one global flag) per direct
  // feedback: "opt in for Valvoline but leave RelaDyne off" — resolved into
  // GenerationContext.vendor.allowExceedCapacityForDosTarget (VendorRules
  // below) by useVendorRules().rulesFor(), the same per-vendor-override
  // mechanism ov2_vendor_order_minimums already uses, rather than living
  // directly on the engine's OrderSettings (which has no vendor concept at
  // all — engine.ts itself never references a vendor_id).
  allow_exceed_capacity_for_dos_target_vendors: Record<string, boolean>
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = {
  days_of_supply_target: 21,
  days_of_supply_min_trigger: 14,
  days_of_supply_max: 35,
  order_minimum_dollars_package: 375,
  // ASSUMPTION: same as package until a real bulk figure is supplied.
  order_minimum_dollars_bulk: 375,
  package_minimum_type: 'dollars',
  package_minimum_qty: null,
  bulk_minimum_type: 'dollars',
  bulk_minimum_qty: null,
  skip_order_if_dos_over: 45,
  flag_cumulative_days: 30,
  flag_cumulative_dos_over: 45,
  bulk_rounding_increment: 1,
  bulk_round_up_threshold_gal: 35,
  bulk_urgent_dos_threshold: 15,
  allow_exceed_capacity_for_dos_target_vendors: {},
}

// Per shop x product ordering rules. Named fields say "gallons" for
// historical reasons, but the volume unit the engine actually works in is
// QUARTS (matching on_hand/daily_usage from inventory.product_usage) —
// units_per_uom_gallons is really "quarts per package" and
// max_capacity_gallons is really "capacity in quarts". See buildGenerationInputs
// in useOrdersV2.ts, the one place that converts real gallon figures
// (vendor_parts.package_qty_gallons, location_order_config.capacity) into
// quarts before they reach here — inventory.ov2_product_rules is a manual
// per-shop override layer on top of that and, if ever populated through a
// future UI, should be entered in quarts too so this stays consistent.
export interface ProductRule {
  location_id: string
  product_id: string
  uom: string | null
  units_per_uom_gallons: number | null
  unit_cost: number | null
  max_capacity_gallons: number | null
  vmi_keepfill_enabled: boolean
  can_ignore_minimum: boolean
  ignore_minimum_if_ordered_alone: boolean
  default_order_amount_if_alone: number
  include_in_total_shop_order: boolean
  // Package-vs-bulk override for this uom (from the UOM Conversions table).
  // Default classification only recognizes a uom that literally says
  // "bulk" — this lets a differently-worded bulk UOM be marked correctly.
  order_type_override: OrderType | null
  // "Critical minimum" — company-wide per PRODUCT (global_products.min_on_hand_qty,
  // same value at every shop that carries it, in quarts), not per shop.
  // Distinct from max_capacity_gallons/the dollar-or-per-product order
  // minimums above: this doesn't set a floor on the ORDER quantity, it
  // gates whether a product with very low usage still gets ordered at all
  // when on-hand has dropped to "not even enough for one oil change" — see
  // generateOrder's belowCriticalFloor in engine.ts.
  min_on_hand_qty: number | null
}

// One candidate line the engine reasons about.
export interface GenerationInput {
  location_id: string
  product_id: string
  rule: ProductRule
  on_hand: number | null        // in quarts — combined with other case types of the same product family, see buildGenerationInputs
  daily_usage: number | null    // quarts/day
  // Present only when this product has other case types of the same
  // family (e.g. 5W30D/5W30BB) — own_on_hand is this product's own reading
  // before combining, and equivalent_products lists every sibling folded
  // into the combined figure above (on-hand always combined; daily_usage
  // too, for a sibling that has its own usage recorded). No exclusion
  // threshold — a slow-moving product legitimately carries weeks of
  // on-hand, so an "implausibly large" cutoff excluded exactly the
  // readings combining exists to catch.
  own_on_hand?: number | null
  equivalent_products?: { product_id: string; on_hand: number }[]
  // Outstanding quantity (quarts) on this product's still-open (not closed/
  // cancelled) Droptop POs for this shop — see buildGenerationInputs. Never
  // folded into on_hand automatically; a line with this set gets the
  // covered_by_open_po flag and waits for an explicit user decision
  // (override/exclude/combine) rather than silently changing the order.
  pendingPoQty?: number | null
}

// How a shop's delivery date is worked out for a vendor.
//   weekly             — a fixed weekday every week
//   week_ab            — alternating weekdays, driven by an uploaded A/B calendar
//   plus_business_days — a flat turnaround, no weekday involved
export type ScheduleType = 'weekly' | 'week_ab' | 'plus_business_days'
export const SCHEDULE_LABELS: Record<ScheduleType, string> = {
  weekly: 'Same weekday every week',
  week_ab: 'Week A / Week B weekdays',
  plus_business_days: '+N business days after ordering',
}

export interface DeliverySchedule {
  type: ScheduleType
  delivery_dow: number | null
  week_a_dow: number | null
  week_b_dow: number | null
  // weekly/week_ab: minimum business days of lead — an order placed closer
  // than this rolls to the next occurrence.
  // plus_business_days: the turnaround itself.
  lead_business_days: number
}

export const DEFAULT_SCHEDULE: DeliverySchedule = {
  type: 'weekly', delivery_dow: null, week_a_dow: null, week_b_dow: null, lead_business_days: 4,
}

/** week_start (Sunday, YYYY-MM-DD) -> 'A' | 'B'. */
export type WeekCalendar = Map<string, 'A' | 'B'>

export interface VendorRules {
  vendor_id: string | null
  minimums: Partial<Record<OrderType, OrderMinimum>>
  // case_type -> the order must total at least this many of it, whenever the
  // order includes any. Not a per-product multiple.
  caseTypeMinimums: Record<string, number>
  // Order/delivery weekday restriction applies to this vendor (RelaDyne only
  // today — other vendors can be ordered any day).
  usesOrderDays: boolean
  // Valvoline-only (see isValvoline in useOrdersV2.ts) — a shop only ever
  // orders a handful of configured products, so every one of them should be
  // visible every time (even at qty 0, not yet due) rather than silently
  // dropped, to make "is something already covered" reviewable at a glance.
  // Optional (not required) so every existing test/call site building a
  // VendorRules object literal by hand doesn't need updating — falsy/absent
  // means "off", matching every vendor before this flag existed.
  alwaysListConfiguredProducts?: boolean
  // Valvoline-only — when a case-type minimum (e.g. 6 bay boxes) isn't met,
  // distribute the shortfall evenly across every configured product of that
  // type (round-robin) instead of maxing out whichever one line already has
  // the most headroom. Also checks upfront whether every configured
  // product's own hard capacity could even reach the minimum; if not, makes
  // no changes at all rather than forcing a partial, arbitrary-looking bump.
  spreadCaseTypeMinimum?: boolean
  // Resolved from OrderSettings.allow_exceed_capacity_for_dos_target_vendors
  // for this specific vendor_id (2026-09-25, widened from a single global
  // flag) — see that field's own comment. Optional/falsy-means-off, same
  // convention as the two flags above, so existing hand-built VendorRules
  // test literals are unaffected.
  allowExceedCapacityForDosTarget?: boolean
}

export type LineFlag =
  | 'below_minimum'          // shop still under minimum after smoothing
  | 'capacity_capped'        // max_capacity_gallons was the binding constraint
  | 'case_minimum_topup'     // raised to meet the vendor case-type minimum
  | 'repeat_ordering'        // lots of supply already sent in the window and still reading low
  | 'over_dos_max'           // pushed past the soft DOS ceiling to reach a minimum
  | 'stocked_out'            // on hand is zero/effectively zero
  | 'critical_minimum'       // ordered because on-hand hit this product's critical minimum, not the usual DOS trigger
  | 'alone_default_qty'      // sole line, used default_order_amount_if_alone
  | 'vmi_keepfill'           // vendor-managed inventory — excluded from the order total by default
  | 'keepfill_will_run_out'  // tank on-hand + usage won't last to this shop's delivery after next
  | 'added_for_smoothing'    // pulled onto the order from the shop's other config to reach the minimum
  | 'smoothing_topped_up'    // this line's own qty was raised to reach the minimum
  | 'covered_by_open_po'     // an open (not closed/cancelled) PO already has this product outstanding — needs a decision
  | 'po_decision_override'   // user chose: order the full suggested qty anyway
  | 'po_decision_exclude'    // user chose: the open PO covers it, don't order more
  | 'po_decision_combine'    // user chose: factor the open PO's outstanding qty into on-hand and re-target
  | 'rounded_to_bulk_minimum' // bulk per-product minimum: raised to the drum minimum, see GeneratedLine.note for the real calculated amount
  | 'exceeded_capacity_for_dos_target' // ordered past configured capacity to reach the DOS target after delivery — see GeneratedLine.note for the real numbers

export interface GeneratedLine {
  location_id: string
  product_id: string
  order_type: OrderType
  uom: string | null
  system_qty: number
  qty: number
  unit_cost: number | null
  on_hand: number | null
  daily_usage: number | null
  dos_before: number | null
  dos_after: number | null
  max_capacity_gallons: number | null
  // The conversion factor actually used to turn this qty into a volume
  // (see gallonsPerUnit in engine.ts — despite the name, the volume unit
  // is quarts; see the top-of-file note there). Snapshotted so review,
  // export, and history can show "qty ordered, in quarts" without
  // re-deriving it from a rule that may since have changed.
  quarts_per_unit: number | null
  included: boolean
  flags: LineFlag[]
  added_by_smoothing: boolean
  triggered_smoothing: boolean
  // Free-text explanation for a decision a fixed LineFlag can't carry the
  // specific numbers for (e.g. "can order 33, rounding up to minimum" —
  // see the bulk_round_up_threshold_gal rule in engine.ts). null otherwise.
  note: string | null
}

// Prior-order facts used only by the flag rules, read from ov2_order_history_lines.
export interface HistoryFact {
  location_id: string
  product_id: string
  order_date: string       // YYYY-MM-DD
  dos_before: number | null
  // Days of supply the ordered quantity represented at the time — captured
  // then rather than recomputed, since usage moves.
  dos_ordered: number | null
  qty: number
}

export interface GenerationContext {
  settings: OrderSettings
  vendor: VendorRules
  orderDate: string                                  // YYYY-MM-DD
  // Shops eligible today (order-day restriction already applied upstream,
  // where the per-vendor day table is available).
  eligibleLocationIds: Set<string> | null            // null = no restriction
  history: HistoryFact[]
  includeVmi: boolean
}

export interface ShopGroupResult {
  location_id: string
  order_type: OrderType
  lines: GeneratedLine[]
  dollars: number
  minimum: number
  meetsMinimum: boolean
  smoothingApplied: boolean
}

export interface GenerationResult {
  lines: GeneratedLine[]
  groups: ShopGroupResult[]
  skipped: { location_id: string; product_id: string; reason: string }[]
}
