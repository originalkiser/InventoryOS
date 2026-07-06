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
  counts: MonthlyCount[]
  histByLoc: Map<string, number[]> // location_id -> ending balances, most recent first
}

export async function fetchPeriodEvalData(
  companyId: string,
  countMonth: string
): Promise<PeriodEvalData> {
  const sb = supabase as any
  const lowerBound = format(subMonths(new Date(countMonth), HISTORY_WINDOW_MONTHS), 'yyyy-MM-dd')

  const [locRes, countRes, balRes] = await Promise.all([
    sb.schema('core').from('locations').select('*').eq('company_id', companyId).order('name'),
    sb.schema('inventory').from('counts').select('*').eq('company_id', companyId).eq('count_month', countMonth),
    sb.schema('inventory').from('ending_balances').select('*').eq('company_id', companyId)
      .gte('month', lowerBound).lt('month', countMonth).order('month', { ascending: false }),
  ])

  const histByLoc = new Map<string, number[]>()
  for (const b of (balRes.data ?? []) as MonthlyEndingBalance[]) {
    if (!b.location_id) continue
    const arr = histByLoc.get(b.location_id) ?? []
    arr.push(Number(b.ending_balance))
    histByLoc.set(b.location_id, arr)
  }

  return {
    locations: (locRes.data ?? []) as Location[],
    counts: (countRes.data ?? []) as MonthlyCount[],
    histByLoc,
  }
}

export interface EvaluatedCount {
  count: MonthlyCount
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

// Threshold-only shape used to drive evaluation from unsaved form state.
export type DraftThresholds = Pick<
  RecountConfig,
  | 'low_adj_threshold'
  | 'high_adj_threshold'
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
