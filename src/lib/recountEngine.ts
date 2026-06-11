// Recount flagging engine — pure business logic for Month End.
// Decides which location counts need a recount based on recount_config thresholds.

import { supabase } from './supabase'
import type { Location, MonthlyCount, RecountConfig } from '@/types'

/**
 * Median of a numeric list. Returns 0 for an empty list.
 * Even-length lists return the average of the two middle values.
 */
export function computeMedian(values: number[]): number {
  const nums = values.filter((v) => typeof v === 'number' && !isNaN(v))
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * Trailing ending balances for a location from monthly_ending_balances,
 * for the `lookbackN` months strictly BEFORE `month` (most recent first).
 * `month` is a 'YYYY-MM-DD' (first-of-month) string.
 */
export async function getEndingBalanceHistory(
  locationId: string,
  month: string,
  lookbackN: number
): Promise<number[]> {
  if (!locationId || lookbackN <= 0) return []
  const { data, error } = await (supabase as any)
    .from('monthly_ending_balances')
    .select('ending_balance, month')
    .eq('location_id', locationId)
    .lt('month', month)
    .order('month', { ascending: false })
    .limit(lookbackN)
  if (error || !data) return []
  return (data as { ending_balance: number }[])
    .map((r) => Number(r.ending_balance))
    .filter((v) => !isNaN(v))
}

export interface RecountEvaluation {
  flags: string[]
  varVsLastMonth: number // signed fractional change vs prev month (0 if prev unknown)
  varVsMedian: number // signed fractional change vs median (0 if median is 0)
}

/** A threshold is "active" only when set to a finite number; blank/null disables it. */
function isSet(v: number | null | undefined): v is number {
  return typeof v === 'number' && !isNaN(v)
}

/**
 * Evaluate a single count row against the recount thresholds.
 * - low/high adjustment count  → total_adjustments
 * - low/high ending balance    → ending_inventory_cost
 * - variance vs median / prev  → ending_inventory_cost
 * Any threshold left blank/undefined disables that trigger.
 */
export function evaluateRecountFlags(
  countRow: Pick<MonthlyCount, 'total_adjustments' | 'ending_inventory_cost'>,
  prevMonthBalance: number | null,
  median: number,
  config: RecountConfig | null
): RecountEvaluation {
  const flags: string[] = []
  const adj = Number(countRow.total_adjustments ?? 0)
  const ending = Number(countRow.ending_inventory_cost ?? 0)

  const varVsLastMonth =
    prevMonthBalance && prevMonthBalance !== 0 ? (ending - prevMonthBalance) / prevMonthBalance : 0
  const varVsMedian = median !== 0 ? (ending - median) / median : 0

  if (!config) return { flags, varVsLastMonth, varVsMedian }

  // Adjustment count bounds
  if (isSet(config.low_adj_threshold) && adj < config.low_adj_threshold) {
    flags.push('low_adjustments')
  }
  if (isSet(config.high_adj_threshold) && adj > config.high_adj_threshold) {
    flags.push('high_adjustments')
  }

  // Ending balance bounds
  if (isSet(config.low_balance_threshold) && ending < config.low_balance_threshold) {
    flags.push('low_ending_balance')
  }
  if (isSet(config.high_balance_threshold) && ending > config.high_balance_threshold) {
    flags.push('high_ending_balance')
  }

  // Variance vs median (pct stored as whole number, e.g. 15 = 15%)
  if (isSet(config.variance_to_median_pct) && median !== 0) {
    if (Math.abs(varVsMedian) * 100 > config.variance_to_median_pct) {
      flags.push('variance_vs_median')
    }
  }

  // Variance vs last month
  if (isSet(config.variance_to_last_month_pct) && prevMonthBalance && prevMonthBalance !== 0) {
    if (Math.abs(varVsLastMonth) * 100 > config.variance_to_last_month_pct) {
      flags.push('variance_vs_last_month')
    }
  }

  return { flags, varVsLastMonth, varVsMedian }
}

/**
 * Active locations that have NOT submitted a count for the period.
 * Matches against the location_ids present in `countRows`.
 */
export function getMissingShops(
  locations: Location[],
  countRows: Pick<MonthlyCount, 'location_id'>[]
): Location[] {
  const submitted = new Set(countRows.map((r) => r.location_id).filter(Boolean))
  return locations.filter((loc) => loc.active && !submitted.has(loc.id))
}

/** Human-readable labels for the flag codes produced by evaluateRecountFlags. */
export const RECOUNT_FLAG_LABELS: Record<string, string> = {
  low_adjustments: 'Low adjustment count',
  high_adjustments: 'High adjustment count',
  low_ending_balance: 'Low ending balance',
  high_ending_balance: 'High ending balance',
  variance_vs_median: 'Variance vs median',
  variance_vs_last_month: 'Variance vs last month',
}
