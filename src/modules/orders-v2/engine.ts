// Orders v2 — order generation engine.
//
// Pure functions only: no React, no Supabase, no clock reads beyond what's
// passed in. Everything the engine needs arrives in GenerationContext, so
// the whole thing is directly testable and a draft can be regenerated
// identically from its stored snapshot.
//
// Unit convention: every volume figure in here (on_hand, daily_usage,
// units_per_uom_gallons, max_capacity_gallons) must arrive already
// expressed in the SAME unit — QUARTS, matching inventory.product_usage.
// The "gallons" in these names is historical; the engine itself never
// hardcodes a real-world gallon/quart conversion, it only requires
// internal consistency. See buildGenerationInputs in useOrdersV2.ts for
// where real gallon figures (vendor capacity, package sizes) get
// converted to quarts before reaching here.
//
// Shape of a run:
//   Pass 1  fill each eligible product toward the DOS target, bounded by
//           dos_max (soft) and max_capacity_gallons (hard).
//   Pass 2  if a shop/order-type group is under its minimum, top up existing
//           lines first (most efficient first), then pull in further eligible
//           products. A per-product minimum is a floor on each line instead.
//   Pass 3  vendor case-type minimums ("at least 6 bay boxes on the order").
//   Flags   informational only; they never block or alter quantities.

import {
  isBulkUom, orderTypeOf,
  type GeneratedLine, type GenerationContext, type GenerationInput,
  type DeliverySchedule, type GenerationResult, type LineFlag, type OrderMinimum,
  type OrderType, type ProductRule, type ShopGroupResult, type WeekCalendar,
} from './types'

// ── Small numeric helpers ────────────────────────────────────────────────

const n = (v: number | null | undefined): number => (v == null || Number.isNaN(v) ? 0 : Number(v))

/** Days of supply. Null when usage is unknown/zero — "infinite", not zero. */
export function daysOfSupply(onHand: number | null, dailyUsage: number | null): number | null {
  const u = n(dailyUsage)
  if (u <= 0) return null
  return n(onHand) / u
}

/** Quarts in one orderable unit; defaults to 1 so a missing size can't zero out an order. */
export const gallonsPerUnit = (rule: ProductRule): number => {
  const g = n(rule.units_per_uom_gallons)
  return g > 0 ? g : 1
}

/**
 * Package vs. bulk for this line. orderTypeOf only recognizes a uom that
 * literally says "bulk", which misses real bulk products configured under
 * a differently-worded uom — order_type_override (set on the UOM
 * Conversions row in useOrdersV2.ts) takes precedence when present.
 */
export const resolvedOrderType = (rule: ProductRule): OrderType => rule.order_type_override ?? orderTypeOf(rule.uom)

/**
 * Round a unit quantity for its UOM. Discrete UOMs must be whole; bulk rounds
 * to the nearest multiple of `bulkIncrement` gallons (1 = whole gallons; a
 * vendor that only ships in round figures — e.g. 5-gallon steps — sets this
 * higher so an order never lands on an arbitrary fractional gallon count).
 * `dir` biases the rounding — 'down' when a cap is binding so a limit is
 * never breached by rounding, 'up' when seeking a DOS target/minimum so a
 * coarse increment never leaves a product short of it, 'nearest' everywhere
 * else.
 */
export function roundQty(qty: number, uom: string | null, bulkIncrement: number, dir: 'nearest' | 'down' | 'up' = 'nearest'): number {
  // Caps are Infinity when nothing limits a product, and a missing figure can
  // produce NaN. Either would serialise to null over the wire and blow up a
  // NOT NULL column, so they're pinned to 0 here rather than at each caller.
  if (!Number.isFinite(qty) || qty <= 0) return 0
  if (isBulkUom(uom)) {
    const step = bulkIncrement > 0 ? bulkIncrement : 1
    if (dir === 'down') return Math.floor(qty / step) * step
    if (dir === 'up') return Math.ceil(qty / step) * step
    return Math.round(qty / step) * step
  }
  if (dir === 'down') return Math.floor(qty)
  if (dir === 'up') return Math.ceil(qty)
  return Math.round(qty)
}

/** Add n business days (Mon–Fri) to a YYYY-MM-DD date. */
export function addBusinessDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return date
  let left = Math.max(0, n)
  while (left > 0) {
    d.setDate(d.getDate() + 1)
    const wd = d.getDay()
    if (wd !== 0 && wd !== 6) left--
  }
  return toIso(d)
}

/** Business days between two dates, not counting the start date itself. */
export function businessDaysBetween(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00'), b = new Date(to + 'T00:00:00')
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0
  let count = 0
  const d = new Date(a)
  while (d < b) {
    d.setDate(d.getDate() + 1)
    const wd = d.getDay()
    if (wd !== 0 && wd !== 6) count++
  }
  return count
}

const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The Sunday that starts the week containing `date` — the calendar's key. */
export function weekStartOf(date: string): string {
  const d = new Date(date + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() - d.getDay())
  return toIso(d)
}

/**
 * Work out the delivery date for one shop's schedule.
 *
 *   weekly              next occurrence of the weekday with at least
 *                       `lead_business_days` of lead; too close rolls a week.
 *   week_ab             same, but the weekday depends on whether the
 *                       candidate week is labelled A or B in the uploaded
 *                       calendar. A week with no label is skipped rather
 *                       than guessed at.
 *   plus_business_days  simply order date + N business days.
 *
 * Returns null when the schedule can't produce a date (no weekday set, or no
 * calendar coverage) — callers show that as unknown rather than inventing one.
 */
export function resolveDeliveryDate(
  orderDate: string, schedule: DeliverySchedule | null | undefined, calendar?: WeekCalendar,
): string | null {
  if (!schedule) return null
  const lead = Math.max(0, n(schedule.lead_business_days))

  if (schedule.type === 'plus_business_days') {
    return addBusinessDays(orderDate, lead > 0 ? lead : 5)
  }

  const start = new Date(orderDate + 'T00:00:00')
  if (Number.isNaN(start.getTime())) return null

  // Walk forward day by day; take the first matching weekday that clears the
  // lead requirement. Capped at 8 weeks so a mis-set schedule can't spin.
  for (let i = 1; i <= 56; i++) {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const iso = toIso(d)
    const dow = d.getDay()

    let wanted: number | null
    if (schedule.type === 'weekly') {
      wanted = schedule.delivery_dow
    } else {
      const label = calendar?.get(weekStartOf(iso))
      if (!label) continue                       // unlabelled week — skip, don't guess
      wanted = label === 'A' ? schedule.week_a_dow : schedule.week_b_dow
    }
    if (wanted == null || dow !== wanted) continue
    if (businessDaysBetween(orderDate, iso) < lead) continue
    return iso
  }
  return null
}

/**
 * Delivery date = the next occurrence of `deliveryDow` strictly after the
 * order date. An order placed ON the delivery weekday rolls to next week —
 * you can't order and receive the same day. (RelaDyne path.)
 */
