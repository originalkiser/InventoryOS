// Shared logic for the Form Builder "Package Pricing" field (2026-09-16) —
// used by both the fill-out canvas (FormBuilderPage.tsx's FormCanvas) and
// the results page, so the auto-split math and OTD default can't drift
// between where a value is entered and where it's later displayed/exported.
import type { PackagePricingRow } from '@/types/forms'

export function newPackagePricingRow(): PackagePricingRow {
  return {
    id: crypto.randomUUID(),
    package_name: '',
    oil_type: '',
    oil_brand: null,
    package_price: null,
    quarts_included: null,
    price_per_quart_after: null,
    tax_mode: null,
    filter_mode: null,
    avg_filter_price: null,
    otd_price: null,
    otd_price_is_manual: false,
    penetration_pct: null,
  }
}

/**
 * Penetration % auto-split: a row with an explicit `penetration_pct` keeps
 * it as-is; the remaining share (100 minus the sum of every explicit value,
 * floored at 0 so over-100% entries don't produce a negative split) is
 * divided evenly across every row that hasn't been given an explicit value
 * yet. Recomputed live from the CURRENT rows every time — there's no
 * separate stored "auto value," so a row's effective % always reflects
 * whatever its siblings currently say, exactly as the seller-facing
 * "still needs updating until entered" behavior requires.
 */
export function effectivePenetrationPct(rows: PackagePricingRow[]): number[] {
  const explicitSum = rows.reduce((s, r) => s + (r.penetration_pct ?? 0), 0)
  const autoCount = rows.filter((r) => r.penetration_pct == null).length
  const remaining = Math.max(0, 100 - explicitSum)
  const autoShare = autoCount > 0 ? remaining / autoCount : 0
  return rows.map((r) => r.penetration_pct ?? autoShare)
}

/** The Out-The-Door price to actually use for a row: the analyst's own manual entry once they've made one, otherwise the package price as a starting default. */
export function effectiveOtdPrice(row: PackagePricingRow): number | null {
  return row.otd_price_is_manual ? row.otd_price : row.package_price
}

export function formatMoney(v: number | null | undefined): string {
  return v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function formatPct(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
}

/** Human label for a filter_mode value — 'premium_only' doesn't read well through plain CSS capitalize(), unlike 'included'/'added'. */
export function formatFilterMode(mode: PackagePricingRow['filter_mode']): string {
  if (mode === 'premium_only') return 'Premium only'
  if (mode === 'added') return 'Added'
  if (mode === 'included') return 'Included'
  return '—'
}

/** One-line plain-text summary of a package row, for the results table/export — see FormResultsPage.tsx. */
export function summarizePackageRow(row: PackagePricingRow, effectivePct: number, isAuto: boolean): string {
  const parts = [
    row.package_name || '(unnamed package)',
    formatMoney(row.package_price),
  ]
  if (row.quarts_included != null) parts.push(`${row.quarts_included} qt incl.`)
  if (row.price_per_quart_after != null) parts.push(`+${formatMoney(row.price_per_quart_after)}/qt after`)
  if (row.tax_mode) parts.push(`tax ${row.tax_mode}`)
  if (row.filter_mode) parts.push(`filter ${formatFilterMode(row.filter_mode)}`)
  if (row.avg_filter_price != null) parts.push(`avg filter ${formatMoney(row.avg_filter_price)}`)
  parts.push(`OTD ${formatMoney(effectiveOtdPrice(row))}`)
  parts.push(`${formatPct(effectivePct)}${isAuto ? ' auto' : ''} penetration`)
  return parts.join(', ')
}
