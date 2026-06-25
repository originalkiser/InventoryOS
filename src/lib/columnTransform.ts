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
 * Resolve a mapping's value for a given file row: a constant when the source is
 * set to "constant", otherwise the file cell — then apply the transform.
 */
export function mappedValue(row: Record<string, string>, m: ColumnMapping): string {
  const raw = m.sourceColumn === CONSTANT_SOURCE ? (m.constant ?? '')
    : m.sourceColumn === COMPOSITE_SOURCE ? fillTemplate(m.template ?? '', row)
    : (row[m.sourceColumn] ?? '')
  // Legacy single transform first, then the richer ordered chain.
  return applyTransforms(applyTransform(raw, m.transform), m.transforms)
}
