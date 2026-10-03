// Pure helpers for the RD Reports "Should have delivered by now" workflow (direct ask 2026-10-03):
// grouping overdue ledger lines by PO, the queue rules for the PO Delivery Check-In email, and the
// default email template. No React / Supabase in here so it can be unit-tested.
import type { RdOrderLedgerRow } from './useRdReports'

export const PO_CHECKIN_COMM_TYPE = 'PO Delivery Check-In'

export type PoCheckStatus = 'ignored' | 'emailed' | 'skipped'
export interface PoCheckStatusRow {
  po_key: string
  status: PoCheckStatus
  skip_count: number
  last_action_at: string
}

/** RelaDyne's customer PO number, or the sales order number when a line carries no PO. */
export const poKeyOf = (l: Pick<RdOrderLedgerRow, 'customer_po_no' | 'sales_order_no'>): string =>
  (l.customer_po_no ?? '').trim() || `SO ${l.sales_order_no}`

export interface OverduePoGroup {
  key: string
  poNo: string | null
  salesOrderNos: string[]
  locationId: string | null
  orderDate: string | null
  expected: string | null
  lines: RdOrderLedgerRow[]
  totalQty: number
}

/**
 * Open ledger lines past their expected delivery date, grouped one row per PO (oldest expected delivery
 * first). `expectedFor` is the same schedule-aware lookup the old flat list used.
 */
export function groupOverdueByPo(
  ledger: RdOrderLedgerRow[],
  expectedFor: (locationId: string | null, orderDate: string | null) => string | null,
  today: string,
): OverduePoGroup[] {
  const byKey = new Map<string, OverduePoGroup>()
  for (const l of ledger) {
    if (l.status !== 'open') continue
    const expected = expectedFor(l.location_id, l.order_date)
    if (expected == null || expected >= today) continue
    const key = poKeyOf(l)
    let g = byKey.get(key)
    if (!g) {
      g = {
        key, poNo: (l.customer_po_no ?? '').trim() || null, salesOrderNos: [], locationId: l.location_id,
        orderDate: l.order_date, expected, lines: [], totalQty: 0,
      }
      byKey.set(key, g)
    }
    g.lines.push(l)
    g.totalQty += Number(l.qty_ordered ?? 0)
    if (!g.salesOrderNos.includes(l.sales_order_no)) g.salesOrderNos.push(l.sales_order_no)
  }
  return [...byKey.values()].sort((a, b) => (a.expected ?? '').localeCompare(b.expected ?? '') || a.key.localeCompare(b.key, undefined, { numeric: true }))
}

/** The email queue: POs ordered inside [from, to] that haven't been ignored or already emailed. Skipped ones stay. */
export function emailQueue(
  groups: OverduePoGroup[], statusByKey: Map<string, PoCheckStatusRow>, from: string, to: string,
  onlyKeys?: Set<string> | null,
): OverduePoGroup[] {
  return groups.filter((g) => {
    if (onlyKeys && !onlyKeys.has(g.key)) return false
    const st = statusByKey.get(g.key)?.status
    if (st === 'ignored' || st === 'emailed') return false
    const d = g.orderDate ?? ''
    return d >= from && d <= to
  })
}

/** One entry per shop for the email modal, shops in natural order of their label. */
export function queueByShop(queue: OverduePoGroup[], labelOf: (id: string | null) => string): { locationId: string; groups: OverduePoGroup[] }[] {
  const m = new Map<string, OverduePoGroup[]>()
  for (const g of queue) {
    if (!g.locationId) continue
    const arr = m.get(g.locationId)
    if (arr) arr.push(g); else m.set(g.locationId, [g])
  }
  return [...m.entries()]
    .map(([locationId, groups]) => ({ locationId, groups }))
    .sort((a, b) => labelOf(a.locationId).localeCompare(labelOf(b.locationId), undefined, { numeric: true }))
}

/** Local YYYY-MM-DD, `daysAgo` days back. */
export function localIsoDaysAgo(daysAgo: number, from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() - daysAgo)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export interface PoEmailTemplate { subject: string; to: string; body: string }

export const PO_EMAIL_TOKENS: { token: string; label: string }[] = [
  { token: 'greeting', label: 'Good morning / afternoon (based on your local time)' },
  { token: 'shop_number', label: 'Shop number' },
  { token: 'shop_name', label: 'Shop name / city' },
  { token: 'area_manager', label: 'Area manager name' },
  { token: 'shop_email', label: 'Shop email' },
  { token: 'am_email', label: 'Area manager email' },
  { token: 'rd_email', label: 'Regional director email' },
  { token: 'po_table', label: 'Table of the POs (PO #, order date, expected delivery, products)' },
]

export const PO_EMAIL_DEFAULT: PoEmailTemplate = {
  subject: 'Shop {{shop_number}} - PO Delivery Check-In',
  to: '{{shop_email}}, {{am_email}}',
  body: `{{greeting}}

Our records show the following order(s) for shop {{shop_number}} were expected to be delivered by now, but we haven't seen them received:

{{po_table}}

Can you check whether the delivery has arrived? If it has, please make sure it's been received in Droptop so our records stay accurate. If it hasn't, let us know and we'll follow up with RelaDyne.

Thank you,`,
}

/** "PRODCODE x6, OTHER x2 (+3 more)" — a compact products cell for the email table. */
export function productsSummary(lines: RdOrderLedgerRow[], max = 6): string {
  const parts = lines.map((l) => `${l.product_code}${l.qty_ordered != null ? ` x${l.qty_ordered}` : ''}`)
  return parts.length > max ? `${parts.slice(0, max).join(', ')} (+${parts.length - max} more)` : parts.join(', ')
}
