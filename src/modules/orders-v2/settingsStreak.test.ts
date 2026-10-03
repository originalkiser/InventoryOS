import { describe, it, expect } from 'vitest'
import { unchangedStreak, type StreakDraft } from './settingsStreak'

const d = (id: string, date: string, target: number | undefined, vendor = 'V1'): StreakDraft => ({
  id, vendor_id: vendor, order_date: date, created_at: `${date}T00:00:00Z`,
  settings_snapshot: target === undefined ? {} : { days_of_supply_target: target },
})

describe('unchangedStreak', () => {
  const all = [d('a', '2026-09-01', 30), d('b', '2026-09-08', 35), d('c', '2026-09-15', 35), d('x', '2026-09-16', 99, 'V2'), d('e', '2026-09-22', 35)]
  it('counts this order and the consecutive older orders (same vendor) with the same value', () => {
    expect(unchangedStreak('days_of_supply_target', all[4], all)).toBe(3)
  })
  it('stops at the first different value and ignores other vendors', () => {
    expect(unchangedStreak('days_of_supply_target', all[1], all)).toBe(1)
    expect(unchangedStreak('days_of_supply_target', all[2], all)).toBe(2)
  })
  it('breaks on an older order that never recorded the setting', () => {
    const list = [d('p', '2026-09-01', undefined), d('q', '2026-09-08', 35)]
    expect(unchangedStreak('days_of_supply_target', list[1], list)).toBe(1)
  })
})
