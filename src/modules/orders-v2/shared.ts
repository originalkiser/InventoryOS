// Orders v2 — small presentation helpers shared across the module's pages.

import { format } from 'date-fns'
import type { DraftStatus, LineFlag } from './types'

export const STATUS_LABEL: Record<DraftStatus, string> = {
  generating: 'Generate',
  review: 'Review',
  final_review: 'Final Review',
  exported: 'Exported',
  cancelled: 'Cancelled',
}

/** Reopen a draft at the step it was left on. */
export function statusRoute(d: { id: string; status: DraftStatus }): string {
  switch (d.status) {
    case 'final_review': return `/orders-v2/draft/${d.id}/final`
    case 'exported': return `/orders-v2/draft/${d.id}/export`
    default: return `/orders-v2/draft/${d.id}`
  }
}

export const money = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

export const num = (v: number | null | undefined, dp = 2) =>
  v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: dp })

export const gallons = (v: number | null | undefined) =>
  v == null ? '—' : `${num(v, 0)} gal`

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Which weekday's shops an order/draft was built for, cached on its settings snapshot. */
export const orderDayLabel = (snapshot: Record<string, unknown> | null | undefined) => {
  const idx = (snapshot as any)?.__order_dow
  return typeof idx === 'number' && idx >= 0 && idx < DOW_SHORT.length ? DOW_SHORT[idx] : '—'
}

export const dos = (v: number | null | undefined) => (v == null ? '∞' : Number(v).toFixed(1))

export const dShort = (d: string | null | undefined) => {
  if (!d) return '—'
  try { return format(new Date(String(d).length <= 10 ? d + 'T00:00:00' : d), 'MMM d, yyyy') } catch { return String(d) }
}

export const dTime = (d: string | null | undefined) => {
  if (!d) return '—'
  try { return format(new Date(d), 'MMM d · h:mm a') } catch { return String(d) }
}

/** Short labels + tone for the flags the engine attaches to a line. */
export const FLAG_META: Record<LineFlag, { label: string; tone: 'red' | 'orange' | 'sky'; title: string }> = {
  below_minimum: { label: 'Under min', tone: 'red', title: 'Shop is still under its order minimum after smoothing' },
  capacity_capped: { label: 'At capacity', tone: 'orange', title: 'Quantity limited by the shop\'s max capacity for this product' },
  case_minimum_topup: { label: 'Case min', tone: 'sky', title: 'Raised to meet the vendor case-type order minimum' },
  repeat_ordering: { label: 'Repeat ordering', tone: 'red', title: 'A lot of supply has already been ordered for this product recently and it still reads low — on-hand may not be reflecting deliveries' },
  over_dos_max: { label: 'Over DOS max', tone: 'orange', title: 'Pushed past the soft days-of-supply ceiling to reach an order minimum' },
  stocked_out: { label: 'Out of stock', tone: 'red', title: 'No on-hand recorded for this product' },
  alone_default_qty: { label: 'Alone qty', tone: 'sky', title: 'Only line on the order — used its configured alone quantity' },
  vmi_keepfill: { label: 'VMI / Keep-fill', tone: 'sky', title: 'Vendor-managed inventory, tracked by tank monitor — excluded from this order\'s total by default since the vendor refills it directly' },
  keepfill_will_run_out: { label: 'Will run dry', tone: 'red', title: 'Tank on-hand and usage won\'t last until this shop\'s delivery after next — may need a vendor keep-fill order before then' },
  added_for_smoothing: { label: 'Added: smoothing', tone: 'sky', title: 'Pulled onto this order from the shop\'s other configured products to help it reach its order minimum' },
  smoothing_topped_up: { label: 'Qty increased: smoothing', tone: 'sky', title: 'Ordered amount raised above what usage alone called for, to help the shop reach its order minimum' },
  covered_by_open_po: { label: 'On open PO', tone: 'orange', title: 'Already has outstanding quantity on a still-open purchase order — decide whether to order anyway, exclude, or combine it into the on-hand calculation' },
  po_decision_override: { label: 'PO: order anyway', tone: 'sky', title: 'Decided to order the full suggested quantity regardless of the open PO' },
  po_decision_exclude: { label: 'PO: excluded', tone: 'sky', title: 'Decided the open PO already covers this — excluded from the order' },
  po_decision_combine: { label: 'PO: combined', tone: 'sky', title: 'Decided to factor the open PO\'s outstanding quantity into on-hand and re-target the order quantity' },
}

