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
  { name: 'adjustment_value', label: 'Adjustment Value', numeric: true },
  { name: 'abs_adjustment_value', label: 'Abs Adjustment Value', numeric: true },
  { name: 'ending_inventory_cost', label: 'Ending Inventory Cost', required: true, numeric: true },
]

// Product Detail upload — additive; many rows per location.
export const PRODUCT_FIELDS: MapField[] = [
  { name: 'location', label: 'Location', required: true },
  { name: 'product_id', label: 'Product', required: true },
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
      l.location_code.toLowerCase() === v ||
      l.name.toLowerCase() === v
  )
  return match?.id ?? null
}

/** Combobox-friendly options for the location picker. */
export function locationOptions(locations: Location[]) {
  return locations
    .filter((l) => l.active)
    .map((l) => ({ value: l.id, label: `${l.location_code} — ${l.name}` }))
}

export function locationLabel(locationId: string | null, locations: Location[]): string {
  if (!locationId) return '—'
  const l = locations.find((x) => x.id === locationId)
  return l ? `${l.location_code} — ${l.name}` : '—'
}

// ---------------------------------------------------------------------------
// Reusable target descriptor for the shared Count Summary upload surface.
// Month End and Weekly write to different tables / template modules but share
// the identical mappable fields, ColumnMapper, and template system.
// ---------------------------------------------------------------------------
export interface SummaryUploadTarget {
  table: 'monthly_counts' | 'weekly_counts'
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
    table: 'monthly_counts',
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
    templateModule: 'weekly',
    dataSourceConfigType: 'weekly_counts',
    defaultCountDateISO: `${weekStart}T12:00:00.000Z`,
    buildExtraColumns: () => ({}),
    cardLabel: 'Weekly Count Summary',
    templatePlaceholder: 'e.g. POS Weekly Export',
  }
}
