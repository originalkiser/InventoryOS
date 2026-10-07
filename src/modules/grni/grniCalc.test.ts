import { describe, expect, it } from 'vitest'
import { calcGrni, computeCompliance, monthEnd, parsePo, receiptKey, shopMode, type GrniInvoice, type GrniOrder, type GrniParams, type GrniPrice } from './grniCalc'

const params: GrniParams = { periodStart: '2026-09-01', cutoff: '2026-09-26', bulkPct: 0.9, packagePct: 0.64, priorPct: 0.9, threshold: 0.8 }
const prices: GrniPrice[] = [
  { itemCode: 'PKG', itemId: 'EURO-SYN-0W30C', uom: 'CS', pkgQtyGal: 3, priceGal: 30, effectiveFrom: '2000-01-01' },     // $90 / case
  { itemCode: 'PKG', itemId: 'EURO-SYN-0W30C', uom: 'CS', pkgQtyGal: 3, priceGal: 40, effectiveFrom: '2026-09-15' },     // $120 / case from 9/15
  { itemCode: 'BULK', itemId: 'SYN-0W20', uom: 'BULK', pkgQtyGal: 1, priceGal: 10, effectiveFrom: '2000-01-01' },
  { itemCode: 'HM', itemId: 'HM0806', uom: 'CS', pkgQtyGal: 4, priceGal: 20, effectiveFrom: '2000-01-01' },
]
const order = (over: Partial<GrniOrder>): GrniOrder => ({ id: Math.random().toString(), orderDate: '2026-09-10', po: '10-09102026P', shipTo: 'STRICKLAND BROTHERS #10', shop: 10, code: 'PKG', desc: 'x', qty: 2, ...over })
const run = (orders: GrniOrder[], extra: Partial<Parameters<typeof calcGrni>[0]> = {}) =>
  calcGrni({ params, orders, invoices: [], prices, receipts: new Map(), compliance: [], ...extra })

describe('helpers', () => {
  it('reads a PO number', () => {
    expect(parsePo('146-05202026B')).toEqual({ date: '2026-05-20', shop: 146, type: 'Bulk' })
    expect(parsePo('96-09042026P')).toEqual({ date: '2026-09-04', shop: 96, type: 'Package' })
    expect(parsePo('06032026P-Dexos').shop).toBeNull()
  })
  it('month end', () => { expect(monthEnd('2026-09-01')).toBe('2026-09-30'); expect(monthEnd('2026-02-01')).toBe('2026-02-28') })
  it('shop rule', () => {
    expect(shopMode(undefined, 0.8)).toBe('receipts')
    expect(shopMode({ shop: 1, pct: 0.5, override: null }, 0.8)).toBe('standard')
    expect(shopMode({ shop: 1, pct: 0.95, override: null }, 0.8)).toBe('receipts')
    expect(shopMode({ shop: 1, pct: 0.5, override: 'receipts' }, 0.8)).toBe('receipts')
    expect(shopMode({ shop: 1, pct: 0.99, override: 'standard' }, 0.8)).toBe('standard')
  })
})

