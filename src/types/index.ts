export * from './database'

export interface ColumnMapping {
  fieldName: string
  sourceColumn: string
  invert: boolean
}

export interface ParsedUpload {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
}
