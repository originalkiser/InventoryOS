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
 * Round a unit quantity for its UOM. Discrete UOMs must be whole; bulk may
 * carry decimals per settings. `dir` biases the rounding — we round down
 * when a cap is binding so a limit is never breached by rounding.
 */
export function roundQty(qty: number, uom: string | null, bulkDecimals: number, dir: 'nearest' | 'down' = 'nearest'): number {
  // Caps are Infinity when nothing limits a product, and a missing figure can
  // produce NaN. Either would serialise to null over the wire and blow up a
  // NOT NULL column, so they're pinned to 0 here rather than at each caller.
  if (!Number.isFinite(qty) || qty <= 0) return 0
  if (isBulkUom(uom)) {
    const f = Math.pow(10, Math.max(0, bulkDecimals))
    return dir === 'down' ? Math.floor(qty * f) / f : Math.round(qty * f) / f
  }
  return dir === 'down' ? Math.floor(qty) : Math.round(qty)
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

/** DOS at delivery: today's on-hand plus the order, less usage until delivery. */
export function dosAfterDelivery(
  onHand: number | null, dailyUsage: number | null, orderedGallons: number,
  orderDate: string, deliveryDate: string | null,
): number | null {
  const u = n(dailyUsage)
  if (u <= 0) return null
  const lead = deliveryDate ? Math.max(0, daysBetween(orderDate, deliveryDate)) : 0
  const atDelivery = n(onHand) - u * lead + orderedGallons
  return atDelivery / u
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
  }
}

