import { describe, it, expect } from 'vitest'
import {
  generateOrder, daysOfSupply, roundQty, nextDeliveryDate, dosAfterDelivery,
  capsFor, renderTemplate, poNumber,
} from './engine'
import { DEFAULT_ORDER_SETTINGS, type GenerationContext, type GenerationInput, type ProductRule } from './types'

const rule = (over: Partial<ProductRule> = {}): ProductRule => ({
  location_id: 'L1', product_id: 'P1', uom: 'case', units_per_uom_gallons: 5, unit_cost: 100,
  max_capacity_gallons: null, vmi_keepfill_enabled: false, can_ignore_minimum: false,
  ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2,
  include_in_total_shop_order: true, ...over,
})

const input = (over: Omit<Partial<GenerationInput>, 'rule'> & { rule?: Partial<ProductRule> } = {}): GenerationInput => {
  const r = rule({ ...(over.rule ?? {}), location_id: over.location_id ?? 'L1', product_id: over.product_id ?? 'P1' })
  return {
    location_id: over.location_id ?? 'L1', product_id: over.product_id ?? 'P1',
    rule: r, on_hand: over.on_hand ?? 10, daily_usage: over.daily_usage ?? 5,
  }
}

/** Dollar minimum shorthand for the vendor rules in these tests. */
const dollars = (v: number) => ({ type: 'dollars' as const, dollars: v, qty: null })

const ctx = (over: Partial<GenerationContext> = {}): GenerationContext => ({
  settings: { ...DEFAULT_ORDER_SETTINGS, ...(over.settings ?? {}) },
  vendor: over.vendor ?? { vendor_id: 'V1', minimums: {}, caseTypeMinimums: {}, usesOrderDays: false },
  orderDate: over.orderDate ?? '2026-08-19',
  eligibleLocationIds: over.eligibleLocationIds ?? null,
  history: over.history ?? [],
  includeVmi: over.includeVmi ?? false,
})

describe('numeric helpers', () => {
  it('treats zero usage as unknown DOS rather than zero', () => {
    expect(daysOfSupply(100, 0)).toBeNull()
    expect(daysOfSupply(100, 5)).toBe(20)
  })

  it('keeps discrete UOMs whole and lets bulk carry configured decimals', () => {
    expect(roundQty(2.6, 'case', 0)).toBe(3)
    expect(roundQty(2.6, 'bulk', 0)).toBe(3)
    expect(roundQty(2.64, 'bulk', 1)).toBe(2.6)
    // rounding down is used wherever a cap binds, so a cap can't be breached
    expect(roundQty(2.9, 'case', 0, 'down')).toBe(2)
  })
})

describe('delivery dating', () => {
  it('takes the next occurrence strictly after the order date', () => {
    // 2026-08-19 is a Wednesday (3). Thursday (4) is the next day.
    expect(nextDeliveryDate('2026-08-19', 4)).toBe('2026-08-20')
  })

  it('rolls to next week when ordering on the delivery weekday itself', () => {
    expect(nextDeliveryDate('2026-08-19', 3)).toBe('2026-08-26')
  })

  it('subtracts usage over the lead time when projecting DOS at delivery', () => {
    // 10 on hand, 5/day, +25 ordered, delivered in 1 day => (10-5+25)/5 = 6
    expect(dosAfterDelivery(10, 5, 25, '2026-08-19', '2026-08-20')).toBe(6)
  })
})

describe('pass 1 — fill to target', () => {
  it('skips products above the min-trigger', () => {
    const res = generateOrder([input({ on_hand: 100, daily_usage: 5 })], ctx())  // DOS 20 > 14
    expect(res.lines).toHaveLength(0)
    expect(res.skipped[0].reason).toBe('above_min_trigger')
  })

  it('orders up toward the target when below the trigger', () => {
    // DOS 2, target 21 => need 105 gallons - 10 on hand = 95 => 19 cases of 5
    const res = generateOrder([input({ on_hand: 10, daily_usage: 5 })], ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false } }))
    expect(res.lines).toHaveLength(1)
    expect(res.lines[0].qty).toBe(19)
    expect(res.lines[0].dos_after).toBeCloseTo(21, 5)
  })

  it('excludes VMI/keepfill unless explicitly included', () => {
    const vmi = input({ rule: { vmi_keepfill_enabled: true } })
    expect(generateOrder([vmi], ctx()).skipped[0].reason).toBe('vmi_keepfill')
    expect(generateOrder([vmi], ctx({ includeVmi: true, vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false } })).lines).toHaveLength(1)
  })

  it('honours the order-day restriction', () => {
    const res = generateOrder([input()], ctx({ eligibleLocationIds: new Set(['OTHER']) }))
    expect(res.skipped[0].reason).toBe('not_order_day')
  })
})

