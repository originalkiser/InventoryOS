export * from './database'

export type TransformKind = 'none' | 'number' | 'integer' | 'trim' | 'upper' | 'lower'

export interface ColumnMapping {
  fieldName: string
  sourceColumn: string
  invert: boolean
  // Optional value transform applied at import time (e.g. "001" → 1 via 'number')
  transform?: TransformKind
}

export interface ParsedUpload {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
}
