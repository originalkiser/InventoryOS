import { describe, expect, it } from 'vitest'
import { shopsToHold } from './orderTiming'
import type { DeliverySchedule, WeekCalendar } from './types'

// The real Valvoline A/B calendar (week start Sunday), extended so a future Thursday can resolve.
const cal: WeekCalendar = new Map([
  ['2026-10-04', 'A'], ['2026-10-11', 'B'], ['2026-10-18', 'A'], ['2026-10-25', 'B'], ['2026-11-01', 'A'], ['2026-11-08', 'B'], ['2026-11-15', 'A'], ['2026-11-22', 'B'],
])
const sched = (a: number | null, b: number | null): DeliverySchedule => ({ type: 'week_ab', delivery_dow: null, week_a_dow: a, week_b_dow: b, biweekly_anchor_date: null, lead_business_days: 4 })
const schedules = new Map<string, DeliverySchedule>([
  ['b-tue', sched(null, 2)], // shop 12: B-week Tuesday
  ['a-tue', sched(2, null)], // shop 100: A-week Tuesday
  ['a-thu', sched(4, null)], // shop 7: A-week Thursday
  ['weekly', { type: 'weekly', delivery_dow: 2, week_a_dow: null, week_b_dow: null, biweekly_anchor_date: null, lead_business_days: 4 }],
])
const run = (orderDate: string, cadenceDays = 7, ids = ['b-tue', 'a-tue', 'weekly', 'none']) => shopsToHold({ orderDate, cadenceDays, schedules, calendar: cal, locationIds: ids })

describe('shopsToHold', () => {
  it('Thu 10/8: the B-Tuesday shop waits (next Thursday still reaches 10/27); the A-Tuesday shop must order now', () => {
    const held = run('2026-10-08')
    expect(held.map((h) => h.location_id)).toEqual(['b-tue'])
    expect(held[0].delivery).toBe('2026-10-27')
    expect(held[0].next_order_date).toBe('2026-10-15')
  })
  it('shop 7 (A-week Thursday, delivers 10/22) can be ordered next week and still get 10/22 — held on Thu 10/8', () => {
    const held = run('2026-10-08', 7, ['a-thu'])
    expect(held).toHaveLength(1)
    expect(held[0].delivery).toBe('2026-10-22')
  })
  it('Thu 10/15 is the last chance for 10/27, so the B shop is ordered then', () => {
    // order 10/15 lands 10/27; waiting to 10/22 would slip to 11/10
    expect(run('2026-10-15').map((h) => h.location_id)).not.toContain('b-tue')
  })
  it('a daily cadence only holds a shop when tomorrow still reaches the same delivery', () => {
    // Thu 10/8 → 10/27 and Fri 10/9 → 10/27: hold; but the A shop: 10/8 → 11/3? (A Tuesdays 10/20, 11/3) check both resolve and differ
    const held = run('2026-10-08', 1)
    expect(held.map((h) => h.location_id)).toContain('b-tue')
  })
  it('never holds a weekly shop, a shop with no schedule, or one the calendar cannot resolve', () => {
    expect(run('2026-10-08').map((h) => h.location_id)).not.toContain('weekly')
    expect(run('2026-10-08').map((h) => h.location_id)).not.toContain('none')
    // calendar runs out before the next order date resolves → can't tell → order
    expect(run('2026-11-19').map((h) => h.location_id)).toEqual([])
  })
})
