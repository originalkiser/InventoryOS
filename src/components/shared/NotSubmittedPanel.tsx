import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button } from '@/components/ui'
import type { Location } from '@/types'
import { differenceInDays, format } from 'date-fns'
import toast from 'react-hot-toast'

interface MetaColumn {
  key: string
  header: string
}

interface NotSubmittedRow {
  location_id: string
  location_code: string
  name: string
  region: string
  _meta: Record<string, string>
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
  metaColumns?: MetaColumn[]
  loading?: boolean
}

const col = createColumnHelper<NotSubmittedRow>()

export function NotSubmittedPanel({
  companyId, periodStartISO, periodLabel, missing, totalActive, lastSubmittedByLoc,
  reminderTitle, exportPrefix, lastSubmittedFormat = 'MMM yyyy', metaColumns, loading,
}: Props) {
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [marking, setMarking] = useState<Set<string>>(new Set())

  const submitted = totalActive - missing.length + confirmed.size
  const pct = totalActive > 0 ? Math.round((submitted / totalActive) * 100) : 0
  const daysSince = Math.max(0, differenceInDays(new Date(), new Date(periodStartISO)))

  const allRows: NotSubmittedRow[] = useMemo(() => missing.map((l) => {
    const meta = (l.metadata ?? {}) as Record<string, unknown>
    const metaVals: Record<string, string> = {}
    for (const mc of (metaColumns ?? [])) {
      metaVals[mc.key] = meta[mc.key] != null ? String(meta[mc.key]) : ''
    }
    return {
      location_id: l.id,
      location_code: l.location_code,
      name: l.name,
      region: l.region ?? '',
      _meta: metaVals,
      days_since: daysSince,
      last_submitted: lastSubmittedByLoc[l.id] ?? '',
    }
  }), [missing, lastSubmittedByLoc, daysSince, metaColumns])

  const rows = useMemo(() => allRows.filter((r) => !confirmed.has(r.location_id)), [allRows, confirmed])
  const confirmedRows = useMemo(() => allRows.filter((r) => confirmed.has(r.location_id)), [allRows, confirmed])

  async function markCounted(locationId: string, locationCode: string) {
    setMarking((p) => new Set([...p, locationId]))
    const { error } = await (supabase as any).schema('inventory').from('manual_count_entries').upsert(
      { company_id: companyId, location_id: locationId, count_period: periodStartISO },
      { onConflict: 'company_id,location_id,count_period' },
    )
    setMarking((p) => { const n = new Set(p); n.delete(locationId); return n })
    if (error) { toast.error(error.message); return }
    setConfirmed((p) => new Set([...p, locationId]))
    toast.success(`${locationCode} marked as manually counted`)
  }

  const columns = useMemo(() => {
    const cols: any[] = [
      col.accessor('location_code', { header: 'Code' }),
      col.accessor('name', { header: 'Name' }),
      col.accessor('region', { header: 'Region', cell: (i: any) => i.getValue() || '—' }),
    ]
    for (const mc of (metaColumns ?? [])) {
      cols.push({
        id: `meta_${mc.key}`,
        header: mc.header,
        accessorFn: (row: NotSubmittedRow) => row._meta[mc.key] ?? '',
        cell: (i: any) => i.getValue() || '—',
      })
    }
    cols.push(col.accessor('days_since', { header: 'Days Since Period Start', cell: (i: any) => `${i.getValue()}d` }))
    cols.push(col.accessor('last_submitted', {
      header: 'Last Submitted',
      cell: (i: any) => (i.getValue() ? format(new Date(i.getValue()), lastSubmittedFormat) : <span className="text-inky/70">Never</span>),
    }))
    cols.push({
      id: 'mark_counted',
      header: '',
      accessorFn: (row: NotSubmittedRow) => row.location_id,
      cell: (i: any) => {
        const locId = i.getValue() as string
        const locCode = i.row.original.location_code as string
        const busy = marking.has(locId)
        return (
          <button
            onClick={() => markCounted(locId, locCode)}
            disabled={busy}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-navy/20 text-inky hover:border-navy/50 hover:text-navy transition-colors disabled:opacity-40"
          >
            {busy ? '…' : 'Mark Counted'}
          </button>
        )
      },
    })
    return cols
  }, [lastSubmittedFormat, metaColumns, marking])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns)

  function copyList() {
    const pending = missing.filter((l) => !confirmed.has(l.id))
    if (!pending.length) { toast('Nothing to copy — all shops submitted or confirmed', { icon: '✅' }); return }
    const text = pending.map((l) => `${l.location_code} — ${l.name}`).join('\n')
    navigator.clipboard.writeText(text)
      .then(() => toast.success(`Copied ${pending.length} shop${pending.length === 1 ? '' : 's'}`))
      .catch(() => toast.error('Clipboard not available'))
  }

  async function createReminder() {
    if (!missing.length) { toast('All shops submitted — no reminder needed', { icon: '✅' }); return }
    const today = format(new Date(), 'yyyy-MM-dd')
    const notes = `Shops not submitted for ${periodLabel} (${missing.length}):\n` +
      missing.map((l) => `• ${l.location_code} — ${l.name}`).join('\n')
    const { error } = await (supabase as any).schema('platform').from('schedule_events').insert({
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

  const exportRows = rows.map((r) => {
    const base: Record<string, unknown> = { code: r.location_code, name: r.name, region: r.region }
    for (const mc of (metaColumns ?? [])) base[mc.header.toLowerCase().replace(/\s+/g, '_')] = r._meta[mc.key] ?? ''
    base.days_since_period_start = r.days_since
    base.last_submitted = r.last_submitted ? format(new Date(r.last_submitted), 'yyyy-MM') : 'Never'
    return base
  })

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

      {confirmedRows.length > 0 && (
        <div className="rounded border border-green-200 bg-green-50/40">
          <div className="px-4 py-2 border-b border-green-200 flex items-center justify-between">
            <span className="text-xs font-mono text-green-700 uppercase tracking-wide font-bold">
              Manually Confirmed ({confirmedRows.length})
            </span>
            <span className="text-[10px] font-mono text-green-500">Counted this session — entry saved to database</span>
          </div>
          <ul className="divide-y divide-green-100">
            {confirmedRows.map((r) => (
              <li key={r.location_id} className="flex items-center gap-3 px-4 py-2">
                <span className="text-xs font-mono text-green-700">{r.location_code}</span>
                <span className="flex-1 text-xs font-body text-green-600">{r.name}</span>
                <span className="text-[10px] font-mono text-green-500">✓ Marked counted</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