describe('calcGrni', () => {
  it('a low-compliance shop is valued at the standard percentage (package 64%, bulk 90%)', () => {
    const r = run([order({ qty: 2 }), order({ code: 'BULK', po: '10-09102026B', qty: 100 })], { compliance: [{ shop: 10, pct: 0.4, override: null }] })
    // package: 2 cases x $90 x 64%   bulk: 100 gal x $10 x 90%
    expect(r.totals.assumed).toBeCloseTo(2 * 90 * 0.64 + 100 * 10 * 0.9)
    expect(r.lines.every((l) => l.kind === 'assumed')).toBe(true)
  })
  it('a good-compliance shop is valued at what it received — package units, not gallons', () => {
    const receipts = new Map([[receiptKey('10-09102026P', 'EURO-SYN-0W30C'), 2]])
    const r = run([order({ qty: 2 })], { receipts })
    expect(r.totals.received).toBeCloseTo(2 * 90) // 2 cases x $90/case (the old sheet multiplied gallons by the per-case price)
    expect(r.lines[0].kind).toBe('received')
  })
  it('received is capped at what was ordered, and nothing received means not counted', () => {
    const over = run([order({ qty: 2 })], { receipts: new Map([[receiptKey('10-09102026P', 'EURO-SYN-0W30C'), 5]]) })
    expect(over.totals.received).toBeCloseTo(2 * 90)
    const none = run([order({ qty: 2 })])
    expect(none.lines[0].kind).toBe('not_received')
    expect(none.totals.total).toBe(0)
  })
  it('prices an order at the list in effect on its order date', () => {
    const r = run([order({ orderDate: '2026-09-20', po: '10-09202026P', qty: 1 })], { compliance: [{ shop: 10, pct: 0, override: null }] })
    expect(r.lines[0].unitPrice).toBe(120)
  })
  it('orders placed after the cut-off are not counted; earlier months go to prior months', () => {
    const r = run([order({ po: '10-09282026P', orderDate: '2026-09-28' }), order({ po: '10-08102026P', orderDate: '2026-08-10', qty: 1 })])
    expect(r.lines[0].kind).toBe('later')
    expect(r.lines[1].kind).toBe('prior')
    expect(r.totals.prior).toBeCloseTo(90 * 0.9)
  })
  it('an order already invoiced with a ship date in the month is counted from the invoice report only', () => {
    const inv: GrniInvoice = { id: 'i', invoiceNo: '1', po: '10-09102026P', orderDate: '2026-09-10', shipDate: '2026-09-20', invoiceDate: '2026-10-02', shop: 10, code: 'PKG', desc: '', gallonsShipped: 6 }
    const r = run([order({ qty: 2 })], { invoices: [inv], compliance: [{ shop: 10, pct: 0, override: null }] })
    expect(r.lines[0].kind).toBe('billed')
    expect(r.totals.assumed).toBe(0)
    expect(r.totals.invoicedAfter).toBeCloseTo(6 * 30) // gallons shipped x price per gallon on the order date
  })
  it('an invoice dated within the month, or shipped outside it, is not GRNI', () => {
    const mk = (over: Partial<GrniInvoice>): GrniInvoice => ({ id: Math.random().toString(), invoiceNo: '1', po: 'x', orderDate: '2026-09-10', shipDate: '2026-09-20', invoiceDate: '2026-10-02', shop: 10, code: 'PKG', desc: '', gallonsShipped: 3, ...over })
    const r = run([], { invoices: [mk({}), mk({ invoiceDate: '2026-09-25' }), mk({ shipDate: '2026-10-01' }), mk({ shipDate: '2026-08-30' })] })
    expect(r.invoices).toHaveLength(1)
  })
  it('HM0806 posts to 12006, everything else to 12005', () => {
    const r = run([order({ code: 'HM', qty: 1 }), order({ qty: 1 })], { compliance: [{ shop: 10, pct: 0, override: null }] })
    expect(r.totals.accounts[12006]).toBeCloseTo(80 * 0.64)
    expect(r.totals.accounts[12005]).toBeCloseTo(90 * 0.64)
  })
  it('an unpriced product (a deposit) is flagged and not counted', () => {
    const r = run([order({ code: 'VDRUMDEP2', desc: 'DRUM DEPOSIT', qty: 3 })])
    expect(r.lines[0].kind).toBe('unpriced')
    expect(r.issues.unpricedCodes[0]).toMatchObject({ code: 'VDRUMDEP2', qty: 3 })
  })
})

describe('computeCompliance', () => {
  it('compares received gallons with invoiced gallons for the period, once per PO + product', () => {
    const inv = (id: string, gal: number): GrniInvoice => ({ id, invoiceNo: id, po: '10-09102026P', orderDate: '2026-09-10', shipDate: '2026-09-12', invoiceDate: '2026-09-20', shop: 10, code: 'PKG', desc: '', gallonsShipped: gal })
    const rows = computeCompliance({ params, invoices: [inv('a', 3), inv('b', 3)], prices, receipts: new Map([[receiptKey('10-09102026P', 'EURO-SYN-0W30C'), 1]]) })
    // invoiced 6 gal over two lines; received 1 case = 3 gal -> 50%
    expect(rows).toHaveLength(1)
    expect(rows[0].pct).toBeCloseTo(0.5)
  })
})
