// Column filter values for DataTable (useTable's default filterFn + ColumnFilter's UI). A column's filter value is
// one of:
//   string[]                                  — the original Excel-style "these exact values" list
//   { kind: 'adv', list?, num?, colors? }     — for columns that opt in via column meta:
//       meta.numeric          -> a number test (less than / greater than / between)
//       meta.colorOf(row)     -> filter by conditional-formatting color key
//       meta.multiValue(row)  -> the row has SEVERAL values (e.g. a set of flags); a list match is "any of"
// Pure and framework-free so it can be tested.

export type NumOp = 'lt' | 'gt' | 'between'
export interface NumFilter { op: NumOp; a: number; b?: number }
export interface AdvFilter { kind: 'adv'; list?: string[]; num?: NumFilter; colors?: string[] }
export type ColumnFilterValue = string[] | AdvFilter

export interface NormalizedFilter { list: string[]; num: NumFilter | null; colors: string[] }

export function normalizeFilter(v: unknown): NormalizedFilter {
  if (Array.isArray(v)) return { list: v as string[], num: null, colors: [] }
  if (v && typeof v === 'object' && (v as AdvFilter).kind === 'adv') {
    const a = v as AdvFilter
    return { list: a.list ?? [], num: a.num ?? null, colors: a.colors ?? [] }
  }
  return { list: [], num: null, colors: [] }
}

/** Collapse back to the smallest representation (undefined = no filter, a bare array when only a list is set). */
export function packFilter(n: NormalizedFilter): ColumnFilterValue | undefined {
  if (!n.list.length && !n.num && !n.colors.length) return undefined
  if (!n.num && !n.colors.length) return n.list
  return { kind: 'adv', ...(n.list.length ? { list: n.list } : {}), ...(n.num ? { num: n.num } : {}), ...(n.colors.length ? { colors: n.colors } : {}) }
}

export function filterActiveCount(v: unknown): number {
  const n = normalizeFilter(v)
  return n.list.length + (n.num ? 1 : 0) + n.colors.length
}

export function numMatches(value: unknown, f: NumFilter): boolean {
  const x = typeof value === 'number' ? value : Number(value)
  if (value == null || value === '' || !Number.isFinite(x)) return false
  if (f.op === 'lt') return x < f.a
  if (f.op === 'gt') return x > f.a
  const lo = Math.min(f.a, f.b ?? f.a), hi = Math.max(f.a, f.b ?? f.a)
  return x >= lo && x <= hi
}

export interface RowAccess {
  value: unknown
  multi?: string[] | null
  color?: string | null
}

export function rowMatchesFilter(v: unknown, r: RowAccess): boolean {
  const n = normalizeFilter(v)
  if (n.list.length) {
    const hit = r.multi ? r.multi.some((m) => n.list.includes(m)) : n.list.includes(String(r.value ?? ''))
    if (!hit) return false
  }
  if (n.num && !numMatches(r.value, n.num)) return false
  if (n.colors.length && !(r.color && n.colors.includes(r.color))) return false
  return true
}
