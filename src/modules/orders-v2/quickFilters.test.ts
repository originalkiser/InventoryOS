import { describe, it, expect } from 'vitest'
import { lineQuickKeys, matchesAnyQuick, quickCounts } from './quickFilters'
import { TAG_DEFS } from './lineFlags'

const th = { target: 35, minTrigger: 18, max: 60 }
const tagged = (before: string[], after: string[], tone: any = null) => ({
  tags: { before: before.map((k) => (TAG_DEFS as any)[k]), after: after.map((k) => (TAG_DEFS as any)[k]), note: null }, tone,
})

describe('quick filters', () => {
  const a = { id: 'a', dos_before: 25, dos_after: 70 }
  const b = { id: 'b', dos_before: 10, dos_after: 40 }
  const map = new Map([['a', tagged(['dos_now_below_target'], ['over_dos_max'])], ['b', tagged(['dos_now_low'], [], 'below_min')]])

  it('collects tag, tone and DOS-cell keys for a line', () => {
    const keys = lineQuickKeys(a, map.get('a'), th)
    expect(keys.has('tag:dos_now_below_target')).toBe(true)
    expect(keys.has('tag:over_dos_max')).toBe(true)
    expect(keys.has('cell:yellow')).toBe(true) // DOS Now 25
    expect(keys.has('cell:orange')).toBe(true) // DOS After 70
    expect(lineQuickKeys(b, map.get('b'), th).has('tone:below_min')).toBe(true)
  })
  it('counts lines per key', () => {
    const c = quickCounts([a, b], map, th)
    expect(c.get('tag:dos_now_low')).toBe(1)
    expect(c.get('cell:green')).toBe(1) // b DOS After 40
    expect(c.get('tone:below_min')).toBe(1)
  })
  it('matches any selected key, and everything when none is selected', () => {
    expect(matchesAnyQuick(new Set(), a, map.get('a'), th)).toBe(true)
    expect(matchesAnyQuick(new Set(['tone:below_min']), a, map.get('a'), th)).toBe(false)
    expect(matchesAnyQuick(new Set(['tone:below_min', 'cell:orange']), a, map.get('a'), th)).toBe(true)
  })
})
