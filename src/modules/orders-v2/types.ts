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

export interface OrderSettings {
  days_of_supply_target: number
  days_of_supply_min_trigger: number
  days_of_supply_max: number
  order_minimum_dollars_package: number
  order_minimum_dollars_bulk: number
  skip_order_if_dos_over: number
  flag_if_ordered_over_dos: number
  flag_if_ordered_within_days: number
  flag_if_last_order_usage_under: number
  bulk_rounding_decimals: number
}

export const DEFAULT_ORDER_SETTINGS: OrderSettings = {
  days_of_supply_target: 21,
  days_of_supply_min_trigger: 14,
  days_of_supply_max: 35,
  order_minimum_dollars_package: 375,
  // ASSUMPTION: same as package until a real bulk figure is supplied.
  order_minimum_dollars_bulk: 375,
  skip_order_if_dos_over: 45,
  flag_if_ordered_over_dos: 30,
  flag_if_ordered_within_days: 30,
  flag_if_last_order_usage_under: 7,
  bulk_rounding_decimals: 0,
}

// Per shop x product ordering rules (inventory.ov2_product_rules), joined
// with the shop's order config + current usage before generation.
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
}

// One candidate line the engine reasons about.
export interface GenerationInput {
  location_id: string
  product_id: string
  rule: ProductRule
  on_hand: number | null        // in gallons
  daily_usage: number | null    // gallons/day
}

export interface VendorRules {
  vendor_id: string | null
  minimums: Partial<Record<OrderType, number>>
  caseTypeLimits: Record<string, number>   // case_type -> max qty per order
}

export type LineFlag =
  | 'below_minimum'          // shop still under minimum after smoothing
  | 'capacity_capped'        // max_capacity_gallons was the binding constraint
  | 'case_limit_capped'      // vendor case-type limit was binding
  | 'recent_high_dos_order'  // ordered recently while DOS was already high
  | 'last_order_short_usage' // last order's usage covered < X days
  | 'stocked_out'            // on hand is zero/effectively zero
  | 'alone_default_qty'      // sole line, used default_order_amount_if_alone

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
