import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useWeek } from '../WeekContext'
import { Report, ReportEntry } from '../types'
import DepartmentCompletion from '../components/dashboards/DepartmentCompletion'

export default function DepartmentPage() {
  const { weekStartStr } = useWeek()
  const [reports, setReports] = useState<Report[]>([])
  const [entriesByReport, setEntriesByReport] = useState<Record<string, ReportEntry[]>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      setLoading(true)
      const sb = supabase as any
      const { data: reportsData } = await sb.schema('outlier').from('reports')
        .select('*, department:departments(*)')
        .order('sort_order')
      if (!reportsData) { setLoading(false); return }
      setReports(reportsData as Report[])
      const { data: weekData } = await sb.schema('outlier').from('weeks')
        .select('*').eq('week_start', weekStartStr).single()
      if (weekData) {
        const { data: entries } = await sb.schema('outlier').from('report_entries')
          .select('*').eq('week_id', weekData.id)
        const grouped: Record<string, ReportEntry[]> = {}
        for (const entry of (entries ?? []) as ReportEntry[]) {
          if (!grouped[entry.report_id]) grouped[entry.report_id] = []
          grouped[entry.report_id].push(entry)
        }
        setEntriesByReport(grouped)
      }
      setLoading(false)
    }
    load()
  }, [weekStartStr])

  if (loading) {
    return (
      <div className="p-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-28 bg-sb-inky/20 rounded-lg animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="px-6 py-4 border-b border-sb-inky/30">
        <h1 className="font-brand font-bold text-sb-cream text-[16px] tracking-wider uppercase">Department Dashboard</h1>
        <p className="font-mono text-sb-inky text-[11px] mt-0.5">Weekly completion overview</p>
      </div>
      <DepartmentCompletion reports={reports} entriesByReport={entriesByReport} />
    </div>
  )
}
