import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button } from '@/components/ui'
import type { Location } from '@/types'
import { differenceInDays, format } from 'date-fns'
import toast from 'react-hot-toast'

interface NotSubmittedRow {
  location_code: string
  name: string
  region: string
  days_since: number
  last_submitted: string // ISO date or ''
}

interface Props {
  companyId: string
  periodStartISO: string // first-of-period date used for "days since period start"
  periodLabel: string // e.g. "June 2026" or "Week of Jun 9"
  missing: Location[] // active shops with no submission this period
  totalActive: number
  lastSubmittedByLoc: Record<string, string | null> // location_id -> ISO date of most recent prior submission
  reminderTitle: string
  exportPrefix: string // CSV filename prefix, e.g. "monthend_not_submitted"
  lastSubmittedFormat?: string // date-fns format for the "Last Submitted" column
  loading?: boolean
}

const col = createColumnHelper<NotSubmittedRow>()

export function NotSubmittedPanel({
  companyId, periodStartISO, periodLabel, missing, totalActive, lastSubmittedByLoc,
  reminderTitle, exportPrefix, lastSubmittedFormat = 'MMM yyyy', loading,
}: Props) {
  const submitted = totalActive - missing.length
  const pct = totalActive > 0 ? Math.round((submitted / totalActive) * 100) : 0
  const daysSince = Math.max(0, differenceInDays(new Date(), new Date(periodStartISO)))

  const rows: NotSubmittedRow[] = useMemo(() => missing.map((l) => ({
    location_code: l.location_code,
    name: l.name,
    region: l.region ?? '',
    days_since: daysSince,
    last_submitted: lastSubmittedByLoc[l.id] ?? '',
  })), [missing, lastSubmittedByLoc, daysSince])

  const columns = useMemo(() => [
    col.accessor('location_code', { header: 'Code' }),
    col.accessor('name', { header: 'Name' }),
    col.accessor('region', { header: 'Region', cell: (i) => i.getValue() || '—' }),
    col.accessor('days_since', { header: 'Days Since Period Start', cell: (i) => `${i.getValue()}d` }),
    col.accessor('last_submitted', {
      header: 'Last Submitted',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()), lastSubmittedFormat) : <span className="text-inky/70">Never</span>),
    }),
  ], [lastSubmittedFormat])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns)

  function copyList() {
    if (!missing.length) { toast('Nothing to copy — all shops submitted', { icon: '✅' }); return }
    const text = missing.map((l) => `${l.location_code} — ${l.name}`).join('\n')
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`Copied ${missing.length} shop${missing.length === 1 ? '' : 's'}`))
      .catch(() => toast.error('Clipboard not available'))
  }

  async function createReminder() {
    if (!missing.length) { toast('All shops submitted — no reminder needed', { icon: '✅' }); return }
    const today = format(new Date(), 'yyyy-MM-dd')
    const notes = `Shops not submitted for ${periodLabel} (${missing.length}):\n` +
      missing.map((l) => `• ${l.location_code} — ${l.name}`).join('\n')
    const { error } = await (supabase as any).from('schedule_events').insert({
      company_id: companyId,
      title: reminderTitle,
      event_type: 'reminder',
      start_date: today,
      is_checklist: true,
      completed: false,
      notes,
    })
    if (error) toast.error(error.message)
    else toast.success('Reminder added to schedule')
  }

  const exportRows = rows.map((r) => ({
    code: r.location_code,
    name: r.name,
    region: r.region,
    days_since_period_start: r.days_since,
    last_submitted: r.last_submitted ? format(new Date(r.last_submitted), 'yyyy-MM') : 'Never',
  }))

  return (
    <div className="flex flex-col gap-4">
      {/* Header stat + progress bar */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs font-mono text-inky">
            <span className={submitted === totalActive ? 'text-green-700' : 'text-orange-600'}>{submitted}</span>
            <span className="text-inky"> of {totalActive} shops submitted for {periodLabel}</span>
          </span>
          <span className="text-xs font-mono text-inky">{pct}%</span>
        </div>
        <div className="h-2 w-full bg-cream border border-navy/30 rounded overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${pct}%`,
              background: submitted === totalActive ? '#39ff14' : '#ffb300',
            }}
          />
        </div>
      </div>

      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={`${exportPrefix}_${periodStartISO}.csv`}
        exportData={exportRows}
        loading={loading}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={copyList}>Copy List</Button>
            <Button size="sm" onClick={createReminder}>Create Reminder</Button>
          </>
        }
      />
    </div>
  )
}
