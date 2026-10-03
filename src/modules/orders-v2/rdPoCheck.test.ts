import { describe, it, expect } from 'vitest'
import { groupOverdueByPo, emailQueue, queueByShop, poKeyOf, localIsoDaysAgo, productsSummary, type PoCheckStatusRow } from './rdPoCheck'
import type { RdOrderLedgerRow } from './useRdReports'

const line = (over: Partial<RdOrderLedgerRow>): RdOrderLedgerRow => ({
  id: Math.random().toString(36).slice(2), location_id: 'L1', sales_order_no: 'SO1', customer_po_no: 'PO-A', order_date: '2026-09-20',
  order_type: null, ship_to_name: null, product_code: 'P1', product_desc: null, qty_ordered: 2, status: 'open',
  delivered_qty: null, delivered_at: null, closed_at: null, first_seen_at: '', last_updated_at: '', ...over,
})
const expected = (_l: string | null, orderDate: string | null) => orderDate // delivery == order date, for simplicity

describe('groupOverdueByPo', () => {
  const today = '2026-10-03'
  it('groups lines of one PO and sums quantity', () => {
    const g = groupOverdueByPo([line({ product_code: 'A', qty_ordered: 2 }), line({ product_code: 'B', qty_ordered: 3 })], expected, today)
    expect(g).toHaveLength(1)
    expect(g[0].lines).toHaveLength(2)
    expect(g[0].totalQty).toBe(5)
    expect(g[0].poNo).toBe('PO-A')
  })
  it('ignores closed lines and lines not yet overdue', () => {
    const g = groupOverdueByPo([line({ status: 'closed_delivered' }), line({ customer_po_no: 'PO-B', order_date: '2026-10-03' })], expected, today)
    expect(g).toHaveLength(0)
  })
  it('falls back to the sales order number when there is no PO', () => {
    const l = line({ customer_po_no: '  ', sales_order_no: '1868148' })
    expect(poKeyOf(l)).toBe('SO 1868148')
    expect(groupOverdueByPo([l], expected, today)[0].poNo).toBeNull()
  })
  it('sorts oldest expected delivery first', () => {
    const g = groupOverdueByPo([line({ customer_po_no: 'NEW', order_date: '2026-09-30' }), line({ customer_po_no: 'OLD', order_date: '2026-09-01' })], expected, today)
    expect(g.map((x) => x.key)).toEqual(['OLD', 'NEW'])
  })
})

describe('emailQueue', () => {
  const today = '2026-10-03'
  const groups = groupOverdueByPo([
    line({ customer_po_no: 'IN-WINDOW', order_date: '2026-09-30' }),
    line({ customer_po_no: 'TOO-OLD', order_date: '2026-09-01' }),
    line({ customer_po_no: 'IGN', order_date: '2026-09-30' }),
    line({ customer_po_no: 'SENT', order_date: '2026-09-30' }),
    line({ customer_po_no: 'SKIPPED', order_date: '2026-09-30' }),
  ], expected, today)
  const st = (key: string, status: PoCheckStatusRow['status']): [string, PoCheckStatusRow] => [key, { po_key: key, status, skip_count: 1, last_action_at: '' }]
  const statuses = new Map([st('IGN', 'ignored'), st('SENT', 'emailed'), st('SKIPPED', 'skipped')])

  it('keeps only POs in the date window that are not ignored or already emailed (skipped stay)', () => {
    const q = emailQueue(groups, statuses, '2026-09-26', '2026-10-03').map((g) => g.key).sort()
    expect(q).toEqual(['IN-WINDOW', 'SKIPPED'])
  })
  it('can be limited to selected keys', () => {
    expect(emailQueue(groups, statuses, '2026-09-01', '2026-10-03', new Set(['TOO-OLD'])).map((g) => g.key)).toEqual(['TOO-OLD'])
  })
  it('splits the queue by shop in natural order', () => {
    const gs = groupOverdueByPo([
      line({ customer_po_no: 'A', location_id: 'L10' }), line({ customer_po_no: 'B', location_id: 'L2' }), line({ customer_po_no: 'C', location_id: 'L2' }),
    ], expected, today)
    const byShop = queueByShop(gs, (id) => String(id))
    expect(byShop.map((s) => s.locationId)).toEqual(['L2', 'L10'])
    expect(byShop[0].groups).toHaveLength(2)
  })
})

describe('helpers', () => {
  it('rolls the default window: 7 days back from today', () => {
    expect(localIsoDaysAgo(7, new Date(2026, 9, 3))).toBe('2026-09-26')
    expect(localIsoDaysAgo(7, new Date(2026, 9, 10))).toBe('2026-10-03')
  })
  it('summarizes products compactly', () => {
    const lines = ['A', 'B', 'C'].map((c) => line({ product_code: c, qty_ordered: 1 }))
    expect(productsSummary(lines, 2)).toBe('A x1, B x1 (+1 more)')
  })
})
