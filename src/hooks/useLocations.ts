import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Location } from '@/types'

// Loads the company's locations and provides id <-> code/name resolution,
// plus access to each location's custom metadata for cross-section linking.
export function useLocations() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [locations, setLocations] = useState<Location[]>([])

  const reload = useCallback(async () => {
    if (!companyId) { setLocations([]); return }
    const { data } = await (supabase as any).from('locations').select('*').eq('company_id', companyId).order('location_code')
    setLocations((data ?? []) as Location[])
  }, [companyId])

  useEffect(() => { reload() }, [reload])

  function resolveId(value: string | null | undefined): string | null {
    const v = String(value ?? '').trim().toLowerCase()
    if (!v) return null
    const m = locations.find(
      (l) => l.id.toLowerCase() === v || l.location_code.toLowerCase() === v || l.name.toLowerCase() === v
    )
    return m?.id ?? null
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

  return { locations, options, resolveId, byId, labelOf, fieldValue, reload }
}
