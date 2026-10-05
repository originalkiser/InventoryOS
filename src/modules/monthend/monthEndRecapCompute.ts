// Fills the Month End Recap for a month straight from the app's own data (counts, manual "marked counted" entries and recount
// requests) — the same three sections the hand-built deck has:
//
//   Daily Month-End Count Compliance — one count cycle, Count Day (a Monday) through Day +7: shops submitted / complete /
//                                      % complete / not submitted / partial-recount products still outstanding, cumulative by day.
//   Compliance Trends MoM            — each shop's INITIAL outcome for the month: Complete / Recount / Partial Recount / Not Submitted.
//   Recount Compliance by Area       — share of each region's / area manager's shops that needed a recount (Recount + Partial).
//
// Definitions (chosen to reproduce how the deck's own numbers relate to each other: its Grand Total % for a month equals
// (Recount + Partial Recount) / total shops in that month's Trends column):
//   shops        = active corporate shops in the deck's five regions (that's the deck's "241 Shops"-style total)
//   submitted    = an allowable-type count (Counts → Results → Allowable Types) with a count date on/before that day, or a shop
//                  "marked counted" on Not Submitted that day
//   recount      = a recount request for the shop in the cycle: 'Partial Recount Products' = Partial, anything else = Recount
//   complete     = submitted and either never flagged, or flagged and its recount finished by that day
// Pure — no React or Supabase — so it's testable.

export interface RecapShop { id: string; region: string; director: string; areaManager: string }
export interface RecapCount { location_id: string | null; count_date: string; count_type: string | null; total_adjustments: number | null }
export interface RecapManual { location_id: string | null; created_at: string }
export interface RecapRecount {
  location_id: string | null
  recount_type: string | null
  requested_products: string[] | null
  request_date: string
  recount_status: string | null
  completed_flags: boolean[] | null
  completed_dates: string[] | null
  updated_at: string | null
}
export interface CellRow { table_key: string; row_label: string; row_sort: number; col_key: string; col_label: string; col_sort: number; value_num: number }

const dateOf = (s: string) => String(s).slice(0, 10)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const parse = (s: string) => new Date(`${s}T00:00:00`)
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const addDaysIso = (s: string, n: number) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d) }
const md = (s: string) => `${parse(s).getMonth() + 1}/${parse(s).getDate()}`
const dowOf = (s: string) => DOW[parse(s).getDay()]

/** The Monday on or before the date the most counts were taken — the count day of the cycle. */
export function cycleStartOf(countDates: string[]): string | null {
  if (!countDates.length) return null
  const tally = new Map<string, number>()
  for (const d of countDates) tally.set(dateOf(d), (tally.get(dateOf(d)) ?? 0) + 1)
  const mode = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
  const d = parse(mode)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // back to Monday
  return iso(d)
}

/** Treat "Oil Recount" and any other full recount alike; only 'Partial Recount Products' is partial. */
const isPartial = (t: string | null) => (t ?? '').trim().toLowerCase() === 'partial recount products'

function completionDate(r: RecapRecount): string | null {
  const flags = r.completed_flags ?? []
  const dates = (r.completed_dates ?? []).map(dateOf).sort()
  const done = (r.recount_status ?? '').toLowerCase() === 'complete' || (flags.length > 0 && flags.every(Boolean))
  if (!done) return null
  return dates.length ? dates[dates.length - 1] : r.updated_at ? dateOf(r.updated_at) : null
}

export interface RecapResult {
  cycleStart: string
  totalShops: number
  monthKey: string
  monthLabel: string
  daily: { shopsSubmitted: number[]; shopsComplete: number[]; notSubmitted: number[]; partialProducts: number[]; percentComplete: number[]; dates: string[] }
  trends: { complete: number; recount: number; partial: number; notSubmitted: number }
  areaPct: Map<string, number> // keyed by `region|areaManager`, `region`, and 'ALL'
  areaCounts: Map<string, { flagged: number; total: number }>
  daysTo100: number | null
}

