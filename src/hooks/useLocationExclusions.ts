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
  // 'exclude' (default): hide locations whose value is in `values`.
  // 'only': hide locations whose value is NOT in `values` (exclude all but).
  mode?: 'exclude' | 'only'
}

// Applied on 'inventory'-surface pages unless the user configures their own
// Owner rule: only Corporate-owned locations are shown (franchise/other
// owners hidden). Non-inventory surfaces (Customer Heatmap, Droptop
// Orders, and future non-operational pages) default to including
// franchise instead — Inventory-side workflows (exception reporting, tank
// monitors, location lookup, etc.) are the ones franchise shouldn't
// silently get pulled into unless a user explicitly opts in, per explicit
// product decision 2026-09-01.
export const DEFAULT_OWNER_RULE: ExclusionRule = { field: 'meta:owner', values: ['Corporate'], mode: 'only' }

const isOwnerField = (field: string) => (field.startsWith('meta:') ? field.slice(5) : field) === 'owner'

// Simplified Owner classification for exclusion-rule matching (and the
// config UI's own checklist, see LocationExclusionsConfig.tsx) — a
// location whose raw `owner` isn't literally "Corporate" (an individual
// franchisee name, a holding company, etc.) buckets as "Franchise". This
// is what makes "keep only Corporate" (the default) and a user's own
// "keep only Corporate, Franchise" (= show everyone) both a two-value
// decision instead of needing to enumerate every real owner name by hand.
export function ownerBucket(raw: string): string {
  const v = raw.trim()
  return v ? (v === 'Corporate' ? 'Corporate' : 'Franchise') : ''
}

// CORRECTED 2026-09-02 (explicit instruction): 'inventory' surfaces now
// force DEFAULT_OWNER_RULE unconditionally — a user's own Owner rule can
// no longer override it there. Previously a user's Owner rule (a single
// preference applied globally across every surface, not per-surface) could
// win over the default, which is exactly what let franchise locations
// leak into Inventory Alerts once a real "keep only Corporate, Franchise"
// override actually started working correctly (see ownerBucket() above,
// fixed the same day) — that override is still exactly what 'other'
// surfaces (Customer Heatmap, Droptop Orders) are meant to respect, but
// "under no circumstances" was the explicit instruction for inventory-side
// pages: no per-user opt-out, automatic, no exceptions. A user's own
// Owner rule (if any) is stripped out entirely for 'inventory' — only
// their non-owner rules (region/market/etc, if any) still apply alongside
// the forced default. 'other' surfaces are unaffected by this change.
export function effectiveRules(rules: ExclusionRule[], surface: 'inventory' | 'other' = 'inventory'): ExclusionRule[] {
  if (surface !== 'inventory') return rules
  return [...rules.filter((r) => !isOwnerField(r.field)), DEFAULT_OWNER_RULE]
}

// Columns a user may exclude on. Base columns read straight off the row;
// "meta:" fields read from the location's metadata jsonb.
//
// Owner deliberately removed (2026-09-02) — effectiveRules() above now
// forces DEFAULT_OWNER_RULE unconditionally for 'inventory' surfaces, so a
// user-set Owner rule here would be silently ineffective there (stripped
// every time), and 'other' surfaces (Customer Heatmap, Droptop Orders)
// each have their own local Owner filter now instead. Leaving it
// selectable here was exactly the footgun that let franchise locations
// leak into Inventory Alerts once a "keep only Corporate, Franchise"
// override actually started working (see ownerBucket()'s own fix, same
// day) — removed rather than left inert.
export const EXCLUDABLE_COLUMNS: { field: string; label: string }[] = [
  { field: 'region', label: 'Region' },
  { field: 'district', label: 'District' },
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

export function useLocationExclusions(surface: 'inventory' | 'other' = 'inventory') {
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
    for (const rule of effectiveRules(rules, surface)) {
      if (!rule.values?.length) continue
      const raw = locExclusionValue(loc, rule.field)
      const v = (isOwnerField(rule.field) ? ownerBucket(raw) : raw).trim().toLowerCase()
      const inList = rule.values.some((rv) => rv.trim().toLowerCase() === v)
      if (rule.mode === 'only') { if (!inList) return true }       // exclude all but these
      else if (v && inList) return true                            // exclude these
    }
    return false
  }, [rules, surface])

  const filterLocations = useCallback(<T extends Location>(locs: T[]): T[] => locs.filter((l) => !isExcluded(l)), [isExcluded])

  return { rules, setRules, isExcluded, filterLocations }
}
