import { describe, expect, it } from 'vitest'
import { effectivePackagePrice, type FranchiseFees } from './franchiseMenu'

const noFees: FranchiseFees = { shopSupplyFee: null, disposalFee: null, oilInflationSurcharge: null }
const allFees: FranchiseFees = { shopSupplyFee: 3, disposalFee: 2, oilInflationSurcharge: 1.5 }

describe('effectivePackagePrice', () => {
  it('returns null when the base price is unset, regardless of fees', () => {
    expect(effectivePackagePrice(null, allFees, true)).toBeNull()
    expect(effectivePackagePrice(null, allFees, false)).toBeNull()
  })

  it('returns the base price unchanged when fees are not included', () => {
    expect(effectivePackagePrice(89.99, allFees, false)).toBe(89.99)
  })

  it('adds all set fees when included', () => {
    expect(effectivePackagePrice(89.99, allFees, true)).toBeCloseTo(96.49)
  })

  it('treats unset individual fees as 0 rather than failing', () => {
    const partial: FranchiseFees = { shopSupplyFee: 3, disposalFee: null, oilInflationSurcharge: null }
    expect(effectivePackagePrice(50, partial, true)).toBe(53)
  })

  it('with no fees at all, included makes no difference', () => {
    expect(effectivePackagePrice(50, noFees, true)).toBe(50)
    expect(effectivePackagePrice(50, noFees, false)).toBe(50)
  })
})
