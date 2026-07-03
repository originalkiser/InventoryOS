import { useEffect, useState, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polyline, Polygon, useMapEvents, useMap } from 'react-leaflet'
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

type MapMode = 'info' | 'route' | 'draw'

// ─── Constants ───────────────────────────────────────────────────────────────

// 12 perceptually distinct colors × 3 CSS patterns = 36 unique combos before repeat
const MARKET_PALETTE = [
  '#002745', '#C0392B', '#E67E22', '#2ECC71',
  '#4F7489', '#9B59B6', '#1ABC9C', '#E91E63',
  '#FF5722', '#3F51B5', '#00BCD4', '#FFC107',
]
const MARKET_PATTERNS = ['solid', 'diag', 'horiz'] as const
type MarketPattern = typeof MARKET_PATTERNS[number]

const LOC_FILTER_HIERARCHY = [
  { field: 'region',       label: 'Region' },
  { field: 'market',       label: 'Market' },
  { field: 'area_manager', label: 'Area Manager' },
]

// ─── Utilities ───────────────────────────────────────────────────────────────

function locFieldValue(loc: Location, field: string): string {
  const direct = (loc as any)[field]
  if (direct != null) return String(direct)
  return String((loc.metadata as any)?.[field] ?? '')
}

function routeKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

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
  return color
}

function getMarketSolidColor(market: string, allMarkets: string[]): string {
  if (!market) return '#4F7489'
  const idx = allMarkets.indexOf(market)
  return MARKET_PALETTE[idx % MARKET_PALETTE.length]
}

/** Decode a Google encoded polyline to [lat, lng] pairs */
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = []
  let idx = 0; let lat = 0; let lng = 0
  while (idx < encoded.length) {
    let b: number; let shift = 0; let result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0; result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
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
  ordered.push(current); unvisited.delete(current.id)
  while (unvisited.size > 0) {
    let bestDist = Infinity; let bestLoc: Location | null = null
    for (const id of unvisited) {
      const l = locs.find((x) => x.id === id)!
      if (l.latitude == null || l.longitude == null || current.latitude == null || current.longitude == null) { bestLoc = l; break }
      const dx = (l.latitude as number) - (current.latitude as number)
      const dy = (l.longitude as number) - (current.longitude as number)
      if (dx * dx + dy * dy < bestDist) { bestDist = dx * dx + dy * dy; bestLoc = l }
    }
    if (!bestLoc) break
    ordered.push(bestLoc); unvisited.delete(bestLoc.id); current = bestLoc
  }
  return ordered
}

/** Ray-casting point-in-polygon — points as [lat, lng] */
function pointInPolygon(point: [number, number], polygon: [number, number][]): boolean {
  const [x, y] = point
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j]
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
}

function makePin(
  code: string,
  background: string,
  routeSelected: boolean,
  infoHighlighted: boolean,
  showLabel: boolean,
): L.DivIcon {
  const size = 14
  let border: string; let shadow: string
  if (routeSelected) {
    border = '2px solid #F2F1E6'
    shadow = '0 0 0 4px rgba(183,224,222,0.7)'
  } else if (infoHighlighted) {
    border = '2.5px solid #002745'
    shadow = '0 0 0 3px rgba(0,39,69,0.35)'
  } else {
    border = '1.5px solid rgba(0,39,69,0.3)'
    shadow = '0 1px 3px rgba(0,0,0,0.25)'
  }
  const label = showLabel
    ? `<span style="position:absolute;top:17px;left:50%;transform:translateX(-50%);font-size:11px;font-family:monospace;font-weight:600;white-space:nowrap;color:#002745;background:rgba(242,241,230,0.92);padding:1px 4px;border-radius:3px;pointer-events:none;">${code}</span>`
    : ''
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
  useEffect(() => { setTimeout(() => map.invalidateSize(), 100) }, [map])
  return null
}

function BoundsWatcher({ onChange }: { onChange: (b: L.LatLngBounds) => void }) {
  const map = useMap()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { onChange(map.getBounds()) }, [])
  useMapEvents({
    moveend: () => onChange(map.getBounds()),
    zoomend: () => onChange(map.getBounds()),
  })
  return null
}

