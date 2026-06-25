import { format } from 'date-fns'

// Reusable import-transform engine. A mapped column can carry a chain of
// transforms applied in order at import time. Everything returns a string so
// downstream coercion (number/date parsing) still works. Used by every import
// (locations, tank monitors, product usage, order history, …) so transform
// configs are saved with the mapping and reused on re-import.

export type Transform =
  | { kind: 'multiply'; by: number }
  | { kind: 'divide'; by: number }
  | { kind: 'gal_to_qt' } // ×4
  | { kind: 'qt_to_gal' } // ÷4
  | { kind: 'parse_after'; delimiter: string } // =VALUE(TEXTAFTER(data, delim))
  | { kind: 'parse_before'; delimiter: string } // number before the delimiter ("001 - X" → 001)
  | { kind: 'pos_location' } // "1 - Thomasville" → "1"
  | { kind: 'phone' } // right-most 10 digits → (###) ###-####
  | { kind: 'date' } // → yyyy-MM-dd
  | { kind: 'datetime' } // → ISO timestamp
  | { kind: 'currency' } // strip symbols → numeric string
  | { kind: 'strip_leading_zeros' } // "001" → "1", "007.5" → "7.5"

export type TransformChainKind = Transform['kind']

// Catalog for the mapping UI: which transforms need an operand, and a label.
export const TRANSFORM_CATALOG: { kind: TransformChainKind; label: string; operand?: 'number' | 'text' }[] = [
  { kind: 'multiply', label: 'Multiply by…', operand: 'number' },
  { kind: 'divide', label: 'Divide by…', operand: 'number' },
  { kind: 'gal_to_qt', label: 'Gallons → Quarts (×4)' },
  { kind: 'qt_to_gal', label: 'Quarts → Gallons (÷4)' },
  { kind: 'parse_after', label: 'Number after delimiter', operand: 'text' },
  { kind: 'parse_before', label: 'Number before delimiter', operand: 'text' },
  { kind: 'pos_location', label: 'POS location number' },
  { kind: 'phone', label: 'Phone (last 10 digits)' },
  { kind: 'date', label: 'Date (no time)' },
  { kind: 'datetime', label: 'Date & time' },
  { kind: 'currency', label: 'Currency (numeric)' },
  { kind: 'strip_leading_zeros', label: 'Strip leading zeros (001 → 1)' },
]

function toNum(v: string): number {
  return parseFloat(String(v ?? '').replace(/[$,\s]/g, ''))
}

function firstNumber(s: string): string {
  const m = /-?\d+(\.\d+)?/.exec(String(s ?? ''))
  return m ? m[0] : ''
}

// Parse a date value safely. Handles Excel serial numbers and rejects absurd
// years (a serial like 46186 parsed as the year 46186 caused Postgres
// "time zone displacement out of range"). Returns null when unparseable.
function parseDateSafe(v: string): Date | null {
  const s = String(v ?? '').trim()
  if (!s) return null
  let d: Date
  if (/^\d+(\.\d+)?$/.test(s)) {
    // Bare number → Excel serial date (days since 1899-12-30).
    d = new Date(Math.round((Number(s) - 25569) * 86400 * 1000))
  } else {
    d = new Date(s)
  }
  if (isNaN(d.getTime())) return null
  const y = d.getFullYear()
  if (y < 1900 || y > 9999) return null
  return d
}

export function formatPhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '')
  if (digits.length < 10) return String(raw ?? '') // too short — leave raw (caller may flag)
  const ten = digits.slice(-10)
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`
}

function applyOne(value: string, t: Transform): string {
  const v = String(value ?? '')
  switch (t.kind) {
    case 'multiply': { const n = toNum(v); return isNaN(n) || isNaN(t.by) ? '' : String(n * t.by) }
    case 'divide': { const n = toNum(v); return isNaN(n) || !t.by ? '' : String(n / t.by) }
    case 'gal_to_qt': { const n = toNum(v); return isNaN(n) ? '' : String(n * 4) }
    case 'qt_to_gal': { const n = toNum(v); return isNaN(n) ? '' : String(n / 4) }
    case 'parse_after': {
      const delim = t.delimiter || '#'
      const idx = v.indexOf(delim)
      const after = idx >= 0 ? v.slice(idx + delim.length) : v
      return firstNumber(after)
    }
    case 'parse_before': {
      const delim = t.delimiter || '-'
      const idx = v.indexOf(delim)
      const before = idx >= 0 ? v.slice(0, idx) : v
      return firstNumber(before)
    }
    case 'pos_location': return firstNumber(v)
    case 'phone': return formatPhone(v)
    case 'date': { const d = parseDateSafe(v); return d ? format(d, 'yyyy-MM-dd') : '' }
    case 'datetime': { const d = parseDateSafe(v); return d ? d.toISOString() : '' }
    case 'currency': { const n = toNum(v); return isNaN(n) ? '' : String(n) }
    case 'strip_leading_zeros': {
      const trimmed = v.trim()
      // Only strip from pure numeric strings (integers or decimals)
      if (/^\d+$/.test(trimmed)) return String(Number(trimmed))
      if (/^\d+\.\d+$/.test(trimmed)) return String(Number(trimmed))
      return v
    }
    default: return v
  }
}

export function applyTransforms(value: string, transforms?: Transform[]): string {
  if (!transforms || transforms.length === 0) return value
  return transforms.reduce((acc, t) => applyOne(acc, t), value)
}

// Format a numeric value as currency for display (storage stays numeric).
export function formatCurrency(n: number | string | null | undefined): string {
  const num = typeof n === 'number' ? n : toNum(String(n ?? ''))
  if (isNaN(num)) return '—'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num)
}

export function describeTransform(t: Transform): string {
  switch (t.kind) {
    case 'multiply': return `×${t.by}`
    case 'divide': return `÷${t.by}`
    case 'gal_to_qt': return 'gal→qt'
    case 'qt_to_gal': return 'qt→gal'
    case 'parse_after': return `after "${t.delimiter || '#'}"`
    case 'parse_before': return `before "${t.delimiter || '-'}"`
    case 'pos_location': return 'POS #'
    case 'phone': return 'phone'
    case 'date': return 'date'
    case 'datetime': return 'date+time'
    case 'currency': return '$'
    case 'strip_leading_zeros': return '0-strip'
  }
}
