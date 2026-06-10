import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { detectHeaderRow } from './columnDetect'

export interface ParseResult {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
}

function normalizeHeader(h: unknown): string {
  return String(h ?? '').trim()
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target!.result as ArrayBuffer)
    reader.onerror = reject
    reader.readAsArrayBuffer(file)
  })
}

export async function parseFile(file: File): Promise<ParseResult> {
  const ext = file.name.split('.').pop()?.toLowerCase()

  if (ext === 'csv') {
    return parseCsv(file)
  } else if (ext === 'xlsx' || ext === 'xls') {
    return parseExcel(file)
  }
  throw new Error(`Unsupported file type: .${ext}`)
}

function parseCsv(file: File): Promise<ParseResult> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false,
      skipEmptyLines: false,
      complete: (results) => {
        try {
          const raw = results.data as unknown[][]
          resolve(processRawRows(raw))
        } catch (e) {
          reject(e)
        }
      },
      error: reject,
    })
  })
}

async function parseExcel(file: File): Promise<ParseResult> {
  const buffer = await readFileAsArrayBuffer(file)
  const workbook = XLSX.read(buffer, { type: 'array' })
  const sheetName = workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  return processRawRows(raw)
}

function processRawRows(raw: unknown[][]): ParseResult {
  const { headerRowIndex, skippedRows } = detectHeaderRow(raw)
  const headerRow = raw[headerRowIndex]
  const headers = (headerRow ?? []).map(normalizeHeader).filter(Boolean)

  const dataRows = raw.slice(headerRowIndex + 1)
  const rows: Record<string, string>[] = []

  for (const row of dataRows) {
    const arr = row as unknown[]
    const hasData = arr.some((v) => String(v ?? '').trim() !== '')
    if (!hasData) continue

    const record: Record<string, string> = {}
    headers.forEach((h, i) => {
      record[h] = String(arr[i] ?? '').trim()
    })
    rows.push(record)
  }

  return { headers, rows, skippedRows, totalRowsParsed: rows.length }
}
