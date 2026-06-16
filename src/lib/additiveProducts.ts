// Additive product batching for Month End.
// Multiple uploads for the same period are kept as SEPARATE batches (non-destructive).
// Per-(location, product) totals are computed by aggregating across all batches.
// InverseToggle sign flips are applied at PARSE time, before aggregation.

import type { ColumnMapping } from '@/types'

/** Numeric product fields that are summed across batches. */
export const PRODUCT_NUMERIC_FIELDS = ['on_hand', 'sold', 'adjusted', 'ending_value'] as const
export type ProductNumericField = (typeof PRODUCT_NUMERIC_FIELDS)[number]

export interface ParsedProductRow {
  location_id: string | null
  location_code: string | null // raw code from the file; resolved to location_id by caller
  product_id: string
  category: string | null
  on_hand: number
  sold: number
  adjusted: number
  ending_value: number
}

/** Tolerant numeric parse: strips currency/commas/parens, treats (123) as -123. */
function toNumber(raw: unknown): number {
  if (raw === null || raw === undefined) return 0
  let s = String(raw).trim()
  if (s === '') return 0
  let sign = 1
  if (/^\(.*\)$/.test(s)) {
    sign = -1
    s = s.slice(1, -1)
  }
  s = s.replace(/[$,\s]/g, '')
  const n = Number(s)
  return isNaN(n) ? 0 : sign * n
}

/**
 * Convert one raw file row into a ParsedProductRow using the column mappings.
 * Applies `invert` per field at parse time (sign flip on the numeric value).
 */
export function parseProductRow(
  row: Record<string, string>,
  mappings: ColumnMapping[]
): ParsedProductRow {
  const byField = new Map(mappings.map((m) => [m.fieldName, m]))

  const readString = (field: string): string => {
    const m = byField.get(field)
    return m ? String(row[m.sourceColumn] ?? '').trim() : ''
  }

  const readNumber = (field: ProductNumericField): number => {
    const m = byField.get(field)
    if (!m) return 0
    const value = toNumber(row[m.sourceColumn])
    return m.invert ? -value : value
  }

  return {
    location_id: null,
    location_code: readString('location_code') || readString('location') || null,
    product_id: readString('product_id'),
    category: readString('category') || null,
    on_hand: readNumber('on_hand'),
    sold: readNumber('sold'),
    adjusted: readNumber('adjusted'),
    ending_value: readNumber('ending_value'),
  }
}

/** Parse an entire upload, applying inversion per the mappings. */
export function parseProductRows(
  rows: Record<string, string>[],
  mappings: ColumnMapping[]
): ParsedProductRow[] {
  return rows.map((r) => parseProductRow(r, mappings)).filter((r) => r.product_id)
}

export interface AggregatedProduct {
  location_id: string | null
  product_id: string
  on_hand: number
  sold: number
  adjusted: number
  ending_value: number
  batch_count: number // how many batch rows contributed
}

interface AggregatableRow {
  location_id: string | null
  product_id: string
  on_hand?: number | null
  sold?: number | null
  adjusted?: number | null
  ending_value?: number | null
}

/**
 * SUM on_hand/sold/adjusted/ending_value per (location_id, product_id) across
 * all supplied batch rows. Batches themselves are never mutated or merged —
 * this is a pure read-side rollup.
 */
export function aggregateProductBatches(batchRows: AggregatableRow[]): AggregatedProduct[] {
  const map = new Map<string, AggregatedProduct>()

  for (const row of batchRows) {
    if (!row.product_id) continue
    const key = `${row.location_id ?? ''}::${row.product_id}`
    let agg = map.get(key)
    if (!agg) {
      agg = {
        location_id: row.location_id ?? null,
        product_id: row.product_id,
        on_hand: 0,
        sold: 0,
        adjusted: 0,
        ending_value: 0,
        batch_count: 0,
      }
      map.set(key, agg)
    }
    agg.on_hand += Number(row.on_hand ?? 0)
    agg.sold += Number(row.sold ?? 0)
    agg.adjusted += Number(row.adjusted ?? 0)
    agg.ending_value += Number(row.ending_value ?? 0)
    agg.batch_count += 1
  }

  return Array.from(map.values())
}
