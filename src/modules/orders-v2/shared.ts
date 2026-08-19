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
}

export const FLAG_CLASS: Record<'red' | 'orange' | 'sky', string> = {
  red: 'bg-[#C0392B]/15 text-[#C0392B] border-[#C0392B]/40',
  orange: 'bg-[#E67E22]/15 text-[#E67E22] border-[#E67E22]/40',
  sky: 'bg-sky/25 text-navy border-sky/50',
}

/** Amber treatment marking a user override, used everywhere edits are shown. */
export const OVERRIDE_CELL = 'border-l-2 border-[#E67E22] bg-[#E67E22]/10'
