import { useEffect, useState, useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useWeeklyStore } from '@/stores/weeklyStore'
import { DataTable } from '@/components/shared/DataTable'
import { NotSubmittedPanel } from '@/components/shared/NotSubmittedPanel'
import { useTable } from '@/hooks/useTable'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { CountSummaryUpload } from '@/modules/monthend/CountSummaryUpload'
import { weeklySummaryTarget, locationLabel } from '@/modules/monthend/countsShared'
import type { Location, WeeklyCount } from '@/types'
import { startOfWeek, addDays, format } from 'date-fns'
import toast from 'react-hot-toast'

// weekStart is a Monday 'yyyy-MM-dd'. Range = [weekStart, weekStart+7).
function weekRange(weekStart: string) {
  const start = new Date(`${weekStart}T00:00:00`)
  const endExclusive = addDays(start, 7)
  const endInclusive = addDays(start, 6)
  return {
    startISO: `${weekStart}T00:00:00.000Z`,
    endExclusiveISO: format(endExclusive, "yyyy-MM-dd'T'00:00:00.000'Z'"),
    label: `Week of ${format(start, 'MMM d')} – ${format(endInclusive, 'MMM d, yyyy')}`,
  }
}

export function WeeklyPage() {
  const { selectedWeek, setSelectedWeek } = useWeeklyStore()
  const { label } = weekRange(selectedWeek)

  function shiftWeek(deltaDays: number) {
    const d = addDays(new Date(`${selectedWeek}T00:00:00`), deltaDays)
    setSelectedWeek(format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd'))
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Weekly Counts</h1>
          <p className="text-xs text-inky mt-0.5">Track weekly count submissions across shops</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-7)} className="px-2 py-1.5 border border-navy/30 rounded text-inky hover:border-gray-500 font-mono text-xs">‹ Prev</button>
          <div className="flex flex-col">
            <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Week</span>
            <input
              type="date"
              value={selectedWeek}
              onChange={(e) => {
                if (!e.target.value) return
                setSelectedWeek(format(startOfWeek(new Date(`${e.target.value}T00:00:00`), { weekStartsOn: 1 }), 'yyyy-MM-dd'))
              }}
              className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-[#00e5ff]"
            />
          </div>
          <button onClick={() => shiftWeek(7)} className="px-2 py-1.5 border border-navy/30 rounded text-inky hover:border-gray-500 font-mono text-xs">Next ›</button>
        </div>
      </div>

      <p className="text-xs font-mono text-inky">Selected: <span className="text-inky">{label}</span></p>

      <Tabs defaultValue="counts">
        <TabsList>
          <TabsTrigger value="counts">Counts</TabsTrigger>
          <TabsTrigger value="not_submitted">Not Submitted</TabsTrigger>
        </TabsList>
        <TabsContent value="counts"><WeeklyCountsTab /></TabsContent>
        <TabsContent value="not_submitted"><WeeklyNotSubmittedTab /></TabsContent>
      </Tabs>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Counts tab
// ---------------------------------------------------------------------------
interface WeeklyRow extends WeeklyCount {
  location_label: string
}

const col = createColumnHelper<WeeklyRow>()
const num = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })

