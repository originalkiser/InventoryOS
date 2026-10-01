// Client-side port of data-connection-dispatcher/index.ts's own
// monthEndCountMonthFor — kept in sync by hand (edge functions and the app
// don't share a module graph). Used by useDataConnectionRunner.ts so the
// manual "Run Now" on the Droptop On Hand connection participates in the
// same count_products month-end feed the automated daily tick does,
// instead of never writing to count_products at all (confirmed gap, direct
// ask 2026-10-02 — the automated tick had already run for the day using
// the OLD (pre-fix) logic, so the only way to catch today up was giving
// Run Now this same capability).
//
// Company-local "YYYY-MM-01" for the month currently in its month-end
// period (last 10 days of the month), OR the morning of the 1st of the
// FOLLOWING month (which still reflects the previous month's true last
// day's closing on-hand) — see the edge function's own comment for the
// day-1 carryover reasoning. Returns null outside both windows.
export function monthEndCountMonthFor(date: Date, timeZone: string): string | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const year = get('year'), month = get('month'), day = get('day')
  const lastDay = new Date(year, month, 0).getDate()
  if (day >= lastDay - 9) return `${year}-${String(month).padStart(2, '0')}-01`
  if (day === 1) {
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    return `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`
  }
  return null
}
