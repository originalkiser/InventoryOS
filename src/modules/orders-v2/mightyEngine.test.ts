import { describe, it, expect } from 'vitest'
import {
  calcMightyOrder, mightyDaysOfSupply, detectMightyPrefixSuffixPatterns, applyMightyProductRule,
  getMightyUomConversion, applyMightyMinOrderRules, computeMightyEfficiency,
} from './mightyEngine'

describe('calcMightyOrder', () => {
  it('orders enough to reach target days of supply after lead time', () => {
    // usage 10/day, lead 3d, target 21d => need 240 on hand, have 50 => order 190
    expect(calcMightyOrder(10, 50, 3, 21)).toBe(190)
  })
  it('never orders negative — already well-stocked returns 0', () => {
    expect(calcMightyOrder(1, 1000, 3, 21)).toBe(0)
  })
  it('applies the onHandToOrderFactor (e.g. ordering in cases of 12)', () => {
    // need 240-50=190 on-hand units, /12 per case, ceil => 16 cases
    expect(calcMightyOrder(10, 50, 3, 21, 1 / 12)).toBe(16)
  })
  it('returns null when usage or on-hand is missing', () => {
    expect(calcMightyOrder(null, 50, 3, 21)).toBeNull()
    expect(calcMightyOrder(10, null, 3, 21)).toBeNull()
  })
})

describe('mightyDaysOfSupply', () => {
  it('divides on-hand by daily usage', () => {
    expect(mightyDaysOfSupply(100, 10)).toBe(10)
  })
  it('returns null for zero or missing usage', () => {
    expect(mightyDaysOfSupply(100, 0)).toBeNull()
    expect(mightyDaysOfSupply(100, null)).toBeNull()
  })
})

describe('detectMightyPrefixSuffixPatterns', () => {
  it('finds a shared suffix above the minimum-count threshold', () => {
    const ids = ['ABC-BB', 'DEF-BB', 'GHI-BB', 'JKL-BB', 'MNO-XYZ']
    const found = detectMightyPrefixSuffixPatterns(ids)
    const bb = found.find((p) => p.type === 'suffix' && p.text === 'BB')
    expect(bb?.count).toBe(4)
  })
  it('respects ignoredKeys', () => {
    const ids = ['ABC-BB', 'DEF-BB', 'GHI-BB', 'JKL-BB']
    const found = detectMightyPrefixSuffixPatterns(ids, new Set(['suffix:BB']))
    expect(found.some((p) => p.text === 'BB')).toBe(false)
  })
})

describe('applyMightyProductRule', () => {
  it('raises a positive order up to minQty', () => {
    expect(applyMightyProductRule({ minQty: 5 }, 2, 10)).toBe(5)
  })
  it('never forces an order on a zero-need line', () => {
    expect(applyMightyProductRule({ minQty: 5 }, 0, 10)).toBe(0)
  })
  it('caps at maxQty', () => {
    expect(applyMightyProductRule({ maxQty: 10 }, 50, 0)).toBe(10)
  })
  it('rounds up to case size', () => {
    expect(applyMightyProductRule({ caseSize: 12 }, 13, 0)).toBe(24)
  })
  it('caps on-hand-after and re-snaps down to a case multiple', () => {
    // onHand 90, maxOnHandAfter 100 => at most 10 more allowed, case 12 => snaps to 0
    expect(applyMightyProductRule({ caseSize: 12, maxOnHandAfter: 100 }, 24, 90)).toBe(0)
  })
})

