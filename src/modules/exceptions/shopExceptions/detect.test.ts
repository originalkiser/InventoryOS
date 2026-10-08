import { describe, expect, it } from 'vitest'
import {
  detectAdjustments, detectDuplicates, detectLatePos, detectZeroSales, reconcile, resolveDeliveryDate,
  type ExistingException, type OpenPo, type Schedule,
} from '../../../../supabase/functions/run-automated-checks/detect'

const act = (location_id: string, product_id: string, activity_date: string, sold_qty: number | null, adjusted_qty: number | null = 0) => ({ location_id, product_id, activity_date, sold_qty, adjusted_qty })
const TODAY = '2026-10-09'

describe('selling at zero on hand', () => {
  const activity = [act('s1', '5W30', '2026-10-07', 6), act('s1', '5W30', '2026-10-08', 4), act('s1', '5W30', '2026-10-09', 3)]
  it('stacks days and quantity on one item per product while on hand stays at zero', () => {
    const r = detectZeroSales({ activity, onHand: new Map([['s1|5w30', 0]]), prior: new Map(), today: TODAY })
    expect(r.get('s1')).toHaveLength(1)
    expect(r.get('s1')![0]).toMatchObject({ product_id: '5W30', days: 3, qty: 13, first: '2026-10-07' })
  })
  it('keeps counting from when it was first flagged (never double counts a rerun)', () => {
    const prior = new Map([['s1', [{ key: '5w30', product_id: '5W30', first: '2026-10-05' }]]])
    const more = [act('s1', '5W30', '2026-10-05', 2), act('s1', '5W30', '2026-10-06', 5), ...activity]
    const a = detectZeroSales({ activity: more, onHand: new Map([['s1|5w30', -2]]), prior, today: TODAY })
    const b = detectZeroSales({ activity: more, onHand: new Map([['s1|5w30', -2]]), prior, today: TODAY })
    expect(a.get('s1')![0]).toMatchObject({ days: 5, qty: 20, first: '2026-10-05' })
    expect(b.get('s1')![0]).toEqual(a.get('s1')![0])
  })
  it('clears when on hand is back above zero or it stopped selling', () => {
    expect(detectZeroSales({ activity, onHand: new Map([['s1|5w30', 12]]), prior: new Map(), today: TODAY }).size).toBe(0)
    expect(detectZeroSales({ activity: [act('s1', '5W30', '2026-09-20', 4)], onHand: new Map([['s1|5w30', 0]]), prior: new Map(), today: TODAY }).size).toBe(0)
  })
  it('skips excluded products', () => {
    expect(detectZeroSales({ activity, onHand: new Map([['s1|5w30', 0]]), prior: new Map(), today: TODAY, excluded: () => true }).size).toBe(0)
  })
})

describe('large adjustments', () => {
  it('adds each product/day to ONE list per sign, over the threshold only', () => {
    const rows = [act('s1', 'A', '2026-10-08', 0, 120), act('s1', 'B', '2026-10-09', 0, 75), act('s1', 'C', '2026-10-09', 0, 20), act('s1', 'D', '2026-10-09', 0, -90), act('s2', 'A', '2026-10-09', 0, 51)]
    const r = detectAdjustments({ activity: rows, threshold: 50 })
    expect(r.positive.get('s1')!.map((i) => i.product_id)).toEqual(['B', 'A']) // newest first
    expect(r.negative.get('s1')!.map((i) => i.qty)).toEqual([-90])
    expect(r.positive.get('s2')).toHaveLength(1)
  })
  it('can use a different threshold for negative adjustments', () => {
    const rows = [act('s1', 'A', '2026-10-08', 0, -60), act('s1', 'B', '2026-10-08', 0, 60)]
    const r = detectAdjustments({ activity: rows, threshold: 50, thresholdNegative: 100 })
    expect(r.negative.size).toBe(0)
    expect(r.positive.get('s1')).toHaveLength(1)
  })
})

