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
  uom?: string // on-hand unit of measure (for UoM conversion)
  min_on_hand?: number | string // per-row min on-hand override (else config trigger)
  max_on_hand?: number | string // per-row max on-hand override (else config capacity)
}

// ---------------------------------------------------------------------------
// Usage adjustment (calc.js getUsageMultiplier) — percentage bumps to daily
// usage, resolved product → category → global.
// ---------------------------------------------------------------------------
export interface UsageAdjustment {
  global?: number // percent, e.g. 10 means +10% usage
  categories?: Record<string, number>
  products?: Record<string, number>
}

// ---------------------------------------------------------------------------
// UoM conversion config (calc.js getUomConversion). order-generator pulls these
// from product rules / category settings / a UoM mapping table / prefix-suffix
// pack rules. All optional — absent ⇒ identity (factor 1), unchanged math.
// ---------------------------------------------------------------------------
export interface UomMapping { fromUnit: string; toUnit: string; factor: number }
export interface UomProductRule { productId: string; onHandUom?: string; orderUom?: string }
export interface PrefixSuffixRule {
  text: string
  matchType: 'prefix' | 'suffix'
  purchaseSize?: number
  orderMode?: 'pack' | 'round'
  exclusions?: { products?: string[]; categories?: string[] }
}
export interface UomConfig {
  uomMappings?: UomMapping[]
  productRules?: UomProductRule[]
  categoryUomSettings?: Record<string, { onHandUom?: string; orderUom?: string }>
  prefixSuffixRules?: PrefixSuffixRule[]
}
export interface UomConversion {
  onHandUom: string
  orderUom: string
  onHandToOrderFactor: number
  orderToOnHandFactor: number
  hasConversion: boolean
  conversionMissing?: boolean
  isPack?: boolean
  packSize?: number
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
  usageAdjustment?: UsageAdjustment | null // % usage bumps (calc.js getUsageMultiplier)
  uom?: UomConfig | null // UoM conversion config (calc.js getUomConversion)
  pending?: Map<string, number> | null // already-ordered qty by `loc|product` (calc.js buildPendingIndex)
  ignoreMax?: { products?: string[]; categories?: string[] } | null // skip max-on-hand cap for these
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
  daily_usage: number | null // parsed daily usage rate (usage × multiplier, pre-conversion)
  days_on_hand: number | null // calc.js calcDaysOnHand (on_hand / daily_usage)
  pending_qty: number // already-on-order qty subtracted from this line
  order_uom: string | null // resolved order unit (when a UoM conversion applies)
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
    (l) => l.id.toLowerCase() === v || l.name.toLowerCase() === v || (l.shop_city ?? '').toLowerCase() === v
  )
  return m?.id ?? null
}

function locLabel(locationId: string | null, raw: string, locations: Location[]): string {
  if (locationId) {
    const l = locations.find((x) => x.id === locationId)
    if (l) return `${l.name} — ${l.shop_city ?? ''}`
  }
  return raw || '—'
}

/** calc.js calcDaysOnHand — days of stock remaining (on_hand / daily_usage). */
export function calcDaysOnHand(usage: number, onHand: number): number | null {
  if (isNaN(usage) || isNaN(onHand) || usage === 0) return null
  return onHand / usage
}

/** calc.js getUsageMultiplier — product → category → global percent bump (1 = no change). */
export function getUsageMultiplier(
  productId: string, category: string | null | undefined, adj: UsageAdjustment | null | undefined
): number {
  if (!adj) return 1
  if (adj.products?.[productId] != null) return 1 + adj.products[productId] / 100
  if (category && adj.categories?.[category] != null) return 1 + adj.categories[category] / 100
  if (adj.global != null) return 1 + adj.global / 100
  return 1
}

