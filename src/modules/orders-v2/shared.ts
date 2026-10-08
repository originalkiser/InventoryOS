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

/** Every other shop's rows on the Review / Final Review tables: a translucent wash of the brand navy — light on cream, lighter on the dark theme. */
export const SHOP_BAND_CLASS = 'bg-navy/[0.16] dark:bg-navy/[0.22]'

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
export const FLAG_META: Record<LineFlag, { label: string; tone: 'red' | 'orange' | 'sky' | 'purple'; title: string }> = {
  below_minimum: { label: 'Under min', tone: 'red', title: 'Shop is still under its order minimum after smoothing' },
  capacity_capped: { label: 'Over capacity', tone: 'orange', title: 'This quantity would put on-hand for this product past the shop\'s max capacity' },
  case_minimum_topup: { label: 'Case min', tone: 'sky', title: 'Raised to meet the vendor case-type order minimum' },
  repeat_ordering: { label: 'Repeat ordering', tone: 'red', title: 'A lot of supply has already been ordered for this product recently and it still reads low — on-hand may not be reflecting deliveries' },
  over_dos_max: { label: 'Over DOS max', tone: 'orange', title: 'Pushed past the soft days-of-supply ceiling to reach an order minimum' },
  drum_capped: { label: 'Drum capped', tone: 'orange', title: 'Drums are ordered 1 per product — more are needed to reach the DOS target (see the note)' },
  no_products_to_meet_min: { label: 'No products to add', tone: 'red', title: 'Still under the order minimum and there were no other products to add to meet it' },
  hm0806_solo_min: { label: 'HM0806 Solo Min', tone: 'purple', title: 'HM0806 was the only product due at this shop, so it was ordered at its 2-unit minimum and the order minimum was ignored' },
  recently_ordered: { label: 'Ordered recently', tone: 'sky', title: 'Ordered within the last 8 days and the on hand plus that order still covers usage — kept on the order at 0. Add a quantity if it should go on anyway.' },
  stocked_out: { label: 'Out of stock', tone: 'red', title: 'No on-hand recorded for this product' },
  critical_minimum: { label: 'Critical min', tone: 'orange', title: 'Ordered because on-hand dropped to/below this product\'s critical minimum (e.g. enough for one oil change), not the usual days-of-supply trigger' },
  alone_default_qty: { label: 'Alone qty', tone: 'sky', title: 'Only line on the order — used its configured alone quantity' },
  combined_on_hand: { label: 'Combined on hands', tone: 'sky', title: 'On Hand is the combined total of this product and its equivalent case types at this shop (hover the On Hand number for the math)' },
  inbound_order: { label: 'Order inbound', tone: 'sky', title: 'An earlier order for this product has not arrived yet — it is counted toward the on hand projected to delivery so this is not ordered twice' },
  drum_alone: { label: 'Drum alone', tone: 'purple', title: 'A drum ordered on its own — allowed without the bay-box minimum, so it is not under minimum' },
  vmi_keepfill: { label: 'VMI / Keep-fill', tone: 'sky', title: 'Vendor-managed inventory, tracked by tank monitor — excluded from this order\'s total by default since the vendor refills it directly' },
  keepfill_will_run_out: { label: 'Will run dry', tone: 'red', title: 'Tank on-hand and usage won\'t last until this shop\'s delivery after next — may need a vendor keep-fill order before then' },
  added_for_smoothing: { label: 'Added: smoothing', tone: 'sky', title: 'Pulled onto this order from the shop\'s other configured products to help it reach its order minimum' },
  smoothing_topped_up: { label: 'Qty increased: smoothing', tone: 'sky', title: 'Ordered amount raised above what usage alone called for, to help the shop reach its order minimum' },
  covered_by_open_po: { label: 'On open PO', tone: 'orange', title: 'Already has outstanding quantity on a still-open purchase order — decide whether to order anyway, exclude, or combine it into the on-hand calculation' },
  po_decision_override: { label: 'PO: order anyway', tone: 'sky', title: 'Decided to order the full suggested quantity regardless of the open PO' },
  po_decision_exclude: { label: 'PO: excluded', tone: 'sky', title: 'Decided the open PO already covers this — excluded from the order' },
  po_decision_combine: { label: 'PO: combined', tone: 'sky', title: 'Decided to factor the open PO\'s outstanding quantity into on-hand and re-target the order quantity' },
  rounded_to_bulk_minimum: { label: 'Rounded: bulk min', tone: 'sky', title: 'Raised to the bulk per-product minimum (a full drum) — see the note on this line for the real calculated amount' },
  exceeded_capacity_for_dos_target: { label: 'Over capacity: DOS target', tone: 'orange', title: 'Ordered past this product\'s configured capacity to reach the target days-of-supply — see the note on this line for the real numbers' },
}

