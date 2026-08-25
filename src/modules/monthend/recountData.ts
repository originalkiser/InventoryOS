// Shared period-evaluation helpers for the recount sub-modules.
// Fetch is separated from evaluation so the Recount Logic preview can re-run
// draft (unsaved) rules on every keystroke without refetching.

import { supabase } from '@/lib/supabase'
import { computeMedian, evaluateRecountFlags } from '@/lib/recountEngine'
import type { Location, MonthlyCount, MonthlyEndingBalance, RecountConfig } from '@/types'
import { format, subMonths } from 'date-fns'

// Generous trailing window so changing the lookback N never needs a refetch.
const HISTORY_WINDOW_MONTHS = 24

export interface PeriodEvalData {
  locations: Location[]
  counts: MonthlyCount[] // count_type = 'Monthly' only — see eligibleLocationIds
  histByLoc: Map<string, number[]> // location_id -> ending balances, most recent first
  // Shops eligible for recount checks this period: submitted a Monthly count,
  // or were manually marked counted (Not Submitted panel's "Mark Counted",
  // which writes inventory.manual_count_entries rather than a real count
  // row). A shop on neither list is still outstanding on Not Submitted and
  // has nothing to evaluate — every recount check (initial rules, tank
  // variance, product-range) is gated to this set so an unsubmitted shop
  // can't get flagged from data that happens to exist without a count
  // behind it (e.g. a Product Detail upload with no matching Count Summary).
  eligibleLocationIds: Set<string>
}

export async function fetchPeriodEvalData(
  companyId: string,
  countMonth: string
): Promise<PeriodEvalData> {
  const sb = supabase as any
  const lowerBound = format(subMonths(new Date(countMonth), HISTORY_WINDOW_MONTHS), 'yyyy-MM-dd')

  const [locRes, countRes, balRes, manualRes] = await Promise.all([
    sb.schema('core').from('locations').select('*').eq('company_id', companyId).order('name'),
    sb.schema('inventory').from('counts').select('*').eq('company_id', companyId).eq('count_month', countMonth),
    sb.schema('inventory').from('monthly_ending_balances').select('*').eq('company_id', companyId)
      .gte('month', lowerBound).lt('month', countMonth).order('month', { ascending: false }),
    sb.schema('inventory').from('manual_count_entries').select('location_id').eq('company_id', companyId).eq('count_period', countMonth),
  ])

  const histByLoc = new Map<string, number[]>()
  for (const b of (balRes.data ?? []) as MonthlyEndingBalance[]) {
    if (!b.location_id) continue
    const arr = histByLoc.get(b.location_id) ?? []
    arr.push(Number(b.ending_balance))
    histByLoc.set(b.location_id, arr)
  }

  const allCounts = (countRes.data ?? []) as MonthlyCount[]
  const monthlyCounts = allCounts.filter((c) => (c.count_type ?? '').trim().toLowerCase() === 'monthly')

  const eligibleLocationIds = new Set<string>()
  for (const c of monthlyCounts) if (c.location_id) eligibleLocationIds.add(c.location_id)
  for (const r of (manualRes.data ?? []) as { location_id: string | null }[]) if (r.location_id) eligibleLocationIds.add(r.location_id)

  return {
    locations: (locRes.data ?? []) as Location[],
    counts: monthlyCounts,
    histByLoc,
    eligibleLocationIds,
  }
}

export interface EvaluatedCount {
  // null for a synthetic entry — an eligible shop flagged only by tank
  // monitor variance, with no Monthly count row of its own to evaluate the
  // dollar-based rules against (RecountLogicTab adds these on top of this
  // function's output so tank variance can flag independently).
  count: MonthlyCount | null
  locationId: string | null
  prev: number | null
  median: number
  varVsLastMonth: number
  varVsMedian: number
  flags: string[]
}

/** Pure evaluation of counts against a (possibly unsaved) config. Dedupes to the latest count per location. */
export function evaluateCounts(
  counts: MonthlyCount[],
  histByLoc: Map<string, number[]>,
  config: RecountConfig | null,
  lookbackN: number
): EvaluatedCount[] {
  const byLoc = new Map<string, MonthlyCount>()
  for (const c of counts) {
    const key = c.location_id ?? `__null_${c.id}`
    const existing = byLoc.get(key)
    if (!existing || new Date(c.count_date) > new Date(existing.count_date)) byLoc.set(key, c)
  }

  return Array.from(byLoc.values()).map((count) => {
    const hist = count.location_id ? histByLoc.get(count.location_id) ?? [] : []
    const prev = hist.length ? hist[0] : null
    const median = computeMedian(hist.slice(0, lookbackN))
    const evaln = evaluateRecountFlags(count, prev, median, config)
    return {
      count,
      locationId: count.location_id,
      prev,
      median,
      varVsLastMonth: evaln.varVsLastMonth,
      varVsMedian: evaln.varVsMedian,
      flags: evaln.flags,
    }
  })
}

export interface TankVarianceCandidate {
  location_id: string
  product_id: string   // resolved internal id
  tank_qts: number
  on_hand: number
  diff: number          // tank_qts - on_hand, signed
}

