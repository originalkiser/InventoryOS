import { describe, it, expect } from 'vitest'
import { generateOrder, roundQty } from './engine'
import { DEFAULT_ORDER_SETTINGS, type GenerationContext, type GenerationInput, type ProductRule } from './types'

// Coverage for the rules revised after the first review: soft DOS ceilings,
// per-product minimums, and vendor case-type minimums.

const rule = (over: Partial<ProductRule> = {}): ProductRule => ({
  location_id: 'L1', product_id: 'P1', uom: 'case', units_per_uom_gallons: 5, unit_cost: 100,
  max_capacity_gallons: null, vmi_keepfill_enabled: false, can_ignore_minimum: false,
  ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2,
  include_in_total_shop_order: true, order_type_override: null, ...over,
})

const input = (over: Omit<Partial<GenerationInput>, 'rule'> & { rule?: Partial<ProductRule> } = {}): GenerationInput => {
  const r = rule({ ...(over.rule ?? {}), location_id: over.location_id ?? 'L1', product_id: over.product_id ?? 'P1' })
  return {
    location_id: over.location_id ?? 'L1', product_id: over.product_id ?? 'P1',
    rule: r, on_hand: over.on_hand ?? 10, daily_usage: over.daily_usage ?? 5,
  }
}

const dollars = (v: number) => ({ type: 'dollars' as const, dollars: v, qty: null })

const ctx = (over: Partial<GenerationContext> = {}): GenerationContext => ({
  settings: { ...DEFAULT_ORDER_SETTINGS, ...(over.settings ?? {}) },
  vendor: over.vendor ?? { vendor_id: 'V1', minimums: {}, caseTypeMinimums: {}, usesOrderDays: false },
  orderDate: over.orderDate ?? '2026-08-19',
  eligibleLocationIds: over.eligibleLocationIds ?? null,
  history: over.history ?? [],
  includeVmi: over.includeVmi ?? false,
})

describe('DOS ceilings are soft, capacity is hard', () => {
  it('no longer skips a well-stocked product outright — it is simply not due', () => {
    // Previously this returned 'dos_over_skip_threshold' and dropped the shop.
    const res = generateOrder([input({ on_hand: 1000, daily_usage: 5 })], ctx())
    expect(res.skipped[0].reason).toBe('above_min_trigger')
  })

  it('exceeds the DOS max to reach a minimum, and flags the lines that did', () => {
    // Pass 1 stops at dos_max (35): (35*5 - 45)/5 = 26 cases at $30 = $780.
    // A $1,500 minimum forces smoothing past that ceiling.
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 30 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(1500) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.groups[0].meetsMinimum).toBe(true)
    expect(res.lines[0].dos_after!).toBeGreaterThan(DEFAULT_ORDER_SETTINGS.days_of_supply_max)
    expect(res.lines[0].flags).toContain('over_dos_max')
  })

  it('still refuses to exceed physical capacity, even for a minimum', () => {
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 60 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(99999) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.lines[0].qty * 5 + 45).toBeLessThanOrEqual(60)
    expect(res.groups[0].meetsMinimum).toBe(false)
  })

  it('will not pull a well-stocked product onto an order just to reach a minimum', () => {
    const due = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 50 } })
    // DOS 100 — far above skip_order_if_dos_over (45), so smoothing must ignore it.
    const flush = input({ product_id: 'P2', on_hand: 500, daily_usage: 5, rule: { unit_cost: 100 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(5000) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([due, flush], c)
    expect(res.lines.find((l) => l.product_id === 'P2')).toBeUndefined()
  })

  it('does pull in a moderately stocked product to reach a minimum', () => {
    const due = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 50 } })
    const spare = input({ product_id: 'P2', on_hand: 100, daily_usage: 5, rule: { unit_cost: 100 } })  // DOS 20 <= 45
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(600) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([due, spare], c)
    const added = res.lines.find((l) => l.product_id === 'P2')
    expect(added?.added_by_smoothing).toBe(true)
  })
})

