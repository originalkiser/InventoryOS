import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useWeek } from '../WeekContext'
import { Department, Report, ReportEntry, Week } from '../types'
import LeadershipDashboard from '../components/dashboards/LeadershipDashboard'

export default function LeadershipPage() {
  const { weekStartStr } = useWeek()
  const [departments, setDepartments] = useState<Department[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [entriesByReport, setEntriesByReport] = useState<Record<string, ReportEntry[]>>({})
  const [allEntries, setAllEntries] = useState<ReportEntry[]>([])
  const [allWeeks, setAllWeeks] = useState<Week[]>([])
  const [currentWeekId, setCurrentWeekId] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const sb = supabase as any

      const [deptRes, rptRes, wkRes] = await Promise.all([
        sb.schema('outlier').from('departments').select('*').order('sort_order'),
        sb.schema('outlier').from('reports').select('*, department:departments(*)').order('sort_order'),
        sb.schema('outlier').from('weeks').select('*').order('week_start', { ascending: false }),
      ])

      const depts  = (deptRes.data ?? []) as Department[]
      const rpts   = (rptRes.data ?? []) as Report[]
      const weeks  = (wkRes.data ?? []) as Week[]

      setDepartments(depts)
      setReports(rpts)
      setAllWeeks(weeks)

      const currentWeek = weeks.find((w: Week) => w.week_start === weekStartStr)
      setCurrentWeekId(currentWeek?.id ?? '')

      if (currentWeek) {
        const { data: entries } = await sb.schema('outlier').from('report_entries')
          .select('*')
          .eq('week_id', currentWeek.id)

        const grouped: Record<string, ReportEntry[]> = {}
        for (const e of (entries ?? []) as ReportEntry[]) {
          if (!grouped[e.report_id]) grouped[e.report_id] = []
          grouped[e.report_id].push(e)
        }
        setEntriesByReport(grouped)
      }

      const { data: allE } = await sb.schema('outlier').from('report_entries').select('*')
      setAllEntries((allE ?? []) as ReportEntry[])

      setLoading(false)
    }
    load()
  }, [weekStartStr])

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        {[...Array(3)].map((_, i) => <div key={i} className="h-24 bg-sb-inky/20 rounded-lg animate-pulse" />)}
      </div>
    )
  }

  return (
    <div>
      <div className="px-6 py-4 border-b border-sb-inky/30">
        <h1 className="font-brand font-bold text-sb-cream text-[16px] tracking-wider uppercase">Leadership Dashboard</h1>
        <p className="font-mono text-sb-inky text-[11px] mt-0.5">All regions · All areas</p>
      </div>
      <LeadershipDashboard
        departments={departments}
        reports={reports}
        entriesByReport={entriesByReport}
        allEntries={allEntries}
        allWeeks={allWeeks}
        currentWeekId={currentWeekId}
      />
    </div>
  )
}
