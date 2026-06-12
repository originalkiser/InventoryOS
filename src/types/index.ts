export * from './database'

export type TransformKind = 'none' | 'number' | 'integer' | 'trim' | 'upper' | 'lower'

// Sentinel sourceColumn meaning "use the constant value for every row".
export const CONSTANT_SOURCE = '__constant__'

export interface ColumnMapping {
  fieldName: string
  sourceColumn: string
  invert: boolean
  // Optional value transform applied at import time (e.g. "001" → 1 via 'number')
  transform?: TransformKind
  // When sourceColumn === CONSTANT_SOURCE, this value is applied to all rows.
  constant?: string
}

export interface ParsedUpload {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
}
