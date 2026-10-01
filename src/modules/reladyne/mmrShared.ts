// Small shared helpers across the RelaDyne MMR tabs.

export const MONTHS_BACK_OPTIONS = [
  { value: '3', label: 'Last 3 Months' },
  { value: '6', label: 'Last 6 Months' },
  { value: '12', label: 'Last 12 Months' },
  { value: 'all', label: 'All Time' },
]

/** The trailing N distinct periods (by string sort, 'YYYY-MM' sorts correctly) out of whatever's present — a plain Set for O(1) membership checks. 'all' returns every period, same shape as "no filter". */
export function trailingPeriods(allPeriods: string[], monthsBack: number | 'all'): Set<string> {
  const distinct = [...new Set(allPeriods)].sort()
  if (monthsBack === 'all') return new Set(distinct)
  return new Set(distinct.slice(-monthsBack))
}

export const num0 = (v: number | null | undefined) => (v == null ? '—' : Math.round(v).toLocaleString())
export const num1 = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }))
export const pct1 = (v: number | null | undefined) => (v == null ? '—' : `${v.toFixed(1)}%`)
export const money = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }))

/** Full month name -> short label, for consistent axis ticks across tabs ('YYYY-MM' -> 'Mon YYYY'). */
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function periodLabel(period: string): string {
  const [y, m] = period.split('-')
  const idx = Number(m) - 1
  return idx >= 0 && idx < 12 ? `${MONTH_SHORT[idx]} ${y}` : period
}