describe('caps', () => {
  it('never exceeds max capacity, and says capacity was binding', () => {
    const i = input({ on_hand: 10, daily_usage: 5, rule: { max_capacity_gallons: 40 } })
    const caps = capsFor(i, ctx())
    expect(caps.maxUnits).toBe(6)             // (40-10)/5
    expect(caps.capacityBound).toBe(true)
    const res = generateOrder([i], ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false } }))
    expect(res.lines[0].qty).toBe(6)
    expect(res.lines[0].flags).toContain('capacity_capped')
  })

  it('treats max capacity as hard but the DOS ceiling as soft', () => {
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 55 } })
    // A minimum far beyond reach: smoothing may pass dos_max but never capacity.
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(100000) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.lines[0].qty * 5 + 45).toBeLessThanOrEqual(55)
  })

  it('caps at dos_max even with no capacity limit', () => {
    // target 21 but dos_max 35 -> plenty of room; tighten dos_max to bind
    const c = ctx({ settings: { ...DEFAULT_ORDER_SETTINGS, days_of_supply_max: 15 }, vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([input({ on_hand: 10, daily_usage: 5 })], c)
    expect(res.lines[0].dos_after! <= 15).toBe(true)
  })
})

describe('pass 2 — smoothing to the order minimum', () => {
  it('tops up an existing line rather than leaving the order short', () => {
    // DOS 9 -> pass 1 fills to target = 12 cases. At $30 that's $360, under
    // the $500 minimum, and headroom to dos_max allows topping up.
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 30 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(500) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    const g = res.groups[0]
    expect(g.smoothingApplied).toBe(true)
    expect(g.meetsMinimum).toBe(true)
    expect(g.dollars).toBeGreaterThanOrEqual(500)
    expect(g.lines[0].triggered_smoothing).toBe(true)
  })

  it('pulls in another eligible product when top-ups cannot close the gap', () => {
    const short = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { unit_cost: 100, max_capacity_gallons: 55 } })
    // P2 isn't due (DOS 20) but is available to help reach the minimum
    const spare = input({ product_id: 'P2', on_hand: 100, daily_usage: 5, rule: { unit_cost: 100 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(500) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([short, spare], c)
    const added = res.lines.find((l) => l.product_id === 'P2')
    expect(added).toBeDefined()
    expect(added!.added_by_smoothing).toBe(true)
    expect(res.groups[0].dollars).toBeGreaterThanOrEqual(500)
  })

  it('reports a group that still cannot reach the minimum instead of forcing it', () => {
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 10, max_capacity_gallons: 55 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(5000) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.groups[0].meetsMinimum).toBe(false)
    expect(res.lines[0].flags).toContain('below_minimum')
    // capacity must still be respected — smoothing never breaches a cap
    expect(res.lines[0].qty * 5 + 45).toBeLessThanOrEqual(55)
  })

  it('uses the alone-quantity for a sole line flagged to ignore the minimum', () => {
    // Minimum is unreachable ($1,200 of demand vs a $5,000 floor), so rather
    // than inflating the order the waiver applies and the alone-qty is used.
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 100, can_ignore_minimum: true, ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(5000) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.lines[0].qty).toBe(2)
    expect(res.lines[0].flags).toContain('alone_default_qty')
    expect(res.groups[0].meetsMinimum).toBe(true)   // minimum waived, not failed
  })

  it('leaves a sole line at real demand when it already clears the minimum', () => {
    // The waiver exists to avoid inflating an order, not to cap a healthy one.
    const i = input({ on_hand: 45, daily_usage: 5, rule: { unit_cost: 100, can_ignore_minimum: true, ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(500) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([i], c)
    expect(res.lines[0].qty).toBe(12)
    expect(res.lines[0].flags).not.toContain('alone_default_qty')
  })

  it('excludes products marked out of the shop total from the minimum maths', () => {
    const counted = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { unit_cost: 100 } })
    const uncounted = input({ product_id: 'P2', on_hand: 45, daily_usage: 5, rule: { unit_cost: 100, include_in_total_shop_order: false } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(300) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([counted, uncounted], c)
    const p2 = res.lines.find((l) => l.product_id === 'P2')!
    // P2's dollars don't count, so the group total must come from P1 alone
    const p1 = res.lines.find((l) => l.product_id === 'P1')!
    expect(res.groups[0].dollars).toBeCloseTo(p1.qty * 100, 5)
    expect(p2.qty).toBeGreaterThan(0)
  })

  it('keeps package and bulk as separate groups with their own minimums', () => {
    const pkg = input({ product_id: 'P1', on_hand: 45, daily_usage: 5, rule: { uom: 'case', unit_cost: 100 } })
    const blk = input({ product_id: 'B1', on_hand: 45, daily_usage: 5, rule: { uom: 'bulk', unit_cost: 4, units_per_uom_gallons: 1 } })
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(200), bulk: dollars(100) }, caseTypeMinimums: {}, usesOrderDays: false } })
    const res = generateOrder([pkg, blk], c)
    expect(res.groups).toHaveLength(2)
    const p = res.groups.find((g) => g.order_type === 'package')!
    const b = res.groups.find((g) => g.order_type === 'bulk')!
    expect(p.minimum).toBe(200)
    expect(b.minimum).toBe(100)
    expect(p.meetsMinimum && b.meetsMinimum).toBe(true)
  })
})

