import { describe, expect, it } from 'vitest'
import { effectivePenetrationPct, effectiveOtdPrice, newPackagePricingRow } from './packagePricing'
import type { PackagePricingRow } from '@/types/forms'

function row(overrides: Partial<PackagePricingRow> = {}): PackagePricingRow {
  return { ...newPackagePricingRow(), ...overrides }
}

describe('effectivePenetrationPct', () => {
  it('splits 100% evenly when nothing has been entered', () => {
    const rows = [row(), row(), row(), row()]
    expect(effectivePenetrationPct(rows)).toEqual([25, 25, 25, 25])
  })

  it('splits the REMAINDER evenly among not-yet-entered rows once one is set — the exact "25% entered, split the other 75%" example', () => {
    const rows = [row({ penetration_pct: 25 }), row(), row(), row()]
    const result = effectivePenetrationPct(rows)
    expect(result[0]).toBe(25)
    expect(result[1]).toBeCloseTo(25) // 75 / 3 remaining
    expect(result[2]).toBeCloseTo(25)
    expect(result[3]).toBeCloseTo(25)
  })

  it('keeps re-splitting as more rows get explicit values', () => {
    const rows = [row({ penetration_pct: 25 }), row({ penetration_pct: 15 }), row(), row()]
    const result = effectivePenetrationPct(rows)
    expect(result[0]).toBe(25)
    expect(result[1]).toBe(15)
    // remaining 60% split across the 2 still-auto rows
    expect(result[2]).toBeCloseTo(30)
    expect(result[3]).toBeCloseTo(30)
  })

  it('floors the remaining share at 0 when explicit entries already exceed 100%', () => {
    const rows = [row({ penetration_pct: 70 }), row({ penetration_pct: 50 }), row()]
    const result = effectivePenetrationPct(rows)
    expect(result[2]).toBe(0)
  })

  it('every row explicit — no auto rows to split anything across', () => {
    const rows = [row({ penetration_pct: 60 }), row({ penetration_pct: 40 })]
    expect(effectivePenetrationPct(rows)).toEqual([60, 40])
  })
})

describe('effectiveOtdPrice', () => {
  it('defaults to package price until manually overridden', () => {
    expect(effectiveOtdPrice(row({ package_price: 89.99, otd_price: null, otd_price_is_manual: false }))).toBe(89.99)
  })
  it('uses the manual otd_price once the analyst has set one, ignoring package_price', () => {
    expect(effectiveOtdPrice(row({ package_price: 89.99, otd_price: 95, otd_price_is_manual: true }))).toBe(95)
  })
})
