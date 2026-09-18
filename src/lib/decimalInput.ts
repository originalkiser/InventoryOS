// Shared by any plain-text price/number input styled as `type="text"
// inputMode="decimal"` instead of `type="number"` — a native number input's
// up/down spinner arrows aren't useful for typing a price and can clip a
// narrow box's last digit (found live on the Franchise Menu Board setup
// form, 2026-09-19), while `inputMode="decimal"` still brings up a numeric
// keypad on a phone without them. This replaces the character validation a
// number input gave for free (digits and at most one decimal point).
export function sanitizeDecimalInput(raw: string): string {
  let cleaned = raw.replace(/[^0-9.]/g, '')
  const dot = cleaned.indexOf('.')
  if (dot !== -1) cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '')
  return cleaned
}
