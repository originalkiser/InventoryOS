import {
  startOfWeek,
  endOfWeek,
  addDays,
  subWeeks,
  format,
  parseISO,
  isValid,
} from 'date-fns'

export function getWeekStart(date: Date): Date {
  return startOfWeek(date, { weekStartsOn: 1 }) // Monday
}

export function getWeekEnd(date: Date): Date {
  return addDays(getWeekStart(date), 4) // Friday
}

export function getThisWeekStart(): Date {
  return getWeekStart(new Date())
}

export function getThisWeekEnd(): Date {
  return getWeekEnd(new Date())
}

export function getThisWeekFriday(): Date {
  return getWeekEnd(new Date())
}

export function getLastWeekStart(): Date {
  return getWeekStart(subWeeks(new Date(), 1))
}

export function getLastWeekEnd(): Date {
  return getWeekEnd(subWeeks(new Date(), 1))
}

export function formatWeekLabel(start: Date, end: Date): string {
  const s = format(start, 'MMM d')
  const e = format(end, 'MMM d, yyyy')
  return `${s} – ${e}`
}

export function formatWeekLabelFromStrings(weekStart: string, weekEnd: string): string {
  const s = parseISO(weekStart)
  const e = parseISO(weekEnd)
  if (!isValid(s) || !isValid(e)) return weekStart
  return formatWeekLabel(s, e)
}

export function toDateString(date: Date): string {
  return format(date, 'yyyy-MM-dd')
}

export function parseDateSafe(str: string | null): Date | null {
  if (!str) return null
  const d = parseISO(str)
  return isValid(d) ? d : null
}

export function getDaysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const d = parseDateSafe(dateStr)
  if (!d) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  d.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}
