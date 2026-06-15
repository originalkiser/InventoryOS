// Port of order-generator unused-row detection logic

export function isEmptyCell(value: unknown): boolean {
  if (value === null || value === undefined) return true
  const str = String(value).trim()
  return str === '' || str === 'null' || str === 'undefined'
}

export function isNonAlphanumericCell(value: unknown): boolean {
  const str = String(value ?? '').trim()
  return str !== '' && !/[a-zA-Z0-9]/.test(str)
}

export function isHeaderCandidate(row: unknown[]): boolean {
  const nonEmpty = row.filter((v) => !isEmptyCell(v))
  if (nonEmpty.length === 0) return false

  const shortStringCount = nonEmpty.filter((v) => {
    const s = String(v).trim()
    return s.length > 0 && s.length <= 60 && isNaN(Number(s))
  }).length

  return shortStringCount / nonEmpty.length > 0.5
}

export function isJunkRow(row: unknown[]): boolean {
  if (row.length === 0) return true
  const empty = row.filter(isEmptyCell).length
  const nonAlpha = row.filter(isNonAlphanumericCell).length
  const total = row.length
  return empty / total > 0.6 || (empty + nonAlpha) / total === 1
}

export interface HeaderDetectionResult {
  headerRowIndex: number
  skippedRows: number
}

export function detectHeaderRow(rows: unknown[][]): HeaderDetectionResult {
  // Among the first rows, pick the header CANDIDATE with the most filled cells —
  // the real header row usually spans the most columns, so this skips short
  // banner/title rows that would otherwise be chosen first.
  const limit = Math.min(rows.length, 20)
  let best = -1
  let bestFilled = -1
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? []
    if (isJunkRow(row) || !isHeaderCandidate(row)) continue
    const filled = row.filter((v) => !isEmptyCell(v)).length
    if (filled > bestFilled) { bestFilled = filled; best = i }
  }
  if (best >= 0) return { headerRowIndex: best, skippedRows: best }
  return { headerRowIndex: 0, skippedRows: 0 }
}
