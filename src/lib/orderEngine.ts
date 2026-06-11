// Order engine — ported from order-generator/src/utils/calc.js.
// The calculation math is preserved verbatim; only the data sources are adapted
// to InventoryOS config tables. See OrderGen-PORT-NOTES.md.

import type {
  Location, LocationOrderConfig, ProductIdMapping, GlobalProduct, VendorPart, OrderMinRule,
} from '@/types'

// ---------------------------------------------------------------------------
// Input / config shapes
// ---------------------------------------------------------------------------
export interface InventoryRow {
  location?: string // raw location identifier (code / name / id)
  product: string
  on_hand?: number | string
  daily_usage?: number | string
  leadtime?: number | string
  category?: string
  cost?: number | string
}

export interface OrderConfigData {
  locationConfigs: LocationOrderConfig[]
  productMappings: ProductIdMapping[]
  globalProducts: GlobalProduct[]
  vendorParts: VendorPart[]
  locations: Location[]
}

export interface GenerationParams {
  targetDays: number
  orderMode: 'days_supply' | 'min_max'
  zeroUsageFill: 'none' | 'min' | 'max'
  triggerOverride?: number | null // overrides order_trigger when set
  limitOverride?: number | null // overrides order_limit when set
}

export interface GeneratedLineItem {
  location_id: string | null
  location_label: string
  product_id: string
  vendor_part_number: string | null
  on_hand: number | null
  suggested_qty: number
  final_qty: number
  unit_of_measure: string | null
  package_type: string | null
  bulk_minimum: number | null
  individual_minimum: number | null
  applied_min_rule: string | null
  trigger_reason: string
  category: string | null
  raw_location: string
}

// ---------------------------------------------------------------------------
// Ported helpers (verbatim math from calc.js)
// ---------------------------------------------------------------------------

/** calc.js isTotalRow — drops grand/sub-total lines from generation. */
export function isTotalRow(product: unknown): boolean {
  const val = String(product ?? '').trim().toLowerCase().replace(/[:\s*.-]+$/, '').trim()
  if (!val) return false
  return /^(grand\s+)?(sub[-\s]?)?totals?(\s+(items?|products?|rows?|units?|qty|quantity|amount|value|cost|price))?$/.test(val)
    || val === 'order total' || val === 'order totals'
}

/** calc.js calcOrder — ceil(max(0,(usage*(lead+targetDays)-onHand)*factor)). */
export function calcOrder(
  usage: number, onHand: number, lead: number, targetDays: number, onHandToOrderFactor = 1
): number | null {
  if (isNaN(usage) || isNaN(onHand) || isNaN(lead)) return null
  return Math.ceil(Math.max(0, (usage * (lead + targetDays) - onHand) * onHandToOrderFactor))
}

function toNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return NaN
  const n = parseFloat(String(v).replace(/[$,]/g, ''))
  return n
}

/** Old→new product id translation (calc.js resolveProductIds equivalent). Applied before matching. */
export function resolveProductIds(rows: InventoryRow[], mappings: ProductIdMapping[]): InventoryRow[] {
  if (!mappings.length) return rows
  const map = new Map(mappings.map((m) => [String(m.old_product_id).trim(), String(m.new_product_id).trim()]))
  return rows.map((r) => {
    const pid = String(r.product ?? '').trim()
    const mapped = map.get(pid)
    return mapped ? { ...r, product: mapped } : r
  })
}

function resolveLocationId(value: string, locations: Location[]): string | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  const m = locations.find(
    (l) => l.id.toLowerCase() === v || l.location_code.toLowerCase() === v || l.name.toLowerCase() === v
  )
  return m?.id ?? null
}

function locLabel(locationId: string | null, raw: string, locations: Location[]): string {
  if (locationId) {
    const l = locations.find((x) => x.id === locationId)
    if (l) return `${l.location_code} — ${l.name}`
  }
  return raw || '—'
}

