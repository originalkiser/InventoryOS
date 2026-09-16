// RelaDyne Open Sales Order / Open Invoice reconciliation (2026-09-16
// request). RelaDyne doesn't expose either report via an API, so they're
// uploaded by hand as Excel exports (see the upload buttons on
// OrdersV2Landing.tsx) and snapshotted into inventory.rd_open_orders /
// rd_open_invoices — each upload REPLACES the company's prior snapshot for
// that report entirely, since both represent "as of right now" state, not
// a ledger.
//
// This file is the pure matching logic (parsing + reconciliation), kept
// free of React/Supabase so it's directly testable, same separation as
// engine.ts. Parsing consumes the same `ParseResult['rows']` shape every
// other upload in this app already produces (src/lib/fileParser.ts, via
// FileUploadZone) — a worker-parsed array of {header: stringValue} records
// — rather than re-reading the raw file with the xlsx package directly, so
// this gets the existing off-main-thread parsing and header-detection for
// free instead of a second, divergent parse path.

// ── Excel parsing ────────────────────────────────────────────────────────

// Both reports use Excel's own date-serial numbers (days since
// 1899-12-30), not real dates — sheet_to_json with raw values leaves them
// as plain numbers.
export function excelSerialToIso(n: unknown): string | null {
  const num = Number(n)
  if (!Number.isFinite(num) || num <= 0) return null
  const ms = Math.round((num - 25569) * 86400 * 1000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

// "STRICKLAND BROTHERS #188" -> "188" — matches core.locations.name (the
// shop's own numeric code), same convention isRealShopLocation/resolveId
// already key off of elsewhere in this app.
export function shopNumberFromShipToName(shipToName: unknown): string | null {
  const m = String(shipToName ?? '').match(/#\s*(\d+)/)
  return m ? m[1] : null
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => String(v ?? '').trim()

export interface ParsedOpenOrderRow {
  sales_order_no: string
  customer_po_no: string
  order_date: string | null
  order_type: string | null
  warehouse_code: string | null
  ship_to_code: string | null
  ship_to_name: string
  shop_number: string | null
  product_code: string
  product_desc: string | null
  qty_ordered: number
}

// Open SO Report columns (confirmed against a real export):
// OrderDate, SalesOrderNo, OrderType, CustomerPONo, SO_WarehouseCode,
// Branch, Div, CustomerNo, ShipToCode, CustomerName, ShipToName,
// ShipToAddress1, ShipToCity, ShipToState, LineWarehouse, ProductCode,
// ProductCodeDesc, SOQuantityOrdered, UserCreated, UserUpdated, ...
export function parseOpenOrdersXlsx(rows: Record<string, string>[]): ParsedOpenOrderRow[] {
  return rows
    .map((r): ParsedOpenOrderRow | null => {
      const salesOrderNo = str(r.SalesOrderNo)
      const productCode = str(r.ProductCode)
      if (!salesOrderNo || !productCode) return null
      return {
        sales_order_no: salesOrderNo,
        customer_po_no: str(r.CustomerPONo),
        order_date: excelSerialToIso(r.OrderDate),
        order_type: str(r.OrderType) || null,
        warehouse_code: str(r.SO_WarehouseCode) || null,
        ship_to_code: str(r.ShipToCode) || null,
        ship_to_name: str(r.ShipToName),
        shop_number: shopNumberFromShipToName(r.ShipToName),
        product_code: productCode,
        product_desc: str(r.ProductCodeDesc) || null,
        qty_ordered: num(r.SOQuantityOrdered),
      }
    })
    .filter((r): r is ParsedOpenOrderRow => r != null)
}

export interface ParsedOpenInvoiceRow {
  sales_order_no: string
  customer_po_no: string
  invoice_no: string | null
  order_date: string | null
  ship_date: string | null
  invoice_date: string | null
  invoice_due_date: string | null
  ship_to_code: string | null
  ship_to_name: string
  shop_number: string | null
  product_code: string
  product_desc: string | null
  qty_ordered: number
  qty_shipped: number
  gallons_ordered: number
  gallons_shipped: number
}

// Open Invoice (IO) Report columns (confirmed against a real export):
// Branch, Div, CustomerNo, BillToName, ShipToCode, ShipToName, InvoiceNo,
// InvoiceType, SalesOrderNo, OrderDate, ShipDate, InvoiceDate,
// InvoiceDueDate, CustomerPONo, ProductCode, ProductCodeDesc,
// QuantityOrdered, QuantityShipped, GallonsOrdered, GallonsShipped, ...
export function parseOpenInvoicesXlsx(rows: Record<string, string>[]): ParsedOpenInvoiceRow[] {
  return rows
    .map((r): ParsedOpenInvoiceRow | null => {
      const salesOrderNo = str(r.SalesOrderNo)
      const productCode = str(r.ProductCode)
      if (!salesOrderNo || !productCode) return null
      return {
        sales_order_no: salesOrderNo,
        customer_po_no: str(r.CustomerPONo),
        invoice_no: str(r.InvoiceNo) || null,
        order_date: excelSerialToIso(r.OrderDate),
        ship_date: excelSerialToIso(r.ShipDate),
        invoice_date: excelSerialToIso(r.InvoiceDate),
        invoice_due_date: excelSerialToIso(r.InvoiceDueDate),
        ship_to_code: str(r.ShipToCode) || null,
        ship_to_name: str(r.ShipToName),
        shop_number: shopNumberFromShipToName(r.ShipToName),
        product_code: productCode,
        product_desc: str(r.ProductCodeDesc) || null,
        qty_ordered: num(r.QuantityOrdered),
        qty_shipped: num(r.QuantityShipped),
        gallons_ordered: num(r.GallonsOrdered),
        gallons_shipped: num(r.GallonsShipped),
      }
    })
    .filter((r): r is ParsedOpenInvoiceRow => r != null)
}

// ── Reconciliation ───────────────────────────────────────────────────────

// A vendor won't ship a partial drum, so some slop between ordered and
// received is routine (rounding, a case substituted for another size,
// etc.) — flag only once the gap is both a meaningful share of the order
// AND more than a rounding-sized amount, not any nonzero difference.
const VARIANCE_TOLERANCE_PCT = 0.05
const VARIANCE_TOLERANCE_ABS = 1

// How many days after ordering before a PO with no sign of delivery
// anywhere (not on the invoice report, not on Droptop) is worth flagging
// as "not received" rather than just "still in transit." RelaDyne's own
// lead time is a few days; this is deliberately generous so a genuinely
// slow-but-normal delivery doesn't trip a false alarm.
const NOT_RECEIVED_GRACE_DAYS = 10

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(fromIso + 'T00:00:00').getTime()
  const b = new Date(toIso + 'T00:00:00').getTime()
  return Math.round((b - a) / 86400000)
}

function hasVariance(ordered: number, received: number): boolean {
  const diff = Math.abs(ordered - received)
  return diff > VARIANCE_TOLERANCE_ABS && diff > ordered * VARIANCE_TOLERANCE_PCT
}

export interface HistoryLineForRecon {
  po_number: string
  order_id: string
  location_id: string | null
  product_id: string
  order_type: 'package' | 'bulk'
  qty: number
  quarts_per_unit: number | null
  order_date: string
}

export interface DroptopPoForRecon {
  po_status: string | null
  delivery_status: string | null
  items: Array<{ product_code: string | null; quantity: number | null; received_quantity: number | null }>
}

export interface ReconciliationVariance {
  product_id: string
  product_code: string | null
  ordered: number
  received: number
  unit: 'gal' | 'unit'
}

export interface ReconciliationFinding {
  po_number: string
  order_id: string
  location_id: string | null
  order_date: string
  status: 'not_received' | 'improperly_received'
  source: 'invoice' | 'droptop' | 'neither'
  variances: ReconciliationVariance[]
}

/**
 * Groups our own recent RelaDyne order-history lines by po_number and
 * checks each PO's real-world fate against the uploaded reports and
 * Droptop's own receiving data, in priority order:
 *   1. On the Open Invoice report -> compare shipped vs ordered per
 *      product (real gallons for bulk, unit qty for package).
 *   2. Not invoiced, but Droptop shows it received (a billing-lag case —
 *      RelaDyne's own invoice can trail actual delivery by days/weeks) ->
 *      compare Droptop's received_quantity vs ordered instead.
 *   3. Not invoiced and Droptop shows nothing received -> still genuinely
 *      open. Only flagged once NOT_RECEIVED_GRACE_DAYS has passed with no
 *      sign of it anywhere (not even the Open SO report, which would mean
 *      it dropped off RelaDyne's own tracking) — otherwise it's just
 *      normal transit time, not an exception.
 * Only mismatches and genuinely overdue no-shows are returned — a clean
 * match produces no finding at all.
 */
export function reconcilePoActivity(params: {
  historyLines: HistoryLineForRecon[]
  openOrderPoNumbers: Set<string> // customer_po_no values present on the current Open SO snapshot
  openInvoicesByPo: Map<string, ParsedOpenInvoiceRow[]>
  droptopByPo: Map<string, DroptopPoForRecon>
  partNumberByProductId: Map<string, string> // our product_id -> RelaDyne ProductCode
  today: string
}): ReconciliationFinding[] {
  const { historyLines, openOrderPoNumbers, openInvoicesByPo, droptopByPo, partNumberByProductId, today } = params

  const byPo = new Map<string, HistoryLineForRecon[]>()
  for (const l of historyLines) {
    if (!l.po_number) continue
    if (!byPo.has(l.po_number)) byPo.set(l.po_number, [])
    byPo.get(l.po_number)!.push(l)
  }

  const findings: ReconciliationFinding[] = []

  for (const [poNumber, lines] of byPo) {
    const first = lines[0]
    // Real gallons for bulk (matches the report's own GallonsOrdered/
    // Shipped columns), plain unit count for package (matches
    // QuantityOrdered/Shipped) — see engine.ts's own header comment on
    // why a correctly-configured bulk line's qty already IS real gallons.
    const orderedFor = (l: HistoryLineForRecon) => (l.order_type === 'bulk' ? l.qty : l.qty)
    const unitFor = (l: HistoryLineForRecon): 'gal' | 'unit' => (l.order_type === 'bulk' ? 'gal' : 'unit')

    const invoiceLines = openInvoicesByPo.get(poNumber)
    const droptopPo = droptopByPo.get(poNumber)

    if (invoiceLines && invoiceLines.length) {
      // Invoiced — compare per product. A product on our order with no
      // matching invoice line at all counts as received=0 (a real gap,
      // not "not applicable").
      const variances: ReconciliationVariance[] = []
      for (const l of lines) {
        const partCode = partNumberByProductId.get(l.product_id)
        const matches = partCode ? invoiceLines.filter((iv) => iv.product_code === partCode) : []
        const ordered = orderedFor(l)
        const received = unitFor(l) === 'gal'
          ? matches.reduce((s, m) => s + m.gallons_shipped, 0)
          : matches.reduce((s, m) => s + m.qty_shipped, 0)
        if (hasVariance(ordered, received)) {
          variances.push({ product_id: l.product_id, product_code: partCode ?? null, ordered, received, unit: unitFor(l) })
        }
      }
      if (variances.length) {
        findings.push({ po_number: poNumber, order_id: first.order_id, location_id: first.location_id, order_date: first.order_date, status: 'improperly_received', source: 'invoice', variances })
      }
      continue
    }

    if (droptopPo && (droptopPo.delivery_status === 'fully_received' || droptopPo.delivery_status === 'partially_received')) {
      // Not yet invoiced by RelaDyne (billing lag), but the shop's own
      // Droptop receiving record confirms it arrived — compare against
      // THAT instead of leaving it looking "still open."
      const variances: ReconciliationVariance[] = []
      for (const l of lines) {
        const partCode = partNumberByProductId.get(l.product_id)
        const item = partCode ? droptopPo.items.find((it) => it.product_code === partCode) : undefined
        const ordered = orderedFor(l)
        const received = item?.received_quantity ?? 0
        if (hasVariance(ordered, received)) {
          variances.push({ product_id: l.product_id, product_code: partCode ?? null, ordered, received, unit: unitFor(l) })
        }
      }
      if (variances.length) {
        findings.push({ po_number: poNumber, order_id: first.order_id, location_id: first.location_id, order_date: first.order_date, status: 'improperly_received', source: 'droptop', variances })
      }
      continue
    }

    // Neither invoiced nor confirmed received in Droptop — still on the
    // Open SO report (genuinely still open, not overdue-flagged here) or
    // gone from both reports with nothing to show for it (only flagged
    // once it's had long enough to have arrived).
    const stillOnOpenOrders = openOrderPoNumbers.has(poNumber)
    const overdue = daysBetween(first.order_date, today) > NOT_RECEIVED_GRACE_DAYS
    if (overdue && (stillOnOpenOrders || (!invoiceLines && !droptopPo))) {
      findings.push({
        po_number: poNumber, order_id: first.order_id, location_id: first.location_id, order_date: first.order_date,
        status: 'not_received', source: droptopPo ? 'droptop' : 'neither', variances: [],
      })
    }
  }

  return findings
}
