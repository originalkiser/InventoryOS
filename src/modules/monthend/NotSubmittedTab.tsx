import { useEffect, useState, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { getMissingShops } from '@/lib/recountEngine'
import { NotSubmittedPanel } from '@/components/shared/NotSubmittedPanel'
import type { Location } from '@/types'
import { format } from 'date-fns'

export function NotSubmittedTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [missing, setMissing] = useState<Location[]>([])
  const [lastSubmitted, setLastSubmitted] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, countRes, priorRes] = await Promise.all([
      sb.schema('core').from('locations').select('*').eq('company_id', companyId).eq('active', true).order('location_code'),
      sb.schema('inventory').from('counts').select('location_id').eq('company_id', companyId).eq('count_month', countMonth),
      sb.schema('inventory').from('counts').select('location_id, count_month').eq('company_id', companyId)
        .lt('count_month', countMonth).order('count_month', { ascending: false }),
    ])

    const locs = (locRes.data ?? []) as Location[]
    const counts = (countRes.data ?? []) as { location_id: string | null }[]
    setLocations(locs)
    setMissing(getMissingShops(locs, counts))

    const lastMap: Record<string, string | null> = {}
    for (const r of (priorRes.data ?? []) as { location_id: string | null; count_month: string }[]) {
      if (r.location_id && !lastMap[r.location_id]) lastMap[r.location_id] = r.count_month
    }
    setLastSubmitted(lastMap)
    setLoading(false)
  }, [companyId, countMonth])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('monthend-notsubmitted-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'counts', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  const periodLabel = format(new Date(countMonth), 'MMMM yyyy')

  return (
    <NotSubmittedPanel
      companyId={companyId}
      periodStartISO={countMonth}
      periodLabel={periodLabel}
      missing={missing}
      totalActive={locations.length}
      lastSubmittedByLoc={lastSubmitted}
      reminderTitle={`Month-end counts outstanding — ${periodLabel}`}
      exportPrefix="monthend_not_submitted"
      metaColumns={[
        { key: 'market', header: 'Market' },
        { key: 'area_manager', header: 'Area Manager' },
        { key: 'regional_director', header: 'Director' },
      ]}
      loading={loading}
    />
  )
}
