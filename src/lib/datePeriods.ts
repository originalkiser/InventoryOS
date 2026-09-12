// Shared date-period presets for the Droptop Orders-based reports
// (Customer Heatmap, Droptop Orders page) — same period picker, same
// remembered-selection behavior, on both. Weeks are Sunday-start (US
// retail/business convention, matching this app's audience).
export type DatePeriod = 'wtd' | 'last_week' | 'mtd' | 'last_month' | 'last_3_months' | 'custom'

export const PERIOD_LABELS: Record<DatePeriod, string> = {
  wtd: 'Week to Date',
  last_week: 'Last Week',
  mtd: 'Month to Date',
  last_month: 'Last Month',
  last_3_months: 'Last 3 Months',
  custom: 'Custom',
}
export const PERIOD_ORDER: DatePeriod[] = ['wtd', 'last_week', 'mtd', 'last_month', 'last_3_months', 'custom']

const iso = (d: Date) => d.toISOString().slice(0, 10)

function startOfWeek(d: Date): Date {
  const r = new Date(d)
  r.setHours(0, 0, 0, 0)
  r.setDate(r.getDate() - r.getDay()) // getDay(): 0 = Sunday
  return r
}

export interface DateRange { start: string; end: string } // yyyy-mm-dd

// "MM/DD" for one side of a range label — parsed from a 'yyyy-mm-dd'
// string via split/Number rather than `new Date(range.start)`, which
// parses a bare date string as UTC midnight and can display as the
// previous day in any negative-UTC-offset timezone (all of the US).
function monthDay(isoDate: string): { month: number; day: number; year: number } {
  const [y, m, d] = isoDate.split('-').map(Number)
  return { year: y, month: m, day: d }
}
const pad2 = (n: number) => String(n).padStart(2, '0')

// "08/30-09/05/2026", or "12/28/2026-01/03/2027" if the range crosses a
// year boundary — the 4-digit year only needs to appear once (at the end)
// when both sides share a year, otherwise it's shown on both sides so
// neither date reads as ambiguous.
export function formatRangeLabel(range: DateRange): string {
  const s = monthDay(range.start)
  const e = monthDay(range.end)
  const startStr = `${pad2(s.month)}/${pad2(s.day)}`
  const endStr = `${pad2(e.month)}/${pad2(e.day)}`
  if (s.year === e.year) return `${startStr}-${endStr}/${e.year}`
  return `${startStr}/${s.year}-${endStr}/${e.year}`
}

// A named period's dropdown option shouldn't just say "Last Week" — it
// should say what dates that actually resolves to right now, so it's
// never ambiguous which week/month is currently selected.
export function formatPeriodOptionLabel(period: DatePeriod, custom?: DateRange): string {
  if (period === 'custom') return PERIOD_LABELS.custom
  return `${PERIOD_LABELS[period]} (${formatRangeLabel(computeRange(period, custom))})`
}

export function computeRange(period: DatePeriod, custom?: DateRange): DateRange {
  const now = new Date()
  switch (period) {
    case 'wtd':
      return { start: iso(startOfWeek(now)), end: iso(now) }
    case 'last_week': {
      const thisWeekStart = startOfWeek(now)
      const lastWeekStart = new Date(thisWeekStart)
      lastWeekStart.setDate(lastWeekStart.getDate() - 7)
      const lastWeekEnd = new Date(thisWeekStart)
      lastWeekEnd.setDate(lastWeekEnd.getDate() - 1)
      return { start: iso(lastWeekStart), end: iso(lastWeekEnd) }
    }
    case 'mtd':
      return { start: iso(new Date(now.getFullYear(), now.getMonth(), 1)), end: iso(now) }
    case 'last_month': {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
      const end = new Date(now.getFullYear(), now.getMonth(), 0) // day 0 of this month = last day of prev month
      return { start: iso(start), end: iso(end) }
    }
    case 'last_3_months': {
      const start = new Date(now)
      start.setDate(start.getDate() - 90)
      return { start: iso(start), end: iso(now) }
    }
    case 'custom':
    default:
      return custom ?? { start: iso(now), end: iso(now) }
  }
}