/** Units needed to reach the DOS target, before caps. */
function unitsToTarget(input: GenerationInput, ctx: GenerationContext): number {
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
    // 'gallons_per_product' is expressed in gallons; convert to units.
    const floorUnits = min.type === 'gallons_per_product' ? floor / per : floor
    if (l.qty >= floorUnits) continue
    // Physical capacity still wins — never order more than the shop can hold.
    const hard = capsFor(inp, ctx, { respectDosMax: false })
    const target = Math.min(floorUnits, hard.maxUnits)
    const rounded = roundQty(target, l.uom, ctx.settings.bulk_rounding_decimals, 'down')
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
 * Vendor case-type minimum: "if the order includes bay boxes at all, it must
 * include at least 6 of them" — a floor on the order's TOTAL for that case
 * type, spread across whichever products are already on it. Deliberately not
 * applied when the order contains none of that case type.
 */
function applyCaseTypeMinimums(
  lines: GeneratedLine[], ctx: GenerationContext, inputs: Map<string, GenerationInput>,
): void {
  const mins = ctx.vendor.caseTypeMinimums ?? {}
  for (const [caseType, minQtyRaw] of Object.entries(mins)) {
    const minQty = n(minQtyRaw)
    if (minQty <= 0) continue
    const ofType = lines.filter((l) => (l.uom ?? '') === caseType && l.qty > 0)
    if (!ofType.length) continue                      // none ordered — rule doesn't apply
    let total = ofType.reduce((s, l) => s + n(l.qty), 0)
    if (total >= minQty) continue

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
  }
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
    const caps = capsFor(input, ctx)
    const belowTrigger = dos != null && dos < ctx.settings.days_of_supply_min_trigger

    if (!belowTrigger) {
      // Not due yet, but still a candidate for smoothing to reach a minimum.
      if (!eligibleSpare.has(groupKey)) eligibleSpare.set(groupKey, [])
      eligibleSpare.get(groupKey)!.push(input)
      skipped.push({ ...idOf(input), reason: dos == null ? 'no_usage_data' : 'above_min_trigger' })
      continue
    }

    const want = unitsToTarget(input, ctx)
    const units = roundQty(Math.min(want, caps.maxUnits), rule.uom, ctx.settings.bulk_rounding_decimals,
      // Round down when a hard cap binds so the cap is never exceeded.
      want > caps.maxUnits ? 'down' : 'nearest')

    if (units <= 0) {
      if (!eligibleSpare.has(groupKey)) eligibleSpare.set(groupKey, [])
      eligibleSpare.get(groupKey)!.push(input)
      skipped.push({ ...idOf(input), reason: 'no_room_or_zero_qty' })
      continue
    }
    pass1.push(buildLine(input, ctx, units, caps))
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

  for (const [key, lines] of byGroup) {
    const [location_id, order_type] = key.split('|') as [string, OrderType]
    const min: OrderMinimum = ctx.vendor.minimums[order_type] ?? {
      type: order_type === 'bulk' ? ctx.settings.bulk_minimum_type : ctx.settings.package_minimum_type,
      dollars: order_type === 'bulk' ? ctx.settings.order_minimum_dollars_bulk : ctx.settings.order_minimum_dollars_package,
      qty: order_type === 'bulk' ? ctx.settings.bulk_minimum_qty : ctx.settings.package_minimum_qty,
    }

    // A per-product minimum is a floor on each line, so it's handled up front
    // and doesn't involve the dollar-smoothing path at all.
    if (min.type !== 'dollars') {
      const met = applyPerProductMinimum(lines, min, ctx, inputByKey)
      applyCaseTypeMinimums(lines, ctx, inputByKey)
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
        soleRule.uom, ctx.settings.bulk_rounding_decimals, 'down',
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
        const step = isBulkUom(lines[i].uom) ? Math.pow(10, -Math.max(0, ctx.settings.bulk_rounding_decimals)) : 1
        const take = Math.min(step, headroom[i])
        if (take <= 0) { headroom[i] = 0; continue }
        lines[i].qty = roundQty(lines[i].qty + take, lines[i].uom, ctx.settings.bulk_rounding_decimals)
        lines[i].system_qty = lines[i].qty
        if (!lines[i].flags.includes('smoothing_topped_up')) lines[i].flags.push('smoothing_topped_up')
        headroom[i] -= take
        lines[i].dos_after = daysOfSupply(n(lines[i].on_hand) + lines[i].qty * gallonsPerUnit(inp.rule), lines[i].daily_usage)
        markOverDosMax(lines[i], ctx)
        dollars = groupDollars(lines, ruleOf)
      }

      // (b) still short — pull in other eligible products from the shop's config
      if (dollars < minimum) {
        // skip_order_if_dos_over applies HERE only: a well-stocked product is
        // never dragged onto an order purely to reach a dollar minimum. It
        // never stops a product that is genuinely due from being ordered.
        const spares = (eligibleSpare.get(key) ?? [])
          .filter((sp) => resolvedOrderType(sp.rule) === order_type)
          .filter((sp) => {
            const d = daysOfSupply(sp.on_hand, sp.daily_usage)
            return d == null || d <= ctx.settings.skip_order_if_dos_over
          })
        for (const sp of spares) {
          if (dollars >= minimum) break
          const caps = capsFor(sp, ctx, { respectDosMax: false })
          if (caps.maxUnits <= 0) continue
          const unitCost = n(sp.rule.unit_cost)
          // No unit cost means the line contributes $0, so it can never close
          // a dollar gap — adding it would just inflate the order for nothing.
          if (unitCost <= 0) continue
          const need = (minimum - dollars) / unitCost
          const units = roundQty(Math.min(Math.max(need, 1), caps.maxUnits), sp.rule.uom, ctx.settings.bulk_rounding_decimals)
          if (units <= 0) continue
          const line = buildLine(sp, ctx, units, caps)
          line.added_by_smoothing = true
          line.flags.push('added_for_smoothing')
          markOverDosMax(line, ctx)
          lines.push(line)
          dollars = groupDollars(lines, ruleOf)
        }
      }
    }

    // Case-type minimums apply to whatever the order ended up containing.
    applyCaseTypeMinimums(lines, ctx, inputByKey)
    dollars = groupDollars(lines, ruleOf)

    const meetsMinimum = dollars >= minimum
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