export const FLAG_CLASS: Record<'red' | 'orange' | 'sky' | 'purple', string> = {
  red: 'bg-[#C0392B]/15 text-[#C0392B] border-[#C0392B]/40',
  orange: 'bg-[#E67E22]/15 text-[#E67E22] border-[#E67E22]/40',
  sky: 'bg-sky/25 text-navy border-sky/50',
  purple: 'bg-[#8E5BB5]/15 text-[#8E5BB5] border-[#8E5BB5]/40',
}

/** Per-user profile pref (Order Settings): show the ORIGINAL Review table instead of the new default one. */
export const OV2_USE_OLD_TABLE_KEY = 'ov2_review_use_old_table'

/** Per-user profile pref: how DOS Now / DOS After are conditionally formatted — 'badge' (shaded + underlined, default) or 'text' (colored text only). */
export const OV2_DOS_STYLE_KEY = 'ov2_review_dos_style'

/** Per-user pref: clicking a shop name on Review opens a popup ('popup') or expands the row inline ('dropdown'). */
export const OV2_SHOP_EXPAND_KEY = 'ov2_review_shop_expand_mode'
/** Per-user pref: 'hidden' shows only the combined on-hand total (math on hover); 'listed' writes each combined product out. */
export const OV2_COMBINED_MODE_KEY = 'ov2_review_combined_mode'

/**
 * Per-user prefs for the flag filter buttons above the Review table: which buttons to show, and "hide the DOS Now ones".
 * Defaults (set 2026-10-04, for every user who hasn't customized): the three row colors plus Repeat ordering, DOS After:
 * low, DOS After: below target and Ordered recently. A button not in the list stays hidden, so newly added flags start off.
 */
export const OV2_SHOWN_QUICK_KEY = 'ov2_review_shown_quick_buttons'
export const OV2_HIDE_DOS_NOW_BUTTONS_KEY = 'ov2_review_hide_dos_now_buttons'
export const DEFAULT_SHOWN_QUICK: string[] = [
  'tone:below_min', 'tone:over_capacity_target', 'tone:excluded',
  'tag:repeat_ordering', 'tag:dos_after_low', 'tag:dos_after_below_target', 'tag:recently_ordered',
]
export const DEFAULT_HIDE_DOS_NOW = true

/** Per-user pref: hide the small phone button (next to Order Settings) that switches Review to the mobile layout. */
export const OV2_HIDE_MOBILE_BUTTON_KEY = 'ov2_review_hide_mobile_button'

/** Amber treatment marking a user override, used everywhere edits are shown. */
export const OVERRIDE_CELL = 'border-l-2 border-[#E67E22] bg-[#E67E22]/10'

/**
 * Hover-only explanation for the DOS-color conditional formatting (direct
 * ask 2026-09-30: replace the always-visible legend paragraph with a
 * tooltip on the colored cells themselves) — a plain `title` attribute
 * rather than a custom popover, matching this app's existing convention for
 * this kind of one-line explanatory hover text.
 */
export const DOS_COLOR_LEGEND = 'Red = under target · Green = at target · Orange = over max'

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
  /** Days until delivery. When > 0 the shelf runs down by usage first (Valvoline: DOS After = days of supply once it lands). */
  leadDays = 0,
): number | null {
  const u = Number(line.daily_usage ?? 0)
  if (!(u > 0)) return null
  const per = Number(line.quarts_per_unit ?? 1)
  const onHand = leadDays > 0 ? Math.max(0, Number(line.on_hand ?? 0) - u * leadDays) : Number(line.on_hand ?? 0)
  return (onHand + qty * per) / u
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
