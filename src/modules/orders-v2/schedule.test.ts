import { describe, it, expect } from 'vitest'
import { resolveDeliveryDate, addBusinessDays, businessDaysBetween, weekStartOf, generateOrder } from './engine'
import { buildGenerationInputs, eligibleLocations, shopsPerOrderDay, draftOrderDow } from './useOrdersV2'
import { DEFAULT_ORDER_SETTINGS, type DeliverySchedule, type GenerationContext, type GenerationInput, type ProductRule, type WeekCalendar } from './types'

// 2026-08-19 is a Wednesday. Weekday numbers: Sun 0 … Sat 6.
const WED = '2026-08-19'

const sched = (over: Partial<DeliverySchedule> = {}): DeliverySchedule => ({
  type: 'weekly', delivery_dow: null, week_a_dow: null, week_b_dow: null, lead_business_days: 0, ...over,
})

describe('business-day helpers', () => {
  it('adds business days, skipping weekends', () => {
    // Wed + 5 business days -> next Wednesday
    expect(addBusinessDays(WED, 5)).toBe('2026-08-26')
    // Wed + 2 -> Friday
    expect(addBusinessDays(WED, 2)).toBe('2026-08-21')
    // Wed + 3 -> Monday (skips the weekend)
    expect(addBusinessDays(WED, 3)).toBe('2026-08-24')
  })

  it('counts business days between dates, excluding the start', () => {
    expect(businessDaysBetween(WED, '2026-08-21')).toBe(2)
    expect(businessDaysBetween(WED, '2026-08-24')).toBe(3)
    expect(businessDaysBetween(WED, WED)).toBe(0)
  })

  it('keys a week by its Sunday', () => {
    expect(weekStartOf(WED)).toBe('2026-08-16')
    expect(weekStartOf('2026-08-16')).toBe('2026-08-16')
  })
})

describe('weekly schedule', () => {
  it('takes the next occurrence of the weekday when there is no lead requirement', () => {
    expect(resolveDeliveryDate(WED, sched({ delivery_dow: 4 }))).toBe('2026-08-20') // Thu
  })

  it('rolls to the following week when the next occurrence is inside the lead time', () => {
    // Thursday is 1 business day out; a 4-business-day lead pushes it a week.
    expect(resolveDeliveryDate(WED, sched({ delivery_dow: 4, lead_business_days: 4 }))).toBe('2026-08-27')
  })

  it('keeps the nearest occurrence once the lead is satisfied', () => {
    // Next Wednesday is 5 business days out, which clears a 4-day lead.
    expect(resolveDeliveryDate(WED, sched({ delivery_dow: 3, lead_business_days: 4 }))).toBe('2026-08-26')
  })

  it('never returns the order date itself', () => {
    expect(resolveDeliveryDate(WED, sched({ delivery_dow: 3 }))).toBe('2026-08-26')
  })

  it('returns null when no weekday is configured', () => {
    expect(resolveDeliveryDate(WED, sched({ delivery_dow: null }))).toBeNull()
  })
})

describe('+N business days schedule', () => {
  it('uses the configured turnaround', () => {
    expect(resolveDeliveryDate(WED, sched({ type: 'plus_business_days', lead_business_days: 5 }))).toBe('2026-08-26')
  })

  it('defaults to 5 business days when none is set', () => {
    expect(resolveDeliveryDate(WED, sched({ type: 'plus_business_days', lead_business_days: 0 }))).toBe('2026-08-26')
  })
})

describe('week A / week B schedule', () => {
  // Week of Aug 16 = A, week of Aug 23 = B, week of Aug 30 = A.
  const cal: WeekCalendar = new Map<string, 'A' | 'B'>([
    ['2026-08-16', 'A'], ['2026-08-23', 'B'], ['2026-08-30', 'A'],
  ])
  const ab = sched({ type: 'week_ab', week_a_dow: 4, week_b_dow: 1 })  // A=Thu, B=Mon

  it('uses week A\'s weekday inside an A week', () => {
    expect(resolveDeliveryDate(WED, ab, cal)).toBe('2026-08-20')       // Thu of the A week
  })

  it('uses week B\'s weekday once the A week has passed', () => {
    // Ordering Friday of the A week: Thursday is gone, so the next hit is
    // Monday of the following (B) week.
    expect(resolveDeliveryDate('2026-08-21', ab, cal)).toBe('2026-08-24')
  })

  it('respects the lead requirement across the A/B boundary', () => {
    // Wed of the A week with a 4-business-day lead: Thu (1 day) is too soon,
    // Mon of the B week (3 days) is too soon, so it lands on Thu of the next A week.
    expect(resolveDeliveryDate(WED, { ...ab, lead_business_days: 4 }, cal)).toBe('2026-09-03')
  })

  it('skips weeks the calendar does not label rather than guessing', () => {
    const sparse: WeekCalendar = new Map<string, 'A' | 'B'>([['2026-08-30', 'A']])
    expect(resolveDeliveryDate(WED, ab, sparse)).toBe('2026-09-03')
  })

  it('returns null with no calendar at all', () => {
    expect(resolveDeliveryDate(WED, ab, new Map())).toBeNull()
  })
})

