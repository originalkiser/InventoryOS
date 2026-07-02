import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, useMapEvents, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Location } from '@/types'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { useDarkMode } from '@/hooks/useDarkMode'
import toast from 'react-hot-toast'
import { ManualRouteModal } from './ManualRouteModal'
import { ApiConfirmModal } from './ApiConfirmModal'

// ─── Types ──────────────────────────────────────────────────────────────────

interface LocationRoute {
  id: string
  company_id: string
  origin_location_id: string
  destination_location_id: string
  distance_miles: number | null
  drive_time_minutes: number | null
  route_geometry: string | null
  data_source: 'api' | 'manual' | 'imported' | 'saved_api'
  updated_at: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

// 12 perceptually distinct colors (brand palette + safe extensions)
const MARKET_PALETTE = [
  '#002745', '#C0392B', '#E67E22', '#2ECC71',
  '#4F7489', '#9B59B6', '#1ABC9C', '#E91E63',
  '#FF5722', '#3F51B5', '#00BCD4', '#FFC107',
]
// 3 pattern types — solid, diagonal stripe, horizontal stripe.
// 12 colors × 3 patterns = 36 unique combinations before any repeat.
const MARKET_PATTERNS = ['solid', 'diag', 'horiz'] as const
type MarketPattern = typeof MARKET_PATTERNS[number]

function getMarketBackground(market: string, allMarkets: string[]): string {
  if (!market) return '#4F7489'
  const idx = allMarkets.indexOf(market)
  const color = MARKET_PALETTE[idx % MARKET_PALETTE.length]
  const pattern: MarketPattern = MARKET_PATTERNS[Math.floor(idx / MARKET_PALETTE.length) % MARKET_PATTERNS.length]
  if (pattern === 'diag') {
    return `repeating-linear-gradient(45deg,${color},${color} 3px,rgba(255,255,255,0.45) 3px,rgba(255,255,255,0.45) 6px)`
  }
  if (pattern === 'horiz') {
    return `repeating-linear-gradient(0deg,${color},${color} 3px,rgba(255,255,255,0.45) 3px,rgba(255,255,255,0.45) 6px)`
  }
  return color // solid
}

// Keep a solid color for the legend swatch border and list dots
function getMarketSolidColor(market: string, allMarkets: string[]): string {
  if (!market) return '#4F7489'
  const idx = allMarkets.indexOf(market)
  return MARKET_PALETTE[idx % MARKET_PALETTE.length]
}

const LOC_FILTER_HIERARCHY = [
  { field: 'region',        label: 'Region' },
  { field: 'market',        label: 'Market' },
  { field: 'area_manager',  label: 'Area Manager' },
]

// ─── Utilities ───────────────────────────────────────────────────────────────

function locFieldValue(loc: Location, field: string): string {
  // Direct columns take priority (post-schema-overhaul); fall back to metadata
  const direct = (loc as any)[field]
  if (direct != null) return String(direct)
  return String((loc.metadata as any)?.[field] ?? '')
}

function routeKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/** Decode a Google encoded polyline to [lat, lng] pairs */
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = []
  let idx = 0
  let lat = 0
  let lng = 0
  while (idx < encoded.length) {
    let b: number
    let shift = 0
    let result = 0
    do {
      b = encoded.charCodeAt(idx++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0
    result = 0
    do {
      b = encoded.charCodeAt(idx++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    coords.push([lat / 1e5, lng / 1e5])
  }
  return coords
}

/** Nearest-neighbor TSP approximation */
function nearestNeighborRoute(locs: Location[]): Location[] {
  if (locs.length <= 2) return locs
  const unvisited = new Set(locs.map((l) => l.id))
  const ordered: Location[] = []
  let current = locs[0]
  ordered.push(current)
  unvisited.delete(current.id)
  while (unvisited.size > 0) {
    let bestDist = Infinity
    let bestLoc: Location | null = null
    for (const id of unvisited) {
      const l = locs.find((x) => x.id === id)!
      if ((l.latitude == null || l.longitude == null) || (current.latitude == null || current.longitude == null)) {
        bestLoc = l
        break
      }
      const dx = (l.latitude as number) - (current.latitude as number)
      const dy = (l.longitude as number) - (current.longitude as number)
      const d = dx * dx + dy * dy
      if (d < bestDist) { bestDist = d; bestLoc = l }
    }
    if (!bestLoc) break
    ordered.push(bestLoc)
    unvisited.delete(bestLoc.id)
    current = bestLoc
  }
  return ordered
}

function makePin(code: string, background: string, selected: boolean, showLabel: boolean): L.DivIcon {
  const size = 14
  const label = showLabel
    ? `<span style="position:absolute;top:17px;left:50%;transform:translateX(-50%);font-size:11px;font-family:monospace;font-weight:600;white-space:nowrap;color:#002745;background:rgba(242,241,230,0.92);padding:1px 4px;border-radius:3px;pointer-events:none;">${code}</span>`
    : ''
  const border = selected ? '2px solid #F2F1E6' : '1.5px solid rgba(0,39,69,0.3)'
  const shadow = selected ? '0 0 0 4px rgba(183,224,222,0.7)' : '0 1px 3px rgba(0,0,0,0.25)'
  return L.divIcon({
    className: '',
    iconAnchor: [size / 2, size / 2],
    html: `<div style="position:relative;width:${size}px;height:${size}px;background:${background};border:${border};border-radius:50%;box-shadow:${shadow};"></div>${label}`,
    iconSize: [size, size],
  })
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ZoomTracker({ onZoom }: { onZoom: (z: number) => void }) {
  useMapEvents({ zoomend: (e) => onZoom(e.target.getZoom()) })
  return null
}

function MapResizer() {
  const map = useMap()
  useEffect(() => {
    setTimeout(() => map.invalidateSize(), 100)
  }, [map])
  return null
}

// ─── Main component ──────────────────────────────────────────────────────────

interface Props {
  locations: Location[]
}

export function MapRoutesTab({ locations }: Props) {
  const { profile } = useAuthStore()
  const { dark } = useDarkMode()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const companyId = profile?.company_id

  // Route data
  const [routes, setRoutes] = useState<LocationRoute[]>([])
  const [loadingRoutes, setLoadingRoutes] = useState(true)

  // Map state
  const [zoom, setZoom] = useState(7)
  const showLabels = zoom >= 10

  // Selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Filters
  const [filterRegion, setFilterRegion] = useState('')
  const [filterMarket, setFilterMarket] = useState('')
  const [filterAM, setFilterAM] = useState('')

  // Modals
  const [manualModal, setManualModal] = useState<{ origin: Location; destination: Location; existing: LocationRoute | null } | null>(null)
  const [apiConfirmModal, setApiConfirmModal] = useState<{ pairs: [Location, Location][] } | null>(null)
  const [apiLoading, setApiLoading] = useState(false)

  // Location lat/lng edit
  const [editingLatLng, setEditingLatLng] = useState<string | null>(null)
  const [latInput, setLatInput] = useState('')
  const [lngInput, setLngInput] = useState('')
  const [savingLatLng, setSavingLatLng] = useState(false)

  // Load routes
  useEffect(() => {
    if (!companyId) return
    loadRoutes()
  }, [companyId])

  async function loadRoutes() {
    setLoadingRoutes(true)
    const sb = supabase as any
    const { data, error } = await sb.schema('core').from('location_routes')
      .select('*')
      .eq('company_id', companyId)
    if (error) toast.error('Failed to load route data')
    setRoutes(data ?? [])
    setLoadingRoutes(false)
  }

  // Route lookup map (bidirectional)
  const routeMap = useMemo(() => {
    const m = new Map<string, LocationRoute>()
    for (const r of routes) m.set(routeKey(r.origin_location_id, r.destination_location_id), r)
    return m
  }, [routes])

  // Markets for coloring
  const allMarkets = useMemo(() => {
    const s = new Set(locations.map((l) => locFieldValue(l, 'market')).filter(Boolean))
    return Array.from(s).sort()
  }, [locations])

  // Filter helpers
  const regionOptions = useMemo(() => Array.from(new Set(locations.map((l) => l.region ?? '').filter(Boolean))).sort(), [locations])
  const marketOptions = useMemo(() => {
    let r = locations
    if (filterRegion) r = r.filter((l) => l.region === filterRegion)
    return Array.from(new Set(r.map((l) => locFieldValue(l, 'market')).filter(Boolean))).sort()
  }, [locations, filterRegion])
  const amOptions = useMemo(() => {
    let r = locations
    if (filterRegion) r = r.filter((l) => l.region === filterRegion)
    if (filterMarket) r = r.filter((l) => locFieldValue(l, 'market') === filterMarket)
    return Array.from(new Set(r.map((l) => locFieldValue(l, 'area_manager')).filter(Boolean))).sort()
  }, [locations, filterRegion, filterMarket])

  // Filtered locations (with lat/lng for the map; still show all on map but highlight)
  const filteredLocations = useMemo(() => {
    let r = locations
    if (filterRegion) r = r.filter((l) => l.region === filterRegion)
    if (filterMarket) r = r.filter((l) => locFieldValue(l, 'market') === filterMarket)
    if (filterAM) r = r.filter((l) => locFieldValue(l, 'area_manager') === filterAM)
    return r
  }, [locations, filterRegion, filterMarket, filterAM])

  const hasFilter = !!(filterRegion || filterMarket || filterAM)
  const mappableLocations = useMemo(
    () => filteredLocations.filter((l) => l.latitude != null && l.longitude != null),
    [filteredLocations]
  )

  // Center on first mappable location
  const mapCenter = useMemo((): [number, number] => {
    if (mappableLocations.length > 0) {
      return [mappableLocations[0].latitude as number, mappableLocations[0].longitude as number]
    }
    return [39.5, -98.35] // center of contiguous US
  }, []) // intentionally only computed once

  // Selected location objects, route-ordered
  const selectedLocations = useMemo(() => {
    const locs = locations.filter((l) => selectedIds.has(l.id))
    return nearestNeighborRoute(locs)
  }, [locations, selectedIds])

  // Route segments for selected ordered locations
  const routeSegments = useMemo(() => {
    const segs: { route: LocationRoute | null; from: Location; to: Location }[] = []
    for (let i = 0; i < selectedLocations.length - 1; i++) {
      const from = selectedLocations[i]
      const to = selectedLocations[i + 1]
      const key = routeKey(from.id, to.id)
      segs.push({ route: routeMap.get(key) ?? null, from, to })
    }
    return segs
  }, [selectedLocations, routeMap])

  // Route stats
  const routeStats = useMemo(() => {
    let totalMiles = 0
    let totalMinutes = 0
    let hasAll = true
    let hasAny = false
    for (const seg of routeSegments) {
      if (seg.route?.distance_miles != null) {
        totalMiles += seg.route.distance_miles
        hasAny = true
      } else {
        hasAll = false
      }
      if (seg.route?.drive_time_minutes != null) totalMinutes += seg.route.drive_time_minutes
    }
    return { totalMiles: Math.round(totalMiles * 10) / 10, totalMinutes, hasAll, hasAny }
  }, [routeSegments])

  // Pairs that need API data
  const missingApiPairs = useMemo((): [Location, Location][] => {
    return routeSegments
      .filter((s) => !s.route && s.from.latitude != null && s.from.longitude != null && s.to.latitude != null && s.to.longitude != null)
      .map((s) => [s.from, s.to])
  }, [routeSegments])

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function selectFiltered() {
    setSelectedIds(new Set(filteredLocations.map((l) => l.id)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  async function handleApiConfirm() {
    if (!apiConfirmModal || !companyId) return
    setApiLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')

      const sb = supabase as any
      const url = `${(sb as any).supabaseUrl}/functions/v1/compute-routes`

      const pairs = apiConfirmModal.pairs.map(([o, d]) => ({
        origin_id: o.id,
        destination_id: d.id,
        origin_lat: o.latitude as number,
        origin_lng: o.longitude as number,
        dest_lat: d.latitude as number,
        dest_lng: d.longitude as number,
      }))

      const resp = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-routes`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({ pairs, company_id: companyId }),
        }
      )

      if (!resp.ok) {
        const err = await resp.json()
        throw new Error(err.error ?? 'API error')
      }

      const result = await resp.json()
      const succeeded = result.results?.filter((r: any) => !r.error).length ?? 0
      const failed = result.results?.filter((r: any) => r.error).length ?? 0

      toast.success(`${succeeded} route${succeeded !== 1 ? 's' : ''} computed${failed ? ` (${failed} failed)` : ''}`)
      setApiConfirmModal(null)
      await loadRoutes()
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to compute routes')
    } finally {
      setApiLoading(false)
    }
  }

  async function handleManualSave(distanceMiles: number, driveTimeMinutes: number) {
    if (!manualModal || !companyId) return
    const { origin, destination } = manualModal
    const sb = supabase as any
    const { error } = await sb.schema('core').from('location_routes').upsert({
      company_id: companyId,
      origin_location_id: origin.id,
      destination_location_id: destination.id,
      distance_miles: distanceMiles,
      drive_time_minutes: driveTimeMinutes,
      data_source: 'manual',
      updated_by: profile?.id ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,origin_location_id,destination_location_id' })

    if (error) { toast.error('Failed to save route data'); return }
    toast.success('Route data saved')
    setManualModal(null)
    await loadRoutes()
  }

  async function saveLatLng(locId: string) {
    const lat = parseFloat(latInput)
    const lng = parseFloat(lngInput)
    if (!isFinite(lat) || !isFinite(lng)) { toast.error('Invalid coordinates'); return }
    setSavingLatLng(true)
    const sb = supabase as any
    const { error } = await sb.schema('core').from('locations')
      .update({ latitude: lat, longitude: lng, updated_at: new Date().toISOString() })
      .eq('id', locId)
    setSavingLatLng(false)
    if (error) { toast.error('Failed to save coordinates'); return }
    toast.success('Coordinates saved')
    setEditingLatLng(null)
  }

  const tileUrl = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
  const tileAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

  return (
    <div className="flex flex-col gap-4">
      {/* Filter bar */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Region</span>
          <select
            value={filterRegion}
            onChange={(e) => { setFilterRegion(e.target.value); setFilterMarket(''); setFilterAM('') }}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none"
          >
            <option value="">All</option>
            {regionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Market</span>
          <select
            value={filterMarket}
            onChange={(e) => { setFilterMarket(e.target.value); setFilterAM('') }}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none"
          >
            <option value="">All</option>
            {marketOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Area Manager</span>
          <select
            value={filterAM}
            onChange={(e) => setFilterAM(e.target.value)}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none"
          >
            <option value="">All</option>
            {amOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {hasFilter && (
          <button
            onClick={() => { setFilterRegion(''); setFilterMarket(''); setFilterAM('') }}
            className="text-xs font-mono text-inky/60 hover:text-navy underline pb-1"
          >
            Clear
          </button>
        )}
        <div className="ml-auto flex items-end gap-2 pb-0.5">
          {filteredLocations.length > 0 && selectedIds.size === 0 && (
            <button
              onClick={selectFiltered}
              className="text-xs font-mono px-3 py-1.5 border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
            >
              Select {hasFilter ? 'Filtered' : 'All'} ({filteredLocations.length})
            </button>
          )}
          {selectedIds.size > 0 && (
            <button
              onClick={clearSelection}
              className="text-xs font-mono px-3 py-1.5 border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
            >
              Clear Selection ({selectedIds.size})
            </button>
          )}
        </div>
      </div>

      {/* Map + panel layout */}
      <div className="flex gap-4" style={{ height: 1040 }}>
        {/* Map */}
        <div className="flex-1 rounded border border-navy/20 overflow-hidden min-w-0">
          {mappableLocations.length === 0 && !loadingRoutes ? (
            <div className="h-full flex flex-col items-center justify-center gap-3 bg-navy/5">
              <p className="text-xs font-mono text-inky/60 text-center max-w-xs">
                No locations have coordinates yet. Add latitude/longitude to locations using the panel on the right, or select a location below.
              </p>
            </div>
          ) : (
            <MapContainer
              center={mapCenter}
              zoom={zoom}
              style={{ height: '100%', width: '100%' }}
              zoomControl
            >
              <TileLayer url={tileUrl} attribution={tileAttribution} />
              <ZoomTracker onZoom={setZoom} />
              <MapResizer />

              {/* Location pins */}
              {mappableLocations.map((loc) => {
                const market = locFieldValue(loc, 'market')
                const bg = getMarketBackground(market, allMarkets)
                const selected = selectedIds.has(loc.id)
                return (
                  <Marker
                    key={loc.id}
                    position={[loc.latitude as number, loc.longitude as number]}
                    icon={makePin(loc.name, bg, selected, showLabels)}
                    eventHandlers={{ click: () => toggleSelect(loc.id) }}
                  />
                )
              })}

              {/* Route polylines */}
              {routeSegments.map((seg, i) => {
                if (!seg.from.latitude || !seg.to.latitude) return null
                const fromPos: [number, number] = [seg.from.latitude as number, seg.from.longitude as number]
                const toPos: [number, number] = [seg.to.latitude as number, seg.to.longitude as number]

                if (seg.route?.route_geometry) {
                  // API geometry — solid line
                  const positions = decodePolyline(seg.route.route_geometry)
                  return <Polyline key={i} positions={positions} color="#002745" weight={3} opacity={0.8} />
                }
                if (seg.route) {
                  // Manual data — dashed straight line
                  return <Polyline key={i} positions={[fromPos, toPos]} color="#4F7489" weight={2} opacity={0.7} dashArray="6 4" />
                }
                // No data — faint dotted line
                return <Polyline key={i} positions={[fromPos, toPos]} color="#B7E0DE" weight={1.5} opacity={0.5} dashArray="2 6" />
              })}
            </MapContainer>
          )}
        </div>

        {/* Side panel */}
        <div className="w-72 flex-shrink-0 flex flex-col border border-navy/20 rounded overflow-hidden">
          {/* Panel header */}
          <div className="bg-navy px-3 py-2 flex-shrink-0">
            <p className="text-xs font-heading font-bold text-cream uppercase tracking-wide">
              {selectedIds.size === 0 ? 'Route Builder' : `Route (${selectedLocations.length} stops)`}
            </p>
          </div>

          {selectedIds.size === 0 ? (
            <div className="flex-1 flex flex-col gap-3 p-3 overflow-y-auto">
              <p className="text-[11px] font-mono text-inky/70">
                Click pins on the map or select locations below to build a route. The tab uses saved route data to calculate optimal order and totals.
              </p>

              {/* Legend */}
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-1.5">Market Colors</p>
                <div className="flex flex-col gap-1">
                  {allMarkets.slice(0, 12).map((m) => (
                    <div key={m} className="flex items-center gap-1.5">
                      <div
                        className="w-3.5 h-3.5 rounded-full flex-shrink-0"
                        style={{
                          background: getMarketBackground(m, allMarkets),
                          border: `1.5px solid ${getMarketSolidColor(m, allMarkets)}`,
                        }}
                      />
                      <span className="text-[10px] font-mono text-navy truncate">{m}</span>
                    </div>
                  ))}
                  {allMarkets.length > 10 && (
                    <span className="text-[10px] font-mono text-inky/40">+{allMarkets.length - 10} more</span>
                  )}
                </div>
              </div>

              {/* Line type legend */}
              <div>
                <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide mb-1.5">Route Lines</p>
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-0.5 bg-navy flex-shrink-0" />
                    <span className="text-[10px] font-mono text-navy">API geometry</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-0.5 border-t-2 border-dashed border-inky flex-shrink-0" />
                    <span className="text-[10px] font-mono text-navy">Manual entry</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-0.5 border-t border-dotted border-sky flex-shrink-0" />
                    <span className="text-[10px] font-mono text-navy">No data</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Route stats */}
              {routeSegments.length > 0 && (
                <div className="px-3 py-2 border-b border-navy/10 bg-navy/5 flex-shrink-0">
                  {routeStats.hasAny ? (
                    <div className="flex gap-4 text-xs font-mono text-navy">
                      <span><strong>{routeStats.totalMiles}</strong> mi</span>
                      <span><strong>{Math.floor(routeStats.totalMinutes / 60)}h {routeStats.totalMinutes % 60}m</strong></span>
                      {!routeStats.hasAll && (
                        <span className="text-[#E67E22] text-[10px]">partial data</span>
                      )}
                    </div>
                  ) : (
                    <p className="text-[10px] font-mono text-inky/50">No route data for these segments yet</p>
                  )}
                </div>
              )}

              {/* Stop list */}
              <div className="flex-1 overflow-y-auto divide-y divide-navy/5">
                {selectedLocations.map((loc, i) => {
                  const seg = routeSegments[i] // segment FROM this stop to next
                  const hasCoords = loc.latitude != null && loc.longitude != null
                  return (
                    <div key={loc.id} className="px-3 py-2 hover:bg-navy/5 transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2 min-w-0">
                          <span className="text-[10px] font-mono text-inky/40 w-4 text-right flex-shrink-0 mt-0.5">{i + 1}</span>
                          <div className="min-w-0">
                            <p className="text-xs font-mono font-bold text-navy">{loc.name}</p>
                            <p className="text-[10px] font-mono text-inky/60 truncate">{loc.shop_city}</p>
                            {!hasCoords && (
                              <p className="text-[10px] font-mono text-[#E67E22]">No coordinates</p>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => toggleSelect(loc.id)}
                          className="text-[10px] text-inky/30 hover:text-[#C0392B] transition-colors flex-shrink-0 mt-0.5"
                          title="Remove from route"
                        >✕</button>
                      </div>

                      {/* Segment info (below each stop except last) */}
                      {seg && (
                        <div className="mt-1.5 ml-6 flex items-center gap-2">
                          {seg.route ? (
                            <div className="flex items-center gap-2 text-[10px] font-mono text-inky/60">
                              {seg.route.distance_miles != null && <span>{seg.route.distance_miles} mi</span>}
                              {seg.route.drive_time_minutes != null && (
                                <span>{seg.route.drive_time_minutes} min</span>
                              )}
                              <span className="text-[9px] px-1 rounded"
                                style={{ background: seg.route.data_source === 'api' || seg.route.data_source === 'saved_api' ? 'rgba(46,204,113,0.15)' : 'rgba(0,39,69,0.06)' }}>
                                {seg.route.data_source}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[10px] font-mono text-inky/40">No data</span>
                          )}
                          <button
                            onClick={() => {
                              setManualModal({ origin: seg.from, destination: seg.to, existing: seg.route })
                            }}
                            className="text-[10px] font-mono text-sky hover:text-navy transition-colors ml-auto"
                          >
                            {seg.route ? 'Edit' : '+ Add'}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Actions */}
              {isAdmin && missingApiPairs.length > 0 && (
                <div className="p-3 border-t border-navy/10 flex-shrink-0">
                  <button
                    onClick={() => setApiConfirmModal({ pairs: missingApiPairs })}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-navy text-cream text-xs font-mono rounded hover:bg-navy/80 transition-colors"
                  >
                    Get {missingApiPairs.length} missing route{missingApiPairs.length !== 1 ? 's' : ''} via API
                  </button>
                  <p className="text-[9px] font-mono text-inky/40 text-center mt-1">Admin only · Google Routes API · paid</p>
                </div>
              )}
            </div>
          )}

          {/* Location list for clicking/coord entry */}
          <div className="border-t border-navy/20 flex-shrink-0">
            <div className="px-3 py-1.5 bg-navy/5 border-b border-navy/10">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">
                {filteredLocations.length} location{filteredLocations.length !== 1 ? 's' : ''}
                {hasFilter ? ' (filtered)' : ''}
              </p>
            </div>
            <div className="max-h-36 overflow-y-auto divide-y divide-navy/5">
              {filteredLocations.map((loc) => {
                const hasCoords = loc.latitude != null && loc.longitude != null
                const sel = selectedIds.has(loc.id)
                const editing = editingLatLng === loc.id
                return (
                  <div key={loc.id}>
                    <div
                      className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors ${sel ? 'bg-sky/20' : 'hover:bg-navy/5'}`}
                      onClick={() => !editing && toggleSelect(loc.id)}
                    >
                      <div
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ background: getMarketBackground(locFieldValue(loc, 'market'), allMarkets) }}
                      />
                      <span className="text-xs font-mono text-navy flex-1 truncate">{loc.name}</span>
                      {!hasCoords && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingLatLng(loc.id)
                            setLatInput('')
                            setLngInput('')
                          }}
                          className="text-[9px] font-mono text-[#E67E22] hover:underline flex-shrink-0"
                          title="Add coordinates"
                        >
                          + coords
                        </button>
                      )}
                      {hasCoords && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingLatLng(loc.id)
                            setLatInput(String(loc.latitude))
                            setLngInput(String(loc.longitude))
                          }}
                          className="text-[9px] font-mono text-inky/30 hover:text-inky/60 flex-shrink-0"
                          title="Edit coordinates"
                        >
                          ✎
                        </button>
                      )}
                    </div>
                    {editing && (
                      <div className="px-3 py-2 bg-cream dark:bg-[#0e2638] border-t border-navy/10 flex flex-col gap-1.5">
                        <div className="flex gap-1.5">
                          <input
                            value={latInput}
                            onChange={(e) => setLatInput(e.target.value)}
                            placeholder="Latitude"
                            className="flex-1 min-w-0 rounded border border-navy/30 bg-white dark:bg-[#122b40] px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none"
                          />
                          <input
                            value={lngInput}
                            onChange={(e) => setLngInput(e.target.value)}
                            placeholder="Longitude"
                            className="flex-1 min-w-0 rounded border border-navy/30 bg-white dark:bg-[#122b40] px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none"
                          />
                        </div>
                        <div className="flex gap-1.5">
                          <button
                            onClick={() => saveLatLng(loc.id)}
                            disabled={savingLatLng}
                            className="flex-1 py-1 bg-navy text-cream text-[10px] font-mono rounded hover:bg-navy/80 disabled:opacity-50"
                          >
                            {savingLatLng ? '…' : 'Save'}
                          </button>
                          <button
                            onClick={() => setEditingLatLng(null)}
                            className="flex-1 py-1 border border-navy/30 text-inky text-[10px] font-mono rounded hover:border-navy/60"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Unmapped count */}
      {filteredLocations.length > 0 && filteredLocations.length !== mappableLocations.length && (
        <p className="text-[10px] font-mono text-inky/50">
          {filteredLocations.length - mappableLocations.length} location{filteredLocations.length - mappableLocations.length !== 1 ? 's' : ''} hidden from map — no coordinates set.
          Use the list panel to add coordinates.
        </p>
      )}

      {/* Modals */}
      {manualModal && (
        <ManualRouteModal
          origin={manualModal.origin}
          destination={manualModal.destination}
          existing={manualModal.existing}
          onSave={handleManualSave}
          onClose={() => setManualModal(null)}
        />
      )}
      {apiConfirmModal && (
        <ApiConfirmModal
          pairs={apiConfirmModal.pairs}
          onConfirm={handleApiConfirm}
          onClose={() => setApiConfirmModal(null)}
          loading={apiLoading}
        />
      )}
    </div>
  )
}
