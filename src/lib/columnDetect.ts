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
  // Collect the header CANDIDATES in the first rows with how many cells each
  // fills. The real header usually spans (nearly) the most columns.
  const limit = Math.min(rows.length, 20)
  const candidates: { index: number; filled: number }[] = []
  for (let i = 0; i < limit; i++) {
    const row = rows[i] ?? []
    if (isJunkRow(row) || !isHeaderCandidate(row)) continue
    candidates.push({ index: i, filled: row.filter((v) => !isEmptyCell(v)).length })
  }
  if (candidates.length === 0) return { headerRowIndex: 0, skippedRows: 0 }

  // Pick the EARLIEST candidate whose width is within ~20% of the widest. This
  // skips short banner/title rows (few cells) but keeps a real header row at the
  // top from being beaten by a lone data row that fills one extra column.
  const maxFilled = Math.max(...candidates.map((c) => c.filled))
  const threshold = maxFilled * 0.8
  const best = candidates.find((c) => c.filled >= threshold) ?? candidates[0]
  return { headerRowIndex: best.index, skippedRows: best.index }
}
