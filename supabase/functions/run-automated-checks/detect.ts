// Shop exceptions — the detection rules, pure (no Deno / Supabase imports) so they can be unit tested from src/. index.ts loads the data,
// calls these, and writes the result into inventory.shop_exceptions. The date helpers below are a trimmed copy of src/modules/orders-v2/engine.ts
// (resolveDeliveryDate and friends) — keep them in sync, same as the Droptop signing code is copied rather than shared.

export type ExceptionType = 'po_late' | 'zero_sales' | 'adj_positive' | 'adj_negative' | 'duplicate_case'
export const SEVERITY = { low: 1, medium: 2, high: 3 } as const
/** The default priority of each type (Settings can override it per type). */
export const BASE_SEVERITY: Record<ExceptionType, number> = { po_late: 2, zero_sales: 3, adj_positive: 2, adj_negative: 3, duplicate_case: 3 }

export interface ExceptionItem { key: string; [field: string]: unknown }
export interface Computed { severity: number; items: ExceptionItem[] }
export interface ExistingException {
  id: string; location_id: string; type: ExceptionType; status: string; severity: number
  first_seen: string; items: ExceptionItem[]; acked_keys: string[]
}

// ── dates ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export function addDays(iso: string, n: number): string { const d = new Date(`${iso}T00:00:00`); d.setDate(d.getDate() + n); return toIso(d) }
export function daysBetween(a: string, b: string): number {
  const t1 = new Date(`${a}T00:00:00`).getTime(), t2 = new Date(`${b}T00:00:00`).getTime()
  if (Number.isNaN(t1) || Number.isNaN(t2)) return 0
  return Math.round((t2 - t1) / 86400000)
}
export function businessDaysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`), b = new Date(`${to}T00:00:00`)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b <= a) return 0
  let count = 0
  const d = new Date(a)
  while (d < b) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) count++ }
  return count
}
export function addBusinessDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`)
  let left = Math.max(0, n)
  while (left > 0) { d.setDate(d.getDate() + 1); const wd = d.getDay(); if (wd !== 0 && wd !== 6) left-- }
  return toIso(d)
}
export function weekStartOf(date: string): string { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() - d.getDay()); return toIso(d) }
function isBiweeklyOnWeek(anchor: string, candidate: string): boolean {
  const weeks = Math.round(daysBetween(weekStartOf(anchor), weekStartOf(candidate)) / 7)
  return ((weeks % 2) + 2) % 2 === 0
}

export interface Schedule {
  type: 'weekly' | 'week_ab' | 'plus_business_days' | 'biweekly'
  delivery_dow: number | null; week_a_dow: number | null; week_b_dow: number | null
  biweekly_anchor_date: string | null; lead_business_days: number
}
export type WeekCalendar = Map<string, 'A' | 'B'>

