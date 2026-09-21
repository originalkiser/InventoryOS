// Mighty manual-order engine — pure/testable, no React/Supabase, same
// separation as engine.ts. See mightyTypes.ts's own header comment for why
// this is a separate engine rather than an extension of the config-driven
// one, and for the OrderGen tool this was ported from.
import type {
  MightyCategoryUomSetting, MightyDetectedPattern, MightyEfficiencyRow, MightyEfficiencySummary,
  MightyLineInput, MightyMinOrderRule, MightyPatternType, MightyPrefixSuffixRule, MightyProductUomOverride,
  MightyUomConversion, MightyUomRule,
} from './mightyTypes'

export function mightyDaysOfSupply(onHand: number | null, dailyUsage: number | null): number | null {
  if (dailyUsage == null || dailyUsage <= 0 || onHand == null) return null
  return onHand / dailyUsage
}

// Suggested order quantity in ON-HAND units (before any UoM conversion) —
// enough to reach targetDays of supply once leadTimeDays have passed.
// onHandToOrderFactor converts the result into order units (e.g. 1/12 if
// ordering in cases of 12) — applied last, matching calcOrder in the
// source tool.
export function calcMightyOrder(
  dailyUsage: number | null, onHand: number | null, leadTimeDays: number, targetDays: number,
  onHandToOrderFactor = 1,
): number | null {
  if (dailyUsage == null || onHand == null || isNaN(dailyUsage) || isNaN(onHand)) return null
  return Math.ceil(Math.max(0, (dailyUsage * (leadTimeDays + targetDays) - onHand) * onHandToOrderFactor))
}

// Auto-detects common 1-3 letter alphabetic prefixes/suffixes across a set
// of product IDs — e.g. a "BB" suffix shared by dozens of products likely
// encodes a pack size someone should confirm. Never applied automatically;
// only ever surfaced as suggestions for an admin to accept ("Use") or
// dismiss ("Ignore") — see the caller for how ignoredKeys persists that.
// minCount scales with the list size (at least 2, or 3% of the total) so a
// coincidental 2-product match on a huge catalog doesn't get flagged, and
// the < 90% ceiling filters out a "pattern" so common it's meaningless
// (most product IDs sharing a first letter, for instance).
export function detectMightyPrefixSuffixPatterns(
  productIds: string[], ignoredKeys: Set<string> = new Set(),
): MightyDetectedPattern[] {
  if (productIds.length < 2) return []
  const total = productIds.length
  const minCount = Math.max(2, Math.ceil(total * 0.03))
  const prefixCounts = new Map<string, number>()
  const suffixCounts = new Map<string, number>()
  for (const id of productIds) {
    const up = String(id).trim().toUpperCase()
    if (!up) continue
    for (let len = 1; len <= 3; len++) {
      if (up.length > len + 1) {
        const pre = up.slice(0, len)
        if (/^[A-Z]+$/.test(pre)) prefixCounts.set(pre, (prefixCounts.get(pre) ?? 0) + 1)
        const suf = up.slice(-len)
        if (/^[A-Z]+$/.test(suf)) suffixCounts.set(suf, (suffixCounts.get(suf) ?? 0) + 1)
      }
    }
  }
  const results: MightyDetectedPattern[] = []
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
  for (const pre of validPrefixes) {
    for (const suf of validSuffixes) {
      if (pre === suf) continue
      const key = `both:${pre}:${suf}`
      if (ignoredKeys.has(key)) continue
      const matching = productIds.filter((id) => {
        const up = String(id).toUpperCase()
        return up.startsWith(pre) && up.endsWith(suf) && up.length > pre.length + suf.length
      })
      if (matching.length >= minCount) {
        results.push({ type: 'both' as MightyPatternType, prefix: pre, suffix: suf, text: `${pre}…${suf}`, count: matching.length, examples: matching.slice(0, 3), key })
      }
    }
  }
  return results.sort((a, b) => b.count - a.count)
}