describe('per-product minimums', () => {
  // units_per_uom_gallons: 4 here means one order UNIT is a real gallon (4
  // quarts, this module's internal unit) — deliberately NOT 1, which is
  // what let the real conversion bug through undetected: 'gallons_per_
  // product' is entered in REAL gallons, but with a 1-quart-per-unit
  // fixture, "real gallons" and "quarts-space units" are numerically
  // identical, so a missing gallons->quarts conversion produced the exact
  // same test result as the correct formula. A per-unit factor that isn't
  // 1 is required for these tests to actually catch that class of bug.
  it('raises each bulk line to the configured gallons per product', () => {
    const a = input({ product_id: 'B1', on_hand: 10, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 4 } })
    const b = input({ product_id: 'B2', on_hand: 12, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 4 } })
    const c = ctx({
      settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_max: 30 },
      vendor: { vendor_id: 'V1', caseTypeMinimums: {}, usesOrderDays: false,
        minimums: { bulk: { type: 'gallons_per_product', dollars: 0, qty: 100 } } },
    })
    const res = generateOrder([a, b], c)
    expect(res.groups[0].meetsMinimum).toBe(true)
    // 100 real gallons at 4 quarts/unit (1 unit = 1 gallon) = 100 units.
    // The unfixed formula (floor / per, no gallons->quarts step) would have
    // given 100/4 = 25 units here — a quarter of the real floor.
    for (const l of res.lines) expect(l.qty).toBeGreaterThanOrEqual(100)
  })

  it('is a floor per line, not a floor on the order total', () => {
    // Two products, 100 gal each — the total is 200, but each line must
    // independently clear 100 rather than the pair summing to it.
    const a = input({ product_id: 'B1', on_hand: 0, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 4 } })
    const b = input({ product_id: 'B2', on_hand: 0, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 4 } })
    const c = ctx({
      settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_max: 200 },
      vendor: { vendor_id: 'V1', caseTypeMinimums: {}, usesOrderDays: false,
        minimums: { bulk: { type: 'gallons_per_product', dollars: 0, qty: 100 } } },
    })
    const res = generateOrder([a, b], c)
    expect(res.lines).toHaveLength(2)
    for (const l of res.lines) expect(l.qty).toBeGreaterThanOrEqual(100)
  })

  it('reports the group short when capacity blocks the per-product floor', () => {
    // max_capacity_gallons is in quarts (this module's internal unit,
    // despite the name) — 40 quarts at 4 quarts/unit caps the line at 10
    // units, well under the 100-unit floor 100 real gallons works out to.
    const a = input({ product_id: 'B1', on_hand: 0, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 4, max_capacity_gallons: 40 } })
    const c = ctx({
      vendor: { vendor_id: 'V1', caseTypeMinimums: {}, usesOrderDays: false,
        minimums: { bulk: { type: 'gallons_per_product', dollars: 0, qty: 100 } } },
    })
    const res = generateOrder([a], c)
    expect(res.lines[0].qty).toBeLessThanOrEqual(10)
    expect(res.groups[0].meetsMinimum).toBe(false)
    expect(res.lines[0].flags).toContain('below_minimum')
  })

  it('regression: a 55-gallon floor at 4 quarts/unit orders 55 units, not 13', () => {
    // The exact real-world numbers from the production report that
    // surfaced this bug: ROT-T6-5W40 (4 quarts/unit — "52 qt" shown under
    // a qty of 13 in the review table) against a configured 55-gallon
    // bulk minimum landed at 13 units instead of 55.
    const a = input({ product_id: 'ROT-T6-5W40', on_hand: 0, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 4, unit_cost: 27 } })
    const c = ctx({
      settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_max: 200 },
      vendor: { vendor_id: 'V1', caseTypeMinimums: {}, usesOrderDays: false,
        minimums: { bulk: { type: 'gallons_per_product', dollars: 0, qty: 55 } } },
    })
    const res = generateOrder([a], c)
    expect(res.lines[0].qty).toBe(55)
  })
})