function WeeklyCountsTab() {
  const { profile } = useAuthStore()
  const { selectedWeek } = useWeeklyStore()
  const companyId = profile?.company_id ?? null
  const { startISO, endExclusiveISO } = weekRange(selectedWeek)

  const [locations, setLocations] = useState<Location[]>([])
  const [counts, setCounts] = useState<WeeklyCount[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, countRes] = await Promise.all([
      sb.from('locations').select('*').eq('company_id', companyId).order('location_code'),
      sb.from('weekly_counts').select('*').eq('company_id', companyId)
        .gte('count_date', startISO).lt('count_date', endExclusiveISO).order('count_date', { ascending: false }),
    ])
    setLocations((locRes.data ?? []) as Location[])
    setCounts((countRes.data ?? []) as WeeklyCount[])
    setLoading(false)
  }, [companyId, startISO, endExclusiveISO])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('weekly-counts-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_counts', filter: `company_id=eq.${companyId}` },
        () => { toast('Weekly counts updated', { icon: '📊' }); load() })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  const rows: WeeklyRow[] = useMemo(() => counts.map((c) => ({
    ...c,
    location_label: locationLabel(c.location_id, locations),
  })), [counts, locations])

  const columns = useMemo(() => [
    col.accessor('location_label', { header: 'Location' }),
    col.accessor('count_type', { header: 'Type', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('count_date', {
      header: 'Count Date',
      cell: (i) => (i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—'),
    }),
    col.accessor('total_adjustments', { header: 'Adjustments', cell: (i) => num(i.getValue()) }),
    col.accessor('adjustment_value', { header: 'Adj Value', cell: (i) => num(i.getValue()) }),
    col.accessor('abs_adjustment_value', { header: 'Abs Adj Value', cell: (i) => num(i.getValue()) }),
    col.accessor('ending_inventory_cost', {
      header: 'Ending Balance',
      cell: (i) => <span className="text-navy">{num(i.getValue())}</span>,
    }),
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns)

  const exportRows = useMemo(() => rows.map((r) => ({
    location: r.location_label,
    count_type: r.count_type ?? '',
    count_date: r.count_date ?? '',
    total_adjustments: r.total_adjustments ?? '',
    adjustment_value: r.adjustment_value ?? '',
    abs_adjustment_value: r.abs_adjustment_value ?? '',
    ending_inventory_cost: r.ending_inventory_cost ?? '',
  })), [rows])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CountSummaryUpload
          locations={locations}
          companyId={companyId}
          target={weeklySummaryTarget(selectedWeek)}
          uploadedBy={profile?.id ?? null}
          onImported={load}
        />
      </div>

      <div>
        <h2 className="text-xs font-mono text-inky uppercase tracking-wide mb-3">Results</h2>
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename={`weekly_counts_${selectedWeek}.csv`}
          exportData={exportRows}
          loading={loading}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Not Submitted tab (the module's primary purpose)
// ---------------------------------------------------------------------------
function WeeklyNotSubmittedTab() {
  const { profile } = useAuthStore()
  const { selectedWeek } = useWeeklyStore()
  const companyId = profile?.company_id ?? null
  const { startISO, endExclusiveISO, label } = weekRange(selectedWeek)

  const [locations, setLocations] = useState<Location[]>([])
  const [missing, setMissing] = useState<Location[]>([])
  const [lastSubmitted, setLastSubmitted] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, weekRes, priorRes] = await Promise.all([
      sb.from('locations').select('*').eq('company_id', companyId).eq('active', true).order('location_code'),
      sb.from('weekly_counts').select('location_id').eq('company_id', companyId)
        .gte('count_date', startISO).lt('count_date', endExclusiveISO),
      sb.from('weekly_counts').select('location_id, count_date').eq('company_id', companyId)
        .lt('count_date', startISO).order('count_date', { ascending: false }),
    ])

    const locs = (locRes.data ?? []) as Location[]
    const submittedIds = new Set(((weekRes.data ?? []) as { location_id: string | null }[]).map((r) => r.location_id).filter(Boolean))
    setLocations(locs)
    setMissing(locs.filter((l) => !submittedIds.has(l.id)))

    const lastMap: Record<string, string | null> = {}
    for (const r of (priorRes.data ?? []) as { location_id: string | null; count_date: string }[]) {
      if (r.location_id && !lastMap[r.location_id]) lastMap[r.location_id] = r.count_date
    }
    setLastSubmitted(lastMap)
    setLoading(false)
  }, [companyId, startISO, endExclusiveISO])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('weekly-notsubmitted-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'weekly_counts', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <NotSubmittedPanel
      companyId={companyId}
      periodStartISO={selectedWeek}
      periodLabel={label}
      missing={missing}
      totalActive={locations.length}
      lastSubmittedByLoc={lastSubmitted}
      reminderTitle={`Weekly counts outstanding — ${label}`}
      exportPrefix="weekly_not_submitted"
      lastSubmittedFormat="MMM d, yyyy"
      loading={loading}
    />
  )
}
