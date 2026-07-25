// Format a usage/day (or similar) rate: two decimals by default, but fall back
// to three decimals only when two would round to "0.00" (so tiny non-zero rates
// stay visible instead of collapsing to zero). Never more than three places.
export function formatUsage(v: number | null | undefined): string {
  if (v == null || isNaN(v)) return '—'
  if (v === 0) return '0.00'
  return Math.abs(v) < 0.005 ? v.toFixed(3) : v.toFixed(2)
}
