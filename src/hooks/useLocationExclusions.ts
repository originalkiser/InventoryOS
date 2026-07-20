import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Location } from '@/types'

// Per-user rules that hide locations from listing/dashboard surfaces.
// Stored in core.user_sidebar_prefs.location_exclusions (jsonb). Operational
// flows (orders, month-end counts, config) intentionally ignore these.
export interface ExclusionRule {
  field: string
  values: string[]
}

// Columns a user may exclude on. Base columns read straight off the row;
// "meta:" fields read from the location's metadata jsonb.
export const EXCLUDABLE_COLUMNS: { field: string; label: string }[] = [
  { field: 'region', label: 'Region' },
  { field: 'district', label: 'District' },
  { field: 'meta:owner', label: 'Owner' },
  { field: 'meta:market', label: 'Market' },
  { field: 'meta:area_manager', label: 'Area Manager' },
  { field: 'meta:regional_director', label: 'Regional Director' },
  { field: 'meta:type', label: 'Type' },
  { field: 'name', label: 'Location Name' },
  { field: 'shop_city', label: 'City' },
]

// Resolve a location's value for a field. owner/market/area_manager/director
// are base columns in core.locations (managed by Global Config), but older data
// lived in `metadata`. Resolve base-column-first with a metadata fallback so
// listings mirror Global Config regardless of where the value is stored. A
// "meta:" prefix is accepted (and stripped) for backward compatibility.
export function locExclusionValue(loc: Location, field: string): string {
  const key = field.startsWith('meta:') ? field.slice(5) : field
  const meta = (loc.metadata ?? {}) as Record<string, any>
  if (key === 'regional_director' || key === 'director') {
    return String((loc as any).director ?? meta.regional_director ?? meta.director ?? '')
  }
  const base = (loc as any)[key]
  if (base != null && String(base) !== '') return String(base)
  const m = meta[key]
  return m == null ? '' : String(m)
}

// Shared store so every surface (profile editor, Locations page, Lookup,
// dashboard) sees the same rules and reacts the instant they change.
interface ExclusionStore {
  rules: ExclusionRule[]
  loadedFor: string | null
  load: (userId: string) => void
  save: (userId: string, next: ExclusionRule[]) => void
}

const useExclusionStore = create<ExclusionStore>((set) => ({
  rules: [],
  loadedFor: null,
  load: (userId) => {
    set({ loadedFor: userId })
    const sb = supabase as any
    sb.schema('core').from('user_sidebar_prefs')
      .select('location_exclusions')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data, error }: any) => {
        // Column may not exist until the migration is applied — fail soft.
        if (!error && Array.isArray(data?.location_exclusions)) {
          set({ rules: data.location_exclusions as ExclusionRule[] })
        }
      })
  },
  save: (userId, next) => {
    set({ rules: next })
    const sb = supabase as any
    sb.schema('core').from('user_sidebar_prefs')
      .upsert({ user_id: userId, location_exclusions: next, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
      .then(({ error }: any) => { if (error) console.warn('[LocationExclusions] save failed:', error.message) })
  },
}))

export function useLocationExclusions() {
  const { user } = useAuthStore()
  const rules = useExclusionStore((s) => s.rules)
  const loadedFor = useExclusionStore((s) => s.loadedFor)
  const load = useExclusionStore((s) => s.load)
  const save = useExclusionStore((s) => s.save)

  useEffect(() => {
    if (user?.id && loadedFor !== user.id) load(user.id)
  }, [user?.id, loadedFor, load])

  const setRules = useCallback((next: ExclusionRule[]) => {
    if (user?.id) save(user.id, next)
  }, [user?.id, save])

  const isExcluded = useCallback((loc: Location): boolean => {
    for (const rule of rules) {
      if (!rule.values?.length) continue
      const v = locExclusionValue(loc, rule.field).trim().toLowerCase()
      if (v && rule.values.some((rv) => rv.trim().toLowerCase() === v)) return true
    }
    return false
  }, [rules])

  const filterLocations = useCallback(<T extends Location>(locs: T[]): T[] => locs.filter((l) => !isExcluded(l)), [isExcluded])

  return { rules, setRules, isExcluded, filterLocations }
}