function MapCapture({ mapRef }: { mapRef: React.MutableRefObject<L.Map | null> }) {
  const map = useMap()
  useEffect(() => { mapRef.current = map }, [map, mapRef])
  return null
}

/** Freehand polygon draw — active only when `active` is true. Disables map drag during draw. */
function DrawLayer({ active, onComplete }: { active: boolean; onComplete: (pts: [number, number][]) => void }) {
  const map = useMap()
  const drawingRef = useRef(false)
  const pointsRef = useRef<L.LatLng[]>([])
  const rafRef = useRef(0)
  const [polyPts, setPolyPts] = useState<[number, number][]>([])

  useEffect(() => {
    if (!active) {
      drawingRef.current = false
      pointsRef.current = []
      setPolyPts([])
      map.dragging.enable()
    }
  }, [active, map])

  useMapEvents({
    mousedown(e) {
      if (!active) return
      drawingRef.current = true
      pointsRef.current = [e.latlng]
      map.dragging.disable()
    },
    mousemove(e) {
      if (!active || !drawingRef.current) return
      pointsRef.current.push(e.latlng)
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        setPolyPts(pointsRef.current.map((p) => [p.lat, p.lng] as [number, number]))
      })
    },
    mouseup() {
      if (!active || !drawingRef.current) return
      drawingRef.current = false
      map.dragging.enable()
      cancelAnimationFrame(rafRef.current)
      const pts = pointsRef.current.map((p) => [p.lat, p.lng] as [number, number])
      setPolyPts([])
      pointsRef.current = []
      if (pts.length >= 3) onComplete(pts)
    },
  })

  if (polyPts.length < 2) return null
  return <Polygon positions={polyPts} color="#002745" fillColor="#B7E0DE" fillOpacity={0.2} weight={1.5} />
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

  const mapRef = useRef<L.Map | null>(null)
  const listItemRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  // Mode: info (default) | route | draw
  const [mode, setMode] = useState<MapMode>('info')

  // Route data
  const [routes, setRoutes] = useState<LocationRoute[]>([])
  const [loadingRoutes, setLoadingRoutes] = useState(true)

  // Map state
  const [zoom, setZoom] = useState(7)
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null)
  const showLabels = zoom >= 10

  // Info mode
  const [selectedPin, setSelectedPin] = useState<Location | null>(null)

  // Route mode — locations selected for routing
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Draw mode
  const [drawnPolygon, setDrawnPolygon] = useState<[number, number][] | null>(null)

  // Filters
  const [filterRegion, setFilterRegion] = useState('')
  const [filterMarket, setFilterMarket] = useState('')
  const [filterAM, setFilterAM] = useState('')

  // Modals
  const [manualModal, setManualModal] = useState<{ origin: Location; destination: Location; existing: LocationRoute | null } | null>(null)
  const [apiConfirmModal, setApiConfirmModal] = useState<{ pairs: [Location, Location][] } | null>(null)
  const [apiLoading, setApiLoading] = useState(false)

  // Lat/lng editing (shown in info card)
  const [editingLatLng, setEditingLatLng] = useState<string | null>(null)
  const [latInput, setLatInput] = useState('')
  const [lngInput, setLngInput] = useState('')
  const [savingLatLng, setSavingLatLng] = useState(false)

  // Load routes
  useEffect(() => {
    if (!companyId) return
    loadRoutes()
  }, [companyId]) // eslint-disable-line

  async function loadRoutes() {
    setLoadingRoutes(true)
    const sb = supabase as any
    const { data, error } = await sb.schema('core').from('location_routes').select('*').eq('company_id', companyId)
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

  // All markets (for color coding)
  const allMarkets = useMemo(() => {
    const s = new Set(locations.map((l) => locFieldValue(l, 'market')).filter(Boolean))
    return Array.from(s).sort()
  }, [locations])

  // Market → first area manager name (for legend labels)
  const marketToAM = useMemo(() => {
    const m = new Map<string, string>()
    for (const loc of locations) {
      const market = locFieldValue(loc, 'market')
      if (market && !m.has(market)) {
        const am = locFieldValue(loc, 'area_manager')
        if (am) m.set(market, am)
      }
    }
    return m
  }, [locations])

  // Filter helpers
  const regionOptions = useMemo(
    () => Array.from(new Set(locations.map((l) => l.region ?? '').filter(Boolean))).sort(),
    [locations],
  )
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
    [filteredLocations],
  )

  // Locations currently visible in the map viewport
  const visibleLocations = useMemo(() => {
    if (!mapBounds) return mappableLocations
    return mappableLocations.filter((l) =>
      mapBounds.contains([l.latitude as number, l.longitude as number]),
    )
  }, [mappableLocations, mapBounds])

  // Locations inside the drawn polygon
  const polygonLocations = useMemo(() => {
    if (!drawnPolygon || drawnPolygon.length < 3) return []
    return mappableLocations.filter((l) =>
      pointInPolygon([l.latitude as number, l.longitude as number], drawnPolygon),
    )
  }, [mappableLocations, drawnPolygon])

  // Center on first mappable location (computed once)
  const mapCenter = useMemo((): [number, number] => {
    if (mappableLocations.length > 0) {
      return [mappableLocations[0].latitude as number, mappableLocations[0].longitude as number]
    }
    return [39.5, -98.35]
  }, []) // eslint-disable-line

  // Route mode derived state
  const selectedLocations = useMemo(() => {
    const locs = locations.filter((l) => selectedIds.has(l.id))
    return nearestNeighborRoute(locs)
  }, [locations, selectedIds])

  const routeSegments = useMemo(() => {
    const segs: { route: LocationRoute | null; from: Location; to: Location }[] = []
    for (let i = 0; i < selectedLocations.length - 1; i++) {
      const from = selectedLocations[i]; const to = selectedLocations[i + 1]
      segs.push({ route: routeMap.get(routeKey(from.id, to.id)) ?? null, from, to })
    }
    return segs
  }, [selectedLocations, routeMap])

  const routeStats = useMemo(() => {
    let totalMiles = 0; let totalMinutes = 0; let hasAll = true; let hasAny = false
    for (const seg of routeSegments) {
      if (seg.route?.distance_miles != null) { totalMiles += seg.route.distance_miles; hasAny = true } else { hasAll = false }
      if (seg.route?.drive_time_minutes != null) totalMinutes += seg.route.drive_time_minutes
    }
    return { totalMiles: Math.round(totalMiles * 10) / 10, totalMinutes, hasAll, hasAny }
  }, [routeSegments])

  const missingApiPairs = useMemo((): [Location, Location][] => {
    return routeSegments
      .filter((s) => !s.route && s.from.latitude != null && s.to.latitude != null)
      .map((s) => [s.from, s.to])
  }, [routeSegments])

  // ─── Mode switching ────────────────────────────────────────────────────────

  function exitRouteMode() {
    setSelectedIds(new Set())
    setMode('info')
  }

  function startRouteFromPin(loc: Location) {
    setSelectedIds(new Set([loc.id]))
    setSelectedPin(null)
    setMode('route')
  }

  function switchToDraw() {
    setSelectedPin(null)
    setDrawnPolygon(null)
    setMode('draw')
  }

  // Scroll the selected pin's sidebar item into view (bidirectional map ↔ list sync)
  useEffect(() => {
    if (!selectedPin) return
    const el = listItemRefs.current.get(selectedPin.id)
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50)
  }, [selectedPin])

  // ─── Pin / sidebar interactions ────────────────────────────────────────────

  function handlePinClick(loc: Location) {
    if (mode === 'route') {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.has(loc.id) ? next.delete(loc.id) : next.add(loc.id)
        return next
      })
    } else if (mode === 'info') {
      setSelectedPin(loc)
    }
    // draw mode: no pin interaction — freehand draw handles it
  }

  function selectFromSidebar(loc: Location) {
    setSelectedPin(loc)
    if (loc.latitude != null && loc.longitude != null && mapRef.current) {
      const b = mapRef.current.getBounds()
      if (!b.contains([loc.latitude as number, loc.longitude as number])) {
        mapRef.current.panTo([loc.latitude as number, loc.longitude as number])
      }
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next
    })
  }

  // ─── DB writes ─────────────────────────────────────────────────────────────

  async function handleApiConfirm() {
    if (!apiConfirmModal || !companyId) return
    setApiLoading(true)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Not authenticated')
      const pairs = apiConfirmModal.pairs.map(([o, d]) => ({
        origin_id: o.id, destination_id: d.id,
        origin_lat: o.latitude as number, origin_lng: o.longitude as number,
        dest_lat: d.latitude as number, dest_lng: d.longitude as number,
      }))
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/compute-routes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ pairs, company_id: companyId }),
      })
      if (!resp.ok) { const err = await resp.json(); throw new Error(err.error ?? 'API error') }
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
    const sb = supabase as any
    const { error } = await sb.schema('core').from('location_routes').upsert({
      company_id: companyId,
      origin_location_id: manualModal.origin.id,
      destination_location_id: manualModal.destination.id,
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
    const lat = parseFloat(latInput); const lng = parseFloat(lngInput)
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

  // Tile: light = CartoDB Voyager (colorful, readable), dark = CartoDB Dark Matter
  const tileUrl = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
  const tileAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">

      {/* Filter bar */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Region</span>
          <select value={filterRegion} onChange={(e) => { setFilterRegion(e.target.value); setFilterMarket(''); setFilterAM('') }}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none">
            <option value="">All</option>
            {regionOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Market</span>
          <select value={filterMarket} onChange={(e) => { setFilterMarket(e.target.value); setFilterAM('') }}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none">
            <option value="">All</option>
            {marketOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Area Manager</span>
          <select value={filterAM} onChange={(e) => setFilterAM(e.target.value)}
            className="rounded border border-navy/30 bg-cream dark:bg-[#122b40] px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none">
            <option value="">All</option>
            {amOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        {hasFilter && (
          <button onClick={() => { setFilterRegion(''); setFilterMarket(''); setFilterAM('') }}
            className="text-xs font-mono text-inky/60 hover:text-navy underline pb-1">
            Clear
          </button>
        )}
      </div>

      {/* Map + sidebar */}
      <div className="flex gap-4" style={{ height: 1040 }}>

        {/* Map area */}
        <div className={`flex-1 rounded border border-navy/20 overflow-hidden min-w-0 relative${mode === 'draw' && !drawnPolygon ? ' [&_.leaflet-container]:!cursor-crosshair' : ''}`}>
          {/* Draw mode instruction overlay */}
          {mode === 'draw' && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] bg-navy/90 text-cream text-xs font-mono px-3 py-1.5 rounded shadow-lg pointer-events-none select-none">
              {drawnPolygon
                ? `${polygonLocations.length} location${polygonLocations.length !== 1 ? 's' : ''} in selection`
                : 'Click and drag to draw a selection area'}
            </div>
          )}

          {mappableLocations.length === 0 && !loadingRoutes ? (
            <div className="h-full flex items-center justify-center bg-navy/5">
              <p className="text-xs font-mono text-inky/60 text-center max-w-xs">
                No locations have coordinates yet. Click a location in the Info sidebar to add lat/lng.
              </p>
            </div>
          ) : (
            <MapContainer center={mapCenter} zoom={zoom} style={{ height: '100%', width: '100%' }} zoomControl>
              <TileLayer url={tileUrl} attribution={tileAttribution} />
              <ZoomTracker onZoom={setZoom} />
              <MapResizer />
              <BoundsWatcher onChange={setMapBounds} />
              <MapCapture mapRef={mapRef} />

              {/* Draw layer — active only when in draw mode and no completed polygon yet */}
              {mode === 'draw' && (
                <DrawLayer active={!drawnPolygon} onComplete={setDrawnPolygon} />
              )}
              {/* Completed draw polygon overlay */}
              {drawnPolygon && (
                <Polygon positions={drawnPolygon} color="#002745" fillColor="#B7E0DE" fillOpacity={0.15} weight={2} dashArray="5 4" />
              )}

              {/* Location pins */}
              {mappableLocations.map((loc) => {
                const market = locFieldValue(loc, 'market')
                return (
                  <Marker
                    key={loc.id}
                    position={[loc.latitude as number, loc.longitude as number]}
                    icon={makePin(loc.name, getMarketBackground(market, allMarkets), selectedIds.has(loc.id), selectedPin?.id === loc.id, showLabels)}
                    eventHandlers={{ click: () => handlePinClick(loc) }}
                  />
                )
              })}

              {/* Route polylines — only in route mode */}
              {mode === 'route' && routeSegments.map((seg, i) => {
                if (!seg.from.latitude || !seg.to.latitude) return null
                const fromPos: [number, number] = [seg.from.latitude as number, seg.from.longitude as number]
                const toPos: [number, number] = [seg.to.latitude as number, seg.to.longitude as number]
                if (seg.route?.route_geometry) {
                  return <Polyline key={i} positions={decodePolyline(seg.route.route_geometry)} color="#002745" weight={3} opacity={0.8} />
                }
                if (seg.route) {
                  return <Polyline key={i} positions={[fromPos, toPos]} color="#4F7489" weight={2} opacity={0.7} dashArray="6 4" />
                }
                return <Polyline key={i} positions={[fromPos, toPos]} color="#B7E0DE" weight={1.5} opacity={0.5} dashArray="2 6" />
              })}
            </MapContainer>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-72 flex-shrink-0 flex flex-col border border-navy/20 rounded overflow-hidden">

          {/* Mode tabs */}
          <div className="flex border-b border-navy/20 flex-shrink-0">
            {([
              { id: 'info' as MapMode, label: 'Info' },
              { id: 'route' as MapMode, label: 'Route Builder' },
              { id: 'draw' as MapMode, label: 'Draw Area' },
            ]).map(({ id, label }) => (
              <button
                key={id}
                onClick={() => {
                  if (id === 'info') { exitRouteMode(); setDrawnPolygon(null); setMode('info') }
                  else if (id === 'route') { setSelectedPin(null); setMode('route') }
                  else switchToDraw()
                }}
                className={[
                  'flex-1 py-2 text-[10px] font-mono transition-colors border-b-2',
                  mode === id ? 'border-navy text-navy font-bold bg-navy/5' : 'border-transparent text-inky/60 hover:text-navy',
                ].join(' ')}
              >
                {label}
              </button>
            ))}
          </div>

          {/* ── INFO MODE ─────────────────────────────────────────────────── */}
          {mode === 'info' && !selectedPin && (
            <div className="flex-1 flex flex-col min-h-0">
              {/* Visible locations list */}
              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="px-3 py-1.5 border-b border-navy/10 bg-cream dark:bg-[#0e2638] sticky top-0 z-10">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">
                    Visible Locations ({visibleLocations.length})
                  </p>
                </div>
                {visibleLocations.length === 0 ? (
                  <p className="px-3 py-4 text-[11px] font-mono text-inky/40 text-center">
                    Pan or zoom the map to show locations
                  </p>
                ) : (
                  visibleLocations.map((loc) => {
                    const market = locFieldValue(loc, 'market')
                    return (
                      <div
                        key={loc.id}
                        ref={(el) => { if (el) listItemRefs.current.set(loc.id, el); else listItemRefs.current.delete(loc.id) }}
                        onClick={() => selectFromSidebar(loc)}
                        className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-navy/5 transition-colors"
                      >
                        <div
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ background: getMarketBackground(market, allMarkets), border: `1px solid ${getMarketSolidColor(market, allMarkets)}` }}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-mono font-bold text-navy">{loc.name}</span>
                          <span className="text-[10px] font-mono text-inky/60 ml-1.5 truncate">{loc.shop_city}</span>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Market legend — scrollable, pinned to bottom */}
              <div className="flex-shrink-0 border-t border-navy/20 max-h-56 flex flex-col">
                <div className="px-3 py-1.5 border-b border-navy/10 bg-cream dark:bg-[#0e2638] flex-shrink-0">
                  <p className="text-[10px] font-mono text-inky/50 uppercase tracking-wide">Markets</p>
                </div>
                <div className="overflow-y-auto flex-1">
                  {allMarkets.map((m) => {
                    const am = marketToAM.get(m)
                    return (
                      <div key={m} className="flex items-center gap-2 px-3 py-1">
                        <div
                          className="w-3.5 h-3.5 rounded-full flex-shrink-0"
                          style={{ background: getMarketBackground(m, allMarkets), border: `1.5px solid ${getMarketSolidColor(m, allMarkets)}` }}
                        />
                        <span className="text-[10px] font-mono text-navy truncate">
                          {m}{am ? <span className="text-inky/50"> ({am})</span> : null}
                        </span>
                      </div>
                    )
                  })}
                  {/* Route line legend */}
                  <div className="border-t border-navy/10 mt-1 pt-1 pb-1">
                    {[
                      { key: 'api', label: 'API geometry', style: { height: 2, background: '#002745' } as React.CSSProperties },
                      { key: 'manual', label: 'Manual entry', style: { height: 0, borderTop: '2px dashed #4F7489' } as React.CSSProperties },
                      { key: 'nodata', label: 'No data', style: { height: 0, borderTop: '1px dotted #B7E0DE' } as React.CSSProperties },
                    ].map(({ key, label, style }) => (
                      <div key={key} className="flex items-center gap-2 px-3 py-0.5">
                        <div className="w-8 flex-shrink-0" style={style} />
                        <span className="text-[10px] font-mono text-navy">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* INFO MODE — pin selected: location info card */}
          {mode === 'info' && selectedPin && (() => {
            const loc = selectedPin
            const market = locFieldValue(loc, 'market')
            const am = locFieldValue(loc, 'area_manager')
            const director = (loc as any).director ?? locFieldValue(loc, 'director')
            const hasCoords = loc.latitude != null && loc.longitude != null
            const editing = editingLatLng === loc.id
            return (
              <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
                <div className="p-3 flex flex-col gap-3">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-mono font-bold text-navy leading-tight">{loc.name}</p>
                      <p className="text-xs font-body text-inky mt-0.5">{loc.shop_city ?? '—'}</p>
                    </div>
                    <button
                      onClick={() => { setSelectedPin(null); setEditingLatLng(null) }}
                      className="text-inky/30 hover:text-navy text-sm font-mono leading-none mt-1"
                      title="Back to list"
                    >✕</button>
                  </div>

                  {/* Info fields */}
                  <div className="flex flex-col gap-2 border border-navy/10 rounded p-2.5 bg-navy/[0.02]">
                    {([
                      { label: 'Region',       val: loc.region },
                      { label: 'Market',       val: market },
                      { label: 'Area Manager', val: am },
                      { label: 'Director',     val: director },
                    ] as { label: string; val: string | null | undefined }[]).map(({ label, val }) => (
                      <div key={label} className="flex gap-2">
                        <span className="text-[10px] font-mono text-inky/50 uppercase tracking-wide w-[80px] flex-shrink-0 pt-0.5">{label}</span>
                        <span className="text-xs font-mono text-navy">{val || '—'}</span>
                      </div>
                    ))}
                  </div>

                  {/* Market swatch */}
                  {market && (
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ background: getMarketBackground(market, allMarkets), border: `1.5px solid ${getMarketSolidColor(market, allMarkets)}` }}
                      />
                      <span className="text-[10px] font-mono text-inky/60">{market}</span>
                    </div>
                  )}

                  {/* Coordinates editor */}
                  <div className="border-t border-navy/10 pt-2.5">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[10px] font-mono text-inky/50 uppercase tracking-wide">Coordinates</span>
                      {!editing && (
                        <button
                          onClick={() => {
                            setEditingLatLng(loc.id)
                            setLatInput(loc.latitude != null ? String(loc.latitude) : '')
                            setLngInput(loc.longitude != null ? String(loc.longitude) : '')
                          }}
                          className="text-[10px] font-mono text-sky hover:text-navy"
                        >
                          {hasCoords ? '✎ Edit' : '+ Add'}
                        </button>
                      )}
                    </div>
                    {!editing && hasCoords && (
                      <p className="text-[10px] font-mono text-inky/60">{String(loc.latitude)}, {String(loc.longitude)}</p>
                    )}
                    {!editing && !hasCoords && (
                      <p className="text-[10px] font-mono text-[#E67E22]">No coordinates — pin not on map</p>
                    )}
                    {editing && (
                      <div className="flex flex-col gap-1.5 mt-1">
                        <div className="flex gap-1.5">
                          <input value={latInput} onChange={(e) => setLatInput(e.target.value)} placeholder="Latitude"
                            className="flex-1 min-w-0 rounded border border-navy/30 bg-white dark:bg-[#122b40] px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none" />
                          <input value={lngInput} onChange={(e) => setLngInput(e.target.value)} placeholder="Longitude"
                            className="flex-1 min-w-0 rounded border border-navy/30 bg-white dark:bg-[#122b40] px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none" />
                        </div>
                        <div className="flex gap-1.5">
                          <button onClick={() => saveLatLng(loc.id)} disabled={savingLatLng}
                            className="flex-1 py-1 bg-navy text-cream text-[10px] font-mono rounded hover:bg-navy/80 disabled:opacity-50">
                            {savingLatLng ? '…' : 'Save'}
                          </button>
                          <button onClick={() => setEditingLatLng(null)}
                            className="flex-1 py-1 border border-navy/30 text-inky text-[10px] font-mono rounded hover:border-navy/60">
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Start route CTA */}
                  <button
                    onClick={() => startRouteFromPin(loc)}
                    className="w-full py-2 bg-navy text-cream text-xs font-mono rounded hover:bg-navy/80 transition-colors"
                  >
                    Start Route from Here
                  </button>
                </div>
              </div>
            )
          })()}

          {/* ── ROUTE MODE ────────────────────────────────────────────────── */}
          {mode === 'route' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="bg-navy px-3 py-2 flex items-center justify-between flex-shrink-0">
                <p className="text-xs font-heading font-bold text-cream uppercase tracking-wide">
                  {selectedIds.size === 0 ? 'Route Builder' : `Route (${selectedLocations.length} stops)`}
                </p>
                <button onClick={exitRouteMode} className="text-[10px] font-mono text-sky hover:text-cream">← Info</button>
              </div>

              {selectedIds.size === 0 ? (
                <p className="p-3 text-[11px] font-mono text-inky/70 leading-relaxed">
                  Click pins on the map to add stops to your route. You can also go to Info mode, click any location, and use "Start Route from Here".
                </p>
              ) : (
                <div className="flex-1 flex flex-col min-h-0">
                  {routeSegments.length > 0 && (
                    <div className="px-3 py-2 border-b border-navy/10 bg-navy/5 flex-shrink-0">
                      {routeStats.hasAny ? (
                        <div className="flex gap-4 text-xs font-mono text-navy">
                          <span><strong>{routeStats.totalMiles}</strong> mi</span>
                          <span><strong>{Math.floor(routeStats.totalMinutes / 60)}h {routeStats.totalMinutes % 60}m</strong></span>
                          {!routeStats.hasAll && <span className="text-[#E67E22] text-[10px]">partial</span>}
                        </div>
                      ) : (
                        <p className="text-[10px] font-mono text-inky/50">No route data for these segments yet</p>
                      )}
                    </div>
                  )}
                  <div className="flex-1 overflow-y-auto divide-y divide-navy/5">
                    {selectedLocations.map((loc, i) => {
                      const seg = routeSegments[i]
                      return (
                        <div key={loc.id} className="px-3 py-2 hover:bg-navy/5 transition-colors">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex items-start gap-2 min-w-0">
                              <span className="text-[10px] font-mono text-inky/40 w-4 text-right flex-shrink-0 mt-0.5">{i + 1}</span>
                              <div className="min-w-0">
                                <p className="text-xs font-mono font-bold text-navy">{loc.name}</p>
                                <p className="text-[10px] font-mono text-inky/60 truncate">{loc.shop_city}</p>
                                {loc.latitude == null && <p className="text-[10px] font-mono text-[#E67E22]">No coordinates</p>}
                              </div>
                            </div>
                            <button onClick={() => toggleSelect(loc.id)}
                              className="text-[10px] text-inky/30 hover:text-[#C0392B] transition-colors flex-shrink-0 mt-0.5" title="Remove">✕</button>
                          </div>
                          {seg && (
                            <div className="mt-1.5 ml-6 flex items-center gap-2">
                              {seg.route ? (
                                <div className="flex items-center gap-2 text-[10px] font-mono text-inky/60">
                                  {seg.route.distance_miles != null && <span>{seg.route.distance_miles} mi</span>}
                                  {seg.route.drive_time_minutes != null && <span>{seg.route.drive_time_minutes} min</span>}
                                  <span className="text-[9px] px-1 rounded"
                                    style={{ background: seg.route.data_source === 'api' || seg.route.data_source === 'saved_api' ? 'rgba(46,204,113,0.15)' : 'rgba(0,39,69,0.06)' }}>
                                    {seg.route.data_source}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-[10px] font-mono text-inky/40">No data</span>
                              )}
                              <button
                                onClick={() => setManualModal({ origin: seg.from, destination: seg.to, existing: seg.route })}
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
                  {isAdmin && missingApiPairs.length > 0 && (
                    <div className="p-3 border-t border-navy/10 flex-shrink-0">
                      <button
                        onClick={() => setApiConfirmModal({ pairs: missingApiPairs })}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-navy text-cream text-xs font-mono rounded hover:bg-navy/80 transition-colors"
                      >
                        Get {missingApiPairs.length} route{missingApiPairs.length !== 1 ? 's' : ''} via API
                      </button>
                      <p className="text-[9px] font-mono text-inky/40 text-center mt-1">Admin only · Google Routes API · paid</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── DRAW MODE ─────────────────────────────────────────────────── */}
          {mode === 'draw' && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="bg-navy px-3 py-2 flex items-center justify-between flex-shrink-0">
                <p className="text-xs font-heading font-bold text-cream uppercase tracking-wide">
                  {drawnPolygon ? `${polygonLocations.length} Selected` : 'Draw Area'}
                </p>
                {drawnPolygon && (
                  <button onClick={() => setDrawnPolygon(null)} className="text-[10px] font-mono text-sky hover:text-cream">Clear</button>
                )}
              </div>
              {!drawnPolygon ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
                  <p className="text-xs font-mono text-inky/60">Click and drag on the map to draw a selection area</p>
                  <p className="text-[10px] font-mono text-inky/40">All locations inside the drawn area will appear here</p>
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto divide-y divide-navy/5">
                  {polygonLocations.length === 0 ? (
                    <p className="px-3 py-4 text-[11px] font-mono text-inky/40 text-center">No locations in selected area</p>
                  ) : (
                    polygonLocations.map((loc) => {
                      const market = locFieldValue(loc, 'market')
                      const am = locFieldValue(loc, 'area_manager')
                      return (
                        <div key={loc.id}
                          className="px-3 py-2 hover:bg-navy/5 cursor-pointer transition-colors"
                          onClick={() => { setMode('info'); setSelectedPin(loc) }}>
                          <div className="flex items-center gap-2">
                            <div
                              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                              style={{ background: getMarketBackground(market, allMarkets), border: `1px solid ${getMarketSolidColor(market, allMarkets)}` }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-xs font-mono font-bold text-navy">{loc.name}</p>
                              <p className="text-[10px] font-mono text-inky/60 truncate">{loc.shop_city}</p>
                              {(market || am) && (
                                <p className="text-[9px] font-mono text-inky/40 truncate">
                                  {[market, am].filter(Boolean).join(' · ')}
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Unmapped count */}
      {filteredLocations.length > 0 && filteredLocations.length !== mappableLocations.length && (
        <p className="text-[10px] font-mono text-inky/50">
          {filteredLocations.length - mappableLocations.length} location{filteredLocations.length - mappableLocations.length !== 1 ? 's' : ''} hidden from map — no coordinates set.
          Click any location in the Info sidebar to add coordinates.
        </p>
      )}

      {/* Modals */}
      {manualModal && (
        <ManualRouteModal
          origin={manualModal.origin} destination={manualModal.destination} existing={manualModal.existing}
          onSave={handleManualSave} onClose={() => setManualModal(null)}
        />
      )}
      {apiConfirmModal && (
        <ApiConfirmModal
          pairs={apiConfirmModal.pairs} onConfirm={handleApiConfirm}
          onClose={() => setApiConfirmModal(null)} loading={apiLoading}
        />
      )}
    </div>
  )
}
