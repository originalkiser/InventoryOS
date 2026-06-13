import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Location, PosLocationMap } from '@/types'

// Loads the company's locations and provides id <-> code/name resolution,
// plus access to each location's custom metadata for cross-section linking.
// Also consults the POS location map so uploads whose location value is a POS
// string ("001 - Thomasville") resolve to the right location.
export function useLocations() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [locations, setLocations] = useState<Location[]>([])
  const [posMaps, setPosMaps] = useState<PosLocationMap[]>([])

  const reload = useCallback(async () => {
    if (!companyId) { setLocations([]); setPosMaps([]); return }
    const [loc, pos] = await Promise.all([
      (supabase as any).from('locations').select('*').eq('company_id', companyId).order('location_code'),
      (supabase as any).from('pos_location_map').select('*').eq('company_id', companyId),
    ])
    setLocations((loc.data ?? []) as Location[])
    setPosMaps((pos.data ?? []) as PosLocationMap[])
  }, [companyId])

  useEffect(() => { reload() }, [reload])

  function resolveId(value: string | null | undefined): string | null {
    const v = String(value ?? '').trim().toLowerCase()
    if (!v) return null
    const m = locations.find(
      (l) => l.id.toLowerCase() === v || l.location_code.toLowerCase() === v || l.name.toLowerCase() === v
    )
    if (m) return m.id
    // Fall back to the POS map: exact pos_string, or its parsed leading number.
    const pos = posMaps.find((p) => String(p.pos_string ?? '').trim().toLowerCase() === v)
    if (pos?.location_id) return pos.location_id
    return null
  }

  // Reverse lookup: the POS string mapped to a location (for showing POS in
  // other tables keyed by location).
  function posStringFor(id: string | null): string {
    if (!id) return ''
    return posMaps.find((p) => p.location_id === id)?.pos_string ?? ''
  }

  function byId(id: string | null): Location | undefined {
    return id ? locations.find((l) => l.id === id) : undefined
  }

  function labelOf(id: string | null): string {
    const l = byId(id)
    return l ? `${l.location_code} — ${l.name}` : '—'
  }

  // Resolve a (possibly linked) field value for a location: base columns first,
  // then custom metadata by key. Used by cross-section linked columns.
  function fieldValue(id: string | null, key: string): string {
    const l = byId(id)
    if (!l) return ''
    if (key === 'location_code') return l.location_code
    if (key === 'name') return l.name
    if (key === 'region') return l.region ?? ''
    const v = (l.metadata as any)?.[key]
    return v == null ? '' : String(v)
  }

  const options = locations.filter((l) => l.active).map((l) => ({ value: l.id, label: `${l.location_code} — ${l.name}` }))

  // Resolve to a location_code string (for tables that key on code).
  function codeOf(id: string | null): string {
    return byId(id)?.location_code ?? ''
  }

  return { locations, posMaps, options, resolveId, byId, labelOf, codeOf, fieldValue, posStringFor, reload }
}
