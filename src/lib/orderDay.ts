// Order day = delivery day minus 3 business days (weekends excluded, no holiday
// skipping — matches the ordering business rules). Works on weekday names, since
// reladyne_delivery_day is stored as a day-of-week string.
//
//   Monday    delivery → Wednesday order (prior week)
//   Tuesday   delivery → Thursday  order
//   Wednesday delivery → Friday    order
//   Thursday  delivery → Monday    order
//   Friday    delivery → Tuesday   order

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Parse a weekday name ("Monday", "mon", "MON") to 0–6 (Sun=0), or null. */
export function parseWeekday(value: string | null | undefined): number | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  const idx = DAY_NAMES.findIndex((d) => d.toLowerCase() === v || d.toLowerCase().startsWith(v) || v.startsWith(d.slice(0, 3).toLowerCase()))
  return idx === -1 ? null : idx
}

/** Walk back `n` business days (skipping Sat/Sun) from a weekday index. */
export function subtractBusinessDays(weekday: number, n: number): number {
  let d = weekday
  let remaining = n
  while (remaining > 0) {
    d = (d + 6) % 7 // step back one calendar day
    if (d !== 0 && d !== 6) remaining-- // only Mon–Fri count
  }
  return d
}

/** Order day (weekday name) for a given delivery-day name. '' if unparseable. */
export function orderDayFromDelivery(deliveryDay: string | null | undefined): string {
  const wd = parseWeekday(deliveryDay)
  if (wd === null) return ''
  return DAY_NAMES[subtractBusinessDays(wd, 3)]
}
