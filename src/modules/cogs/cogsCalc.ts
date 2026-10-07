// COGS Price Check — the calculation, pure (no React / Supabase) so it can be tested.
//
// A vendor back-dates a price change. Droptop booked some receipts / adjustments / sales at the OLD cost; the expected ending balance has to
// move by the difference. For every transaction in the window:
//   expected price  = the vendor's price in effect on its PRICING date (receipts: the date the PO was ORDERED — the order date sets the price,
//                     not the delivery date; sales and adjustments: the day they happened)
//   booked price    = total cost Droptop booked / quantity
//   impact          = qty x (expected - booked)         (signed like the quantity: a sale of old-priced oil at a higher price is negative)
// A transaction is only re-costed when it was booked at an OLD price (the booked cost matches another price on the list for that product),
// or — when "adjust unmatched" is on, as Valvoline's workbook did — whenever it differs from the expected price at all.
//
// Valvoline-style sell-through: the starting on hand was costed at the old price on purpose, so sales draw it down first and only the
// quantity sold BEYOND the starting balance is re-costed. A sale that straddles the balance is split (the workbook re-costed the whole row).

export type TxType = 'sale' | 'receipt' | 'adjustment'

export interface LedgerRow {
  id: string
  location_id: string
  change_date: string // yyyy-MM-dd
  change_type: TxType
  product_id: string
  po_custom_id: string
  qty_change: number
  total_cost: number
}

export interface PriceEntry {
  product_id: string
  price_per_qt: number
  start_date: string | null
  end_date: string | null
}

export interface StartBalance { location_id: string; product_id: string; on_hand_qty: number }

export interface CheckParams {
  start: string
  end: string
  sellThrough: boolean
  adjustUnmatched: boolean
  tolerance: number
}

export type DateSource = 'transaction' | 'po_name' | 'po_record' | 'receipt_date'
export type LineStatus = 'correct' | 'old_price' | 'recosted_other' | 'unmatched' | 'start_stock' | 'no_price' | 'left_as_booked'

export interface CheckLine {
  row: LedgerRow
  pricingDate: string
  dateSource: DateSource
  expectedPpq: number | null
  bookedPpq: number | null
  /** The listed price the booked cost matched when it was an old price. */
  matchedPpq: number | null
  status: LineStatus
  /** Units (positive) drawn from the starting on hand, not re-costed. */
  fromStartQty: number
  /** Signed quantity actually re-costed. */
  adjustedQty: number
  impact: number
}

export interface ShopTotals { location_id: string; sales: number; receipts: number; adjustments: number; total: number; lines: number }

export interface CheckResult {
  lines: CheckLine[]
  byShop: ShopTotals[]
  totals: { sales: number; receipts: number; adjustments: number; total: number }
  counts: Record<LineStatus, number>
  /** Ledger rows in the window for products that aren't on this vendor's price list at all. */
  outsideVendor: number
  /** Starting-balance units never used up, per shop+product — informational for sell-through. */
  remainingStart: { location_id: string; product_id: string; remaining: number }[]
}

const pk = (s: string) => s.trim().toLowerCase()
const round = (n: number, dp = 4) => { const f = 10 ** dp; return Math.round(n * f) / f }

/** The order date embedded in one of our PO numbers: `14-08282026P` (MMDDYYYY + B/P) or `18-20260827` (YYYYMMDD). */
export function poOrderDateFromName(custom: string | null | undefined): string | null {
  const s = (custom ?? '').trim()
  let m = /^\d+-(\d{2})(\d{2})(\d{4})[A-Za-z]*$/.exec(s)
  if (m) {
    const mo = Number(m[1]), d = Number(m[2]), y = Number(m[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) return `${y}-${m[1]}-${m[2]}`
  }
  m = /^\d+-(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 2000 && y <= 2100) return `${m[1]}-${m[2]}-${m[3]}`
  }
  return null
}

/** The date whose price applies: receipts use the PO's order date (name first, then Droptop's PO record, then the receipt date). */
export function pricingDateFor(row: LedgerRow, poDates: Map<string, string>): { date: string; source: DateSource } {
  if (row.change_type !== 'receipt') return { date: row.change_date, source: 'transaction' }
  const fromName = poOrderDateFromName(row.po_custom_id)
  if (fromName) return { date: fromName, source: 'po_name' }
  const fromRecord = row.po_custom_id ? poDates.get(row.po_custom_id) : undefined
  if (fromRecord) return { date: fromRecord, source: 'po_record' }
  return { date: row.change_date, source: 'receipt_date' }
}

export function indexPrices(entries: PriceEntry[]): Map<string, PriceEntry[]> {
  const map = new Map<string, PriceEntry[]>()
  for (const e of entries) {
    if (!Number.isFinite(e.price_per_qt)) continue
    const k = pk(e.product_id)
    if (!map.has(k)) map.set(k, [])
    map.get(k)!.push(e)
  }
  return map
}