/** When an order placed on `orderDate` arrives on this shop's schedule (null when it can't be worked out — never a guess). */
export function resolveDeliveryDate(orderDate: string, schedule: Schedule, calendar: WeekCalendar): string | null {
  const lead = Math.max(0, Number(schedule.lead_business_days) || 0)
  if (schedule.type === 'plus_business_days') return addBusinessDays(orderDate, lead > 0 ? lead : 5)
  const start = new Date(`${orderDate}T00:00:00`)
  if (Number.isNaN(start.getTime())) return null
  for (let i = 1; i <= 56; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i)
    const iso = toIso(d), dow = d.getDay()
    let wanted: number | null
    if (schedule.type === 'weekly') wanted = schedule.delivery_dow
    else if (schedule.type === 'biweekly') {
      wanted = schedule.delivery_dow
      if (wanted != null && dow === wanted && (!schedule.biweekly_anchor_date || !isBiweeklyOnWeek(schedule.biweekly_anchor_date, iso))) continue
    } else {
      const label = calendar.get(weekStartOf(iso))
      if (!label) continue
      wanted = label === 'A' ? schedule.week_a_dow : schedule.week_b_dow
    }
    if (wanted == null || dow !== wanted) continue
    if (businessDaysBetween(orderDate, iso) < lead) continue
    return iso
  }
  return null
}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
export function parseWeekday(value: string | null | undefined): number | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  const idx = DAY_NAMES.findIndex((d) => d === v || d.startsWith(v) || v.startsWith(d.slice(0, 3)))
  return idx === -1 ? null : idx
}
/** The next occurrence of a weekday strictly after the order date (RelaDyne's plain weekly delivery day). */
export function nextDeliveryDate(orderDate: string, dow: number | null): string | null {
  if (dow == null || dow < 0 || dow > 6) return null
  const d = new Date(`${orderDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  let delta = (dow - d.getDay() + 7) % 7
  if (delta === 0) delta = 7
  d.setDate(d.getDate() + delta)
  return toIso(d)
}
/** The order date embedded in one of our PO numbers: 14-08282026P (MMDDYYYY + B/P) or 18-20260827 (YYYYMMDD). */
export function poOrderDateFromName(custom: string | null | undefined): string | null {
  const s = (custom ?? '').trim()
  let m = /^\d+-(\d{2})(\d{2})(\d{4})[A-Za-z]*$/.exec(s)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= 31 && Number(m[3]) >= 2000 && Number(m[3]) <= 2100) return `${m[3]}-${m[1]}-${m[2]}`
  m = /^\d+-(\d{4})(\d{2})(\d{2})$/.exec(s)
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= 31 && Number(m[1]) >= 2000 && Number(m[1]) <= 2100) return `${m[1]}-${m[2]}-${m[3]}`
  return null
}

// ── products ────────────────────────────────────────────────────────────────────────────────────────────────────────
/** A trailing run of letters marks the case/package type (5W30D and 5W30BB both belong to family 5W30). */
export const baseProductId = (id: string): string => id.replace(/[A-Z]+$/i, '') || id
const lc = (s: string) => s.trim().toLowerCase()

export interface Exclusion { location_id: string | null; product_id: string | null; check_type: string }
export function isExcluded(ex: Exclusion[], checkType: string, locationId: string, productId: string): boolean {
  return ex.some((e) => e.check_type === checkType && (e.location_id === null || e.location_id === locationId) && (e.product_id === null || lc(e.product_id) === lc(productId)))
}

// ── 1. selling at zero on hand ──────────────────────────────────────────────────────────────────────────────────────
export interface ActivityRow { location_id: string; product_id: string; activity_date: string; sold_qty: number | null; adjusted_qty: number | null }

/**
 * A product whose on hand is zero (or below) and that has sold in the last few days. Days and quantity STACK on one item per product: they're
 * recounted from the ledger since the product was first flagged, so running twice in a day never double counts. It clears once on hand is
 * back above zero or it stops selling.
 */
export function detectZeroSales(input: {
  activity: ActivityRow[]            // recent days
  onHand: Map<string, number | null> // `${location_id}|${lowercased product}` -> current on hand
  prior: Map<string, ExceptionItem[]> // location_id -> items of its open zero_sales exception
  today: string
  recentDays?: number
  excluded?: (locationId: string, productId: string) => boolean
}): Map<string, ExceptionItem[]> {
  const recentFrom = addDays(input.today, -(input.recentDays ?? 3))
  const byKey = new Map<string, ActivityRow[]>()
  for (const r of input.activity) {
    if (!(Number(r.sold_qty) > 0)) continue
    const k = `${r.location_id}|${lc(r.product_id)}`
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }
  const out = new Map<string, ExceptionItem[]>()
  for (const [k, rows] of byKey) {
    const onHand = input.onHand.get(k)
    if (onHand == null || onHand > 0) continue
    const recent = rows.filter((r) => r.activity_date >= recentFrom)
    if (!recent.length) continue
    const loc = rows[0].location_id, product = rows[0].product_id
    if (input.excluded?.(loc, product)) continue
    const prior = (input.prior.get(loc) ?? []).find((i) => lc(String(i.product_id)) === lc(product))
    const first = (prior?.first as string | undefined) ?? recent.map((r) => r.activity_date).sort()[0]
    const since = rows.filter((r) => r.activity_date >= first)
    const days = new Set(since.map((r) => r.activity_date)).size
    const qty = since.reduce((s, r) => s + Number(r.sold_qty), 0)
    const last = since.map((r) => r.activity_date).sort().slice(-1)[0]
    if (!out.has(loc)) out.set(loc, [])
    out.get(loc)!.push({ key: lc(product), product_id: product, days, qty: Math.round(qty * 100) / 100, first, last, on_hand: onHand })
  }
  return out
}

// ── 2/3. large adjustments ──────────────────────────────────────────────────────────────────────────────────────────
/** One item per product per day whose adjustment is bigger than the threshold (events, so they accumulate on the one card). */
export function detectAdjustments(input: {
  activity: ActivityRow[]; threshold: number; thresholdNegative?: number; excluded?: (locationId: string, productId: string) => boolean
}): { positive: Map<string, ExceptionItem[]>; negative: Map<string, ExceptionItem[]> } {
  const positive = new Map<string, ExceptionItem[]>(), negative = new Map<string, ExceptionItem[]>()
  for (const r of input.activity) {
    const q = Number(r.adjusted_qty)
    if (!Number.isFinite(q) || Math.abs(q) <= (q < 0 ? input.thresholdNegative ?? input.threshold : input.threshold)) continue
    if (input.excluded?.(r.location_id, r.product_id)) continue
    const target = q > 0 ? positive : negative
    if (!target.has(r.location_id)) target.set(r.location_id, [])
    target.get(r.location_id)!.push({ key: `${lc(r.product_id)}|${r.activity_date}`, product_id: r.product_id, date: r.activity_date, qty: Math.round(q * 100) / 100 })
  }
  for (const m of [positive, negative]) for (const items of m.values()) items.sort((a, b) => String(b.date).localeCompare(String(a.date)))
  return { positive, negative }
}

// ── 4. duplicate case types on hand ─────────────────────────────────────────────────────────────────────────────────
/**
 * Two or more case types of the same product (5W30D + 5W30BB) holding stock at one shop. Only families the shop actually orders (configured)
 * are checked, and only when their quantities are within `tolerance` qts of each other (likely the same stock counted twice) - case types
 * further apart than that are probably real stock and are not flagged. A retired id is folded into its replacement first, same as everywhere else.
 */
export function detectDuplicates(input: {
  usage: { location_id: string; product_id: string; on_hands: number | null }[]
  configured: Map<string, Set<string>>        // location_id -> configured family keys (lowercased base ids, already mapped)
  mappings: Map<string, string>               // lowercased old product id -> new product id
  tolerance: number
  excluded?: (locationId: string, productId: string) => boolean
}): Map<string, { severity: number; items: ExceptionItem[] }> {
  const resolve = (id: string) => input.mappings.get(lc(id)) ?? id
  const stock = new Map<string, Map<string, { product_id: string; on_hand: number }>>() // `${loc}|${family}` -> product -> stock
  for (const u of input.usage) {
    const q = Number(u.on_hands)
    if (!Number.isFinite(q) || q <= 0) continue
    const product = resolve(u.product_id)
    const family = lc(baseProductId(product))
    if (!input.configured.get(u.location_id)?.has(family)) continue
    const key = `${u.location_id}|${family}`
    if (!stock.has(key)) stock.set(key, new Map())
    const fam = stock.get(key)!
    const cur = fam.get(lc(product))
    fam.set(lc(product), { product_id: product, on_hand: (cur?.on_hand ?? 0) + q })
  }
  const out = new Map<string, { severity: number; items: ExceptionItem[] }>()
  for (const [key, fam] of stock) {
    if (fam.size < 2) continue
    const [loc, family] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)]
    const members = [...fam.values()].sort((a, b) => b.on_hand - a.on_hand)
    if (members.some((m) => input.excluded?.(loc, m.product_id))) continue
    const diff = members[0].on_hand - members[members.length - 1].on_hand
    if (diff > input.tolerance) continue
    const severity = SEVERITY.high
    const entry = out.get(loc) ?? { severity: 0, items: [] }
    entry.items.push({
      key: family, family: baseProductId(members[0].product_id).toUpperCase(),
      members: members.map((m) => ({ product_id: m.product_id, on_hand: Math.round(m.on_hand * 100) / 100 })),
      diff: Math.round(diff * 100) / 100, severity,
    })
    entry.severity = Math.max(entry.severity, severity)
    out.set(loc, entry)
  }
  return out
}

// ── 5. POs that should have delivered ───────────────────────────────────────────────────────────────────────────────
export interface OpenPo {
  id: string; location_id: string | null; po_id: string; custom_po_id: string | null; supplier_name: string | null
  created_timestamp: string | null; to_receive_timestamp: string | null; vendor_id: string | null
}
/** A late PO that has aged out of the shop's triage and belongs on the "Late POs - not received" list instead. */
export interface MovedPo {
  po_row_id: string; location_id: string; po_id: string; custom_po_id: string | null; supplier_name: string | null
  created_timestamp: string | null; expected: string; days_late: number
}
/**
 * Open POs past their expected delivery by `graceDays` with no receipt activity on any line. `notBefore` ignores POs expected before that
 * date (nothing older is chased). A PO that is `moveAfterDaysLate` days late, or `moveAfterDaysCreated` days past its created date (0 = off),
 * is pushed to `moved` instead of the triage.
 */
export function detectLatePos(input: {
  notBefore?: string
  moveAfterDaysLate?: number
  moveAfterDaysCreated?: number
  moved?: MovedPo[]
  pos: OpenPo[]
  received: Set<string>                          // PO row ids with any received quantity
  schedules: Map<string, Schedule>               // `${location_id}|${vendor_id}`
  calendars: Map<string, WeekCalendar>           // vendor_id -> calendar
  weekdayByLocation: Map<string, number | null>  // RelaDyne's plain delivery weekday
  isReladyne: (supplier: string | null) => boolean
  today: string
  graceDays: number
}): Map<string, ExceptionItem[]> {
  const out = new Map<string, ExceptionItem[]>()
  for (const po of input.pos) {
    if (!po.location_id || input.received.has(po.id)) continue
    const createdIso = po.created_timestamp ? po.created_timestamp.slice(0, 10) : null
    const orderedOn = poOrderDateFromName(po.custom_po_id) ?? createdIso
    let expected: string | null = null
    if (po.to_receive_timestamp) expected = po.to_receive_timestamp.slice(0, 10)
    else if (orderedOn) {
      const sched = po.vendor_id ? input.schedules.get(`${po.location_id}|${po.vendor_id}`) : undefined
      if (sched) expected = resolveDeliveryDate(orderedOn, sched, input.calendars.get(po.vendor_id!) ?? new Map())
      else if (input.isReladyne(po.supplier_name)) expected = nextDeliveryDate(orderedOn, input.weekdayByLocation.get(po.location_id) ?? null)
    }
    if (!expected) continue // can't work out a delivery day — never guess
    const late = daysBetween(expected, input.today)
    if (input.notBefore && expected < input.notBefore) continue
    if (late < input.graceDays) continue
    const age = createdIso ? daysBetween(createdIso, input.today) : 0
    if ((input.moveAfterDaysLate && late >= input.moveAfterDaysLate) || (input.moveAfterDaysCreated && age >= input.moveAfterDaysCreated)) {
      input.moved?.push({ po_row_id: po.id, location_id: po.location_id, po_id: po.po_id, custom_po_id: po.custom_po_id, supplier_name: po.supplier_name, created_timestamp: po.created_timestamp, expected, days_late: late })
      continue
    }
    if (!out.has(po.location_id)) out.set(po.location_id, [])
    out.get(po.location_id)!.push({
      key: `${po.po_id}`, po: po.custom_po_id || po.po_id, po_row_id: po.id, supplier: po.supplier_name, ordered_on: orderedOn, expected, days_late: late,
    })
  }
  for (const items of out.values()) items.sort((a, b) => Number(b.days_late) - Number(a.days_late))
  return out
}

// ── combining into one exception per shop per type ──────────────────────────────────────────────────────────────────
export interface Ops {
  inserts: { location_id: string; type: ExceptionType; severity: number; items: ExceptionItem[]; first_seen: string; last_seen: string }[]
  updates: { id: string; patch: Record<string, unknown> }[]
}

/**
 * Merges what the detectors found with the open exceptions. A shop+type that already has an open exception gets its items and severity
 * refreshed (never a second row); one that has nothing left resolves. An exception a person has skipped / excused / logged reopens only if
 * it now holds an item they hadn't seen when they acted.
 */
export function reconcile(existing: ExistingException[], computed: Map<string, Computed>, today: string, nowIso: string): Ops {
  const ops: Ops = { inserts: [], updates: [] }
  const open = new Map(existing.map((e) => [`${e.location_id}|${e.type}`, e]))
  for (const [key, c] of computed) {
    if (!c.items.length) continue
    const [location_id, type] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1) as ExceptionType]
    const cur = open.get(key)
    if (!cur) { ops.inserts.push({ location_id, type, severity: c.severity, items: c.items, first_seen: today, last_seen: today }); continue }
    const acked = new Set(cur.acked_keys ?? [])
    const hasNew = c.items.some((i) => !acked.has(i.key))
    const reopen = cur.status !== 'pending' && hasNew
    ops.updates.push({
      id: cur.id,
      patch: { items: c.items, severity: c.severity, last_seen: today, updated_at: nowIso, ...(reopen ? { status: 'pending', status_changed_at: nowIso } : {}) },
    })
  }
  for (const cur of existing) {
    const c = computed.get(`${cur.location_id}|${cur.type}`)
    if (c && c.items.length) continue
    ops.updates.push({ id: cur.id, patch: { status: 'resolved', resolved_at: nowIso, last_seen: today, updated_at: nowIso } })
  }
  return ops
}
