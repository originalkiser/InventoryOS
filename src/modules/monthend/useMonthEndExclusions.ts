// Company-wide (2026-09-28 ask — persists across sessions AND months, so a
// per-user preference is the wrong shape here) shop exclusion list for
// Month End's own aggregate totals — deliberately separate from
// core.location_exclusions/useLocationExclusions.ts, which is a per-user
// dashboard/listing visibility filter that explicitly excludes Month End by
// design (see that hook's own header comment). Two reasons, scoped to the
// Month End module only (confirmed with the user — NOT a whole-app
// blacklist): 'overview_only' hides a shop from the Overview tab's totals/
// table/outliers specifically; 'everything' hides it from every Month End
// tab (Overview included — Counts/Recount tabs reading this are a future
// follow-up, not built yet, since only Overview currently consumes it).
import { useCallback, useMemo } from 'react'
import { useAppSetting } from '@/hooks/useAppSetting'

export type MonthEndExclusionReason = 'everything' | 'overview_only'
export interface MonthEndExclusion { location_id: string; reason: MonthEndExclusionReason }

const KEY = 'monthend_shop_exclusions'

export function useMonthEndExclusions() {
  const [exclusions, setExclusions, loaded] = useAppSetting<MonthEndExclusion[]>(KEY, [])

  // Overview hides a shop for EITHER reason — "everything" is a superset of
  // "overview_only" by definition (every Month End tab includes Overview).
  const overviewExcludedIds = useMemo(() => new Set(exclusions.map((e) => e.location_id)), [exclusions])
  // Exposed for future Month End tabs (Counts, Recount Logic, etc.) that
  // want to honor "everything" exclusions too — not consumed anywhere yet.
  const everywhereExcludedIds = useMemo(
    () => new Set(exclusions.filter((e) => e.reason === 'everything').map((e) => e.location_id)),
    [exclusions],
  )

  // useAppSetting's save() takes a plain value, not a functional updater —
  // reads the current `exclusions` closure directly, which is safe since
  // this hook re-renders (with a fresh closure) on every state change.
  const setReason = useCallback((locationId: string, reason: MonthEndExclusionReason | null) => {
    const rest = exclusions.filter((e) => e.location_id !== locationId)
    setExclusions(reason ? [...rest, { location_id: locationId, reason }] : rest)
  }, [exclusions, setExclusions])

  // Bulk variant (2026-09-28 ask — filter by AM/region, multi-select, apply
  // once instead of one-by-one). A real, separate function rather than N
  // sequential setReason() calls: each of those reads the same `exclusions`
  // closure and calls save() independently, so rapid-fire calls would each
  // overwrite the previous one's still-in-flight save with a stale base
  // array — this does the whole set replacement in one save() call.
  const setReasonBulk = useCallback((locationIds: string[], reason: MonthEndExclusionReason | null) => {
    const idSet = new Set(locationIds)
    const rest = exclusions.filter((e) => !idSet.has(e.location_id))
    setExclusions(reason ? [...rest, ...locationIds.map((id) => ({ location_id: id, reason }))] : rest)
  }, [exclusions, setExclusions])

  return { exclusions, setReason, setReasonBulk, overviewExcludedIds, everywhereExcludedIds, loaded }
}
