import { detectHeaderRow } from './columnDetect'

export interface ParseResult {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
  allRows: string[][]      // every raw row (stringified) — for header-row override
  headerRowIndex: number   // detected (or forced) header row, 0-based
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target!.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

// The actual CPU-heavy parsing (XLSX.read/sheet_to_json, Papa.parse, and the
// row-normalizing loop) runs in fileParser.worker.ts — a large spreadsheet
// spends seconds to tens of seconds there, which froze the tab when it ran
// on the main thread. One worker per call; it's terminated once it replies.
let reqId = 0
function runInWorker<T>(kind: 'csv' | 'xlsx' | 'xlsx-all', buffer: ArrayBuffer): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./fileParser.worker.ts', import.meta.url), { type: 'module' })
    const id = String(++reqId)
    worker.onmessage = (e: MessageEvent<{ id: string; ok: boolean; result?: T; error?: string }>) => {
      if (e.data.id !== id) return
      worker.terminate()
      if (e.data.ok) resolve(e.data.result as T)
      else reject(new Error(e.data.error ?? 'Parse failed'))
    }
    worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message || 'Parse failed')) }
    // The buffer is transferred (zero-copy), not cloned — safe since nothing
    // on this side reads it afterward.
    worker.postMessage({ id, kind, buffer }, [buffer])
  })
}

export async function parseFile(file: File): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  const buffer = await readFileAsArrayBuffer(file)

  if (ext === 'csv') return runInWorker<ParseResult>('csv', buffer)
  if (ext === 'xlsx' || ext === 'xls') return runInWorker<ParseResult>('xlsx', buffer)
  throw new Error(`Unsupported file type: .${ext}`)
}

export interface SheetParseResult { name: string; result: ParseResult }

// Parse every sheet in a workbook (CSV = one implicit sheet). Used by uploads
// that map each sheet to a different target (e.g. Parts / Oil / Additives / Total).
export async function parseAllSheets(file: File): Promise<SheetParseResult[]> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  const buffer = await readFileAsArrayBuffer(file)

  if (ext === 'csv') return [{ name: 'Sheet1', result: await runInWorker<ParseResult>('csv', buffer) }]
  if (ext === 'xlsx' || ext === 'xls') return runInWorker<SheetParseResult[]>('xlsx-all', buffer)
  throw new Error(`Unsupported file type: .${ext}`)
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '').trim()
}

// Returns true when every non-empty cell in the row exactly matches its header
// (case-insensitive). Used to discard repeated header rows from stacked tables.
function isDuplicateHeaderRow(record: Record<string, string>, headers: string[]): boolean {
  const nonEmpty = headers.filter(h => record[h] !== '')
  if (nonEmpty.length === 0) return false
  return nonEmpty.every(h => record[h].toLowerCase() === h.toLowerCase())
}

// forcedHeaderIndex overrides auto-detection (used by the manual header picker).
function processRawRows(raw: unknown[][], forcedHeaderIndex?: number): ParseResult {
  const { headerRowIndex, skippedRows } = forcedHeaderIndex != null
    ? { headerRowIndex: forcedHeaderIndex, skippedRows: forcedHeaderIndex }
    : detectHeaderRow(raw)
  const headerRow = raw[headerRowIndex]
  const headers = (headerRow ?? []).map(normalizeHeader).filter(Boolean)

  const dataRows = raw.slice(headerRowIndex + 1)
  const rows: Record<string, string>[] = []
  let dupHeadersSkipped = 0

  for (const row of dataRows) {
    const arr = row as unknown[]
    const hasData = arr.some((v) => String(v ?? '').trim() !== '')
    if (!hasData) continue

    const record: Record<string, string> = {}
    headers.forEach((h, i) => {
      record[h] = String(arr[i] ?? '').trim()
    })

    if (isDuplicateHeaderRow(record, headers)) { dupHeadersSkipped++; continue }
    rows.push(record)
  }

  const allRows = raw.map((r) => (r as unknown[]).map((c) => String(c ?? '')))
  return { headers, rows, skippedRows: skippedRows + dupHeadersSkipped, totalRowsParsed: rows.length, allRows, headerRowIndex }
}

// Re-derive a ParseResult from already-parsed raw rows using a chosen header
// row — powers the "override the detected header row" control. Runs on the
// main thread: it operates on data already held in memory (interactive,
// not the initial heavy parse) and every caller passes a bounded grid.
export function reprocessRows(allRows: string[][], headerRowIndex: number): ParseResult {
  return processRawRows(allRows, headerRowIndex)
}
