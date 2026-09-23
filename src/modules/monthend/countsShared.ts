// Shared helpers for the Month End → Counts tab (summary + product uploads, results).
import type { Location } from '@/types'

export interface MapField {
  name: string
  label: string
  required?: boolean
  numeric?: boolean
  date?: boolean
}

// Count Summary upload — one row per location for the period.
export const SUMMARY_FIELDS: MapField[] = [
  { name: 'location', label: 'Location', required: true },
  { name: 'count_date', label: 'Count Date', date: true },
  { name: 'count_type', label: 'Count Type' },
  { name: 'total_adjustments', label: 'Total Adjustments', numeric: true },
  { name: 'oil_adjustments', label: 'Oil Adjustments', numeric: true },
  { name: 'adjustment_value', label: 'Adjustment Value', numeric: true },
  { name: 'abs_adjustment_value', label: 'Abs Adjustment Value', numeric: true },
  { name: 'ending_inventory_cost', label: 'Ending Inventory Cost', required: true, numeric: true },
]

// Expected Oil Balance upload — one row per location for the period,
// replaces (not additive) — see ExpectedOilBalanceUpload.tsx.
export const EXPECTED_OIL_FIELDS: MapField[] = [
  { name: 'location', label: 'Location', required: true },
  { name: 'expected_balance', label: 'Expected Balance', required: true, numeric: true },
]

// Per-count_type rule (Counts → Results → Summary's own "Allowable Types"
// config, platform.app_settings key below) — the single source of truth for
// "does a count of this type count toward the period," shared by that
// table's own row filtering AND (as of 2026-09-23) the Area Manager Rollup/
// recount eligibility check, which used to hardcode 'monthly' independently
// and never actually read this setting despite looking like the same
// control. No rule saved for a type defaults to 'include' — same fallback
// CountsResultsTable.tsx's own getRule() already used, so wiring this up
// doesn't change what's already showing as allowed there.
export type TypeRuleMode = 'include' | 'exclude' | 'allow_if_over'
export interface TypeRule { mode: TypeRuleMode; threshold: number | null }
export const ALLOWABLE_TYPE_RULES_KEY = 'monthend.allowableTypeRules'

export function isAllowedCountType(
  countType: string | null | undefined,
  totalAdjustments: number | null | undefined,
  typeRules: Record<string, TypeRule>,
): boolean {
  const rule = typeRules[countType ?? '—'] ?? { mode: 'include', threshold: null }
  if (rule.mode === 'exclude') return false
  if (rule.mode === 'allow_if_over') return rule.threshold == null || (totalAdjustments ?? 0) > rule.threshold
  return true
}

// Product Detail upload — additive; many rows per location.
export const PRODUCT_FIELDS: MapField[] = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product', required: true },
  { name: 'category', label: 'Category' },
  { name: 'on_hand', label: 'On Hand', numeric: true },
  { name: 'sold', label: 'Sold', numeric: true },
  { name: 'adjusted', label: 'Adjusted', numeric: true },
  { name: 'ending_value', label: 'Ending Value', numeric: true },
]

/** Tolerant numeric parse: strips $/commas/spaces, treats (123) as -123. */
export function toNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  let s = String(raw).trim()
  if (s === '') return null
  let sign = 1
  if (/^\(.*\)$/.test(s)) {
    sign = -1
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  const n = Number(s)
  return isNaN(n) ? null : sign * n
}

/** Resolve a free-text location value (code, name, or id) to a location_id. */
export function resolveLocationId(value: string, locations: Location[]): string | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  const match = locations.find(
    (l) =>
      l.id.toLowerCase() === v ||
      l.name.toLowerCase() === v ||
      (l.shop_city ?? '').toLowerCase() === v
  )
  return match?.id ?? null
}

/** Combobox-friendly options for the location picker. */
export function locationOptions(locations: Location[]) {
  return locations
    .filter((l) => l.active)
    .map((l) => ({ value: l.id, label: `${l.name} — ${l.shop_city ?? ''}` }))
}

export function locationLabel(locationId: string | null, locations: Location[]): string {
  if (!locationId) return '—'
  const l = locations.find((x) => x.id === locationId)
  return l ? `${l.name} — ${l.shop_city ?? ''}` : '—'
}

// ---------------------------------------------------------------------------
// Reusable target descriptor for the shared Count Summary upload surface.
// Month End and Weekly write to different tables / template modules but share
// the identical mappable fields, ColumnMapper, and template system.
// ---------------------------------------------------------------------------
export interface SummaryUploadTarget {
  table: 'monthly_counts' | 'weekly_counts' | 'counts'
  schema: string
  templateModule: 'monthly_summary' | 'weekly'
  dataSourceConfigType: string
  // ISO timestamp used for count_date when the file doesn't map one
  defaultCountDateISO: string
  // Extra columns stamped on every inserted row (period tag + upload time)
  buildExtraColumns: () => Record<string, unknown>
  cardLabel: string
  templatePlaceholder: string
}

export function monthlySummaryTarget(countMonth: string): SummaryUploadTarget {
  return {
    table: 'counts',
    schema: 'inventory',
    templateModule: 'monthly_summary',
    dataSourceConfigType: 'monthly_counts',
    defaultCountDateISO: `${countMonth}T12:00:00.000Z`,
    buildExtraColumns: () => ({ count_month: countMonth, uploaded_at: new Date().toISOString() }),
    cardLabel: 'Count Summary',
    templatePlaceholder: 'e.g. POS Monthly Export',
  }
}

export function weeklySummaryTarget(weekStart: string): SummaryUploadTarget {
  return {
    table: 'weekly_counts',
    schema: 'inventory',
    templateModule: 'weekly',
    dataSourceConfigType: 'weekly_counts',
    defaultCountDateISO: `${weekStart}T12:00:00.000Z`,
    buildExtraColumns: () => ({}),
    cardLabel: 'Weekly Count Summary',
    templatePlaceholder: 'e.g. POS Weekly Export',
  }
}
