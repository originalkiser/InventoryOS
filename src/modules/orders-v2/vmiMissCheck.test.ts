import { describe, it, expect } from 'vitest'
import { checkVmiMisses, mappedDate, subtractBusinessDays, type VmiShop } from './vmiMissCheck'

// 2026-10-08 is a Thursday.
const shop = (over: Partial<VmiShop> = {}): VmiShop => ({
  location_id: 'L1', warehouse_code: 'DRS', next_delivery: '2026-10-08', delivery_after_next: '2026-10-15',
  products: [{ product_id: 'P', on_hand: 10, daily_usage: 2, runway_days: 5 }], ...over,
})

describe('vmi miss check', () => {
  it('steps back business days over a weekend', () => {
    expect(subtractBusinessDays('2026-10-08', 3)).toBe('2026-10-05') // Thu -> Mon
    expect(subtractBusinessDays('2026-10-06', 3)).toBe('2026-10-01') // Tue -> Thu (skips the weekend)
  })
  it('maps order day vs the day before delivery', () => {
    expect(mappedDate('2026-10-08', { basis: 'order_day', wiggle_days: 5 })).toBe('2026-10-05')
    expect(mappedDate('2026-10-08', { basis: 'day_before_delivery', wiggle_days: 5 })).toBe('2026-10-07')
  })
  it('flags a shop that runs out before the delivery after next with no bulk order near the mapped day', () => {
    const r = checkVmiMisses([shop()], {}, [], '2026-10-06')
    expect(r).toHaveLength(1)
    expect(r[0].target_date).toBe('2026-10-05')
    expect(r[0].min_runway_days).toBe(5)
  })
  it('does not flag when a bulk order is within the wiggle window', () => {
    expect(checkVmiMisses([shop()], {}, [{ location_id: 'L1', order_date: '2026-10-02' }], '2026-10-06')).toHaveLength(0)
    expect(checkVmiMisses([shop()], {}, [{ location_id: 'L1', order_date: '2026-09-20' }], '2026-10-06')).toHaveLength(1)
  })
  it('does not flag before the mapped processing day, or when the tank will last', () => {
    expect(checkVmiMisses([shop()], {}, [], '2026-10-02')).toHaveLength(0)
    expect(checkVmiMisses([shop({ products: [{ product_id: 'P', on_hand: 100, daily_usage: 1, runway_days: 100 }] })], {}, [], '2026-10-06')).toHaveLength(0)
  })
  it('uses the distributor mapping when there is one', () => {
    const timing = { DRS: { basis: 'day_before_delivery' as const, wiggle_days: 1 } }
    expect(checkVmiMisses([shop()], timing, [], '2026-10-06')).toHaveLength(0) // mapped day is 10/07, not yet
    expect(checkVmiMisses([shop()], timing, [{ location_id: 'L1', order_date: '2026-10-02' }], '2026-10-07')).toHaveLength(1) // outside +-1
  })
})