/** The price in effect on a date — if several cover it, the one that started most recently wins. */
export function priceOn(entries: PriceEntry[] | undefined, date: string): PriceEntry | null {
  let best: PriceEntry | null = null
  for (const e of entries ?? []) {
    if (e.start_date && date < e.start_date) continue
    if (e.end_date && date > e.end_date) continue
    if (!best || (e.start_date ?? '') > (best.start_date ?? '')) best = e
  }
  return best
}

const emptyCounts = (): Record<LineStatus, number> => ({ correct: 0, old_price: 0, recosted_other: 0, unmatched: 0, start_stock: 0, no_price: 0, left_as_booked: 0 })

export function runCheck(input: { params: CheckParams; ledger: LedgerRow[]; prices: PriceEntry[]; poDates?: Map<string, string>; startBalances?: StartBalance[] }): CheckResult {
  const { params } = input
  const priceIdx = indexPrices(input.prices)
  const poDates = input.poDates ?? new Map<string, string>()
  const remaining = new Map<string, number>()
  if (params.sellThrough) for (const b of input.startBalances ?? []) remaining.set(`${b.location_id}|${pk(b.product_id)}`, (remaining.get(`${b.location_id}|${pk(b.product_id)}`) ?? 0) + b.on_hand_qty)

  // Oldest first so sales draw the starting balance down in the order they happened (id breaks ties so reruns are stable).
  const rows = input.ledger
    .filter((r) => r.change_date >= params.start && r.change_date <= params.end && Number.isFinite(r.qty_change) && Number.isFinite(r.total_cost))
    .sort((a, b) => (a.change_date < b.change_date ? -1 : a.change_date > b.change_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const lines: CheckLine[] = []
  const counts = emptyCounts()
  let outsideVendor = 0
  for (const row of rows) {
    const entries = priceIdx.get(pk(row.product_id))
    if (!entries) { outsideVendor++; continue }
    const { date, source } = pricingDateFor(row, poDates)
    const expected = priceOn(entries, date)
    const base: CheckLine = { row, pricingDate: date, dateSource: source, expectedPpq: expected?.price_per_qt ?? null, bookedPpq: null, matchedPpq: null, status: 'correct', fromStartQty: 0, adjustedQty: 0, impact: 0 }
    if (row.qty_change === 0) { counts.correct++; lines.push(base); continue }
    if (!expected) { base.status = 'no_price'; counts.no_price++; lines.push(base); continue }
    const booked = row.total_cost / row.qty_change
    base.bookedPpq = round(booked, 5)
    const E = expected.price_per_qt
    if (Math.abs(booked - E) <= params.tolerance) { counts.correct++; lines.push(base); continue }

    const matched = entries.find((e) => Math.abs(e.price_per_qt - E) > params.tolerance && Math.abs(e.price_per_qt - booked) <= params.tolerance) ?? null
    const recost = matched != null || params.adjustUnmatched
    if (!recost) { base.status = 'unmatched'; counts.unmatched++; lines.push(base); continue }

    // Sell-through: the starting on hand was costed at the old price on purpose; only sales past it are re-costed, and negative
    // adjustments are left as booked (the workbook's Valvoline rule).
    let fraction = 1
    if (params.sellThrough && row.change_type === 'sale' && row.qty_change < 0) {
      const key = `${row.location_id}|${pk(row.product_id)}`
      const left = remaining.get(key) ?? 0
      const units = -row.qty_change
      const used = Math.min(Math.max(left, 0), units)
      remaining.set(key, left - used)
      base.fromStartQty = round(used, 4)
      fraction = (units - used) / units
      if (fraction <= 0) { base.status = 'start_stock'; counts.start_stock++; lines.push(base); continue }
    } else if (params.sellThrough && row.change_type === 'adjustment' && row.qty_change < 0) {
      base.status = 'left_as_booked'; counts.left_as_booked++; lines.push(base); continue
    }
    base.status = matched != null ? 'old_price' : 'recosted_other'
    base.matchedPpq = matched?.price_per_qt ?? null
    base.adjustedQty = round(row.qty_change * fraction, 4)
    base.impact = base.adjustedQty * (E - booked)
    if (matched != null) counts.old_price++; else counts.recosted_other++
    lines.push(base)
  }

  const shopMap = new Map<string, ShopTotals>()
  const totals = { sales: 0, receipts: 0, adjustments: 0, total: 0 }
  for (const l of lines) {
    if (!l.impact) continue
    const s = shopMap.get(l.row.location_id) ?? { location_id: l.row.location_id, sales: 0, receipts: 0, adjustments: 0, total: 0, lines: 0 }
    const key = l.row.change_type === 'sale' ? 'sales' : l.row.change_type === 'receipt' ? 'receipts' : 'adjustments'
    s[key] += l.impact; s.total += l.impact; s.lines++
    totals[key] += l.impact; totals.total += l.impact
    shopMap.set(l.row.location_id, s)
  }
  return {
    lines, byShop: [...shopMap.values()].sort((a, b) => a.total - b.total), totals, counts, outsideVendor,
    remainingStart: [...remaining.entries()].map(([k, v]) => { const [location_id, product_id] = k.split('|'); return { location_id, product_id, remaining: v } }).filter((r) => r.remaining > 0.0001),
  }
}
