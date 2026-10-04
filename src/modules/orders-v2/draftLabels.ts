import { draftAdHocLocationIds, draftOrderDow, isReladyne, isValvoline, type DraftRow } from './useOrdersV2'

export const DOW_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** What kind of order a draft is — see the Order Type column on the Orders tab. */
export function orderTypeLabel(d: DraftRow, vendor: string): string {
  if (typeof (d.settings_snapshot as any)?.__resend_for_date === 'string') return 'Re-send (missed items)'
  if (draftAdHocLocationIds(d)) return 'Ad hoc order'
  if (isReladyne(vendor)) return DOW_NAMES_FULL[draftOrderDow(d)]
  if (isValvoline(vendor)) return 'Weekly'
  return 'Regular'
}