// Applies per-product floor/ceiling/case-rounding rules to a suggested
// order quantity. maxOnHandAfter re-snaps DOWN to a case multiple after
// capping (so the cap is never itself violated by rounding back up).
export function applyMightyProductRule(
  rule: { minQty?: number | null; maxQty?: number | null; caseSize?: number | null; maxOnHandAfter?: number | null },
  suggestedQty: number, onHand: number | null,
): number {
  let qty = suggestedQty ?? 0
  if (rule.minQty != null && qty > 0) qty = Math.max(qty, rule.minQty)
  if (rule.maxQty != null) qty = Math.min(qty, rule.maxQty)
  if (rule.caseSize != null && rule.caseSize > 1 && qty > 0) {
    qty = Math.ceil(qty / rule.caseSize) * rule.caseSize
  }
  if (rule.maxOnHandAfter != null && onHand != null && !isNaN(Number(onHand))) {
    const maxAllowed = Math.max(0, rule.maxOnHandAfter - Number(onHand))
    qty = Math.min(qty, maxAllowed)
    if (rule.caseSize != null && rule.caseSize > 1 && qty > 0) {
      qty = Math.floor(qty / rule.caseSize) * rule.caseSize
    }
  }
  return Math.max(0, qty)
}

// Resolves the effective on-hand→order UoM conversion for one product, in
// priority order: an explicit per-product override > a category default >
// a matching prefix/suffix pack-size rule (skipped entirely if either half
// of a per-product override is already set) > plain 1:1. A named
// conversion with no matching entry in uomMappings (either direction)
// comes back flagged conversionMissing rather than silently defaulting, so
// the caller can surface it instead of quietly ordering 1:1.
export function getMightyUomConversion(
  productId: string,
  category: string | null,
  rowUom: string | null,
  productOverride: MightyProductUomOverride | undefined,
  categoryUomSettings: Record<string, MightyCategoryUomSetting>,
  uomMappings: MightyUomRule[],
  prefixSuffixRules: MightyPrefixSuffixRule[],
): MightyUomConversion {
  const onHandUom = (productOverride?.onHandUom || '').trim() || (rowUom || '').trim()
    || (category && categoryUomSettings[category]?.onHandUom) || ''
  const orderUom = (productOverride?.orderUom || '').trim()
    || (category && categoryUomSettings[category]?.orderUom) || ''

  if (onHandUom && orderUom && onHandUom !== orderUom) {
    const m = uomMappings.find((u) => u.fromUnit === onHandUom && u.toUnit === orderUom)
    if (m && m.factor > 0) return { onHandUom, orderUom, onHandToOrderFactor: m.factor, orderToOnHandFactor: 1 / m.factor, hasConversion: true }
    const rev = uomMappings.find((u) => u.fromUnit === orderUom && u.toUnit === onHandUom)
    if (rev && rev.factor > 0) return { onHandUom, orderUom, onHandToOrderFactor: 1 / rev.factor, orderToOnHandFactor: rev.factor, hasConversion: true }
    return { onHandUom, orderUom, onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false, conversionMissing: true }
  }

  if (!productOverride?.onHandUom && !productOverride?.orderUom) {
    const ps = prefixSuffixRules.find((r) => {
      const t = (r.text || '').trim()
      if (!t || !r.purchaseSize) return false
      const excl = r.exclusions ?? { products: [], categories: [] }
      if (excl.products?.includes(productId)) return false
      if (category && excl.categories?.includes(category)) return false
      return r.matchType === 'prefix' ? productId.startsWith(t) : productId.endsWith(t)
    })
    if (ps) {
      const packSize = Number(ps.purchaseSize)
      if (ps.orderMode === 'pack') {
        return { onHandUom: 'unit', orderUom: ps.text, onHandToOrderFactor: 1 / packSize, orderToOnHandFactor: packSize, hasConversion: true, isPack: true, packSize }
      }
      // 'unit' mode: order stays in on-hand units, rounded to pack
      // multiples elsewhere (applyMightyProductRule's caseSize) — no
      // factor conversion needed here, just flagged so the caller knows
      // a pack size applies.
      return { onHandUom: 'unit', orderUom: 'unit', onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false, isPack: true, packSize }
    }
  }

  return { onHandUom, orderUom, onHandToOrderFactor: 1, orderToOnHandFactor: 1, hasConversion: false }
}

