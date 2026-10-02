import { describe, it, expect } from 'vitest'
import { previousBusinessDay, classifyOrderLines } from './rdOrderCheck'

describe('previousBusinessDay', () => {
  it('steps back one weekday', () => {
    expect(previousBusinessDay('2026-10-01')).toBe('2026-09-30') // Thu -> Wed
  })
  it('skips the weekend: Monday looks back to Friday', () => {
    expect(previousBusinessDay('2026-10-05')).toBe('2026-10-02')
  })
  it('Sunday and Saturday also land on Friday', () => {
    expect(previousBusinessDay('2026-10-04')).toBe('2026-10-02')
    expect(previousBusinessDay('2026-10-03')).toBe('2026-10-02')
  })
})

describe('classifyOrderLines', () => {
  const parts = new Map([['OIL-A', 'RD1'], ['OIL-B', 'RD2'], ['OIL-C', 'RD3']])
  const lines = [
    { po_number: '170-09292026P', product_id: 'OIL-A' }, // on the open report
    { po_number: '170-09292026P', product_id: 'OIL-B' }, // not on open report, but invoiced already
    { po_number: '170-09292026P', product_id: 'OIL-C' }, // nowhere -> missing
    { po_number: '170-09292026P', product_id: 'NO-MAP' }, // no RelaDyne code
  ]
  it('splits found / invoiced / missing / unmapped', () => {
    const out = classifyOrderLines(
      lines, new Set(['170-09292026P|RD1']), new Set(['170-09292026P|RD2']), parts)
    expect(out.map((l) => l.status)).toEqual(['found', 'invoiced', 'missing', 'unmapped'])
    expect(out[3].product_code).toBeNull()
    expect(out[2].product_code).toBe('RD3')
  })
  it('matches on PO AND product, not product alone', () => {
    const out = classifyOrderLines([{ po_number: '171-09292026P', product_id: 'OIL-A' }], new Set(['170-09292026P|RD1']), new Set(), parts)
    expect(out[0].status).toBe('missing')
  })
})