describe('duplicate case types on hand', () => {
  const configured = new Map([['s1', new Set(['5w30', 'rot-t4-15w40'])], ['s2', new Set(['5w30'])]])
  const run = (usage: { location_id: string; product_id: string; on_hands: number | null }[], mappings = new Map<string, string>()) =>
    detectDuplicates({ usage, configured, mappings, tolerance: 40 })
  it('flags (high) when the quantities are within 40 qts of each other', () => {
    const r = run([{ location_id: 's1', product_id: '5W30D', on_hands: 220 }, { location_id: 's1', product_id: '5W30BB', on_hands: 190 }])
    expect(r.get('s1')!.severity).toBe(3)
    expect(r.get('s1')!.items[0]).toMatchObject({ family: '5W30', diff: 30 })
  })
  it('does not flag case types that are further apart, and keeps only the close family when a shop has both', () => {
    const far = run([{ location_id: 's1', product_id: '5W30D', on_hands: 400 }, { location_id: 's1', product_id: '5W30BB', on_hands: 100 }])
    expect(far.size).toBe(0)
    const mixed = run([
      { location_id: 's1', product_id: '5W30D', on_hands: 400 }, { location_id: 's1', product_id: '5W30BB', on_hands: 100 },
      { location_id: 's1', product_id: 'ROT-T4-15W40BB', on_hands: 50 }, { location_id: 's1', product_id: 'ROT-T4-15W40', on_hands: 60 },
    ])
    expect(mixed.get('s1')!.items).toHaveLength(1)
    expect(mixed.get('s1')!.items[0]).toMatchObject({ family: 'ROT-T4-15W40', diff: 10 })
    expect(mixed.get('s1')!.severity).toBe(3)
  })
  it('ignores a single case type, zero stock, unconfigured families, and folds a retired id into its replacement', () => {
    expect(run([{ location_id: 's1', product_id: '5W30D', on_hands: 100 }, { location_id: 's1', product_id: '5W30BB', on_hands: 0 }]).size).toBe(0)
    expect(run([{ location_id: 's1', product_id: 'ZZ9D', on_hands: 100 }, { location_id: 's1', product_id: 'ZZ9BB', on_hands: 100 }]).size).toBe(0)
    // R1540 is the same product as ROT-T4-15W40 — holding both ids is one product, not a duplicate
    const m = new Map([['r1540', 'ROT-T4-15W40']])
    expect(run([{ location_id: 's1', product_id: 'R1540', on_hands: 600 }, { location_id: 's1', product_id: 'ROT-T4-15W40', on_hands: 20 }], m).size).toBe(0)
  })
})

