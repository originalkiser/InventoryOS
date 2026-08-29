// Formats a timestamp the way the data-connection-dispatcher edge function
// itself reasons about "when" — in the company's configured operating
// timezone (inventory.data_connection_timezone / useAppSetting), not the
// viewer's own browser/OS timezone. A plain `date-fns format(new Date(iso))`
// renders in local time, which reads as "wrong" to anyone not physically in
// that timezone even though the schedule/sync itself ran exactly on time.
export function formatInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const date = d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true })
  return `${date}, ${time}`
}