export const FLAG_CLASS: Record<'red' | 'orange' | 'sky', string> = {
  red: 'bg-[#C0392B]/15 text-[#C0392B] border-[#C0392B]/40',
  orange: 'bg-[#E67E22]/15 text-[#E67E22] border-[#E67E22]/40',
  sky: 'bg-sky/25 text-navy border-sky/50',
}

/** Amber treatment marking a user override, used everywhere edits are shown. */
export const OVERRIDE_CELL = 'border-l-2 border-[#E67E22] bg-[#E67E22]/10'

/**
 * DOS After for a manually-edited qty — same math as the engine's own
 * buildLine (on_hand + qty * quarts_per_unit, over daily_usage), so a hand
 * edit on Review or Final Review shows the same number generation would
 * have produced for that qty. DOS @ Delivery is NOT recomputed here — it's
 * defined as existing on-hand only (see engine.ts's dosAfterDelivery),
 * independent of the qty being ordered.
 */
export function dosAfterForQty(
  line: { on_hand: number | null; daily_usage: number | null; quarts_per_unit: number | null },
  qty: number,
): number | null {
  const u = Number(line.daily_usage ?? 0)
  if (!(u > 0)) return null
  const per = Number(line.quarts_per_unit ?? 1)
  return (Number(line.on_hand ?? 0) + qty * per) / u
}

/** One column of a copyable/exportable table — `get` reads the plain-text cell value. */
export interface TableCol<T> { label: string; get: (row: T) => string | number; align?: 'left' | 'right' }

/**
 * Copies a table to the clipboard as an HTML table (pastes as a real table
 * into Excel/Outlook/Sheets) with a tab-separated plain-text fallback for
 * anything that only accepts plain text — same approach as
 * LocationLookupPage.tsx's copyTanks/copyOnHand.
 */
export async function copyTableToClipboard<T>(title: string, cols: TableCol<T>[], rows: T[]): Promise<boolean> {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const align = (c: TableCol<T>) => c.align ?? 'left'
  const thStyle = (c: TableCol<T>) => `border:1px solid #002745;background:#B7E0DE;color:#002745;padding:4px 8px;text-align:${align(c)};font-weight:bold;`
  const head = `<tr>${cols.map((c) => `<td style="${thStyle(c)}"><font color="#002745">${esc(c.label)}</font></td>`).join('')}</tr>`
  const body = rows.map((r, i) => {
    const bg = i % 2 ? '#F2F1E6' : '#FFFFFF'
    return `<tr>${cols.map((c) => `<td style="border:1px solid #4F7489;padding:3px 8px;text-align:${align(c)};background:${bg};">${esc(String(c.get(r)))}</td>`).join('')}</tr>`
  }).join('')
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#002745;">`
    + `<div style="font-weight:bold;margin-bottom:4px;">${esc(title)}</div>`
    + `<table style="border-collapse:collapse;font-size:12px;"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
  const plain = [title, cols.map((c) => c.label).join('\t'), ...rows.map((r) => cols.map((c) => c.get(r)).join('\t'))].join('\n')
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })])
    } else {
      await navigator.clipboard.writeText(plain)
    }
    return true
  } catch { return false }
}

/** Downloads a table as a CSV file — quotes any cell containing a comma/quote/newline. */
export function exportTableCsv<T>(filename: string, cols: TableCol<T>[], rows: T[]): void {
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const csv = [cols.map((c) => cell(c.label)).join(','), ...rows.map((r) => cols.map((c) => cell(c.get(r))).join(','))].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