// ---------------------------------------------------------------------------
// generateOrder — produce line items from inventory + InventoryOS config.
// Min/max model: order_trigger = min (reorder point), capacity = max (target),
// order_limit = max-order cap. Preserves calc.js computeSuggested(min_max) math.
// ---------------------------------------------------------------------------
export function generateOrder(
  inventoryRows: InventoryRow[],
  config: OrderConfigData,
  params: GenerationParams
): GeneratedLineItem[] {
  const rows = resolveProductIds(inventoryRows, config.productMappings)
  const out: GeneratedLineItem[] = []

  for (const row of rows) {
    const product = String(row.product ?? '').trim()
    if (!product || isTotalRow(product)) continue

    const rawLoc = String(row.location ?? '').trim()
    const locationId = resolveLocationId(rawLoc, config.locations)

    // Per location+product order config
    const cfg = config.locationConfigs.find(
      (c) => c.product_id === product && (locationId ? c.location_id === locationId : true)
    )
    const trigger = params.triggerOverride ?? (cfg?.order_trigger ?? null) // min / reorder point
    const capacity = cfg?.capacity ?? null // max / target level
    const limit = params.limitOverride ?? (cfg?.order_limit ?? null) // max-order cap

    // Product info (vendor_parts preferred, else global_products)
    const vp = config.vendorParts.find((v) => v.part_number === product)
    const gp = config.globalProducts.find((g) => g.product_id === product)
    const unit_of_measure = vp?.unit_of_measure ?? gp?.unit_of_measure ?? null
    const package_type = vp?.package_type ?? gp?.package_type ?? null
    const bulk_minimum = vp?.bulk_minimum ?? gp?.bulk_minimum ?? null
    const individual_minimum = vp?.individual_minimum ?? gp?.individual_minimum ?? null
    const vendor_part_number = vp?.part_number ?? null

    const onHand = toNum(row.on_hand)
    const usage = toNum(row.daily_usage)
    const lead = isNaN(toNum(row.leadtime)) ? 0 : toNum(row.leadtime)
    const hasUsage = !isNaN(usage) && usage > 0
    const effectiveOnHand = isNaN(onHand) ? null : onHand

    let suggested = 0
    let reason = 'no_order'

    if (params.orderMode === 'min_max' && trigger != null) {
      // calc.js computeSuggested(min_max) branch
      const projectedAtDelivery = (effectiveOnHand ?? 0) - usage * lead
      const belowTrigger = effectiveOnHand !== null && effectiveOnHand <= trigger
      const projectedBelow = hasUsage && projectedAtDelivery < trigger
      if (belowTrigger || projectedBelow) {
        if (capacity != null && effectiveOnHand !== null) {
          suggested = Math.max(0, Math.ceil(capacity - effectiveOnHand))
        } else {
          suggested = calcOrder(usage, effectiveOnHand ?? 0, lead, params.targetDays) ?? 0
        }
        reason = belowTrigger ? 'below_trigger' : 'projected_below_trigger'
      } else if (!hasUsage && effectiveOnHand !== null) {
        // zero-usage fill (calc.js zeroUsageFill)
        if (params.zeroUsageFill === 'max' && capacity != null) {
          suggested = Math.max(0, Math.ceil(capacity - effectiveOnHand))
          reason = 'zero_usage_fill_max'
        } else if (params.zeroUsageFill === 'min' && trigger != null) {
          suggested = Math.max(0, Math.ceil(trigger - effectiveOnHand))
          reason = 'zero_usage_fill_min'
        }
      }
    } else {
      // days_supply mode — pure calcOrder
      const o = calcOrder(usage, effectiveOnHand ?? 0, lead, params.targetDays)
      suggested = o ?? 0
      reason = suggested > 0 ? 'days_supply' : 'no_order'
    }

    // order_limit cap
    if (limit != null && suggested > limit) suggested = limit

    if (suggested <= 0 && reason === 'no_order') continue

    out.push({
      location_id: locationId,
      location_label: locLabel(locationId, rawLoc, config.locations),
      product_id: product,
      vendor_part_number,
      on_hand: effectiveOnHand,
      suggested_qty: suggested,
      final_qty: suggested,
      unit_of_measure,
      package_type,
      bulk_minimum,
      individual_minimum,
      applied_min_rule: null,
      trigger_reason: reason,
      category: row.category ?? null,
      raw_location: rawLoc,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// applyMinOrderRules — flexible MOQ engine (calc.js applyMinOrderRules +
// applyProductRule). Precedence: product/vendor (3) > column_value (2) >
// location (1) > global (0). Minimums only apply when qty > 0.
// ---------------------------------------------------------------------------
interface RuleApplies {
  scope?: string // 'global' | 'location' | 'product' | 'vendor' | 'column_value'
  location?: string
  field?: string
  value?: string
}

function precedenceOf(scope: string | undefined): number {
  switch (scope) {
    case 'product':
    case 'vendor': return 3
    case 'column_value': return 2
    case 'location': return 1
    default: return 0 // global
  }
}

function ruleMatches(applies: RuleApplies, line: GeneratedLineItem): boolean {
  switch (applies.scope) {
    case 'global': return true
    case 'location':
      return String(applies.location ?? '').trim().toLowerCase() === String(line.raw_location).trim().toLowerCase()
        || applies.location === line.location_id
    case 'product':
      return String(applies.value ?? '').trim() === line.product_id
    case 'vendor':
      return !!line.vendor_part_number && String(applies.value ?? '').trim() === line.vendor_part_number
    case 'column_value': {
      const field = applies.field
      const want = String(applies.value ?? '').trim().toLowerCase()
      if (!want) return false
      const got = String((line as any)[field as string] ?? '').trim().toLowerCase()
      return got === want
    }
    default: return false
  }
}

export function applyMinOrderRules(
  lineItems: GeneratedLineItem[],
  rules: OrderMinRule[]
): GeneratedLineItem[] {
  const activeRules = rules.filter((r) => r.active)

  return lineItems.map((line) => {
    let qty = line.final_qty ?? line.suggested_qty
    const labels: string[] = []

    // Baseline product-config minimums carried from generateOrder
    let individualFloor = line.individual_minimum ?? null
    let caseSize = line.bulk_minimum ?? null
    let maxQty: number | null = null
    let maxOnHandAfter: number | null = null

    // Highest-precedence matching rule wins (calc.js precedence semantics)
    let bestPrec = -1
    let bestRule: OrderMinRule | null = null
    for (const rule of activeRules) {
      const applies = (rule.applies_to ?? {}) as RuleApplies
      if (!ruleMatches(applies, line)) continue
      const prec = precedenceOf(applies.scope)
      if (prec > bestPrec) { bestPrec = prec; bestRule = rule }
    }
    if (bestRule) {
      const logic = (bestRule.rule_logic ?? {}) as { caseSize?: number; maxQty?: number; maxOnHandAfter?: number }
      if (bestRule.individual_minimum != null) individualFloor = bestRule.individual_minimum
      if (bestRule.bulk_minimum != null) caseSize = bestRule.bulk_minimum
      if (logic.caseSize != null) caseSize = logic.caseSize
      if (logic.maxQty != null) maxQty = logic.maxQty
      if (logic.maxOnHandAfter != null) maxOnHandAfter = logic.maxOnHandAfter
      labels.push(bestRule.name ?? `rule:${(bestRule.applies_to as RuleApplies).scope ?? 'global'}`)
    }

    // Individual minimum floor — only when an order is already needed (calc.js: qty>0)
    if (individualFloor != null && qty > 0 && qty < individualFloor) {
      qty = individualFloor
      if (!bestRule) labels.push(`min ${individualFloor}`)
    }

    // Round up to case/bulk multiples (calc.js applyProductRule caseSize)
    if (caseSize != null && caseSize > 1 && qty > 0) {
      qty = Math.ceil(qty / caseSize) * caseSize
      if (line.package_type) labels.push(`${line.package_type} x${caseSize}`)
      else labels.push(`case x${caseSize}`)
    }

    // Max order cap
    if (maxQty != null) qty = Math.min(qty, maxQty)

    // Cap so on_hand + order does not exceed maxOnHandAfter, re-snapping to case
    if (maxOnHandAfter != null && line.on_hand != null && !isNaN(Number(line.on_hand))) {
      const maxAllowed = Math.max(0, maxOnHandAfter - Number(line.on_hand))
      qty = Math.min(qty, maxAllowed)
      if (caseSize != null && caseSize > 1 && qty > 0) qty = Math.floor(qty / caseSize) * caseSize
    }

    qty = Math.max(0, qty)
    return {
      ...line,
      final_qty: qty,
      applied_min_rule: labels.length ? labels.join(' · ') : null,
    }
  })
}

// ---------------------------------------------------------------------------
// buildExport — column-layout export (ExportStep.jsx resolveCell). Produces a
// { headers, rows } payload in the chosen column order.
// ---------------------------------------------------------------------------
export interface ExportColumn {
  key: string // a GeneratedLineItem / line field key
  header: string
}

export const DEFAULT_EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'location_label', header: 'Location' },
  { key: 'product_id', header: 'Product' },
  { key: 'vendor_part_number', header: 'Vendor Part #' },
  { key: 'final_qty', header: 'Order Qty' },
  { key: 'unit_of_measure', header: 'UoM' },
  { key: 'package_type', header: 'Package' },
  { key: 'trigger_reason', header: 'Reason' },
  { key: 'applied_min_rule', header: 'Min Rule' },
]

function resolveCell(col: ExportColumn, row: Record<string, unknown>): string {
  const v = row[col.key]
  if (v === null || v === undefined) return ''
  return String(v)
}

export function buildExport(
  lineItems: Array<Record<string, unknown>>,
  columns: ExportColumn[] = DEFAULT_EXPORT_COLUMNS,
  opts: { excludeZeros?: boolean } = {}
): { headers: string[]; rows: string[][] } {
  const src = opts.excludeZeros
    ? lineItems.filter((r) => (Number(r.final_qty) || 0) > 0)
    : lineItems
  const headers = columns.map((c) => c.header)
  const rows = src.map((r) => columns.map((c) => resolveCell(c, r)))
  return { headers, rows }
}

/** Human-readable labels for trigger_reason codes. */
export const TRIGGER_REASON_LABELS: Record<string, string> = {
  below_trigger: 'Below reorder point',
  projected_below_trigger: 'Projected below reorder',
  zero_usage_fill_max: 'Zero-usage fill to capacity',
  zero_usage_fill_min: 'Zero-usage fill to trigger',
  days_supply: 'Days-supply target',
  no_order: 'No order',
}
