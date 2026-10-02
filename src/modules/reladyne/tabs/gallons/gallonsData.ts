// Shared data shapes + pure aggregation for the Product Gallons tab's views
// (Summary / By Month / Charts / Underperformers / Product Mapping) — kept
// React-free so every view reads the exact same filtered row set.
import { billedPct, type GroupKey } from '../../mmrShared'

/** One reladyne_volume_data row, enriched with the resolved Bulk/Package/Drum group, shop number and market. */
export interface GRow {
  period: string
  productDesc: string
  group: GroupKey
  shop: string
  market: string
  ordered: number
  billed: number
  revenue: number
}

export interface Agg { ordered: number; billed: number; revenue: number }

export const emptyAgg = (): Agg => ({ ordered: 0, billed: 0, revenue: 0 })

export function sumRows(rows: GRow[]): Agg {
  const a = emptyAgg()
  for (const r of rows) { a.ordered += r.ordered; a.billed += r.billed; a.revenue += r.revenue }
  return a
}

export function groupRows(rows: GRow[], keyOf: (r: GRow) => string): Map<string, GRow[]> {
  const m = new Map<string, GRow[]>()
  for (const r of rows) {
    const k = keyOf(r)
    const arr = m.get(k)
    if (arr) arr.push(r); else m.set(k, [r])
  }
  return m
}

export type GroupByDim = 'product' | 'group' | 'market' | 'shop'
export const GROUP_BY_OPTIONS: { value: GroupByDim; label: string }[] = [
  { value: 'product', label: 'Product' },
  { value: 'group', label: 'Package Type' },
  { value: 'market', label: 'Market' },
  { value: 'shop', label: 'Shop' },
]

export type MonthMetric = 'both' | 'ordered' | 'billed' | 'billed_pct' | 'revenue'
export const MONTH_METRIC_OPTIONS: { value: MonthMetric; label: string }[] = [
  { value: 'both', label: 'Ordered & Billed' },
  { value: 'ordered', label: 'Gallons Ordered' },
  { value: 'billed', label: 'Gallons Billed' },
  { value: 'billed_pct', label: 'Billed % of Ordered' },
  { value: 'revenue', label: 'Revenue' },
]

export const dimKey = (dim: GroupByDim, groupLabel: (g: GroupKey) => string) => (r: GRow): string => {
  switch (dim) {
    case 'product': return r.productDesc
    case 'group': return groupLabel(r.group)
    case 'market': return r.market
    case 'shop': return r.shop
  }
}

export interface MonthlyRow {
  key: string
  byMonth: Map<string, Agg>
  total: Agg
}

/** One row per dimension value, with an Agg per month + the period total. Sorted by total billed desc. */
export function monthlyBreakdown(rows: GRow[], keyOf: (r: GRow) => string): MonthlyRow[] {
  const out: MonthlyRow[] = []
  for (const [key, list] of groupRows(rows, keyOf)) {
    const byMonth = new Map<string, Agg>()
    for (const [p, pr] of groupRows(list, (r) => r.period)) byMonth.set(p, sumRows(pr))
    out.push({ key, byMonth, total: sumRows(list) })
  }
  return out.sort((a, b) => b.total.billed - a.total.billed)
}

export const aggBilledPct = (a: Agg) => billedPct(a.ordered, a.billed)

export function csvEscape(v: string | number | null): string {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv(filename: string, lines: (string | number | null)[][]) {
  const blob = new Blob([lines.map((l) => l.map(csvEscape).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}
