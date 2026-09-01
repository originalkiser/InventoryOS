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
