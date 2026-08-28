import { describe, expect, it } from 'vitest'
import { buildGenerationInputs, type OrderConfigRow, type UsageRow } from './useOrdersV2'

// buildGenerationInputs' "equivalent case types" combine — 5W30D and
// 5W30BB both resolve to the family "5W30" (a trailing run of letters is
// the case-type suffix), so on-hand recorded under either id should feed
// the same order calculation, with an implausibly-large sibling reading
// excluded from the combined total but still surfaced for review.

function config(product_id: string, overrides: Partial<OrderConfigRow> = {}): OrderConfigRow {
  return { location_id: 'L1', product_id, vendor_id: 'V1', capacity: null, order_limit: null, metadata: {}, ...overrides }
}
function usage(product_id: string, on_hands: number, daily_usage: number): UsageRow {
  return { location_id: 'L1', product_id, on_hands, daily_usage }
}

describe('buildGenerationInputs — equivalent case types', () => {
  it('combines a small sibling reading into the ordered product\'s on-hand', () => {
    const configs = [config('5W30BB'), config('5W30D')]
    const usageRows = [usage('5W30BB', 100, 20), usage('5W30D', 10, 5)]
    const inputs = buildGenerationInputs(configs, [], usageRows)

    const bb = inputs.find((i) => i.product_id === '5W30BB')!
    expect(bb.own_on_hand).toBe(100)
    expect(bb.on_hand).toBe(110) // 100 + 10, since 10 <= min(48, 20)
    expect(bb.equivalent_products).toEqual([{ product_id: '5W30D', on_hand: 10, used: true }])
  })

  it('excludes a sibling reading larger than 12gal-equivalent or daily usage, but still reports it', () => {
    const configs = [config('5W30BB'), config('5W30D')]
    // Sibling on-hand (60) exceeds both the 48-quart cap and this
    // product's own daily usage (20) — implausibly large, so it's not
    // folded into the order math.
    const usageRows = [usage('5W30BB', 100, 20), usage('5W30D', 60, 5)]
    const inputs = buildGenerationInputs(configs, [], usageRows)

    const bb = inputs.find((i) => i.product_id === '5W30BB')!
    expect(bb.on_hand).toBe(100) // unchanged — sibling excluded
    expect(bb.equivalent_products).toEqual([{ product_id: '5W30D', on_hand: 60, used: false }])
  })

  it('never combines case types for a VMI/keep-fill product', () => {
    const configs = [
      config('5W30BB', { metadata: { vmi: 'yes' } }),
      config('5W30D'),
    ]
    const usageRows = [usage('5W30BB', 100, 20), usage('5W30D', 10, 5)]
    const inputs = buildGenerationInputs(configs, [], usageRows)

    const bb = inputs.find((i) => i.product_id === '5W30BB')!
    expect(bb.own_on_hand).toBeUndefined()
    expect(bb.equivalent_products).toBeUndefined()
  })

  it('leaves a product with no configured siblings untouched', () => {
    const configs = [config('HM0806')]
    const usageRows = [usage('HM0806', 42, 3)]
    const inputs = buildGenerationInputs(configs, [], usageRows)

    const hm = inputs.find((i) => i.product_id === 'HM0806')!
    expect(hm.on_hand).toBe(42)
    expect(hm.own_on_hand).toBeUndefined()
    expect(hm.equivalent_products).toBeUndefined()
  })
})