/**
 * VMI tank readings vs. this period's counted on-hand, per (shop, product).
 * Returns every pair with both a tank reading and a count row — the caller
 * decides what counts as "too far off" against a (possibly draft) threshold,
 * same live-preview split as the other rules.
 *
 * Resolves each tank's raw product text the same way the Tank Monitors page
 * does (manual tank_product_map first, then Vendor Parts description/part
 * number) — the SQL exceptions RPC does a raw string match with no such
 * resolution, which this intentionally does not replicate; a tank reading
 * that only resolves through Vendor Parts would otherwise never match here.
 */
export async function fetchTankVarianceCandidates(
  companyId: string, countMonth: string, tankProductMap: Record<string, string>,
): Promise<TankVarianceCandidate[]> {
  const sb = supabase as any
  const [tmRes, vpRes, cpRes] = await Promise.all([
    sb.schema('inventory').from('tank_monitors')
      .select('location_id, product_id, value, unit, inventory_time, reading_date, system_tank_id, serial_rtu_id')
      .eq('company_id', companyId).eq('keep_fill', true).not('location_id', 'is', null).not('product_id', 'is', null),
    sb.schema('inventory').from('vendor_parts').select('part_number, our_part_number, description').eq('company_id', companyId),
    sb.schema('inventory').from('count_products').select('location_id, product_id, on_hand, created_at')
      .eq('company_id', companyId).eq('count_month', countMonth),
  ])

  const parts = (vpRes.data ?? []) as { part_number: string | null; our_part_number: string | null; description: string | null }[]
  const internalMap = new Map<string, string>()
  for (const p of parts) {
    if (!p.our_part_number) continue
    const desc = p.description ? String(p.description).toLowerCase().trim() : ''
    if (desc) internalMap.set(desc, p.our_part_number)
    const pn = p.part_number ? String(p.part_number).toLowerCase().trim() : ''
    if (pn && !internalMap.has(pn)) internalMap.set(pn, p.our_part_number)
  }
  const resolve = (raw: string) => {
    const k = raw.toLowerCase().trim()
    return tankProductMap[k] || internalMap.get(k) || raw
  }
  const readingTime = (v: { inventory_time?: string | null; reading_date?: string | null }) => {
    const d = v.inventory_time ?? v.reading_date
    return d ? new Date(d).getTime() : 0
  }

  // Latest reading per physical tank (system_tank_id/serial_rtu_id), then
  // per (location, resolved product) keep whichever tank read most recently
  // — mirrors the dedup Tank Monitors and the exceptions RPC both use.
  const latestByTank = new Map<string, (typeof tmRes.data)[number]>()
  for (const t of (tmRes.data ?? []) as any[]) {
    const key = `${t.location_id}|${t.system_tank_id ?? t.serial_rtu_id ?? t.product_id}`
    const ex = latestByTank.get(key)
    if (!ex || readingTime(t) > readingTime(ex)) latestByTank.set(key, t)
  }
  const tankByKey = new Map<string, { qts: number; time: number }>()
  for (const t of latestByTank.values()) {
    const resolved = resolve(String(t.product_id))
    const qts = String(t.unit ?? 'gal').toLowerCase().startsWith('gal') ? Number(t.value ?? 0) * 4 : Number(t.value ?? 0)
    const key = `${t.location_id}|${resolved.toLowerCase()}`
    const time = readingTime(t)
    const ex = tankByKey.get(key)
    if (!ex || time >= ex.time) tankByKey.set(key, { qts, time })
  }

  // Latest on-hand per (location, product) for the month — snapshot, not sum.
  const onHandByKey = new Map<string, { on_hand: number; created_at: string }>()
  for (const c of (cpRes.data ?? []) as any[]) {
    if (!c.location_id) continue
    const key = `${c.location_id}|${String(c.product_id).toLowerCase()}`
    const ex = onHandByKey.get(key)
    if (!ex || new Date(c.created_at) > new Date(ex.created_at)) onHandByKey.set(key, { on_hand: Number(c.on_hand ?? 0), created_at: c.created_at })
  }

  const out: TankVarianceCandidate[] = []
  for (const [key, tank] of tankByKey) {
    const oh = onHandByKey.get(key)
    if (!oh) continue
    const [location_id, product_id] = key.split('|')
    out.push({ location_id, product_id, tank_qts: tank.qts, on_hand: oh.on_hand, diff: tank.qts - oh.on_hand })
  }
  return out
}

// Threshold-only shape used to drive evaluation from unsaved form state.
export type DraftThresholds = Pick<
  RecountConfig,
  | 'low_adj_threshold'
  | 'high_adj_threshold'
  | 'oil_low_adj_threshold'
  | 'oil_high_adj_threshold'
  | 'low_balance_threshold'
  | 'high_balance_threshold'
  | 'variance_to_median_pct'
  | 'variance_to_last_month_pct'
  | 'median_months_lookback'
  | 'var_med_threshold_type'
  | 'var_last_threshold_type'
>

/** Build a RecountConfig-compatible object from draft thresholds (only the threshold fields are read downstream). */
export function draftToConfig(d: DraftThresholds): RecountConfig {
  return d as RecountConfig
}