describe('getMightyUomConversion', () => {
  it('uses a named mapping when on-hand and order UoM differ', () => {
    const conv = getMightyUomConversion('P1', null, 'qt', { onHandUom: 'qt', orderUom: 'gal' }, {}, [{ fromUnit: 'qt', toUnit: 'gal', factor: 0.25 }], [])
    expect(conv).toMatchObject({ hasConversion: true, onHandToOrderFactor: 0.25 })
  })
  it('flags a missing conversion instead of silently defaulting to 1:1', () => {
    const conv = getMightyUomConversion('P1', null, 'qt', { onHandUom: 'qt', orderUom: 'gal' }, {}, [], [])
    expect(conv.conversionMissing).toBe(true)
  })
  it('falls back to a matching suffix pack-size rule in pack mode', () => {
    const rule = { id: '1', matchType: 'suffix' as const, text: 'BB', purchaseSize: 24, orderMode: 'pack' as const }
    const conv = getMightyUomConversion('ITEM-BB', null, null, undefined, {}, [], [rule])
    expect(conv).toMatchObject({ isPack: true, packSize: 24, onHandToOrderFactor: 1 / 24 })
  })
  it('honors a per-rule product exclusion', () => {
    const rule = { id: '1', matchType: 'suffix' as const, text: 'BB', purchaseSize: 24, orderMode: 'pack' as const, exclusions: { products: ['ITEM-BB'] } }
    const conv = getMightyUomConversion('ITEM-BB', null, null, undefined, {}, [], [rule])
    expect(conv.isPack).toBeUndefined()
  })
})

describe('applyMightyMinOrderRules', () => {
  const row = { locationId: '253', category: 'Oil', productId: 'P1', uom: 'ea' }
  it('does nothing when orderQty is already 0', () => {
    expect(applyMightyMinOrderRules(row, 0, [{ id: '1', scope: 'global', minQty: 5 }])).toBe(0)
  })
  it('applies a global minimum', () => {
    expect(applyMightyMinOrderRules(row, 2, [{ id: '1', scope: 'global', minQty: 5 }])).toBe(5)
  })
  it('a location-scoped rule beats a global one', () => {
    const rules: import('./mightyTypes').MightyMinOrderRule[] = [
      { id: '1', scope: 'global', minQty: 5 },
      { id: '2', scope: 'location', minQty: 8, location: '253' },
    ]
    expect(applyMightyMinOrderRules(row, 2, rules)).toBe(8)
  })
  it('a column_value rule beats location', () => {
    const rules: import('./mightyTypes').MightyMinOrderRule[] = [
      { id: '1', scope: 'location', minQty: 8, location: '253' },
      { id: '2', scope: 'column_value', minQty: 12, field: 'category', colValue: 'Oil' },
    ]
    expect(applyMightyMinOrderRules(row, 2, rules)).toBe(12)
  })
})

describe('computeMightyEfficiency', () => {
  it('scores 100% for a line that needs and gets exactly the recommended amount', () => {
    const summary = computeMightyEfficiency(
      [{ locationId: '253', productId: 'P1', dailyUsage: 10, onHand: 50, leadTimeDays: 3, maxOnHand: null, orderQty: 190 }],
      21,
    )
    expect(summary.avgEfficiencyPct).toBe(100)
  })
  it('scores 0% for a line that needs stock but got none', () => {
    const summary = computeMightyEfficiency(
      [{ locationId: '253', productId: 'P1', dailyUsage: 10, onHand: 0, leadTimeDays: 3, maxOnHand: null, orderQty: 0 }],
      21,
    )
    expect(summary.avgEfficiencyPct).toBe(0)
  })
  it('scores 100% for a line that needs nothing and got nothing', () => {
    const summary = computeMightyEfficiency(
      [{ locationId: '253', productId: 'P1', dailyUsage: 1, onHand: 1000, leadTimeDays: 3, maxOnHand: null, orderQty: 0 }],
      21,
    )
    expect(summary.avgEfficiencyPct).toBe(100)
  })
  it('caps at 100% rather than rewarding over-ordering', () => {
    const summary = computeMightyEfficiency(
      [{ locationId: '253', productId: 'P1', dailyUsage: 10, onHand: 50, leadTimeDays: 3, maxOnHand: null, orderQty: 1000 }],
      21,
    )
    expect(summary.avgEfficiencyPct).toBe(100)
  })
  it('ignores lines with no usage data', () => {
    const summary = computeMightyEfficiency(
      [{ locationId: '253', productId: 'P1', dailyUsage: 0, onHand: 50, leadTimeDays: 3, maxOnHand: null, orderQty: 0 }],
      21,
    )
    expect(summary.productCount).toBe(0)
  })
})
