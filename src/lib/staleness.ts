// Shared "needs action" staleness logic for Exception Reporting and Location
// Comms rows (and their nav badge counts). A row is stale ("needs action")
// when it isn't closed, its reference date is old enough, and it isn't
// currently bumped/snoozed. Separate from Exception Reporting's "response
// window" setting, which drives RD escalation, not this highlighting.

export const isClosedStatus = (status: string | null | undefined): boolean =>
  (status ?? '').toLowerCase().includes('closed')

// Opaque light-red row tint for stale rows in sticky-column tables. Must be
// a solid color, not a translucent bg-[#C0392B]/N — sticky columns rely on
// an opaque background to hide horizontally-scrolled columns behind them; a
// translucent tint lets that scrolled content bleed through visibly.
export const STALE_ROW_BG = 'bg-[#F4DBD4] dark:bg-[#3A1F1C]'

// ISO date-only string (YYYY-MM-DD) for "today + days" — used to store a
// bump/snooze target in a row's metadata.
export function bumpedUntilISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + Math.max(1, days))
  return d.toISOString().slice(0, 10)
}

function daysSinceDate(dateStr: string): number {
  const start = new Date(dateStr + 'T00:00:00').getTime()
  return Math.floor((Date.now() - start) / 86400000)
}

// Is `metadata.bumped_until` still in the future (row is snoozed)?
export function isBumped(metadata: Record<string, unknown> | null | undefined): boolean {
  const until = (metadata as any)?.bumped_until as string | undefined
  if (!until) return false
  return new Date(until + 'T00:00:00').getTime() > Date.now()
}

// A row "needs action" (and should count toward the nav badge / red highlight)
// when: not closed, has a reference date, that date is `staleDays`+ old, and
// it isn't currently bumped.
export function isStaleRecord(
  status: string | null | undefined,
  referenceDate: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
  staleDays: number,
): boolean {
  if (isClosedStatus(status)) return false
  if (!referenceDate) return false
  if (isBumped(metadata)) return false
  return daysSinceDate(referenceDate) >= staleDays
}
