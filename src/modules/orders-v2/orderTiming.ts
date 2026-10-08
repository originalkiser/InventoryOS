// Order timing — "do we need to order for this shop today?" Pure (no React / Supabase).
//
// A shop on a Week A/B (or other non-weekly) delivery schedule only gets a truck on certain dates. An order placed today lands on the first
// scheduled delivery that clears the lead time. If the NEXT order (cadence days from now — a week for the Thursday-morning Valvoline run,
// 1 for a daily cadence) would still land on that same delivery, there's no reason to order today: the shop is held and ordered next time.
// A shop is ordered today only when waiting would push its delivery to a later date.
import { resolveDeliveryDate } from './engine'
import type { DeliverySchedule, WeekCalendar } from './types'

export interface HeldShop {
  location_id: string
  /** The delivery an order placed today (or next time — it's the same) would land on. */
  delivery: string
  /** The date of the next order opportunity that still reaches `delivery`. */
  next_order_date: string
}

export interface OrderTimingConfig { hold_until_needed: boolean; cadence_days: number }
export const DEFAULT_ORDER_TIMING: OrderTimingConfig = { hold_until_needed: false, cadence_days: 7 }

const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + n)
  return toIso(d)
}

/**
 * Which of these shops can wait until the next order. A shop is only ever held on positive evidence: it needs a schedule, and both the
 * delivery for an order today and the delivery for the next order must resolve (a calendar that doesn't reach next week means "can't tell",
 * so the shop is ordered). Shops with no schedule are never held.
 */
export function shopsToHold(input: {
  orderDate: string
  cadenceDays: number
  schedules: Map<string, DeliverySchedule>
  calendar: WeekCalendar
  locationIds: Iterable<string>
}): HeldShop[] {
  const cadence = Math.max(1, Math.round(input.cadenceDays) || 7)
  const nextOrder = addDaysIso(input.orderDate, cadence)
  const held: HeldShop[] = []
  for (const id of new Set(input.locationIds)) {
    const sched = input.schedules.get(id)
    if (!sched) continue
    const now = resolveDeliveryDate(input.orderDate, sched, input.calendar)
    const later = resolveDeliveryDate(nextOrder, sched, input.calendar)
    if (now && later && now === later) held.push({ location_id: id, delivery: now, next_order_date: nextOrder })
  }
  return held
}

/**
 * Applies a vendor's hold setting to the shops an order would otherwise cover. `eligible` null means "every shop with a configured
 * product" (no order-day restriction). Ad hoc orders are an explicit selection and are never held.
 */
export function applyOrderTiming(args: {
  config: { hold_until_needed?: boolean; cadence_days?: number } | undefined
  adHoc: boolean
  orderDate: string
  eligible: Set<string> | null
  inputLocationIds: Iterable<string>
  schedules: Map<string, DeliverySchedule>
  calendar: WeekCalendar
}): { eligible: Set<string> | null; held: HeldShop[] } {
  const { config } = args
  if (!config?.hold_until_needed || args.adHoc) return { eligible: args.eligible, held: [] }
  const base = args.eligible ?? new Set(args.inputLocationIds)
  const held = shopsToHold({ orderDate: args.orderDate, cadenceDays: config.cadence_days ?? DEFAULT_ORDER_TIMING.cadence_days, schedules: args.schedules, calendar: args.calendar, locationIds: base })
  if (!held.length) return { eligible: args.eligible, held: [] }
  const heldIds = new Set(held.map((h) => h.location_id))
  return { eligible: new Set([...base].filter((id) => !heldIds.has(id))), held }
}

/** The shops held when a draft was last generated (persisted on the draft's settings snapshot). */
export function draftHeldShops(draft: { settings_snapshot?: Record<string, unknown> | null }): HeldShop[] {
  const stored = (draft.settings_snapshot as any)?.__held_shops
  return Array.isArray(stored) ? (stored as HeldShop[]) : []
}
