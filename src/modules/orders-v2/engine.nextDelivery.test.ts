import { describe, expect, it } from 'vitest'
import { nextScheduledDelivery, resolveDeliveryDate, resolveScheduleDescription } from './engine'
import type { DeliverySchedule, WeekCalendar } from './types'

// Thursday 2026-10-08, the real Valvoline A/B calendar around it.
const cal: WeekCalendar = new Map([['2026-10-04', 'A'], ['2026-10-11', 'B'], ['2026-10-18', 'A'], ['2026-10-25', 'B'], ['2026-11-01', 'A']])
const TODAY = '2026-10-08'

const shop12: DeliverySchedule = { type: 'week_ab', delivery_dow: null, week_a_dow: null, week_b_dow: 2, biweekly_anchor_date: null, lead_business_days: 4 }
const shop100Vv: DeliverySchedule = { type: 'week_ab', delivery_dow: null, week_a_dow: 2, week_b_dow: null, biweekly_anchor_date: null, lead_business_days: 4 }
const shop100Rd: DeliverySchedule = { type: 'biweekly', delivery_dow: 5, week_a_dow: null, week_b_dow: null, biweekly_anchor_date: '2026-09-25', lead_business_days: 3 }

describe('nextScheduledDelivery — the upcoming delivery, not the one for an order placed today', () => {
  it('Valvoline B-week Tuesday: 10/13, not the delivery after it (10/27)', () => {
    expect(nextScheduledDelivery(TODAY, shop12, cal)).toBe('2026-10-13')
    // an order placed today can't make 10/13 (4-business-day lead) — that is what the old "next" showed
    expect(resolveDeliveryDate(TODAY, shop12, cal)).toBe('2026-10-27')
  })
  it('Valvoline A-week Tuesday is unchanged: 10/20', () => {
    expect(nextScheduledDelivery(TODAY, shop100Vv, cal)).toBe('2026-10-20')
  })
  it('RelaDyne every-other-Friday: tomorrow (10/9), not 10/23', () => {
    expect(nextScheduledDelivery(TODAY, shop100Rd)).toBe('2026-10-09')
    expect(resolveDeliveryDate(TODAY, shop100Rd)).toBe('2026-10-23')
  })
  it('counts today when today is a delivery day', () => {
    expect(nextScheduledDelivery('2026-10-09', shop100Rd)).toBe('2026-10-09')
    expect(nextScheduledDelivery('2026-10-10', shop100Rd)).toBe('2026-10-23')
  })
  it('the description shows the upcoming date when asked, the order-based one otherwise', () => {
    expect(resolveScheduleDescription(shop12, { orderDate: TODAY, calendar: cal, upcoming: true })).toContain('next: 2026-10-13')
    expect(resolveScheduleDescription(shop12, { orderDate: TODAY, calendar: cal })).toContain('next: 2026-10-27')
  })
})
