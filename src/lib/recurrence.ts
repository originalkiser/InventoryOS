// Recurrence generation for schedule events. Produces the sequence of "anchor"
// dates (yyyy-MM-dd) a recurring event lands on. The caller derives each
// occurrence's start/end from the anchor + the event's duration.
import { parseISO, format, addDays, addWeeks, addMonths, differenceInCalendarDays } from 'date-fns'

export type RecurrenceMode =
  | 'daily'
  | 'weekly'
  | 'monthly_date'          // same day-of-month (e.g. the 10th)
  | 'monthly_nth_weekday'   // e.g. 2nd Monday
  | 'monthly_last_weekday'  // last Monday
  | 'monthly_last_full_week' // the <weekday> of the last full Mon–Sun week

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`
}

/** Weekday / week-of-month facts about a date, used to describe recurrence options. */
export function anchorInfo(dateStr: string) {
  const d = parseISO(dateStr)
  const weekday = d.getDay()
  const dom = d.getDate()
  const nth = Math.ceil(dom / 7)
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const isLast = dom + 7 > daysInMonth
  return { weekday, weekdayName: WEEKDAY_NAMES[weekday], nth, isLast }
}

/** Selectable recurrence options with labels derived from the anchor date. */
export function recurrenceOptions(anchorDateStr: string | null): { value: 'none' | RecurrenceMode; label: string }[] {
  const base: { value: 'none' | RecurrenceMode; label: string }[] = [
    { value: 'none', label: 'None' },
    { value: 'daily', label: 'Daily' },
  ]
  if (!anchorDateStr) {
    return [...base, { value: 'weekly', label: 'Weekly' }, { value: 'monthly_date', label: 'Monthly (by date)' }]
  }
  const { weekdayName, nth } = anchorInfo(anchorDateStr)
  const dom = parseISO(anchorDateStr).getDate()
  return [
    ...base,
    { value: 'weekly', label: `Weekly (every ${weekdayName})` },
    { value: 'monthly_date', label: `Monthly (day ${dom})` },
    { value: 'monthly_nth_weekday', label: `Monthly (${ordinal(nth)} ${weekdayName})` },
    { value: 'monthly_last_weekday', label: `Monthly (last ${weekdayName})` },
    { value: 'monthly_last_full_week', label: `Monthly (${weekdayName} of last full week)` },
  ]
}

function nthWeekdayOfMonth(year: number, month0: number, weekday: number, n: number): Date | null {
  const firstDow = new Date(year, month0, 1).getDay()
  let day = 1 + ((weekday - firstDow + 7) % 7) + (n - 1) * 7
  const dim = new Date(year, month0 + 1, 0).getDate()
  return day > dim ? null : new Date(year, month0, day)
}

function lastWeekdayOfMonth(year: number, month0: number, weekday: number): Date {
  const dim = new Date(year, month0 + 1, 0).getDate()
  const lastDow = new Date(year, month0, dim).getDay()
  return new Date(year, month0, dim - ((lastDow - weekday + 7) % 7))
}

// The <weekday> of the last full Mon–Sun week wholly within the month.
function weekdayOfLastFullWeek(year: number, month0: number, weekday: number): Date {
  const dim = new Date(year, month0 + 1, 0).getDate()
  const lastDay = new Date(year, month0, dim)
  const mondayOffset = (lastDay.getDay() + 6) % 7 // days since Monday
  let monday = new Date(year, month0, dim - mondayOffset)
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6)
  if (sunday.getMonth() !== month0) monday.setDate(monday.getDate() - 7) // week not full → previous
  const offsetFromMonday = (weekday + 6) % 7 // Monday=0 … Sunday=6
  const res = new Date(monday); res.setDate(monday.getDate() + offsetFromMonday)
  return res
}

/**
 * Anchor dates (yyyy-MM-dd) from `anchorStart` through `until` (inclusive),
 * capped at `max`. `until` null → one year out. The first date equals the
 * anchor itself for weekday-based modes.
 */
export function generateOccurrences(anchorStart: string, until: string | null, mode: RecurrenceMode, max: number): string[] {
  const start = parseISO(anchorStart)
  const horizon = until ? parseISO(until) : addMonths(start, 12)
  const out: string[] = []
  const push = (d: Date) => { if (d >= start && d <= horizon && out.length < max) out.push(format(d, 'yyyy-MM-dd')) }

  if (mode === 'daily' || mode === 'weekly' || mode === 'monthly_date') {
    let d = start
    const step = (x: Date) => (mode === 'weekly' ? addWeeks(x, 1) : mode === 'monthly_date' ? addMonths(x, 1) : addDays(x, 1))
    while (d <= horizon && out.length < max) { out.push(format(d, 'yyyy-MM-dd')); d = step(d) }
    return out
  }

  // Weekday-based monthly modes: walk month by month.
  const { weekday, nth } = anchorInfo(anchorStart)
  let cursor = new Date(start.getFullYear(), start.getMonth(), 1)
  const guard = differenceInCalendarDays(horizon, start) + 40
  for (let i = 0; i < guard && out.length < max; i++) {
    const y = cursor.getFullYear(), m = cursor.getMonth()
    let d: Date | null = null
    if (mode === 'monthly_nth_weekday') d = nthWeekdayOfMonth(y, m, weekday, nth)
    else if (mode === 'monthly_last_weekday') d = lastWeekdayOfMonth(y, m, weekday)
    else if (mode === 'monthly_last_full_week') d = weekdayOfLastFullWeek(y, m, weekday)
    if (d) push(d)
    cursor = addMonths(cursor, 1)
    if (cursor > horizon) break
  }
  return out
}
