import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useWeek } from '../WeekContext'
import { Report, ReportEntry, Week, AMLocation, UserProfile } from '../types'
import AMDashboard from '../components/dashboards/AMDashboard'

export default function AMDashboardPage() {
  const { profile } = useAuthStore()
  const { weekStartStr } = useWeek()
  const [amLocations, setAmLocations] = useState<AMLocation[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [entriesByReport, setEntriesByReport] = useState<Record<string, ReportEntry[]>>({})
  const [allEntries, setAllEntries] = useState<ReportEntry[]>([])
  const [allWeeks, setAllWeeks] = useState<Week[]>([])
  const [currentWeekId, setCurrentWeekId] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile) return
    setLoading(true)
    const sb = supabase as any

    const [locRes, reportsRes, weeksRes] = await Promise.all([
      sb.schema('outlier').from('am_locations').select('*').eq('user_id', profile.id),
      sb.schema('outlier').from('reports').select('*, department:departments(*)').order('sort_order'),
      sb.schema('outlier').from('weeks').select('*').order('week_start', { ascending: false }),
    ])

    const locs = (locRes.data ?? []) as AMLocation[]
    const rpts = (reportsRes.data ?? []) as Report[]
    const wks  = (weeksRes.data ?? []) as Week[]

    setAmLocations(locs)
    setReports(rpts)
    setAllWeeks(wks)

    const currentWeek = wks.find((w: Week) => w.week_start === weekStartStr)
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

    // All entries for streak
    const { data: allE } = await sb.schema('outlier').from('report_entries').select('*')
    setAllEntries((allE ?? []) as ReportEntry[])

    setLoading(false)
  }, [profile?.id, weekStartStr])

  useEffect(() => { load() }, [load])

  if (loading || !profile) {
    return (
      <div className="p-6 space-y-3">
        {[...Array(4)].map((_, i) => <div key={i} className="h-20 bg-sb-inky/20 rounded-lg animate-pulse" />)}
      </div>
    )
  }

  // Adapt InventoryOS profile to the UserProfile shape expected by AMDashboard
  const adaptedProfile: UserProfile = {
    id: profile.id,
    auth_user_id: null,
    work_email: profile.email ?? '',
    full_name: profile.full_name,
    role: (profile.role as UserProfile['role']) ?? 'area_manager',
    region: null,
    area: null,
    is_active: true,
    created_at: profile.created_at,
    last_login_at: null,
  }

  return (
    <AMDashboard
      profile={adaptedProfile}
      amLocations={amLocations}
      reports={reports}
      entriesByReport={entriesByReport}
      allEntries={allEntries}
      allWeeks={allWeeks}
      currentWeekId={currentWeekId}
      onRefresh={load}
    />
  )
}
