// Client-side port of data-connection-dispatcher/index.ts's own
// monthEndCountMonthFor — kept in sync by hand (edge functions and the app
// don't share a module graph). Used by useDataConnectionRunner.ts so the
// manual "Run Now" on the Droptop On Hand connection participates in the
// same count_products month-end feed the automated daily tick does,
// instead of never writing to count_products at all.
//
// Company-local "YYYY-MM-01" for the month currently in its month-end
// period (last 10 days of the month), OR the morning of the 1st of the
// FOLLOWING month (which still reflects the previous month's true last
// day's closing on-hand) — see the edge function's own comment for the
// day-1 carryover reasoning. Returns null outside both windows.
//
// `useStoredDataOnly` distinguishes the two cases for the CLIENT caller
// specifically (the edge function doesn't need this — its own automated
// tick always runs at one fixed early-morning time, so a live pull there
// is always a reasonable "yesterday just closed" proxy regardless of which
// branch fired). A MANUAL "Run Now" click can happen at any time of day,
// so the day-1 carryover case is a real risk there: a live pull run, say,
// at 2pm on the 1st would capture the NEW month's own partial-day activity
// and wrongly attribute it to the PREVIOUS month. Direct live incident
// 2026-10-02 — confirmed live pull was about to do exactly this. That case
// must be satisfied by replaying whatever is ALREADY stored in
// product_usage (from that morning's regular sync, untouched since) rather
// than a fresh API call — see backfill_count_products_from_product_usage
// (migration 20260930bz) and its caller in useDataConnectionRunner.ts.
export interface MonthEndCountMonthInfo {
  countMonth: string
  useStoredDataOnly: boolean
}

export function monthEndCountMonthFor(date: Date, timeZone: string): MonthEndCountMonthInfo | null {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const year = get('year'), month = get('month'), day = get('day')
  const lastDay = new Date(year, month, 0).getDate()
  if (day >= lastDay - 9) return { countMonth: `${year}-${String(month).padStart(2, '0')}-01`, useStoredDataOnly: false }
  if (day === 1) {
    const prevMonth = month === 1 ? 12 : month - 1
    const prevYear = month === 1 ? year - 1 : year
    return { countMonth: `${prevYear}-${String(prevMonth).padStart(2, '0')}-01`, useStoredDataOnly: true }
  }
  return null
}
