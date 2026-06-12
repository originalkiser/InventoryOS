import { describe, it, expect } from 'vitest'
import {
  calcOrder, isTotalRow, resolveProductIds, generateOrder, applyMinOrderRules, buildExport,
  calcDaysOnHand, getUsageMultiplier, getUomConversion, buildPendingIndex, autoPendingColMap,
  detectPrefixSuffixPatterns,
  type InventoryRow, type OrderConfigData, type GenerationParams,
} from './orderEngine'
import type {
  Location, LocationOrderConfig, ProductIdMapping, GlobalProduct, VendorPart, OrderMinRule,
} from '@/types'

// --- Fixtures (minimal objects cast to the full row types; the engine only
// reads the fields exercised here) ---------------------------------------------
const locations = [
  { id: 'loc-1', company_id: 'co', location_code: 'S1', name: 'Store 1', active: true },
] as unknown as Location[]

const locationConfigs = [
  { company_id: 'co', location_id: 'loc-1', product_id: 'P1', order_trigger: 10, capacity: 50, order_limit: null, active: true },
  { company_id: 'co', location_id: 'loc-1', product_id: 'P2', order_trigger: 5, capacity: 100, order_limit: 20, active: true },
  { company_id: 'co', location_id: 'loc-1', product_id: 'P3', order_trigger: 10, capacity: 40, order_limit: null, active: true },
] as unknown as LocationOrderConfig[]

const productMappings = [
  { company_id: 'co', old_product_id: 'OLD1', new_product_id: 'P1' },
] as unknown as ProductIdMapping[]

const globalProducts = [
  { company_id: 'co', product_id: 'P1', unit_of_measure: 'EA', package_type: null, bulk_minimum: null, individual_minimum: null },
] as unknown as GlobalProduct[]

const vendorParts = [
  { company_id: 'co', part_number: 'P2', unit_of_measure: 'CS', package_type: 'Case', bulk_minimum: 6, individual_minimum: null },
] as unknown as VendorPart[]

const config: OrderConfigData = { locations, locationConfigs, productMappings, globalProducts, vendorParts }

const inventoryRows: InventoryRow[] = [
  { location: 'S1', product: 'OLD1', on_hand: 3, daily_usage: 0, leadtime: 2 }, // → P1, below trigger
  { location: 'S1', product: 'P2', on_hand: 2, daily_usage: 1, leadtime: 3 },   // below trigger, hits order_limit
  { location: 'S1', product: 'P3', on_hand: 30, daily_usage: 1, leadtime: 2 },  // above trigger → no order
  { location: 'S1', product: 'Subtotal', on_hand: 999, daily_usage: 0, leadtime: 0 }, // total row → skipped
]

const minMaxParams: GenerationParams = {
  targetDays: 14, orderMode: 'min_max', zeroUsageFill: 'none', triggerOverride: null, limitOverride: null,
}

describe('ported calc primitives', () => {
  it('calcOrder matches calc.js: ceil(max(0,(usage*(lead+target)-onHand)))', () => {
    expect(calcOrder(2, 5, 3, 14)).toBe(29) // 2*(3+14)-5 = 29
    expect(calcOrder(1, 100, 2, 14)).toBe(0) // plenty on hand → 0
    expect(calcOrder(NaN, 5, 3, 14)).toBeNull()
  })

  it('isTotalRow flags grand/sub total lines only', () => {
    expect(isTotalRow('Total')).toBe(true)
    expect(isTotalRow('Grand Total')).toBe(true)
    expect(isTotalRow('Subtotal')).toBe(true)
    expect(isTotalRow('Widget-500')).toBe(false)
  })

  it('resolveProductIds applies old→new before matching', () => {
    const out = resolveProductIds([{ product: 'OLD1' } as InventoryRow], productMappings)
    expect(out[0].product).toBe('P1')
  })
})

