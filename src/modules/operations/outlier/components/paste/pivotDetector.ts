export interface PivotDetectionResult {
  isPivot: boolean
  shopCount: number
  employeeCount: number
}

export function detectPivot(rows: string[][]): PivotDetectionResult {
  if (rows.length < 3) return { isPivot: false, shopCount: 0, employeeCount: 0 }

  const hasTotalRow = rows.some(r =>
    r.some(cell => /^(grand\s+)?total$/i.test(cell.trim()))
  )

  // Check for repeated shop identifiers with sub-rows
  const shopPattern = /\bSB-?\d+\b|\bStore\s+\d+\b|\b#\s*\d+\b/i
  let shopCount = 0
  let employeeCount = 0
  const seenShops = new Set<string>()

  for (const row of rows) {
    const firstCell = row[0]?.trim() || ''
    if (shopPattern.test(firstCell)) {
      seenShops.add(firstCell)
      shopCount++
    } else if (firstCell && !/^(grand\s+)?total$/i.test(firstCell) && shopCount > 0) {
      // Non-shop, non-total row after we've seen shops = employee sub-row
      employeeCount++
    }
  }

  const isPivot = hasTotalRow && seenShops.size > 1

  return { isPivot, shopCount: seenShops.size, employeeCount }
}
