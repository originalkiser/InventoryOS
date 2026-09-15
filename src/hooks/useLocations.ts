import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { byNaturalLabel } from '@/lib/naturalSort'
import { shopNumberCityLabel } from '@/lib/shopLabels'
import type { Location, PosLocationMap } from '@/types'

// Section-header/divider rows (e.g. a Monday.com group header like "Open Car
// Wash Stores") sometimes land in core.locations as ordinary active rows — a
// real shop's `name` is always its numeric code, so anything with no digit
// in it isn't an actual shop. Exported so call sites that query
// core.locations directly (not through useLocations) can apply the same
// rule without duplicating the regex.
export function isRealShopLocation(l: Pick<Location, 'name'>): boolean {
  return /\d/.test(l.name ?? '')
}

// A location manually classified 'car_wash' (Locations page's "Need
// Classification" prompt — see migration 20260909d) is a real shop with a
// real numeric name, unlike the header rows isRealShopLocation filters
// above, but should behave the same way everywhere in this app: it exists
// in core.locations and shows in the Locations page's own dedicated
// "Car Wash" group, but never in a lookup list, dashboard, alert, or order
// run. Exported for the same reason as isRealShopLocation — a call site
// that queries core.locations directly (not through this hook) applies the
// same rule without duplicating it.
export function isOperationalLocation(l: Pick<Location, 'name' | 'location_type'>): boolean {
  return isRealShopLocation(l) && l.location_type !== 'car_wash'
}

// Every core.locations column except raw_monday_data (confirmed via
// information_schema.columns 2026-09-15, not just this doc/the TS type —
// see CLAUDE.md's own "verify empirically" history with this table).
// raw_monday_data is never read anywhere in the frontend (write-only, the
// Monday sync's own source-payload archive) but averages ~2KB/row and was
// going out on every single core.locations fetch regardless — a real
// contributor to a live-reported 2.7MB response for a ~370-row table.
// Exported so any other direct `.from('locations').select('*')` call site
// (useInventoryAlerts.ts is the other one right now) can drop the same
// column without duplicating this list or drifting from it.
export const LOCATION_COLUMNS_SANS_MONDAY_PAYLOAD =
  'id, company_id, name, shop_city, region, active, metadata, created_at, updated_at, updated_by, last_change_source, ' +
  'order_date, district, monday_item_id, last_synced_at, owner, market, area_manager, am_phone, am_email, director, rd_email, ' +
  'status, address, city, state, county, zip, store_phone, store_email, location, num_bays, pit_type, store_type, classification, ' +
  'groups, entity_name, brand_used, developer, landlord, num_days_open, manager_workweek, second_asm_approved, date_opened, ' +
  'acquisition_date, year_opened, droptop_go_live, last_price_change, review_pricing_date, last_day_of_business, monday_hours, ' +
  'tuesday_hours, wednesday_hours, thursday_hours, friday_hours, saturday_hours, sunday_hours, holiday_hours, tire_rotations, ' +
  'safety_inspections, emissions_inspections, royalty_rate, local_ad_percent, local_ad_dollar, brand_fund, technology_fee, ' +
  'sales_quartile, economy, premium_hm, premium_full_synthetic, premium_full_synthetic_hm, rp, diesel_syn_blend, diesel_full_syn, ' +
  'european, supply_fee, disposal_fee, oil_inflation_surcharge, planned_2023, planned_2024, valvoline_account_num, ai_shop_id, ' +
  'ai_username, partnerconnect_username, google_review_url, google_review_qr_code, training_shops, integration_manager_region, ' +
  'opus_serial_primary, opus_serial_secondary, former_fz_store_num, tmcw_ql, am_data_map, rd_data_map, droptop_num, ' +
  'droptop_operation_id, reladyne_delivery_day, ai_call_center, ai_call_center_phone, mighty_fz, camera_system, ' +
  'inspection_station_id, mighty_po_upload, marketing_manager, mm_email, mm_cell, hrbp, latitude, longitude, location_type'