describe('generateOrder (min/max model)', () => {
  const lines = generateOrder(inventoryRows, config, minMaxParams)

  it('skips total rows and zero-need rows (P3 above trigger)', () => {
    expect(lines.map((l) => l.product_id).sort()).toEqual(['P1', 'P2'])
  })

  it('orders up to capacity when below trigger (P1: 50-3=47)', () => {
    const p1 = lines.find((l) => l.product_id === 'P1')!
    expect(p1.suggested_qty).toBe(47)
    expect(p1.trigger_reason).toBe('below_trigger')
    expect(p1.location_id).toBe('loc-1') // resolved from "S1"
  })

  it('caps suggested at order_limit (P2: 100-2=98 capped to 20)', () => {
    const p2 = lines.find((l) => l.product_id === 'P2')!
    expect(p2.suggested_qty).toBe(20)
    expect(p2.vendor_part_number).toBe('P2')
    expect(p2.unit_of_measure).toBe('CS')
    expect(p2.package_type).toBe('Case')
    expect(p2.bulk_minimum).toBe(6)
  })
})

describe('applyMinOrderRules (flexible MOQ engine)', () => {
  const gen = generateOrder(inventoryRows, config, minMaxParams)
  const rules = [
    { id: 'r1', company_id: 'co', name: null, applies_to: { scope: 'global' }, individual_minimum: 5, bulk_minimum: null, uom: null, package_type: null, rule_logic: null, active: true },
    { id: 'r2', company_id: 'co', name: 'P1 floor', applies_to: { scope: 'product', value: 'P1' }, individual_minimum: 50, bulk_minimum: null, uom: null, package_type: null, rule_logic: null, active: true },
  ] as unknown as OrderMinRule[]
  const out = applyMinOrderRules(gen, rules)

  it('product-scoped rule wins over global (precedence) and raises floor: P1 47 → 50', () => {
    const p1 = out.find((l) => l.product_id === 'P1')!
    expect(p1.final_qty).toBe(50)
    expect(p1.applied_min_rule).toContain('P1 floor')
  })

  it('rounds up to bulk/case multiples: P2 20 → 24 (ceil(20/6)*6)', () => {
    const p2 = out.find((l) => l.product_id === 'P2')!
    expect(p2.final_qty).toBe(24)
    expect(p2.applied_min_rule).toContain('Case x6')
  })

  it('never forces an order on a zero-need line', () => {
    const zero = applyMinOrderRules(
      [{ ...gen[0], suggested_qty: 0, final_qty: 0, individual_minimum: 12, bulk_minimum: null }],
      [],
    )
    expect(zero[0].final_qty).toBe(0)
  })

  it('honors maxQty / maxOnHandAfter caps from rule_logic', () => {
    const capped = applyMinOrderRules(
      [{ ...gen[0], product_id: 'P1', suggested_qty: 47, final_qty: 47, on_hand: 3, bulk_minimum: null, individual_minimum: null }],
      [{ id: 'rc', company_id: 'co', name: 'cap', applies_to: { scope: 'global' }, individual_minimum: null, bulk_minimum: null, uom: null, package_type: null, rule_logic: { maxQty: 30 }, active: true }] as unknown as OrderMinRule[],
    )
    expect(capped[0].final_qty).toBe(30)
  })
})

describe('days_supply mode', () => {
  it('uses pure calcOrder coverage', () => {
    const params: GenerationParams = { targetDays: 14, orderMode: 'days_supply', zeroUsageFill: 'none', triggerOverride: null, limitOverride: null }
    const rows: InventoryRow[] = [{ location: 'S1', product: 'P1', on_hand: 5, daily_usage: 2, leadtime: 3 }]
    const out = generateOrder(rows, config, params)
    // 2*(3+14)-5 = 29
    expect(out[0].suggested_qty).toBe(29)
    expect(out[0].trigger_reason).toBe('days_supply')
  })
})

