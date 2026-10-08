import { describe, expect, it } from 'vitest'
import { daysAgoFrom, dateRuleStyle, matchDateRule, type DateCfRule } from './dateFormatting'

const rule = (o: Partial<DateCfRule>): DateCfRule => ({ id: 'r', op: 'within', days: 7, color: '#112233', apply: 'background', ...o })
const TODAY = '2026-10-08'

describe('date conditional formatting', () => {
  it('counts whole days back from today', () => {
    expect(daysAgoFrom('2026-10-08', TODAY)).toBe(0)
    expect(daysAgoFrom('2026-10-01', TODAY)).toBe(7)
    expect(daysAgoFrom('2026-09-24T12:00:00Z', TODAY)).toBe(14)
  })
  it('"within" includes the boundary day, "older" starts after it', () => {
    expect(matchDateRule([rule({ days: 7 })], '2026-10-01', TODAY)).not.toBeNull()
    expect(matchDateRule([rule({ days: 7 })], '2026-09-30', TODAY)).toBeNull()
    expect(matchDateRule([rule({ op: 'older', days: 14 })], '2026-09-24', TODAY)).toBeNull()
    expect(matchDateRule([rule({ op: 'older', days: 14 })], '2026-09-23', TODAY)).not.toBeNull()
  })
  it('the first matching rule wins and no date never matches', () => {
    const rules = [rule({ id: 'a', days: 3, color: '#111111' }), rule({ id: 'b', days: 10, color: '#222222' })]
    expect(matchDateRule(rules, '2026-10-06', TODAY)?.id).toBe('a')
    expect(matchDateRule(rules, '2026-10-01', TODAY)?.id).toBe('b')
    expect(matchDateRule(rules, null, TODAY)).toBeNull()
  })
  it('background rules fill the cell, text rules color the text', () => {
    expect(dateRuleStyle(rule({ apply: 'background', color: '#E67E22' }))?.background).toBe('#E67E2259')
    expect(dateRuleStyle(rule({ apply: 'text', color: '#E67E22' }))?.color).toBe('#E67E22')
    expect(dateRuleStyle(null)).toBeUndefined()
  })
})