describe('POs that should have delivered', () => {
  const sched: Schedule = { type: 'week_ab', delivery_dow: null, week_a_dow: null, week_b_dow: 2, biweekly_anchor_date: null, lead_business_days: 4 }
  const cal = new Map<string, 'A' | 'B'>([['2026-09-27', 'A'], ['2026-10-04', 'B'], ['2026-10-11', 'A']])
  const po = (o: Partial<OpenPo>): OpenPo => ({ id: 'p1', location_id: 's1', po_id: 'PO1', custom_po_id: '1-20260924', supplier_name: 'Valvoline', created_timestamp: '2026-09-25T12:00:00Z', to_receive_timestamp: null, vendor_id: 'v1', ...o })
  const base = { received: new Set<string>(), schedules: new Map([['s1|v1', sched]]), calendars: new Map([['v1', cal]]), weekdayByLocation: new Map([['s1', 3 as number | null]]), isReladyne: (s: string | null) => /reladyne/i.test(s ?? ''), today: TODAY, graceDays: 2 }
  it('flags an open PO past its schedule-based delivery with nothing received', () => {
    // ordered 9/24 → B-week Tuesday 10/6
    expect(resolveDeliveryDate('2026-09-24', sched, cal)).toBe('2026-10-06')
    const r = detectLatePos({ ...base, pos: [po({})] })
    expect(r.get('s1')).toHaveLength(1)
    expect(r.get('s1')![0]).toMatchObject({ po: '1-20260924', expected: '2026-10-06', days_late: 3 })
  })
  it('combines several POs on the one shop, and skips received / not-yet-late / uncomputable ones', () => {
    const pos = [po({}), po({ id: 'p2', po_id: 'PO2', custom_po_id: '1-20260925' }), po({ id: 'p3', po_id: 'PO3' }), po({ id: 'p4', po_id: 'PO4', to_receive_timestamp: '2026-10-09T00:00:00Z' }), po({ id: 'p5', po_id: 'PO5', vendor_id: null, supplier_name: 'Other' })]
    const r = detectLatePos({ ...base, pos, received: new Set(['p3']) })
    expect(r.get('s1')!.map((i) => i.key).sort()).toEqual(['PO1', 'PO2'])
  })
  it('ignores POs due before the track-from date', () => {
    // expected 10/6, so a 10/7 floor drops it entirely
    expect(detectLatePos({ ...base, notBefore: '2026-10-07', pos: [po({})] }).size).toBe(0)
    expect(detectLatePos({ ...base, notBefore: '2026-10-06', pos: [po({})] }).get('s1')).toHaveLength(1)
  })
  it('moves a PO to the late list once it is N days late or N days old, instead of the triage', () => {
    const moved: any[] = []
    // 3 days late: a 3-day limit moves it; the triage gets nothing
    expect(detectLatePos({ ...base, moveAfterDaysLate: 3, moved, pos: [po({})] }).size).toBe(0)
    expect(moved).toHaveLength(1)
    expect(moved[0]).toMatchObject({ po_id: 'PO1', location_id: 's1', expected: '2026-10-06', days_late: 3 })
    // created 9/25, today 10/9 = 14 days old
    const m2: any[] = []
    expect(detectLatePos({ ...base, moveAfterDaysCreated: 14, moved: m2, pos: [po({})] }).size).toBe(0)
    expect(m2).toHaveLength(1)
    // limits not reached (or off) -> stays in the triage
    const m3: any[] = []
    expect(detectLatePos({ ...base, moveAfterDaysLate: 10, moveAfterDaysCreated: 30, moved: m3, pos: [po({})] }).get('s1')).toHaveLength(1)
    expect(m3).toHaveLength(0)
  })
  it('falls back to the RelaDyne weekday when the shop has no schedule', () => {
    const r = detectLatePos({ ...base, schedules: new Map(), pos: [po({ supplier_name: 'RelaDyne', custom_po_id: '1-09242026P' })] })
    expect(r.get('s1')![0]).toMatchObject({ expected: '2026-09-30' }) // next Wednesday after 9/24
  })
})

describe('combining into one exception per shop per type', () => {
  const existing = (o: Partial<ExistingException>): ExistingException => ({ id: 'e1', location_id: 's1', type: 'adj_positive', status: 'pending', severity: 2, first_seen: '2026-10-01', items: [{ key: 'a|1' }], acked_keys: [], ...o })
  const NOW = '2026-10-09T10:00:00Z'
  it('inserts a new exception only when the shop has no open one of that type', () => {
    const ops = reconcile([], new Map([['s1|zero_sales', { severity: 3, items: [{ key: 'a' }] }]]), TODAY, NOW)
    expect(ops.inserts).toHaveLength(1)
    expect(ops.inserts[0]).toMatchObject({ location_id: 's1', type: 'zero_sales', severity: 3, first_seen: TODAY })
  })
  it('adds new items to the existing exception instead of creating another', () => {
    const ops = reconcile([existing({})], new Map([['s1|adj_positive', { severity: 2, items: [{ key: 'a|1' }, { key: 'b|2' }] }]]), TODAY, NOW)
    expect(ops.inserts).toHaveLength(0)
    expect(ops.updates).toHaveLength(1)
    expect((ops.updates[0].patch.items as unknown[]).length).toBe(2)
  })
  it('resolves an exception with nothing left, and reopens a logged one only for an item it had not seen', () => {
    expect(reconcile([existing({})], new Map(), TODAY, NOW).updates[0].patch.status).toBe('resolved')
    const logged = existing({ status: 'logged', acked_keys: ['a|1'] })
    const same = reconcile([logged], new Map([['s1|adj_positive', { severity: 2, items: [{ key: 'a|1' }] }]]), TODAY, NOW)
    expect(same.updates[0].patch.status).toBeUndefined() // stays logged
    const more = reconcile([logged], new Map([['s1|adj_positive', { severity: 2, items: [{ key: 'a|1' }, { key: 'c|3' }] }]]), TODAY, NOW)
    expect(more.updates[0].patch.status).toBe('pending')
  })
})