/** calc.js getUomConversion — resolve on-hand↔order unit factors. Absent config ⇒ identity. */
export function getUomConversion(row: InventoryRow, uom: UomConfig | null | undefined): UomConversion {
  const identity: UomConversion = { onHandUom: '', orderUom: '', onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false }
  if (!uom) return identity
  const productId = String(row.product ?? '').trim()
  const rule = (uom.productRules || []).find((r) => String(r.productId).trim() === productId)
  const onHandUom = (rule?.onHandUom || '').trim() || (row.uom && String(row.uom).trim()) || (row.category && uom.categoryUomSettings?.[row.category]?.onHandUom) || ''
  const orderUom = (rule?.orderUom || '').trim() || (row.category && uom.categoryUomSettings?.[row.category]?.orderUom) || ''

  // Named UoM conversion path (product rule / column / category)
  if (onHandUom && orderUom && onHandUom !== orderUom) {
    const m = (uom.uomMappings || []).find((u) => u.fromUnit === onHandUom && u.toUnit === orderUom)
    if (m && m.factor > 0) return { onHandUom, orderUom, onHandToOrderFactor: m.factor, orderToOnHandFactor: 1 / m.factor, hasConversion: true }
    const rev = (uom.uomMappings || []).find((u) => u.fromUnit === orderUom && u.toUnit === onHandUom)
    if (rev && rev.factor > 0) return { onHandUom, orderUom, onHandToOrderFactor: 1 / rev.factor, orderToOnHandFactor: rev.factor, hasConversion: true }
    return { onHandUom, orderUom, onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false, conversionMissing: true }
  }

  // Prefix/suffix pack-size path (fallback when no named UoM applies)
  if (!rule?.onHandUom && !rule?.orderUom) {
    // Use toUpperCase for both sides — detected pattern texts are always uppercase
    // (generated from `up.toUpperCase().slice(...)` in detectPrefixSuffixPatterns),
    // but productId comes from the raw file and may be mixed-case.
    const pidUpper = productId.toUpperCase()
    const ps = (uom.prefixSuffixRules || []).find((r) => {
      const t = (r.text || '').trim().toUpperCase()
      if (!t || !r.purchaseSize) return false
      const excl = r.exclusions || { products: [], categories: [] }
      if (excl.products?.includes(productId)) return false
      if (row.category && excl.categories?.includes(row.category)) return false
      return r.matchType === 'prefix' ? pidUpper.startsWith(t) : pidUpper.endsWith(t)
    })
    if (ps) {
      const packSize = Number(ps.purchaseSize)
      if (ps.orderMode === 'pack') {
        return { onHandUom: 'unit', orderUom: ps.text, onHandToOrderFactor: 1 / packSize, orderToOnHandFactor: packSize, hasConversion: true, isPack: true, packSize }
      }
      return { onHandUom: 'unit', orderUom: 'unit', onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false, isPack: true, packSize }
    }
  }

  return { onHandUom, orderUom, onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false }
}

/** calc.js buildPendingIndex (adapted) — sum already-ordered qty by `location|product`. */
export function buildPendingIndex(
  rows: Array<{ location?: string; product: string; qty: number | string }>
): Map<string, number> {
  const m = new Map<string, number>()
  for (const r of rows) {
    const prod = String(r.product ?? '').trim()
    if (!prod) continue
    const loc = String(r.location ?? '').trim()
    const key = `${loc}|${prod}`.toLowerCase()
    const qty = parseFloat(String(r.qty ?? '')) || 0
    m.set(key, (m.get(key) || 0) + qty)
  }
  return m
}

/** calc.js autoPendingColMap — guess location/product/qty headers in a pending-orders file. */
export function autoPendingColMap(headers: string[]): { location: string; product: string; qty: string } {
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '')
  const location = headers.find((h) => ['location', 'loc', 'store', 'site', 'warehouse'].includes(norm(h))) || ''
  const product = headers.find((h) => ['product', 'productid', 'item', 'itemid', 'sku', 'productname', 'prodid', 'itemno'].includes(norm(h))) || ''
  const qty = headers.find((h) => ['quantity', 'qty', 'qtyordered', 'orderqty', 'units', 'ordered', 'qtyorder'].includes(norm(h))) || ''
  return { location, product, qty }
}

/** Look up pending (already-ordered) qty for a line from a buildPendingIndex map. */
function pendingFor(index: Map<string, number> | null | undefined, rawLoc: string, product: string): number {
  if (!index) return 0
  const key = `${rawLoc}|${product}`.toLowerCase()
  return index.get(key) ?? 0
}

/** calc.js applyOnHandConstraints — raise to min / cap to max on-hand-after, in order units. */
export function applyOnHandConstraints(
  order: number, minOH: number, maxOH: number, effectiveOnHand: number | null,
  orderToOnHandFactor: number, skipMax: boolean
): { order: number; minC: boolean; maxC: boolean } {
  if (effectiveOnHand === null) return { order, minC: false, maxC: false }
  const ohFactor = orderToOnHandFactor || 1
  let minC = false, maxC = false
  if (!isNaN(minOH)) {
    const mo = Math.ceil(Math.max(0, (minOH - effectiveOnHand) / ohFactor))
    if (mo > order) { order = mo; minC = true }
  }
  if (!isNaN(maxOH) && !skipMax) {
    const mo = Math.floor(Math.max(0, (maxOH - effectiveOnHand) / ohFactor))
    if (mo < order) { order = mo; maxC = true }
  }
  return { order, minC, maxC }
}

