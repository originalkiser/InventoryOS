// Mighty manual-order engine — a parallel, much simpler engine to engine.ts's
// config-driven one (GenerationInput/ProductRule/GenerationContext), because
// Mighty-supplied shops carry no location_order_config rows at all: Mighty
// normally manages its own inventory/ordering directly at each shop, and
// this only covers the handful of shops that need a manual order placed on
// their behalf. Sourced from inventory.product_usage (supplier = 'Mighty')
// for whichever shops are picked in the order flow — no per-shop
// capacity/trigger/limit config exists or is needed here.
//
// Ported from the team's existing standalone OrderGen tool
// (github.com/originalkiser/order-generator) rather than reinvented — same
// math, same UoM/prefix-suffix pack-size model, same order-efficiency
// scoring, so a Mighty order in Orders v2 behaves exactly like the tool
// already in use, just without leaving SB Net.

export interface MightyUomRule {
  fromUnit: string
  toUnit: string
  factor: number
}

// 'pack' — the order column shows packs (1 pack = purchaseSize on-hand
// units). 'unit' — the order column stays in on-hand units but always
// rounds UP to the next multiple of purchaseSize.
export type MightyOrderMode = 'pack' | 'unit'
export type MightyMatchType = 'prefix' | 'suffix'

export interface MightyPrefixSuffixRule {
  id: string
  matchType: MightyMatchType
  text: string
  purchaseSize: number
  orderMode: MightyOrderMode
  exclusions?: { products?: string[]; categories?: string[] }
}

export interface MightyCategoryUomSetting {
  onHandUom: string
  orderUom: string
}

export interface MightyUomConversion {
  onHandUom: string
  orderUom: string
  onHandToOrderFactor: number
  orderToOnHandFactor: number
  hasConversion: boolean
  conversionMissing?: boolean
  isPack?: boolean
  packSize?: number
}

// Precedence when more than one rule could apply: column_value (2) >
// location (1) > global (0) — the most-specific rule wins. Minimums only
// ever raise an order that's already > 0; they never force an order on a
// line that needs zero.
export type MightyMinOrderScope = 'global' | 'location' | 'column_value'
export interface MightyMinOrderRule {
  id: string
  scope: MightyMinOrderScope
  minQty: number
  location?: string
  field?: 'category' | 'productId' | 'uom'
  colValue?: string
}

// A per-product override for on-hand/order UoM — takes priority over both
// the category default and any prefix/suffix pack-size rule.
export interface MightyProductUomOverride {
  onHandUom?: string
  orderUom?: string
}

// One line item going into the Mighty engine — built from a product_usage
// row (supplier = 'Mighty') plus the order-level manual fields (lead time,
// target days) an admin sets once for the whole order.
export interface MightyLineInput {
  locationId: string
  productId: string
  category: string | null
  dailyUsage: number | null
  onHand: number | null
  leadTimeDays: number
  minOnHand: number | null
  maxOnHand: number | null
  costPerUnit: number | null
  uom: string | null
}

export interface MightyGeneratedLine extends MightyLineInput {
  orderQty: number
  uomConversion: MightyUomConversion
  minConstraintApplied: boolean
  maxConstraintApplied: boolean
  daysOfSupply: number | null
}

export interface MightyEfficiencyRow {
  locationId: string
  productId: string
  recommended: number
  orderDays: number
  efficiencyPct: number
}

export interface MightyEfficiencySummary {
  productCount: number
  avgEfficiencyPct: number
  avgDaysCovered: number
  totalOrderedUnits: number
  totalRecommendedUnits: number
  leadTimeOptimalDays: number | null
  rows: MightyEfficiencyRow[]
}

export type MightyPatternType = 'prefix' | 'suffix' | 'both'
export interface MightyDetectedPattern {
  type: MightyPatternType
  text: string
  prefix?: string
  suffix?: string
  count: number
  examples: string[]
  key: string
}
