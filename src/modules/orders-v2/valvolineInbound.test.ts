import { describe, expect, it } from 'vitest'
import { computeInbound, type InboundOrderLine } from './valvolineInbound'

const line = (o: Partial<InboundOrderLine>): InboundOrderLine => ({ location_id: 's1', product_id: 'VRP530BB', qty: 3, po_number: '1-20261006', po_date: '2026-10-06', ...o })
// Orders placed on a Tuesday land two weeks later in this fake schedule.
const etaFor = (_loc: string, d: string) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 14); return x.toISOString().slice(0, 10) }
const base = { orderDate: '2026-10-08', today: '2026-10-08', etaFor, received: new Map<string, number>() }

describe('computeInbound', () => {
  it('counts an earlier order whose ETA is still ahead and has no receipt', () => {
    const r = computeInbound({ ...base, lines: [line({})] })
    expect(r.get('s1|VRP530BB')).toEqual({ units: 3, eta: '2026-10-20' })
  })
  it('ignores an order that already arrived (ETA passed) or was received in Droptop', () => {
    expect(computeInbound({ ...base, lines: [line({ po_date: '2026-09-20' })] }).size).toBe(0) // ETA 10/4, past
    expect(computeInbound({ ...base, lines: [line({})], received: new Map([['1-20261006|VRP530BB', 3]]) }).size).toBe(0)
  })
  it('a partial receipt leaves the rest inbound', () => {
    const r = computeInbound({ ...base, lines: [line({})], received: new Map([['1-20261006|VRP530BB', 1]]) })
    expect(r.get('s1|VRP530BB')?.units).toBe(2)
  })
  it('never counts an order from the same run or later (regenerating an exported order must not net against itself)', () => {
    expect(computeInbound({ ...base, lines: [line({ po_date: '2026-10-08' }), line({ po_date: '2026-10-09' })] }).size).toBe(0)
  })
  it('sums several inbound orders for one shop + product', () => {
    const r = computeInbound({ ...base, lines: [line({}), line({ po_number: '1-20261007', po_date: '2026-10-07', qty: 2 })] })
    expect(r.get('s1|VRP530BB')?.units).toBe(5)
  })
})