describe('ported calc.js extras', () => {
  it('calcDaysOnHand = on_hand / usage (null when usage 0)', () => {
    expect(calcDaysOnHand(2, 10)).toBe(5)
    expect(calcDaysOnHand(0, 10)).toBeNull()
  })

  it('getUsageMultiplier resolves product → category → global', () => {
    const adj = { global: 10, categories: { Dairy: 20 }, products: { P1: 50 } }
    expect(getUsageMultiplier('P1', 'Dairy', adj)).toBe(1.5) // product wins
    expect(getUsageMultiplier('PX', 'Dairy', adj)).toBe(1.2) // category
    expect(getUsageMultiplier('PX', 'Other', adj)).toBeCloseTo(1.1) // global
    expect(getUsageMultiplier('PX', null, null)).toBe(1) // none
  })

  it('getUomConversion returns identity without config and a named factor with it', () => {
    expect(getUomConversion({ product: 'P1' }, null).onHandToOrderFactor).toBe(1)
    const conv = getUomConversion(
      { product: 'P1', uom: 'EA', category: 'C' },
      { uomMappings: [{ fromUnit: 'EA', toUnit: 'CS', factor: 0.25 }], categoryUomSettings: { C: { orderUom: 'CS' } } },
    )
    expect(conv.hasConversion).toBe(true)
    expect(conv.onHandToOrderFactor).toBe(0.25)
    expect(conv.orderToOnHandFactor).toBe(4)
  })

  it('buildPendingIndex sums by location|product and autoPendingColMap guesses headers', () => {
    const idx = buildPendingIndex([
      { location: 'S1', product: 'P1', qty: 5 },
      { location: 'S1', product: 'P1', qty: 3 },
    ])
    expect(idx.get('s1|p1')).toBe(8)
    expect(autoPendingColMap(['Store', 'SKU', 'Qty Ordered'])).toEqual({ location: 'Store', product: 'SKU', qty: 'Qty Ordered' })
  })

  it('detectPrefixSuffixPatterns finds a shared prefix', () => {
    const pats = detectPrefixSuffixPatterns(['AB100', 'AB200', 'AB300', 'XY900'])
    expect(pats.some((p) => p.type === 'prefix' && p.text === 'AB')).toBe(true)
  })
})

describe('generateOrder — ported feature wiring', () => {
  it('applies a usage multiplier in days_supply mode', () => {
    const params: GenerationParams = { targetDays: 14, orderMode: 'days_supply', zeroUsageFill: 'none', triggerOverride: null, limitOverride: null, usageAdjustment: { global: 100 } }
    const rows: InventoryRow[] = [{ location: 'S1', product: 'P1', on_hand: 5, daily_usage: 2, leadtime: 3 }]
    const out = generateOrder(rows, config, params)
    // usage doubled to 4: 4*(3+14)-5 = 63
    expect(out[0].suggested_qty).toBe(63)
    expect(out[0].days_on_hand).toBe(2.5) // metric uses raw usage (10/... wait on_hand 5 / usage 2)
  })

  it('subtracts pending qty into final_qty but leaves suggested_qty', () => {
    const params: GenerationParams = { ...minMaxParams, pending: buildPendingIndex([{ location: 'S1', product: 'P1', qty: 10 }]) }
    const rows: InventoryRow[] = [{ location: 'S1', product: 'P1', on_hand: 3, daily_usage: 0, leadtime: 2 }]
    const out = generateOrder(rows, config, params)
    expect(out[0].suggested_qty).toBe(47) // 50 - 3
    expect(out[0].pending_qty).toBe(10)
    expect(out[0].final_qty).toBe(37) // 47 - 10
  })

  it('honors per-row min/max on-hand overrides', () => {
    // No config row for PX; row carries its own min/max on-hand.
    const params: GenerationParams = { ...minMaxParams }
    const rows: InventoryRow[] = [{ location: 'S1', product: 'PX', on_hand: 2, daily_usage: 1, leadtime: 1, min_on_hand: 5, max_on_hand: 20 }]
    const out = generateOrder(rows, config, params)
    expect(out[0].suggested_qty).toBe(18) // up to max 20 - 2 on hand
  })
})

describe('buildExport', () => {
  const gen = generateOrder(inventoryRows, config, minMaxParams)
  const out = applyMinOrderRules(gen, [])

  it('produces headers + rows in column order and respects excludeZeros', () => {
    const exp = buildExport(out as unknown as Array<Record<string, unknown>>, undefined, { excludeZeros: true })
    expect(exp.headers[0]).toBe('Location')
    expect(exp.headers).toContain('Order Qty')
    expect(exp.rows.length).toBe(2) // P1 + P2, both > 0
    // Order Qty column index
    const qtyIdx = exp.headers.indexOf('Order Qty')
    const p2Row = exp.rows.find((r) => r.includes('P2'))!
    expect(p2Row[qtyIdx]).toBe('24')
  })
})
