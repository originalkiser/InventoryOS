// On-hand plausibility check (2026-09-22 request) — flags a line whose
// CURRENT on-hand doesn't line up with what it should be, given a known
// recent delivery and real sales since then.
//
// There's no historical on-hand SNAPSHOT to compare against (confirmed
// live: inventory.daily_product_activity.ending_on_hand is 0-populated
// across 444k+ rows in production — the only code path that ever stamps
// it never actually runs on a real schedule). Instead this tracks forward
// from a real number we DO already have: the on-hand value recorded on the
// order line itself at the moment that order was generated
// (ov2_order_history_lines.on_hand) — combined with real day-by-day
// sold_qty history (which IS populated correctly) and the delivered
// quantity from RelaDyne's own invoice:
//
//   expected_today = on_hand_when_ordered - sold_since_order_date + delivered_qty
//
// Flagged when the CURRENT on-hand falls outside expected ± (toleranceDays
// * dailyUsage) — matching the request's own example (usage 10/day, ±3
// days = ±30).

export interface OnHandCheckInput {
  currentOnHand: number
  onHandWhenOrdered: number
  soldSinceOrder: number
  deliveredQtyQuarts: number
  dailyUsage: number
  toleranceDays?: number
}

export interface OnHandCheckResult {
  expected: number
  low: number
  high: number
  withinRange: boolean
}

export const DEFAULT_TOLERANCE_DAYS = 3
// Only meaningful for a delivery that's actually recent — the older the
// delivery, the more the real-world noise (partial deliveries, manual
// adjustments, miscounts) compounds in sold_since_order_date, so a
// months-old delivery would produce a wide, meaningless band rather than a
// useful flag.
export const RECENT_DELIVERY_DAYS = 21

export function computeOnHandPlausibility(input: OnHandCheckInput): OnHandCheckResult | null {
  const { currentOnHand, onHandWhenOrdered, soldSinceOrder, deliveredQtyQuarts, dailyUsage, toleranceDays = DEFAULT_TOLERANCE_DAYS } = input
  if (dailyUsage <= 0) return null
  const expected = onHandWhenOrdered - soldSinceOrder + deliveredQtyQuarts
  const band = toleranceDays * dailyUsage
  const low = expected - band
  const high = expected + band
  return { expected, low, high, withinRange: currentOnHand >= low && currentOnHand <= high }
}

// A bulk product's delivered amount is only meaningful in real gallons
// (RelaDyne's own GallonsShipped column) — converted to quarts to match
// this app's internal on_hand/daily_usage unit. A package product's
// delivered amount is a case/unit count (QuantityShipped), converted via
// that specific historical order line's own quarts_per_unit (its case
// size) — using the CURRENT config's case size would be wrong if it's
// changed since that order.
export function deliveredQtyToQuarts(
  orderType: 'bulk' | 'package', qtyShipped: number | null, gallonsShipped: number | null, quartsPerUnit: number | null,
): number | null {
  if (orderType === 'bulk') return gallonsShipped != null ? gallonsShipped * 4 : null
  return qtyShipped != null && quartsPerUnit != null ? qtyShipped * quartsPerUnit : null
}

// Whether a delivery is recent enough for the check above to be
// meaningful — see RECENT_DELIVERY_DAYS' own comment.
export function isRecentDelivery(invoiceDate: string, today: string, days: number = RECENT_DELIVERY_DAYS): boolean {
  const d = new Date(invoiceDate + 'T00:00:00')
  const t = new Date(today + 'T00:00:00')
  if (Number.isNaN(d.getTime()) || Number.isNaN(t.getTime())) return false
  const diffDays = (t.getTime() - d.getTime()) / 86400000
  return diffDays >= 0 && diffDays <= days
}