/**
 * calc.js detectPrefixSuffixPatterns — find common product-id prefixes/suffixes for pack rules.
 *
 * Unit test examples:
 *   Input:  ['5W20CS','10W40CS','5W30CS','QTSYN','QTSYN5W20']
 *   Prefix: 'QT' (count 2, startsWith)  Suffix: 'CS' (count 3, endsWith)
 *
 *   Input:  ['AB-001','AB-002','AB-003','CD-001']
 *   Prefix: 'AB' (count 3)  — 'CD' count 1 < minCount, suppressed
 *
 *   Input:  ['PROD1PK','PROD2PK','PROD3PK']
 *   Suffix: 'PK' (count 3, endsWith)  Prefix: none (all start with digits after 'PROD' — only alpha tested)
 *
 * Note: matching in getUomConversion is case-insensitive (both sides toUpperCase).
 */
export function detectPrefixSuffixPatterns(
  productIds: string[], ignoredKeys: Set<string> = new Set()
): Array<{ type: 'prefix' | 'suffix' | 'both'; text: string; count: number; examples: string[]; key: string; prefix?: string; suffix?: string }> {
  if (productIds.length < 2) return []
  const total = productIds.length
  const minCount = Math.max(2, Math.ceil(total * 0.03))
  const prefixCounts = new Map<string, number>()
  const suffixCounts = new Map<string, number>()
  productIds.forEach((id) => {
    const up = String(id).trim().toUpperCase()
    if (!up) return
    for (let len = 1; len <= 3; len++) {
      if (up.length > len + 1) {
        const pre = up.slice(0, len)
        if (/^[A-Z]+$/.test(pre)) prefixCounts.set(pre, (prefixCounts.get(pre) || 0) + 1)
        const suf = up.slice(-len)
        if (/^[A-Z]+$/.test(suf)) suffixCounts.set(suf, (suffixCounts.get(suf) || 0) + 1)
      }
    }
  })
  const results: Array<{ type: 'prefix' | 'suffix' | 'both'; text: string; count: number; examples: string[]; key: string; prefix?: string; suffix?: string }> = []
  const validPrefixes: string[] = [], validSuffixes: string[] = []
  prefixCounts.forEach((count, pre) => {
    if (count >= minCount && count < total * 0.9 && !ignoredKeys.has(`prefix:${pre}`)) {
      validPrefixes.push(pre)
      const examples = productIds.filter((id) => String(id).toUpperCase().startsWith(pre)).slice(0, 3)
      results.push({ type: 'prefix', text: pre, count, examples, key: `prefix:${pre}` })
    }
  })
  suffixCounts.forEach((count, suf) => {
    if (count >= minCount && count < total * 0.9 && !ignoredKeys.has(`suffix:${suf}`)) {
      validSuffixes.push(suf)
      const examples = productIds.filter((id) => String(id).toUpperCase().endsWith(suf)).slice(0, 3)
      results.push({ type: 'suffix', text: suf, count, examples, key: `suffix:${suf}` })
    }
  })
  validPrefixes.forEach((pre) => {
    validSuffixes.forEach((suf) => {
      if (pre === suf) return
      const key = `both:${pre}:${suf}`
      if (ignoredKeys.has(key)) return
      const matching = productIds.filter((id) => {
        const up = String(id).toUpperCase()
        return up.startsWith(pre) && up.endsWith(suf) && up.length > pre.length + suf.length
      })
      if (matching.length >= minCount) {
        results.push({ type: 'both', prefix: pre, suffix: suf, text: `${pre}…${suf}`, count: matching.length, examples: matching.slice(0, 3), key })
      }
    })
  })
  return results.sort((a, b) => b.count - a.count)
}

