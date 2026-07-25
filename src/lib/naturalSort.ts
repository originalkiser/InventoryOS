// Numeric-aware string comparison so location labels like "2-City" sort before
// "11-City" (and "155-City" after "99-City") instead of pure lexicographic
// order ("1", "11", "155", "2"). Used wherever locations are listed.
export function naturalCompare(a: string | null | undefined, b: string | null | undefined): number {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' })
}

// Convenience comparator for option lists sorted by their display label.
export function byNaturalLabel<T extends { label: string }>(a: T, b: T): number {
  return naturalCompare(a.label, b.label)
}
