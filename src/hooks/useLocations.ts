import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { byNaturalLabel } from '@/lib/naturalSort'
import type { Location, PosLocationMap } from '@/types'

// Loads the company's locations and provides id <-> code/name resolution,
// plus access to each location's custom metadata for cross-section linking.
// Also consults the POS location map so uploads whose location value is a POS
// string ("001 - Thomasville") resolve to the right location.
export function useLocations() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { isExcluded } = useLocationExclusions()
  const [locations, setLocations] = useState<Location[]>([])
  const [posMaps, setPosMaps] = useState<PosLocationMap[]>([])

  const reload = useCallback(async () => {
    if (!companyId) { setLocations([]); setPosMaps([]); return }
    const [loc, pos] = await Promise.all([
      (supabase as any).schema('core').from('locations').select('*').eq('company_id', companyId).order('name'),
      (supabase as any).schema('core').from('pos_location_map').select('*').eq('company_id', companyId),
    ])
    setLocations((loc.data ?? []) as Location[])
    setPosMaps((pos.data ?? []) as PosLocationMap[])
  }, [companyId])

  useEffect(() => { reload() }, [reload])

  // Precomputed once per data load rather than per resolveId call — each
  // call used to be up to four full linear scans (locations twice,
  // posMaps twice), which is fine for a handful of calls but becomes a
  // multi-second, tab-freezing blocking loop at the row counts a large
  // file import calls this in (a 250k-row product detail file was the
  // one that surfaced it, but every large-file importer calling
  // resolveId per row shares the same hook). First match in `locations`'
  // array order (sorted by name) wins on a key collision, matching what
  // .find() returned before.
  const byExactKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of locations) {
      const idKey = l.id.toLowerCase(); if (!m.has(idKey)) m.set(idKey, l.id)
      if (l.name) { const k = l.name.toLowerCase(); if (!m.has(k)) m.set(k, l.id) }
      if (l.shop_city) { const k = l.shop_city.toLowerCase(); if (!m.has(k)) m.set(k, l.id) }
    }
    return m
  }, [locations])
  const posByExactKey = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of posMaps) {
      if (!p.pos_string || !p.location_id) continue
      const k = String(p.pos_string).trim().toLowerCase()
      if (!m.has(k)) m.set(k, p.location_id)
    }
    return m
  }, [posMaps])
  const byCodeNumber = useMemo(() => {
    const m = new Map<number, string>()
    for (const l of locations) {
      const cd = String(l.name ?? '').match(/\d+/)?.[0]
      if (cd == null) continue
      const n = Number(cd); if (!m.has(n)) m.set(n, l.id)
    }
    return m
  }, [locations])
  const posByNumber = useMemo(() => {
    const m = new Map<number, string>()
    for (const p of posMaps) {
      if (!p.location_id) continue
      const pd = String(p.pos_string ?? '').match(/\d+/)?.[0]
      if (pd == null) continue
      const n = Number(pd); if (!m.has(n)) m.set(n, p.location_id)
    }
    return m
  }, [posMaps])

  function resolveId(value: string | null | undefined): string | null {
    const v = String(value ?? '').trim().toLowerCase()
    if (!v) return null
    const exact = byExactKey.get(v)
    if (exact) return exact
    // Exact POS-string match.
    const pos = posByExactKey.get(v)
    if (pos) return pos
    // Numeric fallback: match the value's number against location-code numbers
    // (handles "SB 1521 - Port Arthur" → code 1521, and "001" ↔ "1") or a POS
    // string's number.
    const digits = String(value ?? '').match(/\d+/)?.[0]
    if (digits) {
      const n = Number(digits)
      const byCode = byCodeNumber.get(n)
      if (byCode) return byCode
      const posByNum = posByNumber.get(n)
      if (posByNum) return posByNum
    }
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
    return l ? `${l.name} — ${l.shop_city ?? ''}` : '—'
  }

  // Resolve a (possibly linked) field value for a location: base columns first,
  // then custom metadata by key. Used by cross-section linked columns.
  //
  // area_manager/owner/market/am_phone/am_email/director/rd_email were
  // promoted from metadata to real columns on core.locations a while back
  // (see the Location type) — this used to only ever check metadata, which
  // is now stale/empty for any location touched since that promotion, so
  // every one of those fields silently read blank. Matches locVal() in
  // LocationLookupPage.tsx, which already got this right.
  function fieldValue(id: string | null, key: string): string {
    const l = byId(id)
    if (!l) return ''
    if (key === 'name') return l.name
    if (key === 'shop_city') return l.shop_city ?? ''
    if (key === 'region') return l.region ?? ''
    const base = (l as any)[key]
    if (base != null && base !== '') return String(base)
    const v = (l.metadata as any)?.[key]
    return v == null ? '' : String(v)
  }

  const options = locations.filter((l) => l.active)
    .map((l) => ({ value: l.id, label: `${l.name} — ${l.shop_city ?? ''}` }))
    .sort(byNaturalLabel)

  // Exclusion-aware variants for listing/lookup dropdowns (config/operational
  // flows keep using `locations`/`options`, which intentionally ignore these).
  const included = locations.filter((l) => !isExcluded(l))
  const includedOptions = included.filter((l) => l.active)
    .map((l) => ({ value: l.id, label: `${l.name} — ${l.shop_city ?? ''}` }))
    .sort(byNaturalLabel)

  // Resolve to a location name (code) string (for tables that key on code).
  function codeOf(id: string | null): string {
    return byId(id)?.name ?? ''
  }

  return { locations, posMaps, options, included, includedOptions, isExcluded, resolveId, byId, labelOf, codeOf, fieldValue, posStringFor, reload }
}
