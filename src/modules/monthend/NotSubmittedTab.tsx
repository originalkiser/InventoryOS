import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { getMissingShops } from '@/lib/recountEngine'
import { NotSubmittedPanel } from '@/components/shared/NotSubmittedPanel'
import { AmSubmissionRollup } from './AmSubmissionRollup'
import type { Location } from '@/types'
import { format, parseISO } from 'date-fns'

export function NotSubmittedTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [missing, setMissing] = useState<Location[]>([])
  const [monthlyCounts, setMonthlyCounts] = useState<{ location_id: string | null }[]>([])
  const [manualEntries, setManualEntries] = useState<{ location_id: string | null }[]>([])
  const [lastSubmitted, setLastSubmitted] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, countRes, priorRes, manualRes] = await Promise.all([
      sb.schema('core').from('locations').select('*').eq('company_id', companyId).eq('active', true).order('name'),
      sb.schema('inventory').from('counts').select('location_id, count_type').eq('company_id', companyId).eq('count_month', countMonth),
      sb.schema('inventory').from('counts').select('location_id, count_month').eq('company_id', companyId)
        .lt('count_month', countMonth).order('count_month', { ascending: false }),
      // "Mark Counted" (below, in NotSubmittedPanel) writes here rather than
      // to counts — the AM rollup needs to see these too, or a shop marked
      // counted there never clears from this table.
      sb.schema('inventory').from('manual_count_entries').select('location_id').eq('company_id', companyId).eq('count_period', countMonth),
    ])

    const locs = (locRes.data ?? []) as Location[]
    const counts = (countRes.data ?? []) as { location_id: string | null; count_type: string | null }[]
    setLocations(locs)
    setMissing(getMissingShops(locs, counts))
    // Area Manager rollup below counts submissions of type "Monthly" only —
    // the panel above this (and its `missing`/getMissingShops) intentionally
    // stays type-agnostic (any count row satisfies it), so this is a
    // separate, narrower set rather than a change to existing behavior.
    setMonthlyCounts(counts.filter((c) => (c.count_type ?? '').trim().toLowerCase() === 'monthly'))
    setManualEntries((manualRes.data ?? []) as { location_id: string | null }[])

    const lastMap: Record<string, string | null> = {}
    for (const r of (priorRes.data ?? []) as { location_id: string | null; count_month: string }[]) {
      if (r.location_id && !lastMap[r.location_id]) lastMap[r.location_id] = r.count_month
    }
    setLastSubmitted(lastMap)
    setLoading(false)
  }, [companyId, countMonth])

  const monthlySubmittedIds = useMemo(() => {
    const ids = monthlyCounts.map((c) => c.location_id).filter((id): id is string => !!id)
    const manual = manualEntries.map((m) => m.location_id).filter((id): id is string => !!id)
    return new Set([...ids, ...manual])
  }, [monthlyCounts, manualEntries])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const channel = supabase
      .channel('monthend-notsubmitted-rt')
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'counts', filter: `company_id=eq.${companyId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'manual_count_entries', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [companyId, load])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  const periodLabel = format(parseISO(countMonth), 'MMMM yyyy')

  return (
    <div className="flex flex-col gap-6">
      <AmSubmissionRollup locations={locations} monthlySubmittedIds={monthlySubmittedIds} periodLabel={periodLabel} />
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
    </div>
  )
}
