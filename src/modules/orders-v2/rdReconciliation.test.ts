import { describe, expect, it } from 'vitest'
import {
  excelSerialToIso, shopNumberFromShipToName, parseOpenOrdersXlsx, parseOpenInvoicesXlsx,
  reconcilePoActivity, type HistoryLineForRecon, type ParsedOpenInvoiceRow, type DroptopPoForRecon,
} from './rdReconciliation'

describe('excelSerialToIso', () => {
  it('converts a real RelaDyne export serial', () => {
    // 46240 = 2026-08-06 in Excel's date system.
    expect(excelSerialToIso(46240)).toBe('2026-08-06')
  })
  it('handles the value arriving as a string (fileParser stringifies every cell)', () => {
    expect(excelSerialToIso('46240')).toBe('2026-08-06')
  })
  it('returns null for blank/non-numeric input', () => {
    expect(excelSerialToIso('')).toBeNull()
    expect(excelSerialToIso(undefined)).toBeNull()
  })
})

describe('shopNumberFromShipToName', () => {
  it('extracts the shop number after #', () => {
    expect(shopNumberFromShipToName('STRICKLAND BROTHERS #188')).toBe('188')
  })
  it('returns null when there is no # code', () => {
    expect(shopNumberFromShipToName('SOME OTHER CUSTOMER')).toBeNull()
  })
})

describe('parseOpenOrdersXlsx', () => {
  it('parses a row and derives shop number', () => {
    const rows = parseOpenOrdersXlsx([{
      SalesOrderNo: '1868148', OrderType: 'B', CustomerPONo: '177-09152026P', SO_WarehouseCode: 'WH1',
      ShipToCode: '177', ShipToName: 'STRICKLAND BROTHERS #177', ProductCode: '950240520SB0810',
      ProductCodeDesc: '5W20', SOQuantityOrdered: '55', OrderDate: '46240',
    }])
    expect(rows).toHaveLength(1)
    expect(rows[0].shop_number).toBe('177')
    expect(rows[0].order_date).toBe('2026-08-06')
    expect(rows[0].qty_ordered).toBe(55)
  })

  it('drops rows missing a sales order number or product code (junk/system rows)', () => {
    const rows = parseOpenOrdersXlsx([{ SalesOrderNo: '', ProductCode: 'X' }, { SalesOrderNo: '1', ProductCode: '' }])
    expect(rows).toHaveLength(0)
  })
})

describe('parseOpenInvoicesXlsx', () => {
  it('parses shipped quantities and gallons', () => {
    const rows = parseOpenInvoicesXlsx([{
      SalesOrderNo: '1868148', CustomerPONo: '177-09152026P', InvoiceNo: 'INV1',
      ShipToName: 'STRICKLAND BROTHERS #177', ProductCode: '950240520SB0810',
      QuantityOrdered: '55', QuantityShipped: '55', GallonsOrdered: '55', GallonsShipped: '50',
    }])
    expect(rows[0].gallons_shipped).toBe(50)
    expect(rows[0].shop_number).toBe('177')
  })
})

// ── Reconciliation ──────────────────────────────────────────────────────

function line(overrides: Partial<HistoryLineForRecon> = {}): HistoryLineForRecon {
  return {
    po_number: '177-09152026P', order_id: 'order-1', location_id: 'loc-1', product_id: 'DEXOS-SYN-0W20BB',
    order_type: 'bulk', qty: 55, quarts_per_unit: 4, order_date: '2026-08-06', ...overrides,
  }
}

describe('reconcilePoActivity', () => {
  it('produces no finding for a clean, fully-matched invoice', () => {
    const invoiceRow: ParsedOpenInvoiceRow = {
      sales_order_no: '1868148', customer_po_no: '177-09152026P', invoice_no: 'INV1', order_date: '2026-08-06',
      ship_date: '2026-08-08', invoice_date: '2026-08-09', invoice_due_date: null, ship_to_code: '177',
      ship_to_name: 'STRICKLAND BROTHERS #177', shop_number: '177', product_code: 'SO-950240520SB0810',
      product_desc: '5W20', qty_ordered: 55, qty_shipped: 55, gallons_ordered: 55, gallons_shipped: 55,
    }
    const findings = reconcilePoActivity({
      historyLines: [line()],
      openOrderPoNumbers: new Set(),
      openInvoicesByPo: new Map([['177-09152026P', [invoiceRow]]]),
      droptopByPo: new Map(),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-10',
    })
    expect(findings).toHaveLength(0)
  })

  it('flags improperly_received when invoiced gallons fall meaningfully short', () => {
    const invoiceRow: ParsedOpenInvoiceRow = {
      sales_order_no: '1868148', customer_po_no: '177-09152026P', invoice_no: 'INV1', order_date: '2026-08-06',
      ship_date: '2026-08-08', invoice_date: '2026-08-09', invoice_due_date: null, ship_to_code: '177',
      ship_to_name: 'STRICKLAND BROTHERS #177', shop_number: '177', product_code: 'SO-950240520SB0810',
      product_desc: '5W20', qty_ordered: 55, qty_shipped: 55, gallons_ordered: 55, gallons_shipped: 30,
    }
    const findings = reconcilePoActivity({
      historyLines: [line()],
      openOrderPoNumbers: new Set(),
      openInvoicesByPo: new Map([['177-09152026P', [invoiceRow]]]),
      droptopByPo: new Map(),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-10',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].status).toBe('improperly_received')
    expect(findings[0].variances[0]).toMatchObject({ ordered: 55, received: 30, unit: 'gal' })
  })

  it('falls back to Droptop receiving data when not yet invoiced (billing lag)', () => {
    const droptop: DroptopPoForRecon = {
      po_status: 'closed', delivery_status: 'fully_received',
      items: [{ product_code: 'SO-950240520SB0810', quantity: 55, received_quantity: 55 }],
    }
    const findings = reconcilePoActivity({
      historyLines: [line()],
      openOrderPoNumbers: new Set(['177-09152026P']),
      openInvoicesByPo: new Map(),
      droptopByPo: new Map([['177-09152026P', droptop]]),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-20',
    })
    expect(findings).toHaveLength(0)
  })

  it('flags not_received once overdue with no invoice, no Droptop receipt, and off the open-order list', () => {
    const findings = reconcilePoActivity({
      historyLines: [line({ order_date: '2026-08-01' })],
      openOrderPoNumbers: new Set(),
      openInvoicesByPo: new Map(),
      droptopByPo: new Map(),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-20',
    })
    expect(findings).toHaveLength(1)
    expect(findings[0].status).toBe('not_received')
  })

  it('does not flag not_received before the grace period has elapsed', () => {
    const findings = reconcilePoActivity({
      historyLines: [line({ order_date: '2026-08-18' })],
      openOrderPoNumbers: new Set(),
      openInvoicesByPo: new Map(),
      droptopByPo: new Map(),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-20',
    })
    expect(findings).toHaveLength(0)
  })

  it('does not flag not_received while still legitimately open on the Open SO report but under grace', () => {
    const findings = reconcilePoActivity({
      historyLines: [line({ order_date: '2026-08-15' })],
      openOrderPoNumbers: new Set(['177-09152026P']),
      openInvoicesByPo: new Map(),
      droptopByPo: new Map(),
      partNumberByProductId: new Map([['DEXOS-SYN-0W20BB', 'SO-950240520SB0810']]),
      today: '2026-08-20',
    })
    expect(findings).toHaveLength(0)
  })
})