describe('flags', () => {
  it('flags a product ordered recently while DOS was already high', () => {
    const c = ctx({
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false },
      history: [{ location_id: 'L1', product_id: 'P1', order_date: '2026-08-10', dos_before: 40, dos_ordered: null, qty: 5 }],
    })
    expect(generateOrder([input({ on_hand: 10, daily_usage: 5 })], c).lines[0].flags).toContain('recent_high_dos_order')
  })

  it('does not flag when the high-DOS order falls outside the lookback window', () => {
    const c = ctx({
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false },
      history: [{ location_id: 'L1', product_id: 'P1', order_date: '2026-01-01', dos_before: 40, dos_ordered: null, qty: 5 }],
    })
    expect(generateOrder([input()], c).lines[0].flags).not.toContain('recent_high_dos_order')
  })

  it('flags a recent order whose quantity was a large days-of-supply amount', () => {
    const c = ctx({
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false },
      history: [{ location_id: 'L1', product_id: 'P1', order_date: '2026-08-12', dos_before: 5, dos_ordered: 60, qty: 12 }],
    })
    expect(generateOrder([input()], c).lines[0].flags).toContain('recent_large_dos_order')
  })

  it('does not raise the large-DOS flag when the ordered amount was modest', () => {
    const c = ctx({
      vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false },
      history: [{ location_id: 'L1', product_id: 'P1', order_date: '2026-08-12', dos_before: 5, dos_ordered: 5, qty: 1 }],
    })
    expect(generateOrder([input()], c).lines[0].flags).not.toContain('recent_large_dos_order')
  })

  it('flags a stocked-out product', () => {
    const c = ctx({ vendor: { vendor_id: 'V1', minimums: { package: dollars(0) }, caseTypeMinimums: {}, usesOrderDays: false } })
    expect(generateOrder([input({ on_hand: 0, daily_usage: 5 })], c).lines[0].flags).toContain('stocked_out')
  })
})

describe('templates', () => {
  it('builds the PO number in the documented format', () => {
    expect(poNumber('1', '2026-08-19', 'bulk')).toBe('1-08192026B')
    expect(poNumber('1', '2026-08-19', 'package')).toBe('1-08192026P')
  })

  it('renders composite templates with fields and date formats', () => {
    expect(renderTemplate('{shop_number}-{date:MMDDYYYY}{order_type_code}',
      { shop_number: 1, order_type_code: 'B' }, '2026-08-19')).toBe('1-08192026B')
    expect(renderTemplate('{vendor}_{date:YYYY-MM-DD}', { vendor: 'RelaDyne' }, '2026-08-19'))
      .toBe('RelaDyne_2026-08-19')
  })

  it('renders unknown fields as empty rather than leaving the placeholder', () => {
    expect(renderTemplate('{nope}-x', {}, '2026-08-19')).toBe('-x')
  })
})
