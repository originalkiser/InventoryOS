import { describe, it, expect } from 'vitest'
import { computeOnHandPlausibility, deliveredQtyToQuarts, isRecentDelivery } from './onHandCheck'

describe('computeOnHandPlausibility', () => {
  it('matches the request\'s own example: usage 10/day, ±3 days = ±30', () => {
    // on_hand_when_ordered 100, nothing sold since, nothing delivered yet ->
    // expected 100, band 30 -> range [70, 130]
    const r = computeOnHandPlausibility({
      currentOnHand: 100, onHandWhenOrdered: 100, soldSinceOrder: 0, deliveredQtyQuarts: 0, dailyUsage: 10,
    })
    expect(r).toEqual({ expected: 100, low: 70, high: 130, withinRange: true })
  })

  it('flags a current on-hand outside the tolerance band', () => {
    const r = computeOnHandPlausibility({
      currentOnHand: 200, onHandWhenOrdered: 100, soldSinceOrder: 0, deliveredQtyQuarts: 0, dailyUsage: 10,
    })
    expect(r?.withinRange).toBe(false)
  })

  it('accounts for real usage and a real delivery', () => {
    // Ordered with 100 on hand, sold 40 since, delivered 60 -> expected 120
    const r = computeOnHandPlausibility({
      currentOnHand: 118, onHandWhenOrdered: 100, soldSinceOrder: 40, deliveredQtyQuarts: 60, dailyUsage: 10,
    })
    expect(r?.expected).toBe(120)
    expect(r?.withinRange).toBe(true)
  })

  it('returns null when daily usage is zero or negative (tolerance band undefined)', () => {
    expect(computeOnHandPlausibility({ currentOnHand: 100, onHandWhenOrdered: 100, soldSinceOrder: 0, deliveredQtyQuarts: 0, dailyUsage: 0 })).toBeNull()
    expect(computeOnHandPlausibility({ currentOnHand: 100, onHandWhenOrdered: 100, soldSinceOrder: 0, deliveredQtyQuarts: 0, dailyUsage: -5 })).toBeNull()
  })

  it('respects a custom toleranceDays', () => {
    const r = computeOnHandPlausibility({
      currentOnHand: 100, onHandWhenOrdered: 100, soldSinceOrder: 0, deliveredQtyQuarts: 0, dailyUsage: 10, toleranceDays: 1,
    })
    expect(r).toEqual({ expected: 100, low: 90, high: 110, withinRange: true })
  })
})

describe('deliveredQtyToQuarts', () => {
  it('converts a bulk delivery from real gallons to quarts (x4)', () => {
    expect(deliveredQtyToQuarts('bulk', null, 55, null)).toBe(220)
  })

  it('returns null for a bulk delivery with no gallons figure', () => {
    expect(deliveredQtyToQuarts('bulk', null, null, null)).toBeNull()
  })

  it('converts a package delivery via that order\'s own quarts_per_unit (case size)', () => {
    expect(deliveredQtyToQuarts('package', 3, null, 24)).toBe(72)
  })

  it('returns null for a package delivery missing either qty or case size', () => {
    expect(deliveredQtyToQuarts('package', null, null, 24)).toBeNull()
    expect(deliveredQtyToQuarts('package', 3, null, null)).toBeNull()
  })
})

describe('isRecentDelivery', () => {
  it('is true for a delivery within the window', () => {
    expect(isRecentDelivery('2026-09-10', '2026-09-20', 21)).toBe(true)
  })

  it('is false for a delivery outside the window', () => {
    expect(isRecentDelivery('2026-08-01', '2026-09-20', 21)).toBe(false)
  })

  it('is false for a delivery date in the future relative to "today"', () => {
    expect(isRecentDelivery('2026-09-25', '2026-09-20', 21)).toBe(false)
  })

  it('is true exactly at the boundary (today == invoice date)', () => {
    expect(isRecentDelivery('2026-09-20', '2026-09-20', 21)).toBe(true)
  })
})