// Loads the company's locations and provides id <-> code/name resolution,
// plus access to each location's custom metadata for cross-section linking.
// Also consults the POS location map so uploads whose location value is a POS
// string ("001 - Thomasville") resolve to the right location.
//
// `surface` controls whether franchise (non-Corporate-owner) locations are
// excluded by default — 'inventory' (default, matches every existing call
// site unchanged) excludes them unless the user has set their own Owner
// rule; 'other' (Customer Heatmap, Droptop Orders, and other
// non-operational surfaces) includes them by default instead. See
// useLocationExclusions' own comment for the full reasoning.
// Module-level cache + in-flight de-dup, same shape/reasoning as
// useInventory.ts's invCache — found live 2026-09-15 (a .har of a slow
// Order Config load) that this hook had neither: three concurrent
// `core.locations?select=*` pulls fired at once (two identical calls from
// two KeepAlivePages-mounted pages each running their own useLocations()
// instance, plus a third from useInventoryAlerts()'s separate fetch),
// and — with Supabase's own edge layer visibly degraded that day — a
// single one of those took 104 seconds, so doing it 2-3x concurrently
// multiplied real wall-clock wait for something that should be one shared
// pull. `surface` only affects useLocationExclusions below, never the raw
// fetch itself, so the cache key is just companyId.
interface LocCache { companyId: string; locations: Location[]; posMaps: PosLocationMap[]; fetchedAt: number }
let locCache: LocCache | null = null
let locFetchInFlight: { companyId: string; promise: Promise<LocCache> } | null = null
const LOC_CACHE_TTL = 5 * 60 * 1000