export function computeRecap(args: {
  countMonth: string // YYYY-MM-01
  shops: RecapShop[]
  counts: RecapCount[] // already limited to allowable types for this month
  manual: RecapManual[]
  recounts: RecapRecount[]
}): RecapResult | null {
  const { shops } = args
  const ids = new Set(shops.map((s) => s.id))
  const submitted = new Map<string, string>() // shop -> first date counted
  const bump = (id: string | null, d: string) => { if (id && ids.has(id) && (!submitted.has(id) || d < submitted.get(id)!)) submitted.set(id, d) }
  for (const c of args.counts) bump(c.location_id, dateOf(c.count_date))
  for (const m of args.manual) bump(m.location_id, dateOf(m.created_at))
  const start = cycleStartOf([...submitted.values()])
  if (!start || shops.length === 0) return null

  const dates = Array.from({ length: 8 }, (_, i) => addDaysIso(start, i))
  const windowEnd = addDaysIso(start, 14)
  const windowStart = addDaysIso(start, -3)
  // The latest recount request per flagged shop decides its outcome; partial products are counted per request.
  const reqs = args.recounts.filter((r) => r.location_id && ids.has(r.location_id) && dateOf(r.request_date) >= windowStart && dateOf(r.request_date) <= windowEnd)
  const byShop = new Map<string, RecapRecount[]>()
  for (const r of reqs) { const a = byShop.get(r.location_id!); if (a) a.push(r); else byShop.set(r.location_id!, [r]) }
  const shopKind = new Map<string, 'recount' | 'partial'>()
  const shopDone = new Map<string, string | null>()
  for (const [id, rs] of byShop) {
    shopKind.set(id, rs.some((r) => !isPartial(r.recount_type)) ? 'recount' : 'partial')
    const cds = rs.map(completionDate)
    shopDone.set(id, cds.some((d) => d == null) ? null : (cds as string[]).sort().slice(-1)[0])
  }

  const shopsSubmitted: number[] = [], shopsComplete: number[] = [], notSubmitted: number[] = [], partialProducts: number[] = [], percentComplete: number[] = []
  for (const d of dates) {
    let sub = 0, comp = 0
    for (const s of shops) {
      const sd = submitted.get(s.id)
      if (!sd || sd > d) continue
      sub++
      if (!shopKind.has(s.id)) comp++
      else { const cd = shopDone.get(s.id); if (cd && cd <= d) comp++ }
    }
    let prods = 0
    for (const r of reqs) {
      if (!isPartial(r.recount_type) || dateOf(r.request_date) > d) continue
      const cd = completionDate(r)
      if (!cd || cd > d) prods += (r.requested_products ?? []).length
    }
    shopsSubmitted.push(sub); shopsComplete.push(comp); notSubmitted.push(shops.length - sub); partialProducts.push(prods)
    percentComplete.push(Math.round((comp / shops.length) * 1000) / 1000)
  }
  const firstFull = shopsComplete.findIndex((c) => c >= shops.length)
  const lastSub = shopsSubmitted.findIndex((c) => c >= shops.length)
  const daysTo100 = firstFull >= 0 ? firstFull : lastSub >= 0 ? lastSub : null

  // Initial outcome per shop.
  let complete = 0, recount = 0, partial = 0, notSub = 0
  for (const s of shops) {
    if (!submitted.has(s.id)) { notSub++; continue }
    const k = shopKind.get(s.id)
    if (k === 'recount') recount++; else if (k === 'partial') partial++; else complete++
  }

  // Recount rate (Recount + Partial) per region / AM / overall.
  const areaCounts = new Map<string, { flagged: number; total: number }>()
  const add = (key: string, flagged: boolean) => { const e = areaCounts.get(key) ?? { flagged: 0, total: 0 }; e.total++; if (flagged) e.flagged++; areaCounts.set(key, e) }
  for (const s of shops) {
    const f = shopKind.has(s.id)
    add('ALL', f); add(s.region, f); add(`${s.region}|${s.areaManager}`, f)
  }
  const areaPct = new Map<string, number>()
  for (const [k, v] of areaCounts) areaPct.set(k, v.total ? Math.round((v.flagged / v.total) * 1000) / 1000 : 0)

  const [y, m] = args.countMonth.split('-').map(Number)
  return {
    cycleStart: start, totalShops: shops.length,
    monthKey: `${y}-${String(m).padStart(2, '0')}`, monthLabel: `${MON[m - 1]}-${String(y).slice(2)}`,
    daily: { shopsSubmitted, shopsComplete, notSubmitted, partialProducts, percentComplete, dates },
    trends: { complete, recount, partial, notSubmitted: notSub },
    areaPct, areaCounts, daysTo100,
  }
}

// ── Turning a result into the recap's grid cells ──────────────────────────────────────────────────────────────────────

export const dailyTableKey = (monthKey: string) => `daily_compliance_${monthKey.replace('-', '')}`

export function dailyCells(r: RecapResult): CellRow[] {
  const tk = dailyTableKey(r.monthKey)
  const rows: [string, number, number[]][] = [
    ['Shops Submitted', 1, r.daily.shopsSubmitted], ['Shops Complete', 2, r.daily.shopsComplete], ['Percent Complete', 3, r.daily.percentComplete],
    ['Shops Not Submitted', 4, r.daily.notSubmitted], ['Partial Recount Products', 5, r.daily.partialProducts],
  ]
  const out: CellRow[] = []
  for (const [label, sort, vals] of rows) {
    vals.forEach((v, i) => {
      const d = r.daily.dates[i]
      out.push({ table_key: tk, row_label: label, row_sort: sort, col_key: `d${i}`, col_sort: i, value_num: v,
        col_label: i === 0 ? `Count Day (${dowOf(d)} ${md(d)})` : `Day +${i} (${dowOf(d)} ${md(d)})` })
    })
  }
  return out
}

