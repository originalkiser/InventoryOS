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

// How an order minimum is expressed. 'dollars' is a floor on the whole
// shop/order-type total; the per-product variants are floors on each line
// (e.g. bulk must be at least N gallons of each product ordered).
export type MinimumType = 'dollars' | 'units_per_product' | 'gallons_per_product'
export const MINIMUM_TYPE_LABELS: Record<MinimumType, string> = {
  dollars: '$ total for the order',
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
  bulk_rounding_decimals: number
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
  bulk_rounding_decimals: 0,
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
}

export type LineFlag =
  | 'below_minimum'          // shop still under minimum after smoothing
  | 'capacity_capped'        // max_capacity_gallons was the binding constraint
  | 'case_minimum_topup'     // raised to meet the vendor case-type minimum
  | 'repeat_ordering'        // lots of supply already sent in the window and still reading low
  | 'over_dos_max'           // pushed past the soft DOS ceiling to reach a minimum
  | 'stocked_out'            // on hand is zero/effectively zero
  | 'alone_default_qty'      // sole line, used default_order_amount_if_alone
  | 'vmi_keepfill'           // vendor-managed inventory — excluded from the order total by default
  | 'keepfill_will_run_out'  // tank on-hand + usage won't last to this shop's delivery after next
  | 'added_for_smoothing'    // pulled onto the order from the shop's other config to reach the minimum
  | 'smoothing_topped_up'    // this line's own qty was raised to reach the minimum
  | 'covered_by_open_po'     // an open (not closed/cancelled) PO already has this product outstanding — needs a decision
  | 'po_decision_override'   // user chose: order the full suggested qty anyway
  | 'po_decision_exclude'    // user chose: the open PO covers it, don't order more
  | 'po_decision_combine'    // user chose: factor the open PO's outstanding qty into on-hand and re-target

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
