import { CONSTANT_SOURCE, COMPOSITE_SOURCE, type ColumnMapping, type TransformKind } from '@/types'
import { applyTransforms } from '@/lib/transforms'

// Fill a composite template: {Header} tokens → row[Header], literals kept.
// Token names are matched first by exact file header, then by normalized key
// (lowercase, spaces/hyphens → underscores) so {location_code} matches "Location Code".
export function fillTemplate(template: string, row: Record<string, string>): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\-]+/g, '_')
  const normRow: Record<string, string> = {}
  for (const [k, v] of Object.entries(row)) normRow[norm(k)] = v
  return (template ?? '').replace(/\{([^}]+)\}/g, (_, key) => {
    const k = String(key).trim()
    return row[k] ?? normRow[norm(k)] ?? ''
  })
}

export const TRANSFORM_OPTIONS: { value: TransformKind; label: string }[] = [
  { value: 'none', label: 'Text (as-is)' },
  { value: 'number', label: 'Number (001→1)' },
  { value: 'integer', label: 'Whole number' },
  { value: 'trim', label: 'Trim spaces' },
  { value: 'upper', label: 'UPPERCASE' },
  { value: 'lower', label: 'lowercase' },
]

// Apply a value transform at import time. Always returns a string so existing
// downstream coercion (number parsing, etc.) still applies.
export function applyTransform(raw: string, t?: TransformKind): string {
  const v = (raw ?? '').toString()
  switch (t) {
    case 'number': {
      const n = parseFloat(v.replace(/[$,\s]/g, ''))
      return isNaN(n) ? '' : String(n)
    }
    case 'integer': {
      const n = parseFloat(v.replace(/[$,\s]/g, ''))
      return isNaN(n) ? '' : String(Math.trunc(n))
    }
    case 'trim': return v.trim()
    case 'upper': return v.trim().toUpperCase()
    case 'lower': return v.trim().toLowerCase()
    default: return v
  }
}

/**
 * Resolve a mapping's value for a given file row.
 *
 * Pass `allMaps` so composite templates can reference other mapped field names
 * (with their transforms applied) in addition to raw file headers.
 * e.g. `{location_code}-{city}` where `location_code` has strip_leading_zeros
 * will receive the stripped value when allMaps is provided.
 */
export function mappedValue(row: Record<string, string>, m: ColumnMapping, allMaps?: ColumnMapping[]): string {
  let raw: string
  if (m.sourceColumn === CONSTANT_SOURCE) {
    raw = m.constant ?? ''
  } else if (m.sourceColumn === COMPOSITE_SOURCE) {
    let context = { ...row }
    if (allMaps) {
      for (const other of allMaps) {
        if (other.fieldName !== m.fieldName && other.sourceColumn && other.sourceColumn !== COMPOSITE_SOURCE) {
          context[other.fieldName] = mappedValue(row, other)
        }
      }
    }
    raw = fillTemplate(m.template ?? '', context)
  } else {
    raw = row[m.sourceColumn] ?? ''
  }
  return applyTransforms(applyTransform(raw, m.transform), m.transforms)
}