// ── the repeat-ordering flag ────────────────────────────────────────────

const rule = (over: Partial<ProductRule> = {}): ProductRule => ({
  location_id: 'L1', product_id: 'P1', uom: 'case', units_per_uom_gallons: 5, unit_cost: 100,
  max_capacity_gallons: null, vmi_keepfill_enabled: false, can_ignore_minimum: false,
  ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2,
  include_in_total_shop_order: true, order_type_override: null, ...over,
})
const input = (): GenerationInput => ({
  location_id: 'L1', product_id: 'P1', rule: rule(), on_hand: 10, daily_usage: 5,
})
const ctx = (history: GenerationContext['history']): GenerationContext => ({
  settings: DEFAULT_ORDER_SETTINGS,
  vendor: { vendor_id: 'V1', minimums: { package: { type: 'dollars', dollars: 0, qty: null } }, caseTypeMinimums: {}, usesOrderDays: false },
  orderDate: WED, eligibleLocationIds: null, history, includeVmi: false,
})
const past = (date: string, dosOrdered: number) => ({
  location_id: 'L1', product_id: 'P1', order_date: date, dos_before: null, dos_ordered: dosOrdered, qty: 1,
})

describe('repeat-ordering flag', () => {
  it('sums across every order in the window, not just the largest', () => {
    // Three modest orders totalling 60 days of supply — none individually large.
    const c = ctx([past('2026-08-05', 20), past('2026-08-10', 20), past('2026-08-15', 20)])
    expect(generateOrder([input()], c).lines[0].flags).toContain('repeat_ordering')
  })

  it('stays quiet when the cumulative total is within the threshold', () => {
    const c = ctx([past('2026-08-10', 20), past('2026-08-15', 20)])   // 40 <= 45
    expect(generateOrder([input()], c).lines[0].flags).not.toContain('repeat_ordering')
  })

  it('ignores orders outside the lookback window', () => {
    const c = ctx([past('2026-01-01', 90), past('2026-08-15', 10)])
    expect(generateOrder([input()], c).lines[0].flags).not.toContain('repeat_ordering')
  })

  it('flags a single very large order too, since it is the same symptom', () => {
    const c = ctx([past('2026-08-15', 60)])
    expect(generateOrder([input()], c).lines[0].flags).toContain('repeat_ordering')
  })

  it('does not flag a product with no order history', () => {
    expect(generateOrder([input()], ctx([])).lines[0].flags).not.toContain('repeat_ordering')
  })
})

// ── order-day eligibility (weekday, not date) ───────────────────────────

const day = (location_id: string, order_dow: number | null) => ({ location_id, order_dow, delivery_dow: null })

describe('order-day eligibility', () => {
  // WED = 2026-08-19, a Wednesday (dow 3).
  const days = [day('mon1', 1), day('mon2', 1), day('wed1', 3), day('wed2', 3), day('wed3', 3), day('fri1', 5)]

  it('matches on the order date\'s weekday by default', () => {
    const set = eligibleLocations(days, true, WED)
    expect([...set!].sort()).toEqual(['wed1', 'wed2', 'wed3'])
  })

  it('can be pointed at a different weekday without moving the order date', () => {
    const set = eligibleLocations(days, true, WED, 1)
    expect([...set!].sort()).toEqual(['mon1', 'mon2'])
  })

  it('returns an empty set — not everything — for a weekday nobody orders on', () => {
    expect(eligibleLocations(days, true, WED, 6)!.size).toBe(0)
  })

  it('applies no restriction for a vendor that does not use order days', () => {
    expect(eligibleLocations(days, false, WED)).toBeNull()
    expect(eligibleLocations(days, false, WED, 1)).toBeNull()
  })

  it('applies no restriction when no shop has an order day configured', () => {
    expect(eligibleLocations([day('a', null), day('b', null)], true, WED)).toBeNull()
  })

  it('counts shops per weekday for the picker', () => {
    expect(shopsPerOrderDay(days)).toEqual([0, 2, 0, 3, 0, 1, 0])
  })
})

describe('draft order weekday', () => {
  it('uses the explicitly chosen weekday when one was stored', () => {
    expect(draftOrderDow({ order_date: WED, settings_snapshot: { __order_dow: 1 } })).toBe(1)
  })

  it('falls back to the order date\'s weekday', () => {
    expect(draftOrderDow({ order_date: WED, settings_snapshot: {} })).toBe(3)
    expect(draftOrderDow({ order_date: WED, settings_snapshot: null })).toBe(3)
  })

  it('ignores an out-of-range stored value', () => {
    expect(draftOrderDow({ order_date: WED, settings_snapshot: { __order_dow: 9 } })).toBe(3)
  })
})

