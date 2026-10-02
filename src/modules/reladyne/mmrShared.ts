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

// ── Product Gallons tab helpers (direct ask 2026-10-02) ───────────────────

export type GroupKey = 'bulk' | 'package' | 'drum'
export const GROUP_KEYS: GroupKey[] = ['bulk', 'package', 'drum']
export const GROUP_LABELS: Record<GroupKey, string> = { bulk: 'Bulk', package: 'Package', drum: 'Drum' }

/**
 * Default Bulk/Package/Drum grouping when a product has no explicit override
 * in reladyne_product_group_map. The source sheet only says BULK or PACKAGE;
 * real product descriptions mark drums with a trailing " DR" ("DMX SYN XLT
 * 0W20 DEXOS DR") vs case/box packs ("... 6/G BX", "... 12/Q CS"), so that
 * suffix splits drums out of PACKAGE automatically. Anything the heuristic
 * gets wrong is fixed once in the Product Mapping tab.
 */
export function defaultGroupFor(packageGroup: string | null, productDesc: string): GroupKey {
  if ((packageGroup ?? '').toUpperCase() === 'BULK') return 'bulk'
  return /\bDR\s*$/i.test(productDesc.trim()) ? 'drum' : 'package'
}

/** Shop number out of RelaDyne's ship-to name ("STRICKLAND BROTHERS #50", or "...BROTHERS 682" on some franchise rows). */
export function shopNumberFromShipTo(shipToName: string | null): string | null {
  const m = String(shipToName ?? '').match(/BROTHERS\s*#?\s*(\d+)/i)
  return m ? m[1] : null
}

export const billedPct = (ordered: number, billed: number): number | null => (ordered > 0 ? (billed / ordered) * 100 : null)

/** Period-range presets labeled with the actual months they resolve to (direct ask: "we need to see those dates"). */
export function monthsBackOptionsWithDates(allPeriods: string[]) {
  const distinct = [...new Set(allPeriods)].sort()
  const span = (n: number) => {
    const slice = n === 0 ? distinct : distinct.slice(-n)
    if (!slice.length) return ''
    return slice.length === 1 ? ` (${periodLabel(slice[0])})` : ` (${periodLabel(slice[0])} – ${periodLabel(slice[slice.length - 1])})`
  }
  return [
    { value: '3', label: `Last 3 Months${span(3)}` },
    { value: '6', label: `Last 6 Months${span(6)}` },
    { value: '12', label: `Last 12 Months${span(12)}` },
    { value: 'all', label: `All Time${span(0)}` },
  ]
}
