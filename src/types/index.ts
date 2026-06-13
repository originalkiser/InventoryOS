export * from './database'
export type { Transform } from '@/lib/transforms'

export type TransformKind = 'none' | 'number' | 'integer' | 'trim' | 'upper' | 'lower'

// Sentinel sourceColumn meaning "use the constant value for every row".
export const CONSTANT_SOURCE = '__constant__'

export interface ColumnMapping {
  fieldName: string
  sourceColumn: string
  invert: boolean
  // Optional value transform applied at import time (e.g. "001" → 1 via 'number')
  transform?: TransformKind
  // Optional ordered chain of richer transforms (multiply, phone, date, …),
  // applied after the legacy `transform`. See lib/transforms.ts.
  transforms?: import('@/lib/transforms').Transform[]
  // When sourceColumn === CONSTANT_SOURCE, this value is applied to all rows.
  constant?: string
}

export interface ParsedUpload {
  headers: string[]
  rows: Record<string, string>[]
  skippedRows: number
  totalRowsParsed: number
}
