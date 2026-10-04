import { describe, it, expect } from 'vitest'
import { isCompletingType } from './WeeklyStatusTab'
import { parseCountDate } from './WeeklyBulkUpload'

describe('weekly status helpers', () => {
  it('only Weekly and Monthly complete the week', () => {
    expect(isCompletingType('Weekly')).toBe(true)
    expect(isCompletingType(' monthly ')).toBe(true)
    expect(isCompletingType('Bi-Weekly')).toBe(false)
    expect(isCompletingType('Out of Sequence Count')).toBe(false)
    expect(isCompletingType(null)).toBe(false)
  })
  it('parses count dates as UTC midnight', () => {
    expect(parseCountDate('2026-10-04')).toBe('2026-10-04T00:00:00.000Z')
    expect(parseCountDate('10/4/2026')).toBe('2026-10-04T00:00:00.000Z')
    expect(parseCountDate('10/4/26 3:15 PM')).toBe('2026-10-04T00:00:00.000Z')
    expect(parseCountDate('')).toBeNull()
  })
})