export function nextDeliveryDate(orderDate: string, deliveryDow: number | null | undefined): string | null {
  if (deliveryDow == null || deliveryDow < 0 || deliveryDow > 6) return null
  const d = new Date(orderDate + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  let delta = (deliveryDow - d.getDay() + 7) % 7
  if (delta === 0) delta = 7            // strictly after
  d.setDate(d.getDate() + delta)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
export function daysBetween(a: string, b: string): number {
  const t1 = new Date(a + 'T00:00:00').getTime(), t2 = new Date(b + 'T00:00:00').getTime()
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0
  return Math.round((t2 - t1) / 86400000)
}

/**
 * DOS @ Delivery: existing on-hand only, run down by usage over the lead
 * time — i.e. "will the shelf already be dry before the truck even gets
 * here," ignoring this order's own gallons entirely (they aren't on the
 * shelf until delivery day; DOS After already answers "if this arrived
 * instantly"). Floored at 0 rather than going negative — a shop that's
 * already stocked out with several days left before delivery reads as 0,
 * not a deficit.
 */
export function dosAfterDelivery(
  onHand: number | null, dailyUsage: number | null,
  orderDate: string, deliveryDate: string | null,
): number | null {
  const u = n(dailyUsage)
  if (u <= 0) return null
  const lead = deliveryDate ? Math.max(0, daysBetween(orderDate, deliveryDate)) : 0
  const remaining = Math.max(0, n(onHand) - u * lead)
  return remaining / u
}

// ── Caps ────────────────────────────────────────────────────────────────

interface Caps { maxUnits: number; capacityBound: boolean; dosBound: boolean }

/**
 * Largest unit quantity for a line.
 *
 * Two different kinds of ceiling, deliberately kept apart:
 *   - max_capacity_gallons is PHYSICAL — the shop can't hold more, so it is
 *     hard and is never exceeded, even to reach an order minimum.
 *   - days_of_supply_max is a SOFT target — pass 1 stops there, but smoothing
 *     may go past it when a minimum can't otherwise be met (`soft: false`).
 */
export function capsFor(input: GenerationInput, ctx: GenerationContext, opts?: { respectDosMax?: boolean }): Caps {
  const { rule, on_hand, daily_usage } = input
  const per = gallonsPerUnit(rule)
  const u = n(daily_usage)
  const respectDosMax = opts?.respectDosMax !== false

  let maxUnits = Number.POSITIVE_INFINITY
  let dosBound = false
  if (respectDosMax && u > 0) {
    const maxGallons = ctx.settings.days_of_supply_max * u
    maxUnits = Math.max(0, (maxGallons - n(on_hand)) / per)
    dosBound = true
  }

  let capacityBound = false
  if (rule.max_capacity_gallons != null && rule.max_capacity_gallons > 0) {
    const byCapacity = Math.max(0, (rule.max_capacity_gallons - n(on_hand)) / per)
    if (byCapacity < maxUnits) { maxUnits = byCapacity; capacityBound = true; dosBound = false }
  }

  return { maxUnits: Math.max(0, maxUnits), capacityBound, dosBound }
}

// ── Flags ───────────────────────────────────────────────────────────────

function historyFlags(input: GenerationInput, ctx: GenerationContext): LineFlag[] {
  const flags: LineFlag[] = []
  const { settings, orderDate, history } = ctx

  // Repeat-ordering check. Sum the days of supply sent across EVERY order in
  // the window — not the largest single order. If we've already pushed well
  // over a window's worth of supply and the product still reads low, the
  // on-hand figure probably isn't reflecting what was delivered.
  const inWindow = history.filter((h) =>
    h.location_id === input.location_id
    && h.product_id === input.product_id
    && daysBetween(h.order_date, orderDate) >= 0
    && daysBetween(h.order_date, orderDate) <= settings.flag_cumulative_days)

  const totalDosOrdered = inWindow.reduce((sum, h) => sum + n(h.dos_ordered), 0)
  if (totalDosOrdered > settings.flag_cumulative_dos_over) flags.push('repeat_ordering')

  return flags
}

// ── Pass 1 ──────────────────────────────────────────────────────────────

function buildLine(input: GenerationInput, ctx: GenerationContext, rawUnits: number, caps: Caps): GeneratedLine {
  const { rule } = input
  const per = gallonsPerUnit(rule)
  // Guard once, here, so no downstream field can carry Infinity/NaN.
  const units = Number.isFinite(rawUnits) ? Math.max(0, rawUnits) : 0
  const gallons = units * per
  const flags: LineFlag[] = [...historyFlags(input, ctx)]
  if (n(input.on_hand) <= 0) flags.push('stocked_out')
  if (units > 0 && caps.capacityBound) flags.push('capacity_capped')
  if (rule.vmi_keepfill_enabled) flags.push('vmi_keepfill')

  return {
    location_id: input.location_id,
    product_id: input.product_id,
    order_type: resolvedOrderType(rule),
    uom: rule.uom,
    system_qty: units,
    qty: units,
    unit_cost: rule.unit_cost,
    quarts_per_unit: per,
    on_hand: input.on_hand,
    daily_usage: input.daily_usage,
    dos_before: daysOfSupply(input.on_hand, input.daily_usage),
    dos_after: daysOfSupply(n(input.on_hand) + gallons, input.daily_usage),
    max_capacity_gallons: rule.max_capacity_gallons,
    // Vendor-managed inventory is refilled by RelaDyne, not submitted as a
    // line on this order — it's generated for visibility (and the runway
    // check) but starts excluded from the order total. A user can still
    // flip it to Included from Final Review if a one-off order is needed.
    included: rule.vmi_keepfill_enabled ? false : units > 0,
    flags,
    added_by_smoothing: false,
    triggered_smoothing: false,
    note: null,
  }
}

/** Units needed to reach the DOS target, before caps. */
export function unitsToTarget(input: GenerationInput, ctx: GenerationContext): number {
  const u = n(input.daily_usage)
  if (u <= 0) return 0
  const targetGallons = ctx.settings.days_of_supply_target * u
  const deficit = targetGallons - n(input.on_hand)
  if (deficit <= 0) return 0
  return deficit / gallonsPerUnit(input.rule)
}

// ── Pass 2 (smoothing) ──────────────────────────────────────────────────

const lineDollars = (l: GeneratedLine) => n(l.qty) * n(l.unit_cost)

/** Dollars counting toward a shop's minimum (respects include_in_total_shop_order). */
function groupDollars(lines: GeneratedLine[], ruleOf: (l: GeneratedLine) => ProductRule | undefined): number {
  return lines.reduce((sum, l) => {
    const rule = ruleOf(l)
    if (rule && !rule.include_in_total_shop_order) return sum
    return sum + lineDollars(l)
  }, 0)
}

// The engine's own internal unit convention is quarts throughout (see this
// file's header comment) — a 'gallons_per_product' minimum is entered on
// the Order Settings screen as REAL gallons, so it has to cross that
// boundary once here rather than being divided straight into a quarts-per-
// unit figure as if it were already in the same unit.
const QUARTS_PER_GALLON = 4

/**
 * A per-product minimum ("bulk must be >= 250 gallons of each product") is a
 * floor on every line, not on the order total — so it's satisfied line by
 * line, and a group either has every line at the floor or it doesn't.
 */
function applyPerProductMinimum(
  lines: GeneratedLine[], min: OrderMinimum, ctx: GenerationContext,
  inputs: Map<string, GenerationInput>,
): boolean {
  const floor = n(min.qty)
  if (floor <= 0) return true
  let allMet = true
  for (const l of lines) {
    const inp = inputs.get(`${l.location_id}|${l.product_id}`)
    if (!inp) continue
    const per = gallonsPerUnit(inp.rule)
    // 'gallons_per_product' is entered in REAL gallons; convert to quarts
    // (this module's internal unit) before dividing by the per-unit quarts
    // figure to get a unit count. Missing the *QUARTS_PER_GALLON step here
    // silently let a configured "55 gallons" floor act as "55 quarts"
    // instead — a real production order for ROT-T6-5W40 (4 quarts/unit)
    // landed at 13 units (52 quarts = 13 real gallons) against a configured
    // 55-gallon minimum: 55/4 (missing the gallons->quarts step) = 13.75,
    // floored to 13 — exactly the bug. Correct: (55*4)/4 = 55 units.
    const floorUnits = min.type === 'gallons_per_product' ? (floor * QUARTS_PER_GALLON) / per : floor
    if (l.qty >= floorUnits) continue
    // Physical capacity still wins — never order more than the shop can hold.
    // Rounding direction has to follow which one is actually binding: when
    // capacity has room, round UP so the floor itself is never rounded away
    // to just under it (e.g. a 55-gallon floor with a 4.5-gal/unit product —
    // floorUnits=12.2, rounding down landed at 12 units = 54 real gallons,
    // one gallon under the configured minimum); round DOWN only when
    // capacity is the binding constraint, so that cap is never exceeded.
    const hard = capsFor(inp, ctx, { respectDosMax: false })
    const capacityBinds = hard.maxUnits < floorUnits
    const target = capacityBinds ? hard.maxUnits : floorUnits
    const rounded = roundQty(target, l.uom, ctx.settings.bulk_rounding_increment, capacityBinds ? 'down' : 'up')
    if (rounded > l.qty) {
      l.qty = rounded
      l.system_qty = rounded
      l.dos_after = daysOfSupply(n(l.on_hand) + rounded * per, l.daily_usage)
      markOverDosMax(l, ctx)
    }
    if (l.qty + 1e-9 < floorUnits) allMet = false
  }
  return allMet
}

/**
 * Bulk-only variant of the per-product floor above (2026-09-16 request): a
 * vendor won't ship a partial drum, so a line whose own calculated demand
 * falls well short of the configured minimum (e.g. 55 real gallons) isn't
 * automatically worth rounding all the way up — that would force-order a
 * near-full drum for what might be a handful of gallons of real need. Below
 * `bulk_round_up_threshold_gal` of calculated demand, the line is dropped
 * entirely (reported in `skipped`, same surface as every other "not
 * ordered" reason) UNLESS the shop's current days of supply is already
 * under `bulk_urgent_dos_threshold` — meaning it's likely to run low again
 * before the next order cycle regardless of this shortfall, so the drum
 * goes out early anyway. At/above the threshold, the line still rounds up
 * to the full minimum, same as the generic floor, but records what the
 * real calculated amount was in `note` so the bump doesn't read as organic
 * demand growth later.
 *
 * Real gallons, not quarts: a correctly-configured bulk rule uses
 * units_per_uom_gallons: 4 (1 order unit = 1 real gallon = 4 quarts, this
 * module's internal unit — see applyPerProductMinimum's own comment on the
 * historical quarts/gallons bug), so `l.qty` for a bulk line already IS the
 * real gallon figure a human would recognize; no extra conversion here.
 */
function applyBulkPerProductMinimum(
  lines: GeneratedLine[], min: OrderMinimum, ctx: GenerationContext,
  inputs: Map<string, GenerationInput>, skipped: GenerationResult['skipped'],
): { lines: GeneratedLine[]; allMet: boolean } {
  const floor = n(min.qty)
  if (floor <= 0) return { lines, allMet: true }
  const roundUpThreshold = n(ctx.settings.bulk_round_up_threshold_gal)
  const urgentDos = n(ctx.settings.bulk_urgent_dos_threshold)
  let allMet = true
  const kept: GeneratedLine[] = []
  for (const l of lines) {
    const inp = inputs.get(`${l.location_id}|${l.product_id}`)
    if (!inp) { kept.push(l); continue }
    const per = gallonsPerUnit(inp.rule)
    const floorUnits = min.type === 'gallons_per_product' ? (floor * QUARTS_PER_GALLON) / per : floor
    if (l.qty >= floorUnits) { kept.push(l); continue }

    const calc = l.qty
    const urgent = l.dos_before != null && l.dos_before < urgentDos
    if (calc < roundUpThreshold && !urgent) {
      skipped.push({ location_id: l.location_id, product_id: l.product_id, reason: 'below_bulk_minimum' })
      continue
    }

    // Physical capacity still wins, same rounding-direction logic as the
    // generic floor.
    const hard = capsFor(inp, ctx, { respectDosMax: false })
    const capacityBinds = hard.maxUnits < floorUnits
    const target = capacityBinds ? hard.maxUnits : floorUnits
    const rounded = roundQty(target, l.uom, ctx.settings.bulk_rounding_increment, capacityBinds ? 'down' : 'up')
    if (rounded > l.qty) {
      const calcRounded = roundQty(calc, l.uom, ctx.settings.bulk_rounding_increment)
      l.note = `can order ${calcRounded}, rounding up to minimum`
      l.qty = rounded
      l.system_qty = rounded
      l.dos_after = daysOfSupply(n(l.on_hand) + rounded * per, l.daily_usage)
      markOverDosMax(l, ctx)
      if (!l.flags.includes('rounded_to_bulk_minimum')) l.flags.push('rounded_to_bulk_minimum')
    }
    if (l.qty + 1e-9 < floorUnits) allMet = false
    kept.push(l)
  }
  return { lines: kept, allMet }
}

/**
 * Vendor case-type minimum: "if the order includes bay boxes at all, it must
 * include at least 6 of them" — a floor on the order's TOTAL for that case
 * type, spread across whichever products are already on it. Deliberately not
 * applied when the order contains none of that case type.
 */
/**
 * Vendor case-type minimums ("at least 6 bay boxes on the order") — a floor
 * on the total units of one specific UOM across the order, regardless of
 * which product(s) make it up. Distinct from OrderMinimum's per-order/
 * per-product floors; a vendor can have both at once.
 *
 * Returns whether every configured case type with a positive floor actually
 * met it — the caller ORs this into the group's own below_minimum flag.
 * Found 2026-09-23 (a real Valvoline report landed under its configured
 * 6-bay-box floor with no flag at all): this used to (a) skip a case type
 * entirely whenever NO line of that UOM had already been ordered in Pass 1
 * — so a shop with zero bay-box products naturally due never even got a
 * chance to have one pulled in — and (b) return void, so even a genuine,
 * capacity-blocked shortfall on an already-ordered case type was silently
 * accepted as fine. Now pulls in eligible spare products of the case type
 * (same skip_order_if_dos_over guard, and the same "spread the shortfall
 * instead of loading up one product" principle) when topping up what's
 * already on the order isn't enough — and actually says so when it still
 * isn't.
 */
/**
 * Valvoline-only (VendorRules.spreadCaseTypeMinimum) — distributes a
 * case-type shortfall evenly across every configured product of that type
 * at the shop (round-robin: always top up whichever candidate currently
 * holds the FEWEST units), instead of the default behavior's "max out
 * whichever already-ordered line has the most headroom, then as a last
 * resort dump the whole remaining gap onto one spare" — which piles units
 * onto a single product rather than spreading across the shop's other 2.
 * Checks upfront whether the minimum is even reachable through every
 * configured product's own hard capacity combined; if not, makes NO
 * changes at all (the shop's natural DOS-computed quantities are left
 * exactly as generated) rather than forcing a partial, arbitrary-looking
 * bump that still falls short — the caller flags it below_minimum either way.
 */
function applySpreadCaseTypeMinimum(
  lines: GeneratedLine[], caseType: string, minQty: number, ctx: GenerationContext,
  inputs: Map<string, GenerationInput>, spares: GenerationInput[],
): boolean {
  interface Candidate { line: GeneratedLine | null; input: GenerationInput }
  const existing: Candidate[] = lines
    .filter((l) => (l.uom ?? '') === caseType)
    .map((l) => ({ line: l, input: inputs.get(`${l.location_id}|${l.product_id}`)! }))
    .filter((c) => !!c.input)
  const existingKeys = new Set(existing.map((c) => `${c.input.location_id}|${c.input.product_id}`))
  const spareCandidates: Candidate[] = spares
    .filter((sp) => (sp.rule.uom ?? '') === caseType && !existingKeys.has(`${sp.location_id}|${sp.product_id}`))
    .map((sp) => ({ line: null, input: sp }))
  const all = [...existing, ...spareCandidates]
  if (!all.length) return false

  const capOf = (c: Candidate) => capsFor(c.input, ctx, { respectDosMax: false }).maxUnits
  const currentOf = (c: Candidate) => n(c.line?.qty ?? 0)
  const totalNow = existing.reduce((s, c) => s + currentOf(c), 0)
  const totalMax = all.reduce((s, c) => s + Math.max(currentOf(c), capOf(c)), 0)
  if (totalMax + 1e-9 < minQty) return false // not reachable — leave everything untouched

  const qty = new Map<Candidate, number>(all.map((c) => [c, currentOf(c)]))
  let total = totalNow
  let guard = 0
  while (total + 1e-9 < minQty && guard++ < 10000) {
    let best: Candidate | null = null
    let bestQty = Infinity
    let bestHeadroom = 0
    for (const c of all) {
      const q = qty.get(c)!
      const headroom = capOf(c) - q
      if (headroom <= 1e-9) continue
      if (q < bestQty || (q === bestQty && headroom > bestHeadroom)) { best = c; bestQty = q; bestHeadroom = headroom }
    }
    if (!best) break
    qty.set(best, qty.get(best)! + 1)
    total += 1
  }

  for (const c of all) {
    const newQty = qty.get(c)!
    if (newQty === currentOf(c)) continue
    if (!c.line) {
      const caps = capsFor(c.input, ctx, { respectDosMax: false })
      const line = buildLine(c.input, ctx, newQty, caps)
      line.added_by_smoothing = true
      if (!line.flags.includes('added_for_smoothing')) line.flags.push('added_for_smoothing')
      if (!line.flags.includes('case_minimum_topup')) line.flags.push('case_minimum_topup')
      markOverDosMax(line, ctx)
      lines.push(line)
    } else {
      c.line.qty = newQty
      c.line.system_qty = newQty
      c.line.included = true
      c.line.dos_after = daysOfSupply(n(c.line.on_hand) + newQty * gallonsPerUnit(c.input.rule), c.line.daily_usage)
      if (!c.line.flags.includes('case_minimum_topup')) c.line.flags.push('case_minimum_topup')
      markOverDosMax(c.line, ctx)
    }
  }

  return total + 1e-9 >= minQty
}

function applyCaseTypeMinimums(
  lines: GeneratedLine[], ctx: GenerationContext, inputs: Map<string, GenerationInput>,
  spares: GenerationInput[],
): boolean {
  const mins = ctx.vendor.caseTypeMinimums ?? {}
  let allMet = true
  for (const [caseType, minQtyRaw] of Object.entries(mins)) {
    const minQty = n(minQtyRaw)
    if (minQty <= 0) continue
    let ofType = lines.filter((l) => (l.uom ?? '') === caseType && l.qty > 0)
    const sparesOfType = spares.filter((sp) => (sp.rule.uom ?? '') === caseType)
    // A shop with literally no eligible product of this case type (not
    // currently ordered AND none available to pull in) has no way to ever
    // satisfy this floor from this vendor — the rule doesn't apply, same as
    // before, rather than flagging every such shop below_minimum forever.
    if (!ofType.length && !sparesOfType.length) continue
    let total = ofType.reduce((s, l) => s + n(l.qty), 0)
    if (total >= minQty) continue

    if (ctx.vendor.spreadCaseTypeMinimum) {
      if (!applySpreadCaseTypeMinimum(lines, caseType, minQty, ctx, inputs, spares)) allMet = false
      continue
    }

    // Spread the shortfall over the lines with the most physical headroom, so
    // one product isn't loaded up while others sit at their configured target.
    let guard = 0
    while (total + 1e-9 < minQty && guard++ < 10000) {
      let best: GeneratedLine | null = null
      let bestHeadroom = 0
      for (const l of ofType) {
        const inp = inputs.get(`${l.location_id}|${l.product_id}`)
        if (!inp) continue
        const headroom = capsFor(inp, ctx, { respectDosMax: false }).maxUnits - l.qty
        if (headroom > bestHeadroom) { bestHeadroom = headroom; best = l }
      }
      if (!best || bestHeadroom < 1) break            // capacity blocks the rest
      const inp = inputs.get(`${best.location_id}|${best.product_id}`)!
      best.qty += 1
      best.system_qty = best.qty
      best.dos_after = daysOfSupply(n(best.on_hand) + best.qty * gallonsPerUnit(inp.rule), best.daily_usage)
      if (!best.flags.includes('case_minimum_topup')) best.flags.push('case_minimum_topup')
      markOverDosMax(best, ctx)
      total += 1
    }

    // Still short (including "nothing of this case type was ordered at
    // all") — pull in eligible spare products of the same case type.
    if (total + 1e-9 < minQty) {
      const eligible = sparesOfType.filter((sp) => {
        const d = daysOfSupply(sp.on_hand, sp.daily_usage)
        return d == null || d <= ctx.settings.skip_order_if_dos_over
      })
      for (const sp of eligible) {
        if (total + 1e-9 >= minQty) break
        const caps = capsFor(sp, ctx, { respectDosMax: false })
        if (caps.maxUnits <= 0) continue
        const need = minQty - total
        const units = roundQty(Math.min(Math.max(need, 1), caps.maxUnits), sp.rule.uom, ctx.settings.bulk_rounding_increment, 'up')
        if (units <= 0) continue
        const line = buildLine(sp, ctx, units, caps)
        line.added_by_smoothing = true
        if (!line.flags.includes('added_for_smoothing')) line.flags.push('added_for_smoothing')
        if (!line.flags.includes('case_minimum_topup')) line.flags.push('case_minimum_topup')
        markOverDosMax(line, ctx)
        lines.push(line)
        ofType = lines.filter((l) => (l.uom ?? '') === caseType && l.qty > 0)
        total = ofType.reduce((s, l) => s + n(l.qty), 0)
      }
    }
    if (total + 1e-9 < minQty) allMet = false
  }
  return allMet
}

/**
 * "units_per_order" minimum — a floor on the order's total unit/case count,
 * same shape as the dollar minimum's smoothing (top up existing lines, then
 * pull in eligible spares) but counted in units instead of dollars — for a
 * vendor whose real floor is "N cases," not a dollar figure or a per-line
 * gallon/unit floor (see applyPerProductMinimum for that instead).
 */
function applyOrderUnitMinimum(
  lines: GeneratedLine[], minimum: number, ctx: GenerationContext,
  inputs: Map<string, GenerationInput>, ruleOf: (l: GeneratedLine) => ProductRule | undefined,
  spares: GenerationInput[],
): { met: boolean; smoothingApplied: boolean } {
  const groupUnits = () => lines.reduce((sum, l) => {
    const rule = ruleOf(l)
    if (rule && !rule.include_in_total_shop_order) return sum
    return sum + n(l.qty)
  }, 0)
  let total = groupUnits()
  if (minimum <= 0 || total >= minimum) return { met: true, smoothingApplied: false }

  // Same "ordered alone, don't inflate" escape hatch as the dollar minimum.
  const soleLine = lines.length === 1 ? lines[0] : null
  const soleRule = soleLine ? ruleOf(soleLine) : undefined
  if (soleLine && soleRule?.can_ignore_minimum && soleRule.ignore_minimum_if_ordered_alone) {
    const inp = inputs.get(`${soleLine.location_id}|${soleLine.product_id}`)!
    const caps = capsFor(inp, ctx, { respectDosMax: false })
    const alone = roundQty(Math.min(n(soleRule.default_order_amount_if_alone), caps.maxUnits),
      soleRule.uom, ctx.settings.bulk_rounding_increment, 'down')
    if (alone > 0) {
      soleLine.system_qty = alone
      soleLine.qty = alone
      soleLine.dos_after = daysOfSupply(n(soleLine.on_hand) + alone * gallonsPerUnit(soleRule), soleLine.daily_usage)
      if (!soleLine.flags.includes('alone_default_qty')) soleLine.flags.push('alone_default_qty')
    }
    return { met: true, smoothingApplied: false }
  }

  for (const l of lines) l.triggered_smoothing = true

  // (a) top up existing lines, preferring whichever adds the least excess
  // DOS per unit — no dollar cost involved here, so "most efficient" just
  // means "least overstocking," unlike bestTopUpIndex's dollars-per-DOS score.
  const headroom = lines.map((l) => {
    const inp = inputs.get(`${l.location_id}|${l.product_id}`)
    if (!inp) return 0
    return Math.max(0, capsFor(inp, ctx, { respectDosMax: false }).maxUnits - l.qty)
  })
  let guard = 0
  while (total < minimum && guard++ < 10000) {
    let best = -1, bestDosPerUnit = Infinity
    for (let i = 0; i < lines.length; i++) {
      if (headroom[i] <= 0) continue
      const inp = inputs.get(`${lines[i].location_id}|${lines[i].product_id}`)
      if (!inp) continue
      const per = gallonsPerUnit(inp.rule)
      const u = n(lines[i].daily_usage)
      const dosPerUnit = u > 0 ? per / u : Infinity   // no usage data — least preferred, not free
      if (dosPerUnit < bestDosPerUnit) { bestDosPerUnit = dosPerUnit; best = i }
    }
    if (best < 0) break
    const inp = inputs.get(`${lines[best].location_id}|${lines[best].product_id}`)!
    const step = isBulkUom(lines[best].uom) ? Math.max(ctx.settings.bulk_rounding_increment, 0.0001) : 1
    const take = Math.min(step, headroom[best])
    if (take <= 0) { headroom[best] = 0; continue }
    lines[best].qty = roundQty(lines[best].qty + take, lines[best].uom, ctx.settings.bulk_rounding_increment)
    lines[best].system_qty = lines[best].qty
    if (!lines[best].flags.includes('smoothing_topped_up')) lines[best].flags.push('smoothing_topped_up')
    headroom[best] -= take
    lines[best].dos_after = daysOfSupply(n(lines[best].on_hand) + lines[best].qty * gallonsPerUnit(inp.rule), lines[best].daily_usage)
    markOverDosMax(lines[best], ctx)
    total = groupUnits()
  }

  // (b) still short — pull in other eligible products from the shop's config.
  if (total < minimum) {
    const eligible = spares.filter((sp) => {
      const d = daysOfSupply(sp.on_hand, sp.daily_usage)
      return d == null || d <= ctx.settings.skip_order_if_dos_over
    })
    for (const sp of eligible) {
      if (total >= minimum) break
      const caps = capsFor(sp, ctx, { respectDosMax: false })
      if (caps.maxUnits <= 0) continue
      const need = minimum - total
      const units = roundQty(Math.min(Math.max(need, 1), caps.maxUnits), sp.rule.uom, ctx.settings.bulk_rounding_increment, 'up')
      if (units <= 0) continue
      const line = buildLine(sp, ctx, units, caps)
      line.added_by_smoothing = true
      line.flags.push('added_for_smoothing')
      markOverDosMax(line, ctx)
      lines.push(line)
      total = groupUnits()
    }
  }

  return { met: total >= minimum, smoothingApplied: true }
}

/** Note when a line has been pushed past the soft DOS ceiling. */
function markOverDosMax(l: GeneratedLine, ctx: GenerationContext): void {
  if (l.dos_after != null && l.dos_after > ctx.settings.days_of_supply_max
      && !l.flags.includes('over_dos_max')) {
    l.flags.push('over_dos_max')
  }
}

/**
 * "Most efficient" top-up: of the lines that can still take more, prefer the
 * one whose next unit adds the most dollars per unit of excess DOS — i.e.
 * closes the gap with the least overstock, rather than dumping everything
 * into whichever product happens to be first.
 */
function bestTopUpIndex(
  lines: GeneratedLine[], headroom: number[], inputs: Map<string, GenerationInput>,
): number {
  let best = -1, bestScore = -Infinity
  for (let i = 0; i < lines.length; i++) {
    if (headroom[i] <= 0) continue
    const l = lines[i]
    const inp = inputs.get(`${l.location_id}|${l.product_id}`)
    if (!inp) continue
    const per = gallonsPerUnit(inp.rule)
    const u = n(l.daily_usage)
    const dollarsPerUnit = n(l.unit_cost)
    if (dollarsPerUnit <= 0) continue
    // Excess DOS added per unit; guard against zero-usage lines.
    const dosPerUnit = u > 0 ? per / u : 0.0001
    const score = dollarsPerUnit / Math.max(dosPerUnit, 0.0001)
    if (score > bestScore) { bestScore = score; best = i }
  }
  return best
}

// ── Entry point ─────────────────────────────────────────────────────────

export function generateOrder(inputs: GenerationInput[], ctx: GenerationContext): GenerationResult {
  const skipped: GenerationResult['skipped'] = []
  const inputByKey = new Map<string, GenerationInput>()
  for (const i of inputs) inputByKey.set(`${i.location_id}|${i.product_id}`, i)

  // ---- eligibility + Pass 1 ------------------------------------------------
  const pass1: GeneratedLine[] = []
  const eligibleSpare = new Map<string, GenerationInput[]>()   // group key -> products not ordered in pass 1

  for (const input of inputs) {
    const { rule } = input
    const groupKey = `${input.location_id}|${resolvedOrderType(rule)}`

    if (ctx.eligibleLocationIds && !ctx.eligibleLocationIds.has(input.location_id)) {
      skipped.push({ ...idOf(input), reason: 'not_order_day' }); continue
    }
    if (rule.vmi_keepfill_enabled && !ctx.includeVmi) {
      skipped.push({ ...idOf(input), reason: 'vmi_keepfill' }); continue
    }
    // Keep-fill on-hand comes from the tank monitor, not Droptop (see
    // buildGenerationInputs) — a genuinely unmatched/unread tank reports
    // on_hand as null, not 0. Treating that as "empty" here would fabricate
    // a false stocked-out read and generate a bogus catch-up order, so it's
    // surfaced as its own needs-review skip instead (never silently
    // included, per the keep-fill rule in CLAUDE.md).
    if (rule.vmi_keepfill_enabled && ctx.includeVmi && input.on_hand == null) {
      skipped.push({ ...idOf(input), reason: 'vmi_no_tank_data' }); continue
    }

    const dos = daysOfSupply(input.on_hand, input.daily_usage)
    let caps = capsFor(input, ctx)
    const belowDosTrigger = dos != null && dos < ctx.settings.days_of_supply_min_trigger
    // Even when usage is so low the DOS math above would never trigger an
    // order (a slow-moving product can carry a huge DOS on very little
    // on-hand), dropping to/below this product's critical minimum — set
    // per product on Global Products, e.g. "enough for one oil change:
    // 12qt diesel, 8qt Euro, 5qt others" — should still trigger ordering.
    // Sized by the normal usage/DOS math below like anything else; this
    // only affects whether the product is eligible at all and, if the
    // usual sizing would still land at 0, ensures at least 1 unit.
    const belowCriticalFloor = rule.min_on_hand_qty != null && rule.min_on_hand_qty > 0
      && n(input.on_hand) <= rule.min_on_hand_qty
    const belowTrigger = belowDosTrigger || belowCriticalFloor

    if (!belowTrigger) {
      // Not due yet, but still a candidate for smoothing to reach a minimum.
      if (!eligibleSpare.has(groupKey)) eligibleSpare.set(groupKey, [])
      eligibleSpare.get(groupKey)!.push(input)
      skipped.push({ ...idOf(input), reason: dos == null ? 'no_usage_data' : 'above_min_trigger' })
      continue
    }

    let want = unitsToTarget(input, ctx)
    if (belowCriticalFloor && want <= 0) {
      want = 1
      // The soft DOS-max cap would otherwise collapse to 0 headroom here —
      // a product with very low/near-zero usage can have its on-hand
      // already "exceed" whatever a tiny usage rate would justify under
      // days_of_supply_max, which is exactly backwards for a floor whose
      // whole point is overriding usage-based sizing. Recompute with only
      // the HARD physical-capacity cap, same as every other minimum-driven
      // quantity in this file (applyPerProductMinimum, bestTopUpIndex).
      caps = capsFor(input, ctx, { respectDosMax: false })
    }

    // Direct ask (2026-09-24): reaching the configured target days-of-supply
    // matters more than staying within a shop's configured physical
    // capacity — when capacity is genuinely what's holding this line short
    // of the target (not the softer days_of_supply_max ceiling, which is
    // untouched here), order the full amount needed to reach the target
    // anyway instead of clamping to capacity. Never silent: flagged (with a
    // note carrying the real numbers) so the amount ordered can be verified
    // on Review/Final Review, per this app's "make exceptions visible" rule.
    // Gated behind an off-by-default OrderSettings toggle (see that field's
    // own comment in types.ts) rather than always-on — capacity being the
    // one truly hard ceiling is otherwise relied on and tested throughout
    // this file's own Pass 2 (minimums/smoothing).
    let exceedsCapacityForTarget = false
    if (ctx.settings.allow_exceed_capacity_for_dos_target && caps.capacityBound && want > caps.maxUnits) {
      exceedsCapacityForTarget = true
      caps = { ...caps, maxUnits: want, capacityBound: false }
    }

    const units = roundQty(Math.min(want, caps.maxUnits), rule.uom, ctx.settings.bulk_rounding_increment,
      // Round down when a hard cap binds so the cap is never exceeded;
      // otherwise round UP toward the target rather than to nearest — a
      // coarse package size (e.g. a 12-quart case against 0.68 qt/day of
      // usage) would otherwise round down to whichever whole unit happens
      // to be numerically closest to the fractional ideal, chronically
      // leaving a slow-moving product under its DOS target rather than at
      // or slightly past it.
      want > caps.maxUnits ? 'down' : 'up')

    if (units <= 0) {
      // Physical capacity still wins — a product already at/over its hard
      // cap can't be forced to order even when it's under its critical
      // floor (shouldn't happen together in practice, but caps.maxUnits is
      // never overridden here regardless).
      if (!eligibleSpare.has(groupKey)) eligibleSpare.set(groupKey, [])
      eligibleSpare.get(groupKey)!.push(input)
      skipped.push({ ...idOf(input), reason: 'no_room_or_zero_qty' })
      continue
    }
    const line = buildLine(input, ctx, units, caps)
    if (belowCriticalFloor && !line.flags.includes('critical_minimum')) line.flags.push('critical_minimum')
    if (exceedsCapacityForTarget) {
      const per = gallonsPerUnit(rule)
      const finalQuarts = n(input.on_hand) + units * per
      const overBy = rule.max_capacity_gallons != null ? Math.max(0, finalQuarts - rule.max_capacity_gallons) : null
      if (!line.flags.includes('exceeded_capacity_for_dos_target')) line.flags.push('exceeded_capacity_for_dos_target')
      line.note = `Ordered ${units} to reach the ${ctx.settings.days_of_supply_target}-day target`
        + (overBy != null ? ` — exceeds configured capacity by ${Math.round(overBy)} qt` : ' — exceeds configured capacity')
    }
    pass1.push(line)
  }

  // Valvoline-only (VendorRules.alwaysListConfiguredProducts) — a shop that
  // ordered nothing this run (or ordered only 1-2 of its 3 configured
  // products) would otherwise have no visibility at all into its other
  // products' status. Every configured-but-not-due product gets a qty:0
  // line here (same buildLine() every genuinely-due product goes through,
  // so it inherits the exact same included:false/dimmed-row treatment this
  // app already gives VMI keep-fill lines — visible in Review, excluded
  // from the order total, and a user can still bump the qty and Include it
  // manually). Deliberately unconditional on whether anything else at that
  // shop is due — "not_order_day"-skipped locations never reach
  // eligibleSpare at all, so this can't resurrect a location genuinely
  // excluded for a different reason.
  if (ctx.vendor.alwaysListConfiguredProducts) {
    const pass1Keys = new Set(pass1.map((l) => `${l.location_id}|${l.product_id}`))
    for (const spareList of eligibleSpare.values()) {
      for (const sp of spareList) {
        const key = `${sp.location_id}|${sp.product_id}`
        if (pass1Keys.has(key)) continue
        pass1Keys.add(key)
        pass1.push(buildLine(sp, ctx, 0, capsFor(sp, ctx, { respectDosMax: false })))
      }
    }
  }

  // ---- group + Pass 2 ------------------------------------------------------
  const byGroup = new Map<string, GeneratedLine[]>()
  for (const l of pass1) {
    const k = `${l.location_id}|${l.order_type}`
    if (!byGroup.has(k)) byGroup.set(k, [])
    byGroup.get(k)!.push(l)
  }

  const ruleOf = (l: GeneratedLine) => inputByKey.get(`${l.location_id}|${l.product_id}`)?.rule
  const groups: ShopGroupResult[] = []

  for (const [key, groupLines] of byGroup) {
    let lines = groupLines
    const [location_id, order_type] = key.split('|') as [string, OrderType]
    const min: OrderMinimum = ctx.vendor.minimums[order_type] ?? {
      type: order_type === 'bulk' ? ctx.settings.bulk_minimum_type : ctx.settings.package_minimum_type,
      dollars: order_type === 'bulk' ? ctx.settings.order_minimum_dollars_bulk : ctx.settings.order_minimum_dollars_package,
      qty: order_type === 'bulk' ? ctx.settings.bulk_minimum_qty : ctx.settings.package_minimum_qty,
    }
    // Shared across every branch below — case-type minimums (and the
    // units_per_order/dollar "pull in spares" steps) all draw from the same
    // pool of this shop's other configured-but-not-yet-due products.
    const spares = (eligibleSpare.get(key) ?? []).filter((sp) => resolvedOrderType(sp.rule) === order_type)

    // "units_per_order" is a floor on the whole group's total unit/case
    // count — same shape as the dollar minimum (smooth to close the gap),
    // just counted in units. applyOrderUnitMinimum already implements this
    // correctly (found 2026-09-23: it existed, fully built and tested-in-
    // spirit, but was never actually wired in here — every non-dollar
    // minimum type, including this one, was silently falling through to
    // applyPerProductMinimum below instead, which enforces a floor on EACH
    // LINE rather than the order's total).
    if (min.type === 'units_per_order') {
      const result = applyOrderUnitMinimum(lines, n(min.qty), ctx, inputByKey, ruleOf, spares)
      const caseTypesMet = applyCaseTypeMinimums(lines, ctx, inputByKey, spares)
      const met = result.met && caseTypesMet
      if (!met) for (const l of lines) if (!l.flags.includes('below_minimum')) l.flags.push('below_minimum')
      groups.push({
        location_id, order_type, lines, dollars: groupDollars(lines, ruleOf),
        minimum: n(min.qty), meetsMinimum: met, smoothingApplied: result.smoothingApplied,
      })
      continue
    }

    // A per-product minimum is a floor on each line, so it's handled up front
    // and doesn't involve the dollar-smoothing path at all.
    if (min.type !== 'dollars') {
      // Bulk gets its own, more nuanced version of the floor (see
      // applyBulkPerProductMinimum) — package per-product floors keep the
      // original always-round-up behavior unchanged.
      let met: boolean
      if (order_type === 'bulk') {
        const result = applyBulkPerProductMinimum(lines, min, ctx, inputByKey, skipped)
        lines = result.lines
        met = result.allMet
      } else {
        met = applyPerProductMinimum(lines, min, ctx, inputByKey)
      }
      const caseTypesMet = applyCaseTypeMinimums(lines, ctx, inputByKey, spares)
      met = met && caseTypesMet
      if (!met) for (const l of lines) if (!l.flags.includes('below_minimum')) l.flags.push('below_minimum')
      groups.push({
        location_id, order_type, lines, dollars: groupDollars(lines, ruleOf),
        minimum: n(min.qty), meetsMinimum: met, smoothingApplied: false,
      })
      continue
    }

    const minimum = n(min.dollars)
    let dollars = groupDollars(lines, ruleOf)
    let smoothingApplied = false

    // A single line flagged to ignore the minimum when ordered alone uses its
    // configured alone-quantity instead of being inflated to hit the minimum.
    const soleLine = lines.length === 1 ? lines[0] : null
    const soleRule = soleLine ? ruleOf(soleLine) : undefined
    if (soleLine && soleRule?.can_ignore_minimum && soleRule.ignore_minimum_if_ordered_alone && dollars < minimum) {
      const inp = inputByKey.get(`${soleLine.location_id}|${soleLine.product_id}`)!
      const caps = capsFor(inp, ctx, { respectDosMax: false })
      const alone = roundQty(
        Math.min(n(soleRule.default_order_amount_if_alone), caps.maxUnits),
        soleRule.uom, ctx.settings.bulk_rounding_increment, 'down',
      )
      if (alone > 0) {
        soleLine.system_qty = alone
        soleLine.qty = alone
        soleLine.dos_after = daysOfSupply(n(soleLine.on_hand) + alone * gallonsPerUnit(soleRule), soleLine.daily_usage)
        if (!soleLine.flags.includes('alone_default_qty')) soleLine.flags.push('alone_default_qty')
      }
      groups.push({
        location_id, order_type, lines, dollars: groupDollars(lines, ruleOf),
        minimum, meetsMinimum: true, smoothingApplied: false,
      })
      continue
    }

    if (dollars < minimum) {
      smoothingApplied = true
      // Everything already on the order caused the shortfall — mark them so
      // the review UI can show which products pulled the order under.
      for (const l of lines) l.triggered_smoothing = true

      // (a) top up existing lines, most efficient first
      // dos_max is a soft target: smoothing may exceed it (flagged), but
      // physical capacity is still hard.
      const headroom = lines.map((l) => {
        const inp = inputByKey.get(`${l.location_id}|${l.product_id}`)
        if (!inp) return 0
        return Math.max(0, capsFor(inp, ctx, { respectDosMax: false }).maxUnits - l.qty)
      })
      let guard = 0
      while (dollars < minimum && guard++ < 10000) {
        const i = bestTopUpIndex(lines, headroom, inputByKey)
        if (i < 0) break
        const inp = inputByKey.get(`${lines[i].location_id}|${lines[i].product_id}`)!
        const step = isBulkUom(lines[i].uom) ? Math.max(ctx.settings.bulk_rounding_increment, 0.0001) : 1
        const take = Math.min(step, headroom[i])
        if (take <= 0) { headroom[i] = 0; continue }
        lines[i].qty = roundQty(lines[i].qty + take, lines[i].uom, ctx.settings.bulk_rounding_increment)
        lines[i].system_qty = lines[i].qty
        // Real bug found live 2026-09-24, Valvoline: a topped-up line could
        // still be sitting at its original included:false (a Valvoline
        // alwaysListConfiguredProducts placeholder starts qty:0/included:
        // false, same as VMI keep-fill) — this loop bumped qty without ever
        // touching included, so the row stayed dimmed despite showing a
        // real, nonzero suggested quantity. Never mattered before this
        // vendor flag existed, since every OTHER vendor's lines here already
        // start qty>0/included:true (see pass1's own `units <= 0` guard) —
        // this is simply the same "included = qty > 0" convention used
        // everywhere else in this app (patchQty, applySpreadCaseTypeMinimum),
        // applied here too, and is a no-op for any line already included.
        lines[i].included = lines[i].qty > 0
        if (!lines[i].flags.includes('smoothing_topped_up')) lines[i].flags.push('smoothing_topped_up')
        headroom[i] -= take
        lines[i].dos_after = daysOfSupply(n(lines[i].on_hand) + lines[i].qty * gallonsPerUnit(inp.rule), lines[i].daily_usage)
        markOverDosMax(lines[i], ctx)
        dollars = groupDollars(lines, ruleOf)
      }

      // (b) still short — pull in other eligible products from the shop's config
      if (dollars < minimum) {
        // Real bug found live 2026-09-24, Valvoline: `spares` is this shop's
        // eligibleSpare list, built once up front and never pruned — it
        // still lists a product even after alwaysListConfiguredProducts (or
        // part (a) above, which can top up a placeholder that started life
        // as one of these very spares) has already given it a real line.
        // This loop had no check for that, unlike applySpreadCaseTypeMinimum
        // below (which correctly excludes via its own existingKeys), so it
        // could — and did — push a SECOND, brand-new line for a product that
        // already had one (confirmed live: duplicate rows for the same shop
        // + product, one `smoothing_topped_up` from part (a) above, one
        // `added_for_smoothing` from this loop). Never possible before
        // alwaysListConfiguredProducts existed, since for every other
        // vendor a "spare" (not due) and an "existing line" were always
        // mutually exclusive sets. existingKeys is updated as lines are
        // pushed below so this loop can't duplicate against itself either.
        const existingKeys = new Set(lines.map((l) => `${l.location_id}|${l.product_id}`))
        // skip_order_if_dos_over applies HERE only: a well-stocked product is
        // never dragged onto an order purely to reach a dollar minimum. It
        // never stops a product that is genuinely due from being ordered.
        const dollarSpares = spares.filter((sp) => {
          if (existingKeys.has(`${sp.location_id}|${sp.product_id}`)) return false
          const d = daysOfSupply(sp.on_hand, sp.daily_usage)
          return d == null || d <= ctx.settings.skip_order_if_dos_over
        })
        for (const sp of dollarSpares) {
          if (dollars >= minimum) break
          const caps = capsFor(sp, ctx, { respectDosMax: false })
          if (caps.maxUnits <= 0) continue
          const unitCost = n(sp.rule.unit_cost)
          // No unit cost means the line contributes $0, so it can never close
          // a dollar gap — adding it would just inflate the order for nothing.
          if (unitCost <= 0) continue
          const need = (minimum - dollars) / unitCost
          const units = roundQty(Math.min(Math.max(need, 1), caps.maxUnits), sp.rule.uom, ctx.settings.bulk_rounding_increment)
          if (units <= 0) continue
          const line = buildLine(sp, ctx, units, caps)
          line.added_by_smoothing = true
          line.flags.push('added_for_smoothing')
          markOverDosMax(line, ctx)
          existingKeys.add(`${sp.location_id}|${sp.product_id}`)
          lines.push(line)
          dollars = groupDollars(lines, ruleOf)
        }
      }
    }

    // Case-type minimums apply to whatever the order ended up containing.
    const caseTypesMet = applyCaseTypeMinimums(lines, ctx, inputByKey, spares)
    dollars = groupDollars(lines, ruleOf)

    const meetsMinimum = dollars >= minimum && caseTypesMet
    if (!meetsMinimum) for (const l of lines) if (!l.flags.includes('below_minimum')) l.flags.push('below_minimum')

    groups.push({ location_id, order_type, lines, dollars, minimum, meetsMinimum, smoothingApplied })
  }

  return { lines: groups.flatMap((g) => g.lines), groups, skipped }
}

function idOf(i: GenerationInput) { return { location_id: i.location_id, product_id: i.product_id } }

// ── Composite template rendering (export / PO numbers) ──────────────────

/**
 * Render `{field}`, `{date:FORMAT}`, `{today:FORMAT}` and zero-padded
 * `{field:00000}` placeholders. Used for PO numbers, file names, sheet
 * names, export columns and email subjects so they all share one syntax.
 *   {shop_number}-{date:MMDDYYYY}{order_type_code}     -> 1-08192026B
 *   {today:MMDDYYYY}                                   -> today's date, not the order date
 *   {date+4:MMDDYYYY}                                  -> order date, 4 calendar days later
 *   S{shop_number:00000}                                -> S00013
 */
export function renderTemplate(tpl: string, values: Record<string, string | number | null | undefined>, date?: string): string {
  return (tpl ?? '').replace(/\{([a-z_]+)([+-]\d+)?(?::([^}]+))?\}/gi, (_m, key: string, offset: string | undefined, fmt: string | undefined) => {
    const k = key.toLowerCase()
    if (k === 'today') return formatDateToken(addCalendarDays(toIso(new Date()), offset ? Number(offset) : 0), fmt ?? 'MMDDYYYY')
    if (k === 'date') {
      const base = date ?? (values.date as string)
      return formatDateToken(offset ? addCalendarDays(base, Number(offset)) : base, fmt ?? 'MMDDYYYY')
    }
    const v = values[key]
    if (v == null) return ''
    // Zero-pad, e.g. {shop_number:00000} -> "00013" — any other fmt on a
    // non-date field is left as a no-op rather than an error.
    if (fmt && /^0+$/.test(fmt)) return String(v).padStart(fmt.length, '0')
    return String(v)
  })
}

function addCalendarDays(date: string | undefined, days: number): string | undefined {
  if (!date) return date
  const d = new Date(String(date) + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return date
  d.setDate(d.getDate() + days)
  return toIso(d)
}

function formatDateToken(date: string | undefined, fmt: string): string {
  if (!date) return ''
  const d = new Date(String(date) + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return ''
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const DD = String(d.getDate()).padStart(2, '0')
  const YYYY = String(d.getFullYear())
  const YY = YYYY.slice(-2)
  return fmt.replace(/YYYY/g, YYYY).replace(/YY/g, YY).replace(/MM/g, MM).replace(/DD/g, DD)
}

/** PO number: {shop}-{MMDDYYYY}{B|P}, one per shop per order type per run. */
export function poNumber(shopNumber: string, orderDate: string, orderType: OrderType): string {
  return `${shopNumber}-${formatDateToken(orderDate, 'MMDDYYYY')}${orderType === 'bulk' ? 'B' : 'P'}`
}
