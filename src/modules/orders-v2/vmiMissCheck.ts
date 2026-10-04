// "Possible VMI misses": a shop whose VMI / keep-fill tank will run dry before the delivery after next, with no bulk order in
// the system around the time RelaDyne's distributor for that shop normally processes it. Pure — no React or Supabase.
//
// Each RelaDyne distributor (warehouse code on the open sales order report) is mapped to WHEN its VMI orders get processed:
//   order_day            — on the shop's order day (the delivery day minus three business days)
//   day_before_delivery  — the day before the shop's next delivery
// with some wiggle room (default 5 days) either side. A shop is a possible miss when the mapped day has arrived, a product
// will run out first, and there's no bulk order within the wiggle window.

export type TimingBasis = 'order_day' | 'day_before_delivery'
export interface DistributorTiming { basis: TimingBasis; wiggle_days: number }
export type TimingMap = Record<string, DistributorTiming>
export const DEFAULT_TIMING: DistributorTiming = { basis: 'order_day', wiggle_days: 5 }
export const BASIS_LABELS: Record<TimingBasis, string> = {
  order_day: "On the shop's order day",
  day_before_delivery: 'The day before delivery',
}

export interface VmiProduct { product_id: string; on_hand: number | null; daily_usage: number | null; runway_days: number | null }
export interface VmiShop {
  location_id: string
  warehouse_code: string | null
  products: VmiProduct[]
  next_delivery: string | null
  delivery_after_next: string | null
}
export interface BulkOrderFact { location_id: string; order_date: string }

export interface VmiMiss {
  location_id: string
  warehouse_code: string | null
  products: VmiProduct[]
  min_runway_days: number | null
  next_delivery: string
  delivery_after_next: string
  target_date: string
  window_start: string
  window_end: string
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (s: string) => new Date(`${s}T00:00:00`)
export const addDays = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) }
export const daysBetween = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 86400000)
/** Step back N business days (Mon–Fri). */
export function subtractBusinessDays(s: string, n: number): string {
  const d = parse(s)
  let left = n
  while (left > 0) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) left-- }
  return iso(d)
}

/** The day this shop's VMI order is normally processed for its next delivery. */
export function mappedDate(nextDelivery: string, t: DistributorTiming): string {
  return t.basis === 'day_before_delivery' ? addDays(nextDelivery, -1) : subtractBusinessDays(nextDelivery, 3)
}

export function checkVmiMisses(shops: VmiShop[], timing: TimingMap, bulkOrders: BulkOrderFact[], today: string): VmiMiss[] {
  const bulkByLoc = new Map<string, string[]>()
  for (const b of bulkOrders) { const a = bulkByLoc.get(b.location_id); if (a) a.push(b.order_date); else bulkByLoc.set(b.location_id, [b.order_date]) }
  const out: VmiMiss[] = []
  for (const s of shops) {
    if (!s.next_delivery || !s.delivery_after_next) continue
    const daysToNext2 = daysBetween(today, s.delivery_after_next)
    // Products that would be empty before the delivery after next (the earliest an order placed now could land).
    const running = s.products.filter((p) => p.runway_days != null && p.runway_days < daysToNext2)
    if (running.length === 0) continue
    const t = (s.warehouse_code && timing[s.warehouse_code]) || DEFAULT_TIMING
    const target = mappedDate(s.next_delivery, t)
    if (today < target) continue // the mapped processing day hasn't arrived yet
    const start = addDays(target, -t.wiggle_days)
    const end = addDays(target, t.wiggle_days)
    const upper = end < today ? end : today
    if ((bulkByLoc.get(s.location_id) ?? []).some((d) => d >= start && d <= upper)) continue
    out.push({
      location_id: s.location_id, warehouse_code: s.warehouse_code, products: running,
      min_runway_days: Math.min(...running.map((p) => p.runway_days as number)),
      next_delivery: s.next_delivery, delivery_after_next: s.delivery_after_next,
      target_date: target, window_start: start, window_end: end,
    })
  }
  return out.sort((a, b) => (a.min_runway_days ?? 0) - (b.min_runway_days ?? 0))
}

/** A bulk order, by RelaDyne's own PO convention: our PO numbers end in B for bulk, P for package. */
export const isBulkPoNumber = (po: string | null | undefined) => /B$/i.test((po ?? '').trim())
