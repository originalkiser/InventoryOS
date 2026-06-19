export function isMonthEndPeriod(date: Date = new Date()): boolean {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  return date.getDate() >= lastDay - 9 // last 10 days of the month
}

export function getMonthEndPeriodRange(date: Date = new Date()): { start: Date; end: Date } {
  const year = date.getFullYear()
  const month = date.getMonth()
  const lastDay = new Date(year, month + 1, 0)
  const startDay = new Date(year, month, lastDay.getDate() - 9)
  return { start: startDay, end: lastDay }
}

export function daysUntilMonthEndPeriod(date: Date = new Date()): number {
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
  const startOfPeriod = lastDay - 9
  return Math.max(0, startOfPeriod - date.getDate())
}