describe('vendor case-type minimums', () => {
  it('tops the order up to at least the case-type minimum across products', () => {
    // DOS 12 with a target of 13 => 1 bay box due on each product, 2 in total.
    // Bay boxes ship in sixes, so the order has to be topped up to 6.
    const a = input({ product_id: 'A', on_hand: 60, daily_usage: 5, rule: { uom: 'bay_box', unit_cost: 50 } })
    const b = input({ product_id: 'B', on_hand: 60, daily_usage: 5, rule: { uom: 'bay_box', unit_cost: 50 } })
    const c = ctx({
      settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_min_trigger: 14, days_of_supply_target: 13 },
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: { bay_box: 6 }, usesOrderDays: false },
    })
    const res = generateOrder([a, b], c)
    const total = res.lines.filter((l) => l.uom === 'bay_box').reduce((s, l) => s + l.qty, 0)
    expect(total).toBeGreaterThanOrEqual(6)
    expect(res.lines.some((l) => l.flags.includes('case_minimum_topup'))).toBe(true)
  })

  it('does not force the case type onto an order that has none of it', () => {
    const drum = input({ product_id: 'D', on_hand: 10, daily_usage: 5, rule: { uom: 'drum', unit_cost: 50 } })
    const c = ctx({
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: { bay_box: 6 }, usesOrderDays: false },
    })
    const res = generateOrder([drum], c)
    expect(res.lines.every((l) => l.uom === 'drum')).toBe(true)
  })

  it('is a total for the order, not a multiple each product must be ordered in', () => {
    const a = input({ product_id: 'A', on_hand: 60, daily_usage: 5, rule: { uom: 'bay_box', unit_cost: 50 } })
    const b = input({ product_id: 'B', on_hand: 60, daily_usage: 5, rule: { uom: 'bay_box', unit_cost: 50 } })
    const c = ctx({
      settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_target: 15 },
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: { bay_box: 6 }, usesOrderDays: false },
    })
    const res = generateOrder([a, b], c)
    // Individual lines are free to be any quantity — only the sum must clear 6.
    expect(res.lines.some((l) => l.qty % 6 !== 0)).toBe(true)
    expect(res.lines.reduce((s, l) => s + l.qty, 0)).toBeGreaterThanOrEqual(6)
  })
})

describe('never emits a non-finite quantity', () => {
  // Regression: an uncapped product (no usage data, no capacity limit) has an
  // Infinity cap. With no unit cost the smoothing branch used that cap as the
  // quantity, and JSON.stringify(Infinity) is null — which violated the NOT
  // NULL constraint on ov2_order_draft_lines.system_qty.
  it('does not order Infinity of a costless, uncapped product to reach a minimum', () => {
    const due = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 50 } })
    const costless = input({ product_id: 'P2', on_hand: 5, daily_usage: 0, rule: { unit_cost: null, max_capacity_gallons: null } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(9999) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([due, costless], c)
    for (const l of res.lines) {
      expect(Number.isFinite(l.qty)).toBe(true)
      expect(Number.isFinite(l.system_qty)).toBe(true)
    }
    // A $0 line can't close a dollar gap, so it shouldn't be pulled in at all.
    expect(res.lines.find((l) => l.product_id === 'P2')).toBeUndefined()
  })

  it('keeps every numeric field finite across a whole run', () => {
    const rows = [
      input({ product_id: 'A', on_hand: 0, daily_usage: 0, rule: { unit_cost: null } }),
      input({ product_id: 'B', on_hand: 10, daily_usage: 5, rule: { unit_cost: 20 } }),
      input({ product_id: 'C', on_hand: 5, daily_usage: 1, rule: { uom: 'bulk', units_per_uom_gallons: 1, unit_cost: 0 } }),
    ]
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(5000), bulk: dollars(5000) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder(rows, c)
    for (const l of res.lines) {
      for (const v of [l.qty, l.system_qty]) expect(Number.isFinite(v)).toBe(true)
      for (const v of [l.dos_before, l.dos_after, l.unit_cost, l.on_hand, l.daily_usage]) {
        if (v != null) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  it('rounds a non-finite quantity down to zero', () => {
    expect(roundQty(Number.POSITIVE_INFINITY, 'case', 0)).toBe(0)
    expect(roundQty(Number.NaN, 'case', 0)).toBe(0)
    expect(roundQty(Number.POSITIVE_INFINITY, 'bulk', 1)).toBe(0)
  })
})