export function trendsCells(r: RecapResult): CellRow[] {
  const [y, m] = r.monthKey.split('-').map(Number)
  const col = { col_key: r.monthKey, col_label: `${r.monthLabel} (${r.totalShops} Shops)`, col_sort: y * 100 + m }
  return [
    { table_key: 'trends', row_label: 'Complete', row_sort: 1, ...col, value_num: r.trends.complete },
    { table_key: 'trends', row_label: 'Recount', row_sort: 2, ...col, value_num: r.trends.recount },
    { table_key: 'trends', row_label: 'Partial Recount', row_sort: 3, ...col, value_num: r.trends.partial },
    { table_key: 'trends', row_label: 'Not Submitted', row_sort: 4, ...col, value_num: r.trends.notSubmitted },
  ]
}

const normName = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim()
function lev(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

/**
 * The area grid's rows are labelled like the deck ("Central - Ryan Bolden", indented "  Casey Penley", "Grand Total"). Match each
 * app region/AM to an existing row (spelling in the app can differ a letter or two from the deck's); an AM with no row gets a
 * new one under its region. Returns the cells plus the names that needed a new row so the user can see them.
 */
export function areaCells(r: RecapResult, existingRows: { label: string; sort: number }[]): { cells: CellRow[]; added: string[] } {
  const col = { col_key: r.monthKey, col_label: r.monthLabel, col_sort: Number(r.monthKey.replace('-', '')) }
  const cells: CellRow[] = []
  const added: string[] = []
  // The deck indents area-manager rows with leading spaces — non-breaking ones in the seeded data — so test for any whitespace.
  const indented = (x: { label: string }) => /^\s/.test(x.label)
  const regionRows = existingRows.filter((x) => !indented(x) && x.label !== 'Grand Total')
  const amRows = existingRows.filter(indented)
  const indent = amRows[0]?.label.match(/^\s+/)?.[0] ?? '\u00a0\u00a0'
  const put = (label: string, sort: number, pct: number) => cells.push({ table_key: 'area_compliance', row_label: label, row_sort: sort, ...col, value_num: pct })

  put('Grand Total', existingRows.find((x) => x.label === 'Grand Total')?.sort ?? 600, r.areaPct.get('ALL') ?? 0)
  const regions = new Set<string>()
  for (const k of r.areaCounts.keys()) if (k !== 'ALL' && !k.includes('|')) regions.add(k)
  for (const region of regions) {
    const row = regionRows.find((x) => normName(x.label.split(' - ')[0]) === normName(region))
    if (!row) continue // a region the deck doesn't track
    put(row.label, row.sort, r.areaPct.get(region) ?? 0)
    let extra = 0
    for (const key of [...r.areaCounts.keys()].filter((k) => k.startsWith(`${region}|`)).sort()) {
      const am = key.slice(region.length + 1)
      const n = normName(am)
      // Same-region rows first (exact name, then within two letters), then any row.
      const lo = row.sort, hi = row.sort + 99
      const pool = amRows.filter((x) => x.sort > lo && x.sort <= hi)
      const hit = pool.find((x) => normName(x.label) === n) ?? pool.find((x) => lev(normName(x.label), n) <= 2)
      if (hit) put(hit.label, hit.sort, r.areaPct.get(key) ?? 0)
      else {
        extra++
        const label = `${indent}${am}`
        const sort = row.sort + 50 + extra
        put(label, sort, r.areaPct.get(key) ?? 0)
        added.push(`${am} (${region})`)
      }
    }
  }
  return { cells, added }
}

export function dailyNotes(r: RecapResult): string[] {
  const d0 = r.daily.dates[0]
  const day = (s: string) => parse(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  const notes = [
    `${r.daily.shopsSubmitted[0]} of ${r.totalShops} active locations submitted a count on the day of the count (${day(d0)})`,
    `Of those, ${r.daily.shopsComplete[0]} were deemed "complete" based on adjustment activity and ending inventory balances.`,
  ]
  if (r.daysTo100 != null) {
    notes.push(r.daysTo100 === 0 ? 'Every shop completed on the day of the count'
      : `It took ${r.daysTo100} days to reach 100% compliance on completed shops (last shop completed on ${md(r.daily.dates[r.daysTo100])})`)
  } else {
    const last = r.daily.shopsComplete[7]
    notes.push(`By Day +7 (${md(r.daily.dates[7])}), ${last} of ${r.totalShops} shops (${Math.round((last / r.totalShops) * 100)}%) were complete`)
  }
  return notes
}
