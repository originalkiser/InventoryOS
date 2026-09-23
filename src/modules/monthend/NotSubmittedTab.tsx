import { useEffect, useState, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { getMissingShops } from '@/lib/recountEngine'
import { isRealShopLocation } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { NotSubmittedPanel } from '@/components/shared/NotSubmittedPanel'
import { AmSubmissionRollup } from './AmSubmissionRollup'
import { ALLOWABLE_TYPE_RULES_KEY, isAllowedCountType, type TypeRule } from './countsShared'
import type { Location } from '@/types'
import { format, parseISO } from 'date-fns'

export function NotSubmittedTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [locations, setLocations] = useState<Location[]>([])
  const [missing, setMissing] = useState<Location[]>([])
  const [allowedCounts, setAllowedCounts] = useState<{ location_id: string | null }[]>([])
  const [manualEntries, setManualEntries] = useState<{ location_id: string | null }[]>([])
  const [lastSubmitted, setLastSubmitted] = useState<Record<string, string | null>>({})
  const [loading, setLoading] = useState(true)
  // Counts → Results → Summary's own "Allowable Types" config — see
  // countsShared.ts's isAllowedCountType. Previously this rollup hardcoded
  // 'monthly' independently and never actually read this setting despite
  // looking like the same control (2026-09-23 — a shop's genuine
  // out-of-sequence recount didn't clear it from Not Submitted even though
  // that type was already marked allowable in Results).
  const [typeRules] = useAppSetting<Record<string, TypeRule>>(ALLOWABLE_TYPE_RULES_KEY, {})

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, countRes, priorRes, manualRes] = await Promise.all([
      sb.schema('core').from('locations').select('*').eq('company_id', companyId).eq('active', true).order('name'),
      sb.schema('inventory').from('counts').select('location_id, count_type, total_adjustments').eq('company_id', companyId).eq('count_month', countMonth),
      sb.schema('inventory').from('counts').select('location_id, count_month').eq('company_id', companyId)
        .lt('count_month', countMonth).order('count_month', { ascending: false }),
      // "Mark Counted" (below, in NotSubmittedPanel) writes here rather than
      // to counts — the AM rollup needs to see these too, or a shop marked
      // counted there never clears from this table.
      sb.schema('inventory').from('manual_count_entries').select('location_id').eq('company_id', companyId).eq('count_period', countMonth),
    ])

    // Header/divider rows (e.g. "Open Car Wash Stores") sometimes land in
    // core.locations as active rows — see isRealShopLocation.
    const locs = ((locRes.data ?? []) as Location[]).filter(isRealShopLocation)
    const counts = (countRes.data ?? []) as { location_id: string | null; count_type: string | null; total_adjustments: number | null }[]
    setLocations(locs)
    setMissing(getMissingShops(locs, counts))
    // Area Manager rollup below counts submissions of an allowable type only
    // (per the shared Allowable Types config) — the panel above this (and
    // its `missing`/getMissingShops) intentionally stays type-agnostic (any
    // count row satisfies it), so this is a separate, narrower set rather
    // than a change to existing behavior.
    setAllowedCounts(counts.filter((c) => isAllowedCountType(c.count_type, c.total_adjustments, typeRules)))
    setManualEntries((manualRes.data ?? []) as { location_id: string | null }[])

    const lastMap: Record<string, string | null> = {}
    for (const r of (priorRes.data ?? []) as { location_id: string | null; count_month: string }[]) {
      if (r.location_id && !lastMap[r.location_id]) lastMap[r.location_id] = r.count_month
    }
    setLastSubmitted(lastMap)
    setLoading(false)
  }, [companyId, countMonth, typeRules])

  const monthlySubmittedIds = useMemo(() => {
    const ids = allowedCounts.map((c) => c.location_id).filter((id): id is string => !!id)
    const manual = manualEntries.map((m) => m.location_id).filter((id): id is string => !!id)
    return new Set([...ids, ...manual])
  }, [allowedCounts, manualEntries])

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
