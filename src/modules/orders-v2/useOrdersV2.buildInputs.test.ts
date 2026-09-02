import { describe, expect, it } from 'vitest'
import { buildGenerationInputs, type OrderConfigRow, type UsageRow, type PurchaseOrderRow, type PoItemRow, type TankOnHandRow, type VendorPartRow } from './useOrdersV2'

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

describe('buildGenerationInputs — pending PO coverage', () => {
  function po(id: string, po_status: string): PurchaseOrderRow {
    return { id, location_id: 'L1', po_status }
  }
  function item(purchase_order_id: string, overrides: Partial<PoItemRow> = {}): PoItemRow {
    return { purchase_order_id, product_id: 'HM0806', quantity: 10, received_quantity: null, remaining_quantity: null, purchase_uom: 'GA', ...overrides }
  }

  it('flags pendingPoQty (in quarts) for an open PO, never adjusting on_hand itself', () => {
    const configs = [config('HM0806')]
    const usageRows = [usage('HM0806', 42, 3)]
    const purchaseOrders = [po('PO1', 'accepted')]
    const items = [item('PO1', { remaining_quantity: 5, purchase_uom: 'GA' })] // 5 gal = 20 quarts
    const inputs = buildGenerationInputs(configs, [], usageRows, [], [], [], [], [], purchaseOrders, items)

    const hm = inputs.find((i) => i.product_id === 'HM0806')!
    expect(hm.on_hand).toBe(42) // unchanged — never auto-combined
    expect(hm.pendingPoQty).toBe(20)
  })

  it('ignores closed/cancelled POs', () => {
    const configs = [config('HM0806')]
    const usageRows = [usage('HM0806', 42, 3)]
    const purchaseOrders = [po('PO1', 'closed')]
    const items = [item('PO1', { remaining_quantity: 5, purchase_uom: 'GA' })]
    const inputs = buildGenerationInputs(configs, [], usageRows, [], [], [], [], [], purchaseOrders, items)

    expect(inputs.find((i) => i.product_id === 'HM0806')!.pendingPoQty).toBeNull()
  })

  it('falls back to quantity minus received when remaining_quantity is null', () => {
    const configs = [config('HM0806')]
    const usageRows = [usage('HM0806', 42, 3)]
    const purchaseOrders = [po('PO1', 'sent')]
    const items = [item('PO1', { quantity: 10, received_quantity: 4, remaining_quantity: null, purchase_uom: 'QT' })]
    const inputs = buildGenerationInputs(configs, [], usageRows, [], [], [], [], [], purchaseOrders, items)

    expect(inputs.find((i) => i.product_id === 'HM0806')!.pendingPoQty).toBe(6) // 10 - 4, already quarts
  })

  it('skips items in a purchase UOM that has no reliable quarts conversion (e.g. CASE/EA)', () => {
    const configs = [config('HM0806')]
    const usageRows = [usage('HM0806', 42, 3)]
    const purchaseOrders = [po('PO1', 'accepted')]
    const items = [item('PO1', { remaining_quantity: 5, purchase_uom: 'CASE' })]
    const inputs = buildGenerationInputs(configs, [], usageRows, [], [], [], [], [], purchaseOrders, items)

    expect(inputs.find((i) => i.product_id === 'HM0806')!.pendingPoQty).toBeNull()
  })

  it('never applies to a VMI/keep-fill product', () => {
    const configs = [config('HM0806', { metadata: { vmi: 'yes' } })]
    const usageRows = [usage('HM0806', 42, 3)]
    const purchaseOrders = [po('PO1', 'accepted')]
    const items = [item('PO1', { remaining_quantity: 5, purchase_uom: 'GA' })]
    const inputs = buildGenerationInputs(configs, [], usageRows, [], [], [], [], [], purchaseOrders, items)

    expect(inputs.find((i) => i.product_id === 'HM0806')!.pendingPoQty).toBeNull()
  })
})

// A keep-fill/VMI product's on-hand comes from the tank monitor, but tank
// telemetry names its own products however the provider does ("DMX SYN
// 0W20"), never the shop's canonical product_id — a plain product_id join
// would never match anything (this was a real bug: every keep-fill product
// with a real tank installed still showed "no data" in Orders v2, even
// though the same tank's reading displayed correctly on Location Lookup).
// Resolution mirrors LocationLookupPage.tsx exactly: the manual
// tankProductMap override first, then an automatic match against
// vendor_parts' description/part_number.
describe('buildGenerationInputs — tank monitor product-name resolution', () => {
  function tank(product_id: string, on_hand: number): TankOnHandRow {
    return { location_id: 'L1', product_id, on_hand }
  }
  function vendorPart(our_part_number: string, description: string): VendorPartRow {
    return { vendor_id: 'V1', our_part_number, unit_of_measure: null, metadata: null, description }
  }

  it('resolves a tank reading through the manual tankProductMap override', () => {
    const configs = [config('SYN-0W20', { metadata: { vmi: 'yes' } })]
    const tankOnHand = [tank('DMX SYN 0W20', 100.25)]
    const tankProductMap = { 'dmx syn 0w20': 'SYN-0W20' }
    const inputs = buildGenerationInputs(configs, [], [], [], [], [], [], tankOnHand, [], [], tankProductMap)

    // Keep-fill on-hand is gallons -> quarts (×4) — same convention as
    // max_capacity_gallons elsewhere in this module.
    expect(inputs.find((i) => i.product_id === 'SYN-0W20')!.on_hand).toBe(401)
  })

  it('falls back to an automatic vendor_parts description/part_number match with no manual override', () => {
    const configs = [config('SYN-0W20', { metadata: { vmi: 'yes' } })]
    const tankOnHand = [tank('dmx syn 0w20 bu', 50)]
    const vendorParts = [vendorPart('SYN-0W20', 'DMX SYN 0W20 BU')]
    const inputs = buildGenerationInputs(configs, [], [], [], vendorParts, [], [], tankOnHand)

    expect(inputs.find((i) => i.product_id === 'SYN-0W20')!.on_hand).toBe(200)
  })

  it('leaves on_hand null (needs-review) when no mapping matches at all', () => {
    const configs = [config('SYN-0W20', { metadata: { vmi: 'yes' } })]
    const tankOnHand = [tank('some unrecognized raw name', 50)]
    const inputs = buildGenerationInputs(configs, [], [], [], [], [], [], tankOnHand)

    expect(inputs.find((i) => i.product_id === 'SYN-0W20')!.on_hand).toBeNull()
  })
})