// ── on-hand resolution through product ID mappings ──────────────────────

const cfg = (product_id: string) => ({
  location_id: 'L1', product_id, vendor_id: 'V1', capacity: null, metadata: {},
})
const use = (product_id: string, on_hands: number | null, daily_usage: number | null) => ({
  location_id: 'L1', product_id, on_hands, daily_usage,
})

describe('on-hand resolution', () => {
  const maps = [{ old_product_id: 'R540BB', new_product_id: 'ROT-T6-5W40BB' }]

  it('joins usage straight through when the ids already match', () => {
    const [i] = buildGenerationInputs([cfg('5W20')], [], [use('5W20', 120, 4)])
    expect(i.on_hand).toBe(120)
    expect(i.daily_usage).toBe(4)
  })

  it('finds usage recorded under a retired product id', () => {
    // Regression: the order config uses the new id, product_usage still has
    // the old one, so a direct join found no on-hand at all.
    const [i] = buildGenerationInputs([cfg('ROT-T6-5W40BB')], [], [use('R540BB', 96, 0.66)], maps)
    expect(i.on_hand).toBe(96)
    expect(i.daily_usage).toBe(0.66)
  })

  it('sums old and new rows for the same product', () => {
    const [i] = buildGenerationInputs(
      [cfg('ROT-T6-5W40BB')], [], [use('R540BB', 50, 0.5), use('ROT-T6-5W40BB', 30, 0.25)], maps)
    expect(i.on_hand).toBe(80)
    expect(i.daily_usage).toBeCloseTo(0.75, 6)
  })

  it('matches case-insensitively', () => {
    const [i] = buildGenerationInputs([cfg('ROT-T6-5W40BB')], [], [use('r540bb', 12, 1)], maps)
    expect(i.on_hand).toBe(12)
  })

  it('leaves on-hand null when the shop has no usage row at all', () => {
    const [i] = buildGenerationInputs([cfg('NOPE')], [], [use('5W20', 10, 1)], maps)
    expect(i.on_hand).toBeNull()
  })

  it('only returns products in the shop order config', () => {
    // Usage for a product the shop isn't configured for must not create a line.
    const out = buildGenerationInputs([cfg('5W20')], [], [use('5W20', 1, 1), use('OTHER', 99, 9)], maps)
    expect(out).toHaveLength(1)
    expect(out[0].product_id).toBe('5W20')
  })
})

// ── package size / cost resolution through vendor parts ─────────────────

const vp = (over: Partial<{ vendor_id: string | null; our_part_number: string | null; unit_of_measure: string | null; metadata: Record<string, unknown> }> = {}) => ({
  vendor_id: 'V1', our_part_number: '5W20', unit_of_measure: null, metadata: {}, ...over,
})
const uomRow = (over: Partial<{ vendor_id: string | null; from_unit: string; to_unit: string; factor: number; order_type: 'package' | 'bulk' | null }> = {}) => ({
  vendor_id: null, from_unit: '', to_unit: 'Quarts', factor: 1, order_type: null, ...over,
})

