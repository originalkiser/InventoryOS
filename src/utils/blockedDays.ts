import { format } from 'date-fns'

export type RawBlockedDay = string | { date: string; note?: string }
export type NormalizedBlockedDay = { date: string; note?: string }

/** Accepts both legacy string arrays and new object arrays. Always returns sorted objects. */
export function normalizeBlockedDays(
  raw: RawBlockedDay[] | null | undefined,
): NormalizedBlockedDay[] {
  if (!raw) return []
  return (raw as RawBlockedDay[])
    .map((d) => (typeof d === 'string' ? { date: d } : d))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** "Thu, Jul 2, 2026" or "Thu, Jul 2, 2026 (Vacation)" */
export function formatBlockedDayLabel(bd: NormalizedBlockedDay): string {
  const label = format(new Date(bd.date + 'T00:00:00'), 'EEE, MMM d, yyyy')
  return bd.note ? `${label} (${bd.note})` : label
}

/** Insert or replace by date, keeping sorted. */
export function upsertBlockedDay(
  existing: NormalizedBlockedDay[],
  entry: NormalizedBlockedDay,
): NormalizedBlockedDay[] {
  return [...existing.filter((d) => d.date !== entry.date), entry].sort((a, b) =>
    a.date.localeCompare(b.date),
  )
}

/** Remove by date. */
export function removeBlockedDay(
  existing: NormalizedBlockedDay[],
  date: string,
): NormalizedBlockedDay[] {
  return existing.filter((d) => d.date !== date)
}