// ---------------------------------------------------------------------------
// generateOrder — produce line items from inventory + InventoryOS config.
//
// Parameter guide & safe defaults:
//   orderMode:      'days_supply' (preferred) | 'min_max'
//                   days_supply = ceil(max(0, usage*(lead+targetDays) - onHand) * factor)
//                   min_max     = order to capacity when onHand ≤ trigger (needs config rows)
//   targetDays:     14  — number of days of stock to cover beyond lead time
//   zeroUsageFill:  'none'  — KEEP THIS AS 'none'. Any other value causes lines with
//                   no daily_usage to fill to min/max capacity, inflating the order.
//   uom.onHandToOrderFactor: applied ONCE inside calcOrder. Never apply it again
//                   before rounding — double-application is the main inflation source.
//
// Numeric safety: on_hand, daily_usage, and leadtime are run through toNum() which
// converts '' / null / undefined → NaN. NaN propagates into calcOrder → returns null
// → suggested = 0 → line is skipped. This is the correct silent-skip behaviour.
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

    // Per location+product order config. Per-row min/max on-hand columns (when
    // mapped) override the config trigger/capacity for this row.
    const cfg = config.locationConfigs.find(
      (c) => c.product_id === product && (locationId ? c.location_id === locationId : true)
    )
    const rowMin = toNum(row.min_on_hand)
    const rowMax = toNum(row.max_on_hand)
    const trigger = params.triggerOverride ?? (!isNaN(rowMin) ? rowMin : (cfg?.order_trigger ?? null)) // min / reorder point
    const capacity = !isNaN(rowMax) ? rowMax : (cfg?.capacity ?? null) // max / target level
    const limit = params.limitOverride ?? (cfg?.order_limit ?? null) // max-order cap

    // Product info (vendor_parts preferred, else global_products)
    const vp = config.vendorParts.find((v) => v.part_number === product)
    const gp = config.globalProducts.find((g) => g.product_id === product)
    const unit_of_measure = vp?.unit_of_measure ?? gp?.unit_of_measure ?? null
    const package_type = vp?.package_type ?? gp?.package_type ?? null
    const bulk_minimum = vp?.bulk_minimum ?? gp?.bulk_minimum ?? null
    const individual_minimum = vp?.individual_minimum ?? gp?.individual_minimum ?? null
    const vendor_part_number = vp?.part_number ?? null

    // UoM conversion (calc.js getUomConversion) — identity factors when unconfigured.
    const uomConv = getUomConversion(row, params.uom)
    const ohFactor = uomConv.orderToOnHandFactor || 1 // order units → on-hand units

    const onHand = toNum(row.on_hand)
    const rawUsage = toNum(row.daily_usage)
    // Usage multiplier (calc.js getUsageMultiplier) — defaults to ×1.
    const mult = getUsageMultiplier(product, row.category, params.usageAdjustment)
    const usage = isNaN(rawUsage) ? rawUsage : rawUsage * mult
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
          suggested = Math.max(0, Math.ceil((capacity - effectiveOnHand) / ohFactor))
        } else {
          suggested = calcOrder(usage, effectiveOnHand ?? 0, lead, params.targetDays, uomConv.onHandToOrderFactor) ?? 0
        }
        reason = belowTrigger ? 'below_trigger' : 'projected_below_trigger'
      } else if (!hasUsage && effectiveOnHand !== null) {
        // zero-usage fill (calc.js zeroUsageFill)
        if (params.zeroUsageFill === 'max' && capacity != null) {
          suggested = Math.max(0, Math.ceil((capacity - effectiveOnHand) / ohFactor))
          reason = 'zero_usage_fill_max'
        } else if (params.zeroUsageFill === 'min' && trigger != null) {
          suggested = Math.max(0, Math.ceil((trigger - effectiveOnHand) / ohFactor))
          reason = 'zero_usage_fill_min'
        }
      }
    } else {
      // days_supply mode — pure calcOrder
      const o = calcOrder(usage, effectiveOnHand ?? 0, lead, params.targetDays, uomConv.onHandToOrderFactor)
      suggested = o ?? 0
      reason = suggested > 0 ? 'days_supply' : 'no_order'
    }

    // order_limit cap
    if (limit != null && suggested > limit) suggested = limit

    // Prefix/suffix pack rule, "round" mode: round the order up to a whole pack
    // multiple. ("pack" mode is already handled by the conversion factor above.)
    if (uomConv.isPack && !uomConv.hasConversion && uomConv.packSize && uomConv.packSize > 1 && suggested > 0) {
      suggested = Math.ceil(suggested / uomConv.packSize) * uomConv.packSize
    }

    // Per-row min/max on-hand-after constraints (calc.js applyOnHandConstraints).
    // Only the explicit per-row min_on_hand/max_on_hand columns drive this layer —
    // config trigger/capacity already shaped the min_max suggestion above, so we
    // don't re-cap days_supply orders by them.
    const skipMax = !!(params.ignoreMax && (
      (row.category && params.ignoreMax.categories?.includes(row.category)) ||
      params.ignoreMax.products?.includes(product)
    ))
    const constrained = applyOnHandConstraints(
      suggested, rowMin, rowMax, effectiveOnHand, ohFactor, skipMax
    )
    suggested = constrained.order

    if (suggested <= 0 && reason === 'no_order') continue

    // Subtract already-ordered (pending) qty from what we still need to order.
    const pending_qty = pendingFor(params.pending, rawLoc, product)
    const final_qty = Math.max(0, suggested - pending_qty)

    out.push({
      location_id: locationId,
      location_label: locLabel(locationId, rawLoc, config.locations),
      product_id: product,
      vendor_part_number,
      on_hand: effectiveOnHand,
      suggested_qty: suggested,
      final_qty,
      unit_of_measure,
      package_type,
      bulk_minimum,
      individual_minimum,
      applied_min_rule: null,
      trigger_reason: reason,
      category: row.category ?? null,
      raw_location: rawLoc,
      daily_usage: isNaN(rawUsage) ? null : rawUsage,
      days_on_hand: calcDaysOnHand(rawUsage, onHand),
      pending_qty,
      order_uom: uomConv.hasConversion ? uomConv.orderUom : null,
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
