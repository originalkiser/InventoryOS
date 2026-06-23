export interface ParsedLocation {
  rowKey: string      // canonical: SB-{number}
  rowLabel: string    // original string
  matched: boolean
}

const LOCATION_PATTERNS = [
  /\bSB-?(\d+)\b/i,
  /\bStore\s+(\d+)\b/i,
  /\bStrickland\s+Brothers\s+#\s*(\d+)\b/i,
  /\b[A-Za-z]+\s+SB-?(\d+)\b/i,
  /\b[A-Za-z]+\s+#\s*(\d+)\b/i,
  /\b#\s*(\d+)\b/,
  /\b(\d{2,4})\b/,
]

export function parseLocation(text: string): ParsedLocation {
  const trimmed = text.trim()

  for (const pattern of LOCATION_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      const num = match[1]
      return {
        rowKey: `SB-${num}`,
        rowLabel: trimmed,
        matched: true,
      }
    }
  }

  return {
    rowKey: `UNMATCHED-${trimmed.replace(/\s+/g, '-').toLowerCase()}`,
    rowLabel: trimmed,
    matched: false,
  }
}

export function parseEmployeeRow(shopText: string, employeeName: string): ParsedLocation {
  const shopParsed = parseLocation(shopText)
  const slug = employeeName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
  return {
    rowKey: `${shopParsed.rowKey}:${slug}`,
    rowLabel: employeeName.trim(),
    matched: shopParsed.matched,
  }
}
