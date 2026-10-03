import { describe, it, expect } from 'vitest'
import { computeLineTags, dosTone, rowToneOf, combinedSuffix, type TagLine } from './lineFlags'

const thresholds = { target: 35, minTrigger: 18, max: 60 }
const base = (over: Partial<TagLine> = {}): TagLine => ({
  flags: [], qty: 3, is_override: false, included: true, dos_before: 25, dos_after: 40, max_capacity_gallons: 100, note: null, ...over,
})
const ctx = (onHandAfter: number, belowMin = false) => ({ thresholds, onHandAfter: () => onHandAfter, belowMinimum: () => belowMin })
const keys = (t: { key: string }[]) => t.map((x) => x.key)

describe('dosTone', () => {
  it('is less aggressive: yellow between the min trigger and the target, red only under the trigger', () => {
    expect(dosTone(70, thresholds)).toBe('orange')
    expect(dosTone(40, thresholds)).toBe('green')
    expect(dosTone(35, thresholds)).toBe('green')
    expect(dosTone(30, thresholds)).toBe('yellow')
    expect(dosTone(18, thresholds)).toBe('yellow')
    expect(dosTone(17.9, thresholds)).toBe('red')
    expect(dosTone(null, thresholds)).toBeNull()
  })
})

describe('computeLineTags', () => {
  it('puts pre-order conditions in Before and order consequences in After', () => {
    const t = computeLineTags(base({ flags: ['critical_minimum', 'smoothing_topped_up'], dos_before: 10 }), ctx(50))
    expect(keys(t.before)).toEqual(['critical_minimum', 'dos_now_low'])
    expect(keys(t.after)).toContain('smoothing_topped_up')
  })
  it('flags DOS Now yellow when under target but at/above the trigger', () => {
    expect(keys(computeLineTags(base({ dos_before: 25 }), ctx(10)).before)).toEqual(['dos_now_below_target'])
  })
  it('over capacity only when on-hand-after really exceeds capacity — and drops when qty is set to 0', () => {
    expect(keys(computeLineTags(base(), ctx(150)).after)).toContain('capacity_capped')
    expect(keys(computeLineTags(base(), ctx(100)).after)).not.toContain('capacity_capped') // exactly at capacity
    expect(keys(computeLineTags(base({ qty: 0 }), ctx(150)).after)).not.toContain('capacity_capped')
  })
  it('keeps the engine\'s "over capacity: DOS target" tag and note only while it still applies', () => {
    const line = base({ flags: ['exceeded_capacity_for_dos_target'], note: 'Ordered 6 to reach the 35-day target' })
    const live = computeLineTags(line, ctx(150))
    expect(keys(live.after)).toContain('exceeded_capacity_for_dos_target')
    expect(live.note).toBe('Ordered 6 to reach the 35-day target')
    // edited by hand -> the engine's explanation is stale
    const edited = computeLineTags({ ...line, is_override: true }, ctx(150))
    expect(keys(edited.after)).not.toContain('exceeded_capacity_for_dos_target')
    expect(edited.note).toBeNull()
    // zeroed -> gone
    expect(computeLineTags({ ...line, qty: 0 }, ctx(150)).note).toBeNull()
  })
  it('shows only the DOS-target over-capacity tag when both would apply', () => {
    const t = computeLineTags(base({ flags: ['exceeded_capacity_for_dos_target'] }), ctx(150))
    expect(keys(t.after)).toContain('exceeded_capacity_for_dos_target')
    expect(keys(t.after)).not.toContain('capacity_capped')
  })
  it('keeps the recently-ordered tag and its note even though the qty is 0', () => {
    const t = computeLineTags(base({ flags: ['recently_ordered'], qty: 0, note: 'Ordered 2026-09-28' }), ctx(10))
    expect(keys(t.after)).toContain('recently_ordered')
    expect(t.note).toBe('Ordered 2026-09-28')
  })
  it('drops engine quantity tags once edited or zeroed, but keeps PO decisions', () => {
    const line = base({ flags: ['case_minimum_topup', 'po_decision_override'] })
    expect(keys(computeLineTags(line, ctx(10)).after)).toEqual(['case_minimum_topup', 'po_decision_override'])
    expect(keys(computeLineTags({ ...line, is_override: true }, ctx(10)).after)).toEqual(['po_decision_override'])
  })
  it('below_minimum is live and only for included lines', () => {
    expect(keys(computeLineTags(base(), ctx(10, true)).after)).toContain('below_minimum')
    expect(keys(computeLineTags(base({ included: false }), ctx(10, true)).after)).not.toContain('below_minimum')
  })
  it('flags DOS After tiers', () => {
    expect(keys(computeLineTags(base({ dos_after: 10 }), ctx(10)).after)).toContain('dos_after_low')
    expect(keys(computeLineTags(base({ dos_after: 30 }), ctx(10)).after)).toContain('dos_after_below_target')
    expect(keys(computeLineTags(base({ dos_after: 70 }), ctx(10)).after)).toContain('over_dos_max')
  })
})

describe('rowToneOf', () => {
  it('excluded beats below-min beats over-capacity-for-target', () => {
    const over = computeLineTags(base({ flags: ['exceeded_capacity_for_dos_target'] }), ctx(150))
    expect(rowToneOf(base(), over)).toBe('over_capacity_target')
    const both = computeLineTags(base({ flags: ['exceeded_capacity_for_dos_target'] }), ctx(150, true))
    expect(rowToneOf(base(), both)).toBe('below_min')
    expect(rowToneOf(base({ included: false }), both)).toBe('excluded')
    expect(rowToneOf(base(), computeLineTags(base(), ctx(10)))).toBeNull()
  })
})

describe('combinedSuffix', () => {
  it('shows text after the last hyphen with an ellipsis, or the whole id when there is no hyphen', () => {
    expect(combinedSuffix('EURO-SYN-0W20D')).toBe('…0W20D')
    expect(combinedSuffix('HM0806')).toBe('HM0806')
  })
})