describe('package size / cost resolution', () => {
  it('resolves quarts-per-package from the vendor-scoped UOM table', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ unit_of_measure: 'Drum' })], [uomRow({ vendor_id: 'V1', from_unit: 'Drum', factor: 55 })])
    expect(i.rule.units_per_uom_gallons).toBe(55)
  })

  it('a global (no vendor) UOM mapping applies to any vendor', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ unit_of_measure: 'Bay Box' })], [uomRow({ vendor_id: null, from_unit: 'Bay Box', factor: 12 })])
    expect(i.rule.units_per_uom_gallons).toBe(12)
  })

  it('a vendor part is only matched against its own vendor', () => {
    // cfg() configures shop L1 for vendor V1; the part is filed under V2, so
    // the vendor_parts join itself finds nothing for this shop.
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ vendor_id: 'V2', unit_of_measure: 'Drum' })],
      [uomRow({ vendor_id: 'V1', from_unit: 'Drum', factor: 55 })])
    expect(i.rule.units_per_uom_gallons).toBeNull()
  })

  it('a vendor-specific UOM mapping does not apply to a different vendor', () => {
    // The part matches (both V1), but the only Drum mapping on file is V2's.
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ vendor_id: 'V1', unit_of_measure: 'Drum' })],
      [uomRow({ vendor_id: 'V2', from_unit: 'Drum', factor: 55 })])
    expect(i.rule.units_per_uom_gallons).toBeNull()
  })

  it('falls back to package_qty_gallons x 4 when the UOM has no mapping yet', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ unit_of_measure: 'Drum', metadata: { package_qty_gallons: 55 } })], [])
    expect(i.rule.units_per_uom_gallons).toBe(220)
  })

  it('derives unit cost as package_qty_gallons x price_per_gallon', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ metadata: { package_qty_gallons: 55, price_per_gallon: 3 } })], [])
    expect(i.rule.unit_cost).toBe(165)
  })

  it('an explicit ov2_product_rules value wins over anything derived', () => {
    const rule = { location_id: 'L1', product_id: '5W20', uom: 'drum', units_per_uom_gallons: 40, unit_cost: 200, max_capacity_gallons: null, vmi_keepfill_enabled: false, can_ignore_minimum: false, ignore_minimum_if_ordered_alone: true, default_order_amount_if_alone: 2, include_in_total_shop_order: true, order_type_override: null }
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [rule], [], [], [vp({ metadata: { package_qty_gallons: 55, price_per_gallon: 3 } })], [])
    expect(i.rule.units_per_uom_gallons).toBe(40)
    expect(i.rule.unit_cost).toBe(200)
  })

  it('converts the config capacity from gallons to quarts', () => {
    const [i] = buildGenerationInputs([{ ...cfg('5W20'), capacity: 40 }], [], [], [], [], [])
    expect(i.rule.max_capacity_gallons).toBe(160)
  })

  it('leaves package size/cost null when no vendor part matches at all', () => {
    const [i] = buildGenerationInputs([cfg('NOPART')], [], [], [], [vp()], [])
    expect(i.rule.units_per_uom_gallons).toBeNull()
    expect(i.rule.unit_cost).toBeNull()
  })
})

// ── order type override (package vs. bulk) ───────────────────────────────

describe('order type override', () => {
  it('marks a line bulk when the matched UOM row says so, despite the uom text', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ unit_of_measure: 'Tank' })], [uomRow({ vendor_id: 'V1', from_unit: 'Tank', order_type: 'bulk' })])
    expect(i.rule.order_type_override).toBe('bulk')
  })

  it('does not apply a different vendor\'s order-type override', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [], [], [vp({ vendor_id: 'V1', unit_of_measure: 'Tank' })],
      [uomRow({ vendor_id: 'V2', from_unit: 'Tank', order_type: 'bulk' })])
    expect(i.rule.order_type_override).toBeNull()
  })

  it('leaves order type unset when no vendor part matches', () => {
    const [i] = buildGenerationInputs([cfg('NOPART')], [], [], [], [vp()], [uomRow({ from_unit: 'Tank', order_type: 'bulk' })])
    expect(i.rule.order_type_override).toBeNull()
  })
})

// ── on-hand/usage unit conversion (global_products) ──────────────────────

const gp = (product_id: string, unit_of_measure: string | null) => ({ product_id, unit_of_measure })

describe('on-hand unit conversion', () => {
  it('converts ounces to quarts for a product tracked that way', () => {
    const [i] = buildGenerationInputs(
      [cfg('HM0806')], [], [use('HM0806', 320, 32)], [], [], [], [gp('HM0806', 'oz')])
    expect(i.on_hand).toBeCloseTo(10, 6)     // 320 oz / 32
    expect(i.daily_usage).toBeCloseTo(1, 6)  // 32 oz / 32
  })

  it('leaves quarts-tracked products unchanged', () => {
    const [i] = buildGenerationInputs(
      [cfg('5W20')], [], [use('5W20', 100, 5)], [], [], [], [gp('5W20', 'Quarts')])
    expect(i.on_hand).toBe(100)
    expect(i.daily_usage).toBe(5)
  })

  it('leaves a product with no global_products row unchanged', () => {
    const [i] = buildGenerationInputs([cfg('5W20')], [], [use('5W20', 100, 5)], [], [], [], [])
    expect(i.on_hand).toBe(100)
    expect(i.daily_usage).toBe(5)
  })

  it('resolves the source unit through product_id_mappings same as usage', () => {
    const maps = [{ old_product_id: 'OLDID', new_product_id: 'HM0806' }]
    const [i] = buildGenerationInputs(
      [cfg('HM0806')], [], [use('HM0806', 320, 32)], maps, [], [], [gp('OLDID', 'oz')])
    expect(i.on_hand).toBeCloseTo(10, 6)
  })

  it.each(['OZ', 'Oz.', 'ounce', 'Ounces', 'fl oz', 'fluid ounces'])(
    'recognizes %j as ounces, not just an exact "oz" match', (unit) => {
      const [i] = buildGenerationInputs([cfg('HM0806')], [], [use('HM0806', 320, 32)], [], [], [], [gp('HM0806', unit)])
      expect(i.on_hand).toBeCloseTo(10, 6)
    })
})
