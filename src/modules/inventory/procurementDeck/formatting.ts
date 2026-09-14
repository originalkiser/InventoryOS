export type ValueFormat = 'currency' | 'percent' | 'number' | 'gallons000'

export function formatValue(v: number | null | undefined, format: ValueFormat): string {
  if (v == null || Number.isNaN(v)) return '—'
  switch (format) {
    case 'currency': return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    case 'percent': return `${(v * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`
    case 'gallons000': return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })}K`
    default: return v.toLocaleString(undefined, { maximumFractionDigits: 1 })
  }
}

// The number an editable input should show/accept for this format (percent
// edits as "20" not "0.2"), and the inverse to get back to the stored value.
export function toInputValue(v: number | null | undefined, format: ValueFormat): string {
  if (v == null || Number.isNaN(v)) return ''
  return format === 'percent' ? String(Math.round(v * 1000) / 10) : String(v)
}
export function fromInputValue(raw: string, format: ValueFormat): number | null {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  if (Number.isNaN(n)) return null
  return format === 'percent' ? n / 100 : n
}
