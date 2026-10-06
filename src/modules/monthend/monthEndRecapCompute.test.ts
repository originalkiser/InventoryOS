import { describe, expect, it } from 'vitest'
import { computeRecap, dailyNotes, managerCallouts, managerNotes, type RecapShop } from './monthEndRecapCompute'

const shops: RecapShop[] = ['A', 'B', 'C', 'D'].map((id) => ({ id, region: 'West', director: 'x', areaManager: 'AM' }))
// Count day Monday 2026-09-21: A counted that day, B on Tuesday, C never, D counted Monday and needed a recount.
const counts = [
  { location_id: 'A', count_date: '2026-09-21', count_type: 'Monthly', total_adjustments: 0 },
  { location_id: 'B', count_date: '2026-09-22', count_type: 'Monthly', total_adjustments: 0 },
  { location_id: 'D', count_date: '2026-09-21', count_type: 'Monthly', total_adjustments: 0 },
  { location_id: 'A', count_date: '2026-09-21', count_type: 'Monthly', total_adjustments: 0 },
  { location_id: 'D', count_date: '2026-09-21', count_type: 'Monthly', total_adjustments: 0 },
]
const recounts = [{ location_id: 'D', recount_type: 'Oil Recount', requested_products: ['P1'], request_date: '2026-09-22', recount_status: 'open', completed_flags: [false], completed_dates: null, updated_at: null }]

describe('computeRecap — daily table runs to the end of the count month', () => {
  const r = computeRecap({ countMonth: '2026-09-01', shops, counts, manual: [], recounts })!
  it('starts on the count Monday and ends on the last day of September', () => {
    expect(r.cycleStart).toBe('2026-09-21')
    expect(r.daily.dates[0]).toBe('2026-09-21')
    expect(r.daily.dates[r.daily.dates.length - 1]).toBe('2026-09-30')
    expect(r.daily.dates).toHaveLength(10)
    expect(r.daily.shopsSubmitted).toHaveLength(10)
  })
  it('notes name the real last day', () => {
    expect(dailyNotes(r).join(' ')).toContain('By Day +9 (9/30)')
  })
  it('never shorter than Day +7', () => {
    const early = computeRecap({ countMonth: '2026-08-01', shops, counts: counts.map((c) => ({ ...c, count_date: c.count_date.replace('2026-09-21', '2026-08-24').replace('2026-09-22', '2026-08-25') })), manual: [], recounts: [] })!
    expect(early.daily.dates.length).toBe(8) // Mon 8/24 -> Mon 8/31
  })
})

describe('missing-manager call-outs', () => {
  const r = computeRecap({ countMonth: '2026-09-01', shops, counts, manual: [], recounts })!
  it('flags shops without a manager that had no count by end of day Monday', () => {
    // B counted Tuesday (late), C never counted, A counted on time — D is missing a manager too but counted on Monday.
    const c = managerCallouts(r, new Set(['A', 'B', 'C', 'D']))
    expect(c.late.map((x) => x.id).sort()).toEqual(['B', 'C'])
    expect(c.late.find((x) => x.id === 'C')!.submitted).toBeNull()
  })
  it('flags shops that needed a recount while missing a manager', () => {
    expect(managerCallouts(r, new Set(['D'])).recount).toEqual([{ id: 'D', kind: 'recount' }])
    expect(managerCallouts(r, new Set(['A'])).recount).toEqual([])
  })
  it('ignores shops that have a manager', () => {
    expect(managerCallouts(r, new Set()).late).toEqual([])
    expect(managerNotes(r, new Set(), (x) => x)).toEqual([])
  })
  it('writes notes naming the shops', () => {
    const notes = managerNotes(r, new Set(['B', 'C', 'D']), (id) => `Shop ${id}`)
    expect(notes[0]).toContain('Shop B, Shop C')
    expect(notes[1]).toContain('Shop D')
  })
})