export function useLocations(surface: 'inventory' | 'other' = 'inventory') {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { isExcluded } = useLocationExclusions(surface)
  const fresh = locCache?.companyId === companyId
  const [locations, setLocations] = useState<Location[]>(fresh ? locCache!.locations : [])
  const [posMaps, setPosMaps] = useState<PosLocationMap[]>(fresh ? locCache!.posMaps : [])
  // Exposed so a page whose own data loads fast (e.g. Location Comms' own
  // small table) can hold its loading spinner until locations are ready too
  // instead of rendering with every location-derived label/lookup still
  // blank and then popping in a moment later — see loadingRef note below.
  const [loading, setLoading] = useState(!fresh)

  const load = useCallback(async (force = false) => {
    if (!companyId) { setLocations([]); setPosMaps([]); setLoading(false); return }
    if (!force && locCache?.companyId === companyId && Date.now() - locCache.fetchedAt < LOC_CACHE_TTL) {
      setLocations(locCache.locations)
      setPosMaps(locCache.posMaps)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      let inFlight = locFetchInFlight?.companyId === companyId ? locFetchInFlight.promise : null
      if (!inFlight || force) {
        const promise = (async (): Promise<LocCache> => {
          const [loc, pos] = await Promise.all([
            (supabase as any).schema('core').from('locations').select(LOCATION_COLUMNS_SANS_MONDAY_PAYLOAD).eq('company_id', companyId).order('name'),
            (supabase as any).schema('core').from('pos_location_map').select('*').eq('company_id', companyId),
          ])
          // Filtered here (not at the query) so Config -> Locations and the
          // Locations page's own Car Wash/Closed groups, which read
          // core.locations directly and not through this hook, still see
          // header rows and car-wash locations — this hook feeds the
          // operational surfaces (Location Lookup, AM/RD Lookup, most
          // dropdowns) that should never see either.
          const entry: LocCache = {
            companyId,
            locations: ((loc.data ?? []) as Location[]).filter(isOperationalLocation),
            posMaps: (pos.data ?? []) as PosLocationMap[],
            fetchedAt: Date.now(),
          }
          locCache = entry
          return entry
        })()
        locFetchInFlight = { companyId, promise }
        inFlight = promise
      }
      const entry = await inFlight
      setLocations(entry.locations)
      setPosMaps(entry.posMaps)
    } finally {
      setLoading(false)
      if (locFetchInFlight?.companyId === companyId) locFetchInFlight = null
    }
  }, [companyId, isExcluded])

  // Manual refresh (after editing/matching a location elsewhere) always
  // bypasses the cache — the 2 real call sites (Tank Monitors' unassigned
  // matcher, Menu Board's revisit refresh) need a genuinely fresh pull.
  const reload = useCallback(() => load(true), [load])

  useEffect(() => { load() }, [load])

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

  // Wrapped in useCallback (stable identity as long as their real inputs —
  // the memoized lookup maps / `locations` itself — don't change) so
  // consumers that memoize on these functions (e.g. a report's useMemo
  // depending on `loc.byId`/`loc.fieldValue` instead of the whole `loc`
  // object) actually get the memoization benefit instead of recomputing on
  // every render. See includedOptions/options below for the matching fix on
  // the derived arrays.
  const resolveId = useCallback((value: string | null | undefined): string | null => {
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
  }, [byExactKey, posByExactKey, byCodeNumber, posByNumber])

  // Reverse lookup: the POS string mapped to a location (for showing POS in
  // other tables keyed by location).
  const posStringFor = useCallback((id: string | null): string => {
    if (!id) return ''
    return posMaps.find((p) => p.location_id === id)?.pos_string ?? ''
  }, [posMaps])

  const byId = useCallback((id: string | null): Location | undefined => {
    return id ? locations.find((l) => l.id === id) : undefined
  }, [locations])

  const labelOf = useCallback((id: string | null): string => {
    const l = byId(id)
    return l ? shopNumberCityLabel(l.name, l.shop_city) : '—'
  }, [byId])

  // Resolve a (possibly linked) field value for a location: base columns first,
  // then custom metadata by key. Used by cross-section linked columns.
  //
  // area_manager/owner/market/am_phone/am_email/director/rd_email were
  // promoted from metadata to real columns on core.locations a while back
  // (see the Location type) — this used to only ever check metadata, which
  // is now stale/empty for any location touched since that promotion, so
  // every one of those fields silently read blank. Matches locVal() in
  // LocationLookupPage.tsx, which already got this right.
  const fieldValue = useCallback((id: string | null, key: string): string => {
    const l = byId(id)
    if (!l) return ''
    if (key === 'name') return l.name
    if (key === 'shop_city') return l.shop_city ?? ''
    if (key === 'region') return l.region ?? ''
    const base = (l as any)[key]
    if (base != null && base !== '') return String(base)
    const v = (l.metadata as any)?.[key]
    return v == null ? '' : String(v)
  }, [byId])

  // These used to be plain per-render `.filter()`/`.map()`/`.sort()` calls —
  // cheap on their own, but every consumer that depends on `options`/
  // `included`/`includedOptions` (or the whole `loc` object) then recomputed
  // on every render of every page using this hook regardless of whether
  // `locations` actually changed, since the arrays got a fresh identity each
  // time. Wrapped in useMemo so downstream memoization actually holds — no
  // behavior change, same filter/sort logic.
  const options = useMemo(() => locations.filter((l) => l.active)
    .map((l) => ({ value: l.id, label: shopNumberCityLabel(l.name, l.shop_city) }))
    .sort(byNaturalLabel), [locations])

  // Exclusion-aware variants for listing/lookup dropdowns (config/operational
  // flows keep using `locations`/`options`, which intentionally ignore these).
  const included = useMemo(() => locations.filter((l) => !isExcluded(l)), [locations, isExcluded])
  const includedOptions = useMemo(() => included.filter((l) => l.active)
    .map((l) => ({ value: l.id, label: shopNumberCityLabel(l.name, l.shop_city) }))
    .sort(byNaturalLabel), [included])

  // Resolve to a location name (code) string (for tables that key on code).
  const codeOf = useCallback((id: string | null): string => {
    return byId(id)?.name ?? ''
  }, [byId])

  return useMemo(() => ({ locations, posMaps, loading, options, included, includedOptions, isExcluded, resolveId, byId, labelOf, codeOf, fieldValue, posStringFor, reload }),
    [locations, posMaps, loading, options, included, includedOptions, isExcluded, resolveId, byId, labelOf, codeOf, fieldValue, posStringFor, reload])
}
