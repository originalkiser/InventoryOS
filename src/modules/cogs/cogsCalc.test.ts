import { describe, expect, it } from 'vitest'
import { poOrderDateFromName, pricingDateFor, priceOn, runCheck, type LedgerRow, type PriceEntry } from './cogsCalc'

const row = (o: Partial<LedgerRow> & { id: string }): LedgerRow => ({
  location_id: 's1', change_date: '2026-09-10', change_type: 'sale', product_id: 'P1', po_custom_id: '', qty_change: -10, total_cost: -40, ...o,
})
const OLD: PriceEntry = { product_id: 'P1', price_per_qt: 4, start_date: null, end_date: '2026-08-31' }
const NEW: PriceEntry = { product_id: 'P1', price_per_qt: 5, start_date: '2026-09-01', end_date: null }
const params = { start: '2026-09-01', end: '2026-09-30', sellThrough: false, adjustUnmatched: false, tolerance: 0.0005 }

describe('order date from a PO name', () => {
  it('reads both of our PO formats and rejects look-alikes', () => {
    expect(poOrderDateFromName('14-08282026P')).toBe('2026-08-28')
    expect(poOrderDateFromName('20-08302026B')).toBe('2026-08-30')
    expect(poOrderDateFromName('18-20260827')).toBe('2026-08-27')
    expect(poOrderDateFromName('RD SO 1868148')).toBeNull()
    expect(poOrderDateFromName('')).toBeNull()
  })
  it('prices a receipt on its order date, not the day it arrived', () => {
    const r = row({ id: 'r', change_type: 'receipt', change_date: '2026-09-03', po_custom_id: '14-08282026P', qty_change: 10, total_cost: 40 })
    expect(pricingDateFor(r, new Map())).toEqual({ date: '2026-08-28', source: 'po_name' })
    const noName = row({ id: 'r2', change_type: 'receipt', change_date: '2026-09-03', po_custom_id: 'ABC', qty_change: 10, total_cost: 40 })
    expect(pricingDateFor(noName, new Map([['ABC', '2026-08-30']]))).toEqual({ date: '2026-08-30', source: 'po_record' })
    expect(pricingDateFor(noName, new Map())).toEqual({ date: '2026-09-03', source: 'receipt_date' })
  })
})

describe('price lookup', () => {
  it('uses the price in effect, the latest start winning when two overlap', () => {
    expect(priceOn([OLD, NEW], '2026-08-31')?.price_per_qt).toBe(4)
    expect(priceOn([OLD, NEW], '2026-09-01')?.price_per_qt).toBe(5)
    expect(priceOn([{ ...NEW, price_per_qt: 6, start_date: '2026-09-05' }, NEW], '2026-09-10')?.price_per_qt).toBe(6)
    expect(priceOn([OLD], '2026-09-10')).toBeNull()
  })
})

describe('runCheck', () => {
  it('re-costs a receipt booked at the old price, using the order date to pick the right price', () => {
    // received 9/3 but ordered 8/28 — the OLD price (4) was right at order time, so a cost booked at 4 is correct...
    const early = row({ id: 'a', change_type: 'receipt', change_date: '2026-09-03', po_custom_id: '14-08282026P', qty_change: 10, total_cost: 40 })
    // ...while the same receipt ordered 9/2 should have cost 5, so one booked at 4 is short 10 qt x $1
    const late = row({ id: 'b', change_type: 'receipt', change_date: '2026-09-03', po_custom_id: '14-09022026P', qty_change: 10, total_cost: 40 })
    const res = runCheck({ params, ledger: [early, late], prices: [OLD, NEW] })
    expect(res.lines.find((l) => l.row.id === 'a')!.status).toBe('correct')
    const l = res.lines.find((x) => x.row.id === 'b')!
    expect(l.status).toBe('old_price')
    expect(l.impact).toBeCloseTo(10)
    expect(res.totals.receipts).toBeCloseTo(10)
  })

  it('signs sales and adjustments like their quantity', () => {
    const sale = row({ id: 's', qty_change: -10, total_cost: -40 })
    const adj = row({ id: 'j', change_type: 'adjustment', qty_change: 3, total_cost: 12 })
    const res = runCheck({ params, ledger: [sale, adj], prices: [OLD, NEW] })
    expect(res.totals.sales).toBeCloseTo(-10) // more COGS, less inventory
    expect(res.totals.adjustments).toBeCloseTo(3)
    expect(res.totals.total).toBeCloseTo(-7)
  })

  it('leaves a cost that matches no listed price alone unless told to re-cost it', () => {
    const odd = row({ id: 'o', qty_change: -10, total_cost: -42 })
    expect(runCheck({ params, ledger: [odd], prices: [OLD, NEW] }).counts.unmatched).toBe(1)
    const res = runCheck({ params: { ...params, adjustUnmatched: true }, ledger: [odd], prices: [OLD, NEW] })
    expect(res.counts.recosted_other).toBe(1)
    expect(res.totals.sales).toBeCloseTo(-8) // -10 x (5 - 4.2)
  })

  it('sell-through: sales use up the starting on hand first and only the excess is re-costed', () => {
    const sales = [row({ id: '1', change_date: '2026-09-02', qty_change: -6, total_cost: -24 }), row({ id: '2', change_date: '2026-09-03', qty_change: -6, total_cost: -24 }), row({ id: '3', change_date: '2026-09-04', qty_change: -4, total_cost: -16 })]
    const res = runCheck({ params: { ...params, sellThrough: true }, ledger: sales, prices: [OLD, NEW], startBalances: [{ location_id: 's1', product_id: 'p1', on_hand_qty: 8 }] })
    const by = (id: string) => res.lines.find((l) => l.row.id === id)!
    expect(by('1').status).toBe('start_stock') // 6 of 8 used
    expect(by('2').fromStartQty).toBeCloseTo(2) // 2 left, so 4 of this sale's 6 are past it
    expect(by('2').impact).toBeCloseTo(-4)
    expect(by('3').impact).toBeCloseTo(-4)
    expect(res.totals.sales).toBeCloseTo(-8)
  })

  it('sell-through leaves negative adjustments as booked, and counts the rest as outside the vendor', () => {
    const neg = row({ id: 'n', change_type: 'adjustment', qty_change: -2, total_cost: -8 })
    const other = row({ id: 'x', product_id: 'ZZZ' })
    const res = runCheck({ params: { ...params, sellThrough: true }, ledger: [neg, other], prices: [OLD, NEW], startBalances: [] })
    expect(res.counts.left_as_booked).toBe(1)
    expect(res.outsideVendor).toBe(1)
    expect(res.totals.total).toBe(0)
  })

  it('flags a transaction with no price in effect rather than guessing', () => {
    const res = runCheck({ params, ledger: [row({ id: 'p', change_date: '2026-09-10' })], prices: [OLD] })
    expect(res.counts.no_price).toBe(1)
  })
})
