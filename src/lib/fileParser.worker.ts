/// <reference lib="webworker" />
// Runs the CPU-heavy part of file parsing off the main thread. A 250k-row
// spreadsheet spends most of its time in XLSX.read/sheet_to_json and the
// row-normalizing loop below — synchronous work that, on the main thread,
// froze the tab for the whole duration. Message-passing the raw bytes in
// and the parsed rows back keeps the UI responsive regardless of file size.
//
// Mirrors the logic in fileParser.ts exactly (this file intentionally
// doesn't import from it, so the worker bundle stays self-contained and
// free of anything that isn't worker-safe) — keep the two in sync.
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { detectHeaderRow } from './columnDetect'

interface ParseResult {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
  allRows: string[][]
  headerRowIndex: number
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '').trim()
}

function isDuplicateHeaderRow(record: Record<string, string>, headers: string[]): boolean {
  const nonEmpty = headers.filter((h) => record[h] !== '')
  if (nonEmpty.length === 0) return false
  return nonEmpty.every((h) => record[h].toLowerCase() === h.toLowerCase())
}

function processRawRows(raw: unknown[][]): ParseResult {
  const { headerRowIndex, skippedRows } = detectHeaderRow(raw)
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
    headers.forEach((h, i) => { record[h] = String(arr[i] ?? '').trim() })

    if (isDuplicateHeaderRow(record, headers)) { dupHeadersSkipped++; continue }
    rows.push(record)
  }

  const allRows = raw.map((r) => (r as unknown[]).map((c) => String(c ?? '')))
  return { headers, rows, skippedRows: skippedRows + dupHeadersSkipped, totalRowsParsed: rows.length, allRows, headerRowIndex }
}

function parseCsvBuffer(buffer: ArrayBuffer): ParseResult {
  const text = new TextDecoder('utf-8').decode(buffer)
  const results = Papa.parse<unknown[]>(text, { header: false, skipEmptyLines: false })
  return processRawRows(results.data as unknown[][])
}

function readWorkbook(buffer: ArrayBuffer) {
  return XLSX.read(buffer, { type: 'array', cellDates: true })
}

function sheetToResult(workbook: XLSX.WorkBook, sheetName: string): ParseResult {
  const sheet = workbook.Sheets[sheetName]
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true })
  return processRawRows(raw)
}

function parseExcelBuffer(buffer: ArrayBuffer): ParseResult {
  const workbook = readWorkbook(buffer)
  return sheetToResult(workbook, workbook.SheetNames[0])
}

function parseAllSheetsBuffer(buffer: ArrayBuffer): { name: string; result: ParseResult }[] {
  const workbook = readWorkbook(buffer)
  return workbook.SheetNames.map((name) => ({ name, result: sheetToResult(workbook, name) }))
}

type Request =
  | { id: string; kind: 'csv'; buffer: ArrayBuffer }
  | { id: string; kind: 'xlsx'; buffer: ArrayBuffer }
  | { id: string; kind: 'xlsx-all'; buffer: ArrayBuffer }

self.onmessage = (e: MessageEvent<Request>) => {
  const { id, kind, buffer } = e.data
  try {
    const result = kind === 'csv' ? parseCsvBuffer(buffer)
      : kind === 'xlsx' ? parseExcelBuffer(buffer)
      : parseAllSheetsBuffer(buffer)
    ;(self as unknown as Worker).postMessage({ id, ok: true, result })
  } catch (err) {
    ;(self as unknown as Worker).postMessage({ id, ok: false, error: err instanceof Error ? err.message : 'Parse failed' })
  }
}
