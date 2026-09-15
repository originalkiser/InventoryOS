export type ValueFormat = 'currency' | 'percent' | 'number' | 'gallons000'

// Always exactly 1 decimal place, with the number's own type called out
// (currency: $ prefix, percent: % suffix) and a thousands comma whenever
// the value is >= 1000 — toLocaleString's default grouping already does
// the comma, minimumFractionDigits pins it to always show the .0 rather
// than only "up to" 1 decimal.
export function formatValue(v: number | null | undefined, format: ValueFormat): string {
  if (v == null || Number.isNaN(v)) return '—'
  const opts = { minimumFractionDigits: 1, maximumFractionDigits: 1 }
  switch (format) {
    case 'currency': return `$${v.toLocaleString(undefined, opts)}`
    case 'percent': return `${(v * 100).toLocaleString(undefined, opts)}%`
    case 'gallons000': return `${v.toLocaleString(undefined, opts)}K`
    default: return v.toLocaleString(undefined, opts)
  }
}

// The number an editable input should show/accept for this format (percent
// edits as "20" not "0.2"), and the inverse to get back to the stored value.
export function toInputValue(v: number | null | undefined, format: ValueFormat): string {
  if (v == null || Number.isNaN(v)) return ''
  return format === 'percent' ? String(Math.round(v * 1000) / 10) : String(v)
}
export function fromInputValue(raw: string, format: ValueFormat): number | null {
  // Strip a $ prefix, % suffix, and thousands commas defensively — the
  // field shows a fully formatted value ("$1,234.5") except while actively
  // being edited (see GridSection's onFocus/onBlur swap), but a paste or a
  // typed $ shouldn't just silently fail to parse.
  const t = raw.trim().replace(/[$,%]/g, '')
  if (t === '') return null
  const n = Number(t)
  if (Number.isNaN(n)) return null
  return format === 'percent' ? n / 100 : n
}