// Applies global/location/field-value minimum order quantities — the
// most-specific matching rule wins (column_value > location > global), and
// a minimum only ever raises an order that's already > 0.
export function applyMightyMinOrderRules(
  row: { locationId: string; category: string | null; productId: string; uom: string | null },
  orderQty: number,
  minOrderRules: MightyMinOrderRule[],
): number {
  if (!minOrderRules.length || orderQty <= 0) return orderQty
  let bestPrecedence = -1
  let applicableMin: number | null = null
  for (const rule of minOrderRules) {
    const min = Number(rule.minQty)
    if (isNaN(min) || min <= 0) continue
    let matches = false
    let precedence = 0
    if (rule.scope === 'global') {
      matches = true; precedence = 0
    } else if (rule.scope === 'location') {
      matches = row.locationId.trim().toLowerCase() === (rule.location ?? '').trim().toLowerCase()
      precedence = 1
    } else if (rule.scope === 'column_value') {
      const ruleVal = (rule.colValue ?? '').trim().toLowerCase()
      if (ruleVal !== '' && rule.field) {
        const fieldVal = String(row[rule.field] ?? '').trim().toLowerCase()
        matches = fieldVal === ruleVal
      }
      precedence = 2
    }
    if (matches && precedence > bestPrecedence) {
      bestPrecedence = precedence
      applicableMin = min
    }
  }
  return applicableMin !== null && orderQty < applicableMin ? applicableMin : orderQty
}

// Order Efficiency scorecard — per line, "recommended" is either
// maxOnHand-onHand (when a max is set) or the same target-days-of-supply
// math calcMightyOrder uses; efficiency caps at 100% (over-ordering past
// the recommendation doesn't score above optimal, it just shows up as an
// outlier in the Most Ordered panel) and floors at 0% for a line that
// needed something but got nothing. A line needing nothing that also got
// nothing scores 100%; needing nothing but getting something scores 50%
// (a real but lesser problem than under-ordering a line that DOES need
// stock).
export function computeMightyEfficiency(
  lines: { locationId: string; productId: string; dailyUsage: number | null; onHand: number | null; leadTimeDays: number; maxOnHand: number | null; orderQty: number }[],
  targetDays: number,
): MightyEfficiencySummary {
  const usageLines = lines.filter((l) => (l.dailyUsage ?? 0) > 0)
  if (usageLines.length === 0) {
    return { productCount: 0, avgEfficiencyPct: 0, avgDaysCovered: 0, totalOrderedUnits: 0, totalRecommendedUnits: 0, leadTimeOptimalDays: null, rows: [] }
  }
  const rows: MightyEfficiencyRow[] = usageLines.map((l) => {
    const usage = l.dailyUsage as number
    const onHand = l.onHand ?? 0
    const order = l.orderQty || 0
    const recommended = l.maxOnHand != null && l.maxOnHand > 0
      ? Math.max(0, l.maxOnHand - onHand)
      : Math.max(0, usage * (l.leadTimeDays + targetDays) - onHand)
    const orderDays = usage > 0 ? order / usage : 0
    const efficiencyPct = recommended <= 0
      ? (order > 0 ? 50 : 100)
      : order <= 0
        ? 0
        : Math.min(100, Math.round((Math.min(order, recommended) / recommended) * 100))
    return { locationId: l.locationId, productId: l.productId, recommended, orderDays, efficiencyPct }
  })
  const avgDaysCovered = rows.reduce((s, r) => s + r.orderDays, 0) / rows.length
  const avgEfficiencyPct = Math.round(rows.reduce((s, r) => s + r.efficiencyPct, 0) / rows.length)
  const totalRecommendedUnits = rows.reduce((s, r) => s + r.recommended, 0)
  const totalOrderedUnits = usageLines.reduce((s, l) => s + (l.orderQty || 0), 0)
  const leaded = usageLines.filter((l) => l.leadTimeDays > 0)
  const leadTimeOptimalDays = leaded.length
    ? Math.round(leaded.reduce((s, l) => s + l.leadTimeDays, 0) / leaded.length + targetDays)
    : null
  return { productCount: rows.length, avgEfficiencyPct, avgDaysCovered, totalOrderedUnits, totalRecommendedUnits, leadTimeOptimalDays, rows }
}
