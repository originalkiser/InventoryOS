// Customer Heatmap — where customers placing orders are physically coming
// from, by zip-code cluster, over a date range. Reads inventory.droptop_orders
// (populated by the droptop-sync-orders Edge Function — see Config -> Data
// Connections' "Droptop — Orders (Customers)" row) joined at sync time
// against inventory.zip_centroids for lat/lng, since Droptop's order/
// customer records carry an address but no coordinates.
//
// Read-only against already-synced data — never calls the Droptop API
// itself (an earlier "Pull This Range" button that did was removed;
// syncing lives solely in Config -> Data Connections now).
//
// Resolution is zip-centroid, not rooftop-exact — a density view of which
// areas customers cluster in, not a pin-per-order map.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, GeoJSON as GeoJSONLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { Maximize2, Minimize2 } from 'lucide-react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDarkMode } from '@/hooks/useDarkMode'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useEarliestOrderDate } from '@/hooks/useEarliestOrderDate'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { getCached, setCached } from '@/lib/idbCache'
import { fetchDateRangeConcurrent } from '@/lib/concurrentDateRangeFetch'
import { fetchByOrderIds } from '@/lib/droptopChildFetch'
import { Button, Card, CardBody, Input, MultiSelectDropdown, Modal, Toggle } from '@/components/ui'
import { getMarketSolidColor } from '@/lib/marketColors'
import { normalizeCityCase, shopNumberCityLabel } from '@/lib/shopLabels'

interface OrderRow {
  id: string
  location_id: string | null
  order_id: string
  first_name: string | null
  last_name: string | null
  city: string | null
  region: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  geocoded_lat: number | null
  geocoded_lng: number | null
  geocode_status: string | null
  final_price: number | null
  order_finalized_at: string | null
  // Set when the order's a fleet/B2B account (see
  // 20260916_droptop_order_expanded_fields) — fleet vehicles are commonly
  // registered somewhere other than where they're actually driven, so they
  // can read as noise on a customer-geography map. Null for an ordinary
  // retail order.
  fleet_company_id: string | null
}
interface PackageRow { order_id: string; name: string | null }
interface ProductRow { order_id: string; product_id: string | null; uom: string | null }
interface ServiceRow { order_id: string; products: { product_id?: string; uom?: string }[] | null }
// Same "oil = QT unit-of-measure" convention DroptopOrdersPage.tsx already
// established (Droptop doesn't populate product_type, so name/category text
// isn't reliable) — kept identical here rather than inferred independently.
const isQuart = (uom: string | null | undefined) => (uom ?? '').trim().toUpperCase() === 'QT'

// Address-level mode uses geocoded_lat/lng when a real Census match
// exists; any order not yet geocoded (or one Census couldn't match) falls
// back to its zip-centroid position rather than disappearing from the
// map — geocoding is opt-in and gradual (Data Connections' "Run
// Geocoding"), so most orders won't have it on day one.
function effectiveCoords(r: OrderRow, mode: 'zip' | 'address'): { lat: number | null; lng: number | null } {
  if (mode === 'address' && r.geocode_status === 'matched' && r.geocoded_lat != null && r.geocoded_lng != null) {
    return { lat: r.geocoded_lat, lng: r.geocoded_lng }
  }
  return { lat: r.lat, lng: r.lng }
}

interface ZipCluster {
  zip: string
  city: string
  region: string
  lat: number
  lng: number
  count: number
  locationIds: Set<string>
}

// Radius/color scale. Real customer geography is heavily skewed (a shop's
// own zip and its neighbors dominate, then a long tail of 1-2-order zips):
//   1. Radius scales by sqrt(count/max), not linearly — circle AREA should
//      be proportional to the value for a graduated-symbol map to read
//      correctly at a glance.
//   2. Color is a continuous gradient positioned by each zip's PERCENTILE
//      RANK among the currently-loaded zips, not raw count/max — a linear
//      count/max gradient on this skewed a distribution would leave
//      almost everything at the blue end with only a couple of extreme
//      reds. Percentile rank spreads the same data evenly across the full
//      gradient (same "robust to skew" reasoning the old median/80th-
//      percentile 3-bucket scheme used, just continuous instead of 3
//      discrete steps).
interface DensityBreakpoints { sorted: number[]; max: number }

function densityBreakpoints(counts: number[]): DensityBreakpoints {
  const sorted = [...counts].sort((a, b) => a - b)
  return { sorted, max: sorted.length ? sorted[sorted.length - 1] : 0 }
}

// Blue -> green -> yellow -> orange -> red. Four of these five stops are
// already-approved brand tokens (sky/sb-green/sb-orange/sb-red); #F1C40F
// (a warm yellow) was added specifically for this gradient — the one stop
// the existing palette had no equivalent for — per explicit design
// decision rather than an ad hoc addition.
const GRADIENT_STOPS: [number, string][] = [
  [0, '#B7E0DE'], [0.25, '#2ECC71'], [0.5, '#F1C40F'], [0.75, '#E67E22'], [1, '#C0392B'],
]
function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
// Exported (via module scope) so the legend can render the exact same
// gradient as a CSS background instead of a hand-tuned approximation.
function gradientColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i++) {
    const [t0, c0] = GRADIENT_STOPS[i]
    const [t1, c1] = GRADIENT_STOPS[i + 1]
    if (clamped <= t1) {
      const localT = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0)
      const [r0, g0, b0] = hexToRgb(c0)
      const [r1, g1, b1] = hexToRgb(c1)
      return rgbToHex(r0 + (r1 - r0) * localT, g0 + (g1 - g0) * localT, b0 + (b1 - b0) * localT)
    }
  }
  return GRADIENT_STOPS[GRADIENT_STOPS.length - 1][1]
}

// Percentile rank of `count` within `sorted` (ascending), as a 0-1
// fraction — the midpoint of its run of equal values, so a tie among many
// zips sharing one count doesn't all round toward the same edge.
function percentileRank(count: number, sorted: number[]): number {
  if (sorted.length <= 1) return sorted.length === 1 ? 1 : 0
  let lo = 0, hi = sorted.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] < count) lo = mid + 1; else hi = mid }
  let hi2 = lo
  while (hi2 < sorted.length && sorted[hi2] === count) hi2++
  return ((lo + hi2 - 1) / 2) / (sorted.length - 1)
}

// `zoom` grows the base radius the further in the viewer zooms — the pixel
// radius itself was always zoom-independent (CircleMarker, not Circle), but
// a fixed handful of pixels reads as "too small to be valuable" once zoomed
// in far enough to see individual streets, since everything else on the map
// is now much larger. Capped so it doesn't balloon at max zoom.
function styleFor(count: number, bp: DensityBreakpoints, zoom: number): { radius: number; color: string; fill: string } {
  const t = bp.max > 0 ? count / bp.max : 0
  const zoomBoost = Math.min(30, Math.max(0, zoom - 5) * 2.5)
  const radius = 4 + Math.sqrt(t) * 22 + zoomBoost
  const color = gradientColor(percentileRank(count, bp.sorted))
  return { radius, color, fill: color }
}

// Store-location pin — visually distinct (teardrop, not a circle, per
// explicit request — Map & Routes' own round pins stay there) from the
// customer-density CircleMarkers so a shop's own marker doesn't get lost
// among or mistaken for a zip cluster right on top of it. Color is by
// market (getMarketSolidColor, shared with Map & Routes so a market's
// color matches across both pages); an optional label shows the shop
// number above the pin, matching Map & Routes' own "Labels" toggle.
function makeShopPinIcon(color: string, label: string | null): L.DivIcon {
  const labelHtml = label
    ? `<span style="position:absolute;top:-3px;left:50%;transform:translateX(-50%);font-size:10px;font-family:monospace;font-weight:700;color:#002745;background:rgba(242,241,230,0.92);padding:0 3px;border-radius:3px;white-space:nowrap;pointer-events:none;">${label}</span>`
    : ''
  return L.divIcon({
    className: 'shop-pin-marker',
    html: `<div style="position:relative;width:22px;height:30px;">`
      + `<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">`
      + `<path d="M11 0C4.9 0 0 4.9 0 11c0 8.25 11 19 11 19s11-10.75 11-19C22 4.9 17.1 0 11 0z" fill="${color}" stroke="#F2F1E6" stroke-width="1.5"/>`
      + `<circle cx="11" cy="11" r="4.5" fill="#B7E0DE"/>`
      + `</svg>${labelHtml}</div>`,
    iconSize: [22, 30],
    iconAnchor: [11, 30], // tip points at the actual coordinate
    tooltipAnchor: [0, -26],
  })
}

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const dateShort = (v: string | null) => v ? new Date(v).toLocaleDateString() : '—'

// Simplified Owner classification for the filter dropdown — every real
// `owner` value that isn't literally "Corporate" (individual franchisee
// names, holding companies, etc.) buckets as "Franchise". Matches
// DEFAULT_OWNER_RULE's own Corporate-vs-everyone-else distinction
// (useLocationExclusions.ts) rather than introducing a third classification
// scheme. `owner` may live on the base column or (pre-promotion) metadata —
// checked the same order fieldValue() falls back through.
function ownerClassOf(l: { owner?: string | null; metadata?: unknown }): 'Corporate' | 'Franchise' {
  const raw = l.owner ?? (l.metadata as any)?.owner ?? ''
  return String(raw).trim() === 'Corporate' ? 'Corporate' : 'Franchise'
}

// normalizeCityCase/shopNumberCityLabel moved to src/lib/shopLabels.ts so
// useLocations.ts (labelOf/options/includedOptions) can share the same fix
// instead of carrying its own separate, and until 2026-09-02, un-fixed copy.

// Imperatively pans/zooms the map when the selected zip changes — a plain
// state change on <MapContainer center> only sets the *initial* view, not
// a live one, so this needs react-leaflet's useMap() the same way
// MapRoutesTab.tsx already does for its own pan/fit calls.
function FocusZip({ target }: { target: ZipCluster | null }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 9), { duration: 0.6 })
    // When already zoomed to 9+, Math.max above keeps the destination zoom
    // equal to the current one — a pan-only fly. Leaflet's Canvas renderer
    // (preferCanvas, used for both circles and choropleth below) only does
    // its full internal redraw on a genuine zoom-level change; a pan-only
    // animated flyTo leaves per-feature setStyle() colors stale until
    // something forces a real _resetView() — which is exactly what a manual
    // zoom in/out does today (a known Leaflet Canvas limitation, see
    // Leaflet/Leaflet#5170, #6050, #8164). Nudge the map with a silent,
    // non-animated setView to its own current center/zoom once the fly
    // finishes — forces that same internal reset without moving anything.
    // .once avoids the nudge's own moveend re-triggering this.
    map.once('moveend', () => { map.setView(map.getCenter(), map.getZoom(), { animate: false }) })
  }, [target, map])
  return null
}

// Reports the live zoom level up to the parent (via useState setter) so
// circle radii can grow with it — same useMap()-in-a-child pattern as
// FocusZip, since useMap() only works inside MapContainer's own subtree.
function ZoomTracker({ onZoom }: { onZoom: (z: number) => void }) {
  const map = useMap()
  useEffect(() => {
    onZoom(map.getZoom())
    const handler = () => onZoom(map.getZoom())
    map.on('zoomend', handler)
    return () => { map.off('zoomend', handler) }
  }, [map, onZoom])
  return null
}

// Clicking empty map background deselects the current zip — each zip
// CircleMarker stops its own click from bubbling here (L.DomEvent.
// stopPropagation), so this only fires for a genuine "click out".
function DeselectOnMapClick({ onDeselect }: { onDeselect: () => void }) {
  useMapEvents({ click: onDeselect })
  return null
}

// Leaflet sizes its container once at mount and never re-measures it on its
// own — a later CSS-driven resize (entering/leaving fullscreen, switching
// height mode) leaves the map thinking it's still its original size until
// something calls invalidateSize(). `resizeKey` is any value that changes
// exactly when the wrapper's actual size changes; the small delay lets the
// CSS transition/layout settle first so invalidateSize() measures the real
// final size rather than a mid-transition one.
function MapResizeHandler({ resizeKey }: { resizeKey: string }) {
  const map = useMap()
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 150)
    return () => clearTimeout(t)
  }, [resizeKey, map])
  return null
}

export function CustomerHeatmapPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  // 'other' surface — franchise shops included by default here (unlike
  // Inventory-side pages), per explicit product decision 2026-09-01.
  const loc = useLocations('other')
  const { dark } = useDarkMode()
  const earliestDate = useEarliestOrderDate(companyId)
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod('heatmap:period', 'last_week')

  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [matchMode, setMatchMode] = useState<'all' | 'shared'>('all')
  const [rows, setRows] = useState<OrderRow[]>([])
  // Package/product/oil detail — only ever populated on the full-detail
  // path (see loadChildren below); the nightly rollup has no such linkage,
  // which is exactly why using one of these filters forces full detail
  // (isRollupEligible, below).
  const [packages, setPackages] = useState<PackageRow[]>([])
  const [products, setProducts] = useState<ProductRow[]>([])
  const [services, setServices] = useState<ServiceRow[]>([])
  const [packageFilters, setPackageFilters] = useState<string[]>([])
  const [productIdFilters, setProductIdFilters] = useState<string[]>([])
  const [oilOnly, setOilOnly] = useState(false)
  const [loading, setLoading] = useState(true)
  // Real progress instead of a bare spinner — `total` comes from a cheap
  // COUNT-only request up front, `loaded` ticks up per page. Reverted from
  // an earlier progressive-render attempt (map/table updating as pages
  // arrived): that made the page usable sooner but the browser stayed
  // janky for the whole load (re-clustering/re-rendering thousands of zips
  // repeatedly), which was worse overall than a longer blocking load with
  // an accurate progress bar. `rows`/the map only update ONCE, when the
  // full load finishes — this state exists purely to drive the bar.
  const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null })
  // Rollup fast-path — inventory.heatmap_zip_rollups is a nightly-refreshed
  // pre-aggregation, so a range entirely in the past can skip the full
  // raw-order scan/pagination above almost entirely: one small RPC call
  // instead of 100+ paginated pages. Not used for a range touching today
  // (the rollup can be up to ~24h stale) or Address-Level mode (the rollup
  // has no geocoded coordinates, only zip centroids). `fullDetailRequested`
  // is the escape hatch — order-level actions (a zip's actual orders,
  // exports, the true "Not On Map" drill-down) all need real rows, so
  // those trigger the exact same full fetch this page always used to run
  // unconditionally, just deferred until actually asked for.
  const [rollupClusters, setRollupClusters] = useState<ZipCluster[] | null>(null)
  const [rollupLoading, setRollupLoading] = useState(false)
  const [rollupTotals, setRollupTotals] = useState<{ mapped: number; unmapped: number | null } | null>(null)
  const [fullDetailRequested, setFullDetailRequested] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedZip, setSelectedZip] = useState<string | null>(null)
  const [orderModal, setOrderModal] = useState<{ title: string; rows: OrderRow[] } | null>(null)
  const [zoom, setZoom] = useState(5)
  const [zipExportMode, setZipExportMode] = useState<'total' | 'by-shop'>('total')
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)

  // Skip the map entirely — the stats cards and Visits-by-Zip table below
  // are what most "just tell me the numbers" checks actually need, and the
  // map (thousands of DOM/Leaflet elements, plus a real network fetch for
  // choropleth boundaries) is the most expensive thing on this page to
  // render. Persisted like the other view toggles.
  const [hideMap, setHideMap] = useState<boolean>(() => {
    try { return localStorage.getItem('heatmap:hide-map') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:hide-map', hideMap ? '1' : '0') } catch { /* ignore */ }
  }, [hideMap])

  // Choropleth (actual zip outlines) as a toggleable alternative to the
  // circle view, not a replacement — persisted like the other view toggles.
  const [mapViewMode, setMapViewMode] = useState<'circles' | 'choropleth'>(() => {
    try { return localStorage.getItem('heatmap:view-mode') === 'choropleth' ? 'choropleth' : 'circles' } catch { return 'circles' }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:view-mode', mapViewMode) } catch { /* ignore */ }
  }, [mapViewMode])
  // zip -> raw GeoJSON geometry (Polygon/MultiPolygon), fetched only in
  // choropleth mode. A zip missing here (a small fraction of ZCTAs — water/
  // unpopulated areas have no boundary in the source data) falls back to
  // its normal circle rather than silently vanishing from the map.
  const [zipGeometries, setZipGeometries] = useState<Map<string, GeoJSON.Geometry>>(new Map())
  // Optional: drop the fallback-circle zips from choropleth mode entirely
  // instead of showing them as dots — purely visual preference, persisted
  // like the other view toggles. Off by default (no data silently hidden
  // unless asked for).
  const [hideNoBoundaryZips, setHideNoBoundaryZips] = useState<boolean>(() => {
    try { return localStorage.getItem('heatmap:hide-no-boundary') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:hide-no-boundary', hideNoBoundaryZips ? '1' : '0') } catch { /* ignore */ }
  }, [hideNoBoundaryZips])

  // Map size controls — "Tall" grows the map card in place (filters/stats
  // above stay visible); Fullscreen overlays it across the whole viewport.
  // Height mode persists like the other view toggles; fullscreen always
  // starts closed (not something you'd want to reopen into on a fresh load).
  const [mapHeightMode, setMapHeightMode] = useState<'normal' | 'tall'>(() => {
    try { return localStorage.getItem('heatmap:height-mode') === 'tall' ? 'tall' : 'normal' } catch { return 'normal' }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:height-mode', mapHeightMode) } catch { /* ignore */ }
  }, [mapHeightMode])
  const [isMapFullscreen, setIsMapFullscreen] = useState(false)
  // Esc closes fullscreen, matching the platform convention for any
  // full-viewport overlay.
  useEffect(() => {
    if (!isMapFullscreen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsMapFullscreen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMapFullscreen])

  // Fleet/B2B orders often read as geographic noise — the vehicle's
  // registered address is frequently nowhere near where it's actually
  // driven day to day. Off by default (nothing hidden unless asked for),
  // persisted like the other view toggles. Forces full detail (see
  // isRollupEligible below) since the nightly rollup table has no fleet
  // awareness to filter by.
  // Defaults to HIDDEN (2026-09-03 product decision) — fleet orders read as
  // geographic noise more often than not, so an unset/missing key means
  // hidden; only an explicit '0' (user turned the toggle off) shows them.
  const [hideFleetOrders, setHideFleetOrders] = useState<boolean>(() => {
    try { return localStorage.getItem('heatmap:hide-fleet') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:hide-fleet', hideFleetOrders ? '1' : '0') } catch { /* ignore */ }
  }, [hideFleetOrders])

  // Address-level plotting (real geocoded lat/lng per order) vs the
  // default zip-centroid — an optional, more precise alternative, not a
  // replacement (see effectiveCoords()). Geocoding itself runs from Data
  // Connections' "Run Geocoding" — this toggle just changes which
  // coordinates already-geocoded orders plot at.
  const [coordinateMode, setCoordinateMode] = useState<'zip' | 'address'>(() => {
    try { return localStorage.getItem('heatmap:coordinate-mode') === 'address' ? 'address' : 'zip' } catch { return 'zip' }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:coordinate-mode', coordinateMode) } catch { /* ignore */ }
  }, [coordinateMode])

  // Pin filters (Market/Region/AM) + Labels toggle — same controls as Map &
  // Routes, brought over to narrow/label the store pins specifically. These
  // are separate from the Shop(s) picker above, which scopes the actual
  // order data query; these only filter which of the resulting pins show.
  const [showPinLabels, setShowPinLabels] = useState<boolean>(() => {
    try { return localStorage.getItem('heatmap:pin-labels') === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:pin-labels', showPinLabels ? '1' : '0') } catch { /* ignore */ }
  }, [showPinLabels])
  const [showPins, setShowPins] = useState<boolean>(() => {
    try { return localStorage.getItem('heatmap:show-pins') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('heatmap:show-pins', showPins ? '1' : '0') } catch { /* ignore */ }
  }, [showPins])
  // Simplified to a hard Corporate/Franchise binary rather than every real
  // `owner` value (individual franchisee names, etc.) — a location whose
  // owner isn't literally "Corporate" is "Franchise" for filtering
  // purposes, matching DEFAULT_OWNER_RULE's own Corporate-vs-everyone-else
  // distinction elsewhere in this app.
  const [filterOwners, setFilterOwners] = useState<string[]>([])
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [zipSearch, setZipSearch] = useState('')
  const [orderModalPackages, setOrderModalPackages] = useState<Map<string, string[]> | null>(null)
  const [orderModalExporting, setOrderModalExporting] = useState<'csv' | 'xlsx' | null>(null)
  const zipRowRefs = useRef(new Map<string, HTMLTableRowElement>())
  // The actual Leaflet map container — captured by html2canvas for the
  // Copy button's real screenshot (see copyHeatmap below). null whenever
  // hideMap is on, since nothing's rendered to capture then.
  const mapWrapperRef = useRef<HTMLDivElement | null>(null)

  // Dynamic based on Region/Market/AM — narrows which shops even show up
  // as pickable once one of those is set, rather than a full always-the-
  // same list. Doesn't prune an already-selected shop that a later filter
  // change makes invalid (it stays effectively selected, just hidden from
  // the visible checklist) — matches this page's existing "good enough,
  // not full cascade-pruning" precedent for the Region/Market/AM filters.
  const shopOptions = useMemo(() => {
    if (!filterOwners.length && !filterRegions.length && !filterMarkets.length && !filterAMs.length) {
      return loc.includedOptions.map((o) => ({ value: o.label }))
    }
    return loc.includedOptions.filter((o) => {
      const l = loc.byId(o.value)
      if (!l) return false
      if (filterOwners.length && !filterOwners.includes(ownerClassOf(l))) return false
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) return false
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) return false
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) return false
      return true
    }).map((o) => ({ value: o.label }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.includedOptions, filterOwners, filterRegions, filterMarkets, filterAMs])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

  // Region/Market/AM pin filters now also scope the heatmap itself (zip
  // clusters, stats cards, Visits by Zip), not just which pins draw — an
  // order counts toward the heatmap only if its shop matches the active
  // filters. null = no restriction (every loaded order counts), matching
  // how shopPins itself used to filter before this was unified. Moved
  // above the fetch effect (was declared after it) so the fetch itself can
  // scope its SERVER query by this too, not just client-side post-filter
  // whatever a full unscoped pull already returned.
  const allowedLocationIds = useMemo(() => {
    if (!filterOwners.length && !filterRegions.length && !filterMarkets.length && !filterAMs.length) return null
    const ids = new Set<string>()
    for (const l of loc.locations) {
      if (filterOwners.length && !filterOwners.includes(ownerClassOf(l))) continue
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) continue
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) continue
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) continue
      ids.add(l.id)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterOwners, filterRegions, filterMarkets, filterAMs])

  // What to actually send the server: the explicit Shop(s) picker narrows
  // to exactly those shops (intersected with Region/Market/AM if both are
  // set at once); otherwise Region/Market/AM alone narrows; otherwise no
  // restriction. A stable, sorted, joined string (not the array/Set
  // itself) so effects can depend on its VALUE without re-firing on every
  // render just because a new array/Set object was allocated.
  const effectiveLocationIds = useMemo(() => {
    if (shopIds.length) return allowedLocationIds === null ? shopIds : shopIds.filter((id) => allowedLocationIds.has(id))
    return allowedLocationIds === null ? null : [...allowedLocationIds]
  }, [shopIds, allowedLocationIds])
  const effectiveLocationKey = effectiveLocationIds === null ? '' : [...effectiveLocationIds].sort().join(',')

  // Eligible for the rollup fast-path: entirely in the past (the rollup can
  // be up to ~24h stale, so a range touching today falls back to the exact
  // full-fetch behavior this page always used) and zip-centroid mode (the
  // rollup has no geocoded per-order coordinates for Address-Level mode).
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), [])
  // Package/Product ID/Oil filters need the package/product child-table
  // join (loadChildren below), which the nightly rollup doesn't carry —
  // same precedent as hideFleetOrders forcing full detail.
  const isRollupEligible = coordinateMode === 'zip' && range.end < todayStr && !hideFleetOrders
    && !packageFilters.length && !productIdFilters.length && !oilOnly
  const showRollupPreview = isRollupEligible && !fullDetailRequested
  // Resets back to "try the rollup first" whenever the range/shop/filter
  // selection actually changes — a fresh selection deserves a fresh chance
  // at the fast path, not to inherit "give me full detail" from whatever
  // was previously selected.
  useEffect(() => { setFullDetailRequested(false) }, [range.start, range.end, effectiveLocationKey, coordinateMode])

  // Company-wide market list (not just the currently-visible shops) so a
  // market's color-by-index stays the same regardless of what's filtered —
  // matching Map & Routes' own allMarkets, which is what makes the colors
  // consistent between the two pages.
  const allMarkets = useMemo(() => {
    const s = new Set(loc.locations.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))
    return [...s].sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations])

  // Fixed two-value list — see ownerClassOf's own comment for why this
  // isn't derived from every distinct raw `owner` value.
  const ownerOptions = useMemo(() => [{ value: 'Corporate' }, { value: 'Franchise' }], [])
  const regionOptions = useMemo(() => {
    let r = loc.locations
    if (filterOwners.length) r = r.filter((l) => filterOwners.includes(ownerClassOf(l)))
    return [...new Set(r.map((l) => l.region ?? '').filter(Boolean))].sort().map((v) => ({ value: v }))
  }, [loc.locations, filterOwners])
  const marketOptions = useMemo(() => {
    let r = loc.locations
    if (filterOwners.length) r = r.filter((l) => filterOwners.includes(ownerClassOf(l)))
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterOwners, filterRegions])
  const amOptions = useMemo(() => {
    let r = loc.locations
    if (filterOwners.length) r = r.filter((l) => filterOwners.includes(ownerClassOf(l)))
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    if (filterMarkets.length) r = r.filter((l) => filterMarkets.includes(loc.fieldValue(l.id, 'market')))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'area_manager')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterOwners, filterRegions, filterMarkets])

  useEffect(() => {
    if (!companyId) return
    // Rollup preview mode skips this fetch entirely — no reason to pull
    // every raw order just to throw most of the work away when a small
    // pre-aggregated table already has the answer for this range. `rows`
    // stays empty (order-level features naturally read as "not loaded
    // yet" until Load Full Detail is used) and the ordinary blocking
    // spinner/progress-bar UI doesn't show either.
    if (showRollupPreview) { setRows([]); setPackages([]); setProducts([]); setServices([]); setLoading(false); setError(null); return }
    let cancelled = false
    setLoading(true)
    setLoadProgress({ loaded: 0, total: null })
    setError(null)
    setSelectedZip(null)
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`

    function applyFilters(q: any) {
      q = q.eq('company_id', companyId).gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
      if (effectiveLocationIds) q = q.in('location_id', effectiveLocationIds)
      if (hideFleetOrders) q = q.is('fleet_company_id', null)
      return q
    }

    // Per-browser cache so leaving this page and coming back doesn't have
    // to re-run the same 100+-page fetch — see idbCache.ts. Bumped from an
    // initial 15 minutes (too short — a real ~20-minute step-away still
    // missed it) to an hour, matching the rollup table's own ~24h
    // staleness tolerance loosely but erring shorter since this covers
    // live (not nightly-refreshed) data; refreshing the page still forces
    // a real reload if a full hour has actually passed.
    const CACHE_TTL_MS = 60 * 60 * 1000
    const cacheKey = `heatmap-orders:${companyId}:${effectiveLocationKey}:${range.start}:${range.end}:${coordinateMode}:${hideFleetOrders ? 'nofleet' : 'all'}`

    // Package/product/service child rows for a set of already-loaded order
    // ids — same tables/shape DroptopOrdersPage.tsx joins, via the shared
    // fetchByOrderIds. Best-effort: a failure here shouldn't blow up a page
    // that already has its order rows loaded and can render the map fine
    // without package/product filtering.
    async function loadChildren(orderIds: string[]) {
      if (!orderIds.length) { if (!cancelled) { setPackages([]); setProducts([]); setServices([]) }; return }
      try {
        const [pkgRows, prodRows, svcRows] = await Promise.all([
          fetchByOrderIds<PackageRow>('droptop_order_packages', orderIds, 'order_id, name'),
          fetchByOrderIds<ProductRow>('droptop_order_products', orderIds, 'order_id, product_id, uom'),
          fetchByOrderIds<ServiceRow>('droptop_order_services', orderIds, 'order_id, products'),
        ])
        if (cancelled) return
        setPackages(pkgRows); setProducts(prodRows); setServices(svcRows)
      } catch {
        // Package/Product ID/Oil filters just won't have real options to
        // pick from until this succeeds again on a later load — the map
        // itself is unaffected.
        if (!cancelled) { setPackages([]); setProducts([]); setServices([]) }
      }
    }

    async function run() {
      const cached = await getCached<OrderRow[]>(cacheKey, CACHE_TTL_MS)
      if (cached && !cancelled) {
        setRows(cached)
        setLoading(false)
        void loadChildren(cached.map((r) => r.id))
        return
      }

      // Real progress instead of an indeterminate spinner: a cheap
      // COUNT-only request (head:true — no rows returned, the count is
      // computed server-side) using the exact same filters as the real
      // fetch below. Best-effort — if it fails for any reason the load
      // still proceeds, just without a percentage (the bar falls back to
      // "N loaded so far" with no denominator).
      const { count } = await applyFilters(sb.schema('inventory').from('droptop_orders').select('id', { count: 'exact', head: true }))
      if (!cancelled) setLoadProgress({ loaded: 0, total: count ?? null })

      // Keyset pagination by (order_finalized_at, id), not plain id — a
      // cursor ordered by id while filtering on order_finalized_at can't use
      // an index to seek to the matching date range (see
      // 20260907_droptop_orders_date_index.sql), which is what made a narrow
      // custom range time out even though a wide one loaded fine. Loads
      // every order in range/shop scope, mapped or not — the "Not On Map"
      // card/modal needs the unmapped ones too.
      //
      // PAGE was briefly raised to 3000 to cut round trips, but this
      // Supabase project's API "Max Rows" setting silently caps EVERY
      // response at 1000 regardless of what .limit() requests — that's a
      // project-level API setting, not a Postgres GUC, so it didn't show up
      // in the pg_settings check that (wrongly) cleared raising it. The
      // real bug this caused wasn't the cap itself, it was the loop's exit
      // condition (`batch.length < PAGE`) reading "server gave me fewer
      // than I asked for" as "that's the last page" — with PAGE=3000 and
      // every response silently capped at 1000, EVERY page looked short,
      // so the loop stopped after page one. Fixed the exit condition to
      // only stop on a genuinely EMPTY page (batch.length === 0), which is
      // correct regardless of whatever the real cap is now or later, and
      // reverted PAGE to 1000 to match the actual ceiling instead of
      // requesting more than will ever be honored.
      const PAGE = 1000
      // A full company-wide month used to be 100+ SEQUENTIAL page requests
      // — correct, but every page waited on the previous one's round trip
      // even though the table can easily serve several requests in
      // parallel. fetchDateRangeConcurrent (src/lib) keeps this exact
      // keyset-pagination shape (still index-friendly on the date range,
      // still safe to retry a single page) but runs it across several
      // non-overlapping day-range slices at once instead of one loop
      // covering the whole range — see that file for why slicing by date
      // rather than plain OFFSET paging.
      const MAX_PAGE_RETRIES = 2
      let all: OrderRow[]
      try {
        all = await fetchDateRangeConcurrent<OrderRow>({
          rangeStart: range.start,
          rangeEnd: range.end,
          totalCount: count ?? null,
          cursorOf: (row) => ({ date: row.order_finalized_at ?? startIso, id: row.id }),
          isCancelled: () => cancelled,
          onProgress: (loadedSoFar) => { if (!cancelled) setLoadProgress((p) => ({ ...p, loaded: loadedSoFar })) },
          fetchPage: async (subStart, subEnd, cursor) => {
            const subStartIso = `${subStart}T00:00:00.000Z`
            const subEndIso = `${subEnd}T23:59:59.999Z`
            let lastErr: string | null = null
            for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
              if (cancelled) return []
              let q = applyFilters(sb.schema('inventory').from('droptop_orders')
                .select('id, location_id, order_id, first_name, last_name, city, region, zip, lat, lng, geocoded_lat, geocoded_lng, geocode_status, final_price, order_finalized_at, fleet_company_id'))
                .gte('order_finalized_at', subStartIso).lte('order_finalized_at', subEndIso)
                .order('order_finalized_at', { ascending: true })
                .order('id', { ascending: true }).limit(PAGE)
              if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
              const { data: pageData, error: err } = await q
              if (!err) return (pageData ?? []) as OrderRow[]
              lastErr = err.message
              if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
            }
            throw new Error(lastErr ?? 'Failed to load orders')
          },
        })
      } catch (e) {
        if (!cancelled) {
          setError(`${e instanceof Error ? e.message : 'Failed to load orders'} — some pages may not have loaded`)
          setLoading(false)
        }
        return
      }
      if (cancelled) return
      setRows(all)
      setLoading(false)
      void setCached(cacheKey, all)
      void loadChildren(all.map((r) => r.id))
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true }
    // Restarts cleanly on ANY of these — including a Region/Market/AM/Shop
    // change while a previous pull is still in flight, per explicit
    // request: the cleanup above sets `cancelled`, so an in-progress fetch
    // for the OLD selection stops writing to state as soon as this effect
    // re-runs for the new one, instead of finishing (or continuing to
    // burn through pages) before the new selection's own fetch can start.
    // hideFleetOrders/coordinateMode are read inside (applyFilters/cache
    // key) but wouldn't always change showRollupPreview's own value (e.g.
    // toggling fleet while already in full-detail mode for an unrelated
    // reason) — listed explicitly so a toggle always refetches instead of
    // silently reusing the previous fetch's filter.
  }, [companyId, effectiveLocationKey, range.start, range.end, showRollupPreview, hideFleetOrders, coordinateMode]) // eslint-disable-line react-hooks/exhaustive-deps

  // Rollup fast path — one RPC call against the pre-aggregated table
  // instead of the 100+-page raw fetch above. `location_ids` per zip
  // (returned by the RPC) doubles as what "Shared Only" matching needs
  // downstream (see the `clusters` useMemo), so this drops straight into
  // the exact same ZipCluster pipeline the raw path already feeds.
  useEffect(() => {
    if (!companyId || !showRollupPreview) { setRollupClusters(null); setRollupTotals(null); return }
    let cancelled = false
    setRollupLoading(true)
    setError(null)
    setSelectedZip(null)
    const sb = supabase as any
    const locIds = effectiveLocationIds

    async function run() {
      const startIso = `${range.start}T00:00:00.000Z`
      const endIso = `${range.end}T23:59:59.999Z`
      let unmappedQ = sb.schema('inventory').from('droptop_orders')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
        .or('zip.is.null,zip.eq.')
      if (locIds) unmappedQ = unmappedQ.in('location_id', locIds)

      // RPC calls go through PostgREST exactly like a plain .from() query —
      // the SAME project "Max Rows" cap that once silently truncated the
      // raw orders fetch at 1,000 rows applies here too, and this call
      // wasn't paginated at all when first shipped. A real company-wide
      // month has 7,000-12,000+ zip rows, so it was silently cut off at
      // 1,000. Paginated the identical way as every other fetch in this
      // file: keep requesting pages until a genuinely empty one comes
      // back, never assume a single call returns everything. The RPC's own
      // ORDER BY zip (added alongside this fix) makes page boundaries
      // stable.
      const PAGE = 1000
      const all: any[] = []
      let unmappedResult: { count: number | null; error: unknown } | null = null
      for (let from = 0; ; from += PAGE) {
        const [pageRes, unmappedRes] = await Promise.all([
          sb.rpc('get_heatmap_zip_rollup_clusters', { p_start: range.start, p_end: range.end, p_location_ids: locIds }).range(from, from + PAGE - 1),
          from === 0 ? unmappedQ : Promise.resolve(unmappedResult),
        ])
        if (from === 0) unmappedResult = unmappedRes as any
        if (cancelled) return
        if (pageRes.error) {
          // Fast path failed (migration not applied yet, a transient
          // error, whatever) — fall back to full detail automatically
          // instead of a dead end. The raw-fetch effect above picks this
          // up the moment fullDetailRequested flips.
          setError(`Fast preview unavailable (${pageRes.error.message}) — loading full detail instead`)
          setFullDetailRequested(true)
          setRollupLoading(false)
          return
        }
        const batch = (pageRes.data ?? []) as any[]
        all.push(...batch)
        if (batch.length === 0) break
      }
      const built: ZipCluster[] = all.map((r) => ({
        zip: r.zip,
        city: normalizeCityCase(r.city ?? ''),
        region: r.region ?? '',
        lat: Number(r.lat),
        lng: Number(r.lng),
        count: Number(r.order_count),
        locationIds: new Set((r.location_ids ?? []) as string[]),
      }))
      setRollupClusters(built)
      setRollupTotals({
        mapped: built.reduce((sum, c) => sum + c.count, 0),
        unmapped: unmappedResult?.error ? null : (unmappedResult?.count ?? null),
      })
      setRollupLoading(false)
    }
    run().catch((e) => {
      if (cancelled) return
      setError(e instanceof Error ? e.message : 'Fast preview failed — loading full detail instead')
      setFullDetailRequested(true)
      setRollupLoading(false)
    })
    return () => { cancelled = true }
  }, [companyId, effectiveLocationKey, range.start, range.end, showRollupPreview]) // eslint-disable-line react-hooks/exhaustive-deps

  // Package/product/oil detail — mirrors DroptopOrdersPage.tsx's own
  // by-order maps and option-derivation shape exactly (see that file's
  // header comment for why product ids need checking in both sources).
  const packagesByOrder = useMemo(() => {
    const m = new Map<string, PackageRow[]>()
    for (const p of packages) { const a = m.get(p.order_id) ?? []; a.push(p); m.set(p.order_id, a) }
    return m
  }, [packages])
  const productsByOrder = useMemo(() => {
    const m = new Map<string, ProductRow[]>()
    for (const p of products) { const a = m.get(p.order_id) ?? []; a.push(p); m.set(p.order_id, a) }
    return m
  }, [products])
  const servicesByOrder = useMemo(() => {
    const m = new Map<string, ServiceRow[]>()
    for (const s of services) { const a = m.get(s.order_id) ?? []; a.push(s); m.set(s.order_id, a) }
    return m
  }, [services])
  function quartsForOrder(orderId: string): number {
    let total = 0
    for (const p of productsByOrder.get(orderId) ?? []) if (isQuart(p.uom)) total += 1
    for (const svc of servicesByOrder.get(orderId) ?? []) for (const pr of (svc.products ?? [])) if (isQuart(pr.uom)) total += 1
    return total
  }
  const allPackageNames = useMemo(() => [...new Set(packages.map((p) => p.name).filter((n): n is string => !!n))].sort(), [packages])
  const packageOptionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of packages) if (p.name) m.set(p.name, (m.get(p.name) ?? 0) + 1)
    return m
  }, [packages])
  const packageOptions = useMemo(
    () => allPackageNames.map((n) => ({ value: n, count: packageOptionCounts.get(n) ?? 0 })),
    [allPackageNames, packageOptionCounts],
  )
  const allProductIds = useMemo(() => {
    const s = new Set<string>()
    for (const p of products) if (p.product_id) s.add(p.product_id)
    for (const svc of services) for (const pr of (svc.products ?? [])) if (pr.product_id) s.add(pr.product_id)
    return [...s].sort()
  }, [products, services])
  const productIdOptionCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of products) if (p.product_id) m.set(p.product_id, (m.get(p.product_id) ?? 0) + 1)
    for (const svc of services) for (const pr of (svc.products ?? [])) if (pr.product_id) m.set(pr.product_id, (m.get(pr.product_id) ?? 0) + 1)
    return m
  }, [products, services])
  const productIdOptions = useMemo(
    () => allProductIds.map((id) => ({ value: id, count: productIdOptionCounts.get(id) ?? 0 })),
    [allProductIds, productIdOptionCounts],
  )

  const filteredRows = useMemo(
    () => rows.filter((r) => {
      if (allowedLocationIds !== null && (!r.location_id || !allowedLocationIds.has(r.location_id))) return false
      if (packageFilters.length && !(packagesByOrder.get(r.id) ?? []).some((p) => p.name && packageFilters.includes(p.name))) return false
      if (productIdFilters.length) {
        const inTopLevel = (productsByOrder.get(r.id) ?? []).some((p) => p.product_id && productIdFilters.includes(p.product_id))
        const inServices = (servicesByOrder.get(r.id) ?? []).some((s) => (s.products ?? []).some((p) => p.product_id && productIdFilters.includes(p.product_id)))
        if (!inTopLevel && !inServices) return false
      }
      if (oilOnly && quartsForOrder(r.id) === 0) return false
      return true
    }),
    // quartsForOrder reads productsByOrder/servicesByOrder, both already
    // deps below — same convention as DroptopOrdersPage's quartsFor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, allowedLocationIds, packagesByOrder, productsByOrder, servicesByOrder, packageFilters, productIdFilters, oilOnly],
  )
  const geocodedOrderCount = useMemo(() => filteredRows.filter((r) => r.geocode_status === 'matched').length, [filteredRows])

  const mappedRows = useMemo(
    () => filteredRows.filter((r) => { const c = effectiveCoords(r, coordinateMode); return c.lat != null && c.lng != null }),
    [filteredRows, coordinateMode],
  )
  const unmappedRows = useMemo(
    () => filteredRows.filter((r) => { const c = effectiveCoords(r, coordinateMode); return c.lat == null || c.lng == null }),
    [filteredRows, coordinateMode],
  )

  // Grouping stays zip-based in BOTH modes — the entire selection/scroll/
  // table system downstream is built around a zip uniquely identifying one
  // cluster, and a finer-grained "cluster by exact address" key would
  // break that (multiple address-level points legitimately sharing one
  // zip, making selectedZip no longer unique). Address mode instead just
  // changes WHICH coordinate a zip's dot plots at: the average of that
  // zip's actual geocoded order positions when any exist, falling back to
  // the zip centroid otherwise — a real, meaningful improvement (the dot
  // shifts to reflect where within the zip customers actually are) without
  // needing a parallel selection model.
  const allClusters = useMemo<ZipCluster[]>(() => {
    // Rollup fast path — feeds the exact same downstream pipeline
    // (matchMode filtering, density buckets, map rendering, the on-screen
    // table) that the raw path below builds, just sourced from the
    // pre-aggregated table instead of individual orders. Falls through to
    // the real computation the moment showRollupPreview turns off (Load
    // Full Detail clicked, or the range/mode became ineligible).
    if (showRollupPreview) return rollupClusters ?? []
    interface Accum { zip: string; city: string; region: string; count: number; locationIds: Set<string>; centroidLat: number; centroidLng: number; geoLatSum: number; geoLngSum: number; geoCount: number }
    const byZip = new Map<string, Accum>()
    for (const r of mappedRows) {
      const key = r.zip || `${r.lat},${r.lng}`
      const geocoded = coordinateMode === 'address' && r.geocode_status === 'matched' && r.geocoded_lat != null && r.geocoded_lng != null
      let a = byZip.get(key)
      if (!a) {
        a = {
          zip: r.zip ?? '—', city: normalizeCityCase(r.city ?? ''), region: r.region ?? '',
          count: 0, locationIds: new Set(), centroidLat: r.lat as number, centroidLng: r.lng as number,
          geoLatSum: 0, geoLngSum: 0, geoCount: 0,
        }
        byZip.set(key, a)
      }
      a.count++
      if (r.location_id) a.locationIds.add(r.location_id)
      if (geocoded) { a.geoLatSum += r.geocoded_lat as number; a.geoLngSum += r.geocoded_lng as number; a.geoCount++ }
    }
    return [...byZip.values()].map((a): ZipCluster => ({
      zip: a.zip, city: a.city, region: a.region, count: a.count, locationIds: a.locationIds,
      lat: a.geoCount > 0 ? a.geoLatSum / a.geoCount : a.centroidLat,
      lng: a.geoCount > 0 ? a.geoLngSum / a.geoCount : a.centroidLng,
    }))
  }, [mappedRows, coordinateMode, showRollupPreview, rollupClusters])

  // "Shared" = only zips with a customer at EVERY selected shop.
  // "All" (default) = zips from ANY selected shop (plain union — already
  // what the query itself returns once 2+ shops are picked).
  const clusters = useMemo(() => {
    let list = allClusters
    if (matchMode === 'shared' && shopIds.length >= 2) {
      const need = shopIds
      list = list.filter((c) => need.every((id) => c.locationIds.has(id)))
    }
    return [...list].sort((a, b) => b.count - a.count)
  }, [allClusters, matchMode, shopIds])

  const densityBp = useMemo(() => densityBreakpoints(clusters.map((c) => c.count)), [clusters])
  const focusTarget = useMemo(() => clusters.find((c) => c.zip === selectedZip) ?? null, [clusters, selectedZip])

  const mapCenter = useMemo((): [number, number] => {
    if (clusters.length > 0) return [clusters[0].lat, clusters[0].lng]
    return [39.5, -98.35] // continental US fallback
  }, [clusters.length > 0 ? clusters[0].zip : null]) // eslint-disable-line react-hooks/exhaustive-deps

  // Stable "which zips are on the map" key — separate from `clusters`
  // itself, whose object identity (and every cluster's `count`) changes on
  // EVERY progressive-load flush, not just when a zip is gained or lost.
  // Effects/memos below that only care about the zip SET (which boundaries
  // to fetch, which map features exist) key off this instead, so a
  // company-wide load isn't re-fetching boundaries or rebuilding the whole
  // map layer roughly once a second for the entire load — only when a
  // genuinely new zip shows up.
  const zipsKey = useMemo(() => [...new Set(clusters.map((c) => c.zip))].sort().join(','), [clusters])

  // Choropleth boundaries — fetched only in choropleth mode, only for the
  // zips actually on the map right now (never the whole 31k-zip table).
  // Chunked .in() the same defensive way as everything else this session.
  useEffect(() => {
    if (hideMap || mapViewMode !== 'choropleth' || !zipsKey) return
    let cancelled = false
    const zips = zipsKey.split(',')
    const sb = supabase as any
    const CHUNK = 200
    ;(async () => {
      const m = new Map<string, GeoJSON.Geometry>()
      for (let i = 0; i < zips.length; i += CHUNK) {
        const slice = zips.slice(i, i + CHUNK)
        const { data, error } = await sb.schema('inventory').from('zip_boundaries').select('zip, geometry').in('zip', slice)
        if (error) break
        for (const r of (data ?? []) as { zip: string; geometry: GeoJSON.Geometry }[]) m.set(r.zip, r.geometry)
      }
      if (!cancelled) setZipGeometries(m)
    })()
    return () => { cancelled = true }
  }, [hideMap, mapViewMode, zipsKey])

  // Per-zip lat/lng snapshot, also keyed off zipsKey rather than `clusters`
  // directly — used only as the fallback point position for a zip with no
  // boundary in zipGeometries. A tiny lag behind the very latest
  // weighted-average position (address mode) while more orders are still
  // streaming in is an imperceptible tradeoff for not rebuilding the
  // entire map layer on every incoming page.
  const zipMeta = useMemo(() => {
    const m = new Map<string, { lat: number; lng: number }>()
    for (const c of clusters) if (!m.has(c.zip)) m.set(c.zip, { lat: c.lat, lng: c.lng })
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zipsKey])
  // How many zips on the current map have no boundary on file — drives the
  // "N No Boundary" toggle button (only shown in choropleth mode).
  const noBoundaryCount = useMemo(
    () => [...zipMeta.keys()].filter((zip) => !zipGeometries.has(zip)).length,
    [zipMeta, zipGeometries],
  )

  // ONE merged GeoJSON layer for the whole map, instead of a React
  // component PER zip. A company-wide month can put 5,000-7,000+ zips on
  // the map at once — mounting that many individual <GeoJSON>/<CircleMarker>
  // React components (each its own Leaflet Path, DOM/SVG node, and event
  // bindings) is what actually made the page unresponsive, not the order
  // volume itself. This single layer's `data` only changes when the zip SET
  // changes (zipsKey/zipGeometries), not on every progressive-load flush;
  // per-zip fill color updates imperatively via .setStyle() below instead
  // of by rebuilding the layer. A zip with no boundary on file falls back
  // to a Point feature, rendered as a circle via pointToLayer — unless
  // hideNoBoundaryZips is on, in which case it's dropped from the map
  // entirely (a visual-only choice, not a data change — it still counts in
  // every stat/table, just doesn't draw).
  const choroplethFeatureCollection = useMemo((): GeoJSON.FeatureCollection => ({
    type: 'FeatureCollection',
    features: [...zipMeta.entries()]
      .filter(([zip]) => !hideNoBoundaryZips || zipGeometries.has(zip))
      .map(([zip, meta]) => ({
        type: 'Feature',
        properties: { zip },
        geometry: zipGeometries.get(zip) ?? { type: 'Point', coordinates: [meta.lng, meta.lat] },
      })),
  }), [zipMeta, zipGeometries, hideNoBoundaryZips])

  // Refs so the layer's style function / event handlers (bound once per
  // feature, at layer-build time — see onEachChoroplethFeature/
  // choroplethPointToLayer below) always read CURRENT data instead of
  // whatever was current the one time they were attached.
  const clustersByZipRef = useRef(new Map<string, ZipCluster>())
  useEffect(() => { clustersByZipRef.current = new Map(clusters.map((c) => [c.zip, c])) }, [clusters])
  const densityBpRef = useRef(densityBp)
  useEffect(() => { densityBpRef.current = densityBp }, [densityBp])
  const zoomRef = useRef(zoom)
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  const ordersForZipRef = useRef<(zip: string) => OrderRow[]>(() => [])

  const choroplethLayerRef = useRef<L.GeoJSON | null>(null)
  // react-leaflet's <GeoJSON> only reliably parses `data` at MOUNT time — an
  // already-mounted layer does NOT re-parse when the `data` prop reference
  // changes on its own. That was a real bug here: a zip whose real boundary
  // loaded in AFTER the layer first built kept showing its Point-fallback
  // circle indefinitely (since its geometry "changed" from Point to
  // Polygon only in the `data` prop, which the live layer ignored) until
  // the whole view was toggled off and back on to force a fresh mount.
  // clearLayers()+addData() explicitly forces the live layer to redraw
  // from the CURRENT feature set — both genuinely new zips and any zip
  // whose geometry just resolved from a fallback point to a real boundary.
  useEffect(() => {
    const layer = choroplethLayerRef.current
    if (!layer) return
    layer.clearLayers()
    layer.addData(choroplethFeatureCollection)
  }, [choroplethFeatureCollection])

  // Repaints the merged layer's per-feature colors whenever counts/density/
  // zoom change — a cheap in-place .setStyle() pass, not a rebuild. Runs
  // right after the addData() effect above (same deps trigger, declared
  // after it) so newly (re)added layers get correctly colored immediately
  // rather than sitting at addData()'s flat default style. (Doesn't touch
  // the Point-fallback circles' radius — Leaflet's Path.setStyle() has no
  // radius concept — so a zip with no boundary won't grow with zoom the
  // way a normal circle does; an accepted, minor cosmetic gap given how
  // few zips actually lack one.)
  useEffect(() => {
    const layer = choroplethLayerRef.current
    if (!layer) return
    layer.setStyle((feature?: GeoJSON.Feature) => {
      const zip = feature?.properties?.zip as string | undefined
      const c = zip ? clustersByZipRef.current.get(zip) : undefined
      const s = c ? styleFor(c.count, densityBp, zoom) : { radius: 0, color: '#4F7489', fill: '#B7E0DE' }
      return { color: s.color, fillColor: s.fill, fillOpacity: 0.55, weight: 1.5 }
    })
  }, [clusters, densityBp, zoom, mapViewMode, choroplethFeatureCollection])

  const onEachChoroplethFeature = useCallback((feature: GeoJSON.Feature, layer: L.Layer) => {
    const zip = feature.properties?.zip as string | undefined
    if (!zip) return
    layer.bindTooltip(() => {
      const c = clustersByZipRef.current.get(zip)
      const loc = c?.city ? ` — ${c.city}, ${c.region}` : ''
      return `<span class="font-mono text-xs">${zip}${loc}<br/>${c?.count ?? 0} order${c?.count === 1 ? '' : 's'}</span>`
    })
    layer.on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      setSelectedZip((prev) => (prev === zip ? null : zip))
    })
    layer.on('dblclick', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e)
      // Always opens — in rollup preview this has no real rows yet, and
      // the modal itself shows a "Load Full Detail" prompt rather than a
      // silently-empty table (see the Modal render below).
      const c = clustersByZipRef.current.get(zip)
      setOrderModal({ title: `Orders — ${zip}${c?.city ? ` (${c.city}, ${c.region})` : ''}`, rows: ordersForZipRef.current(zip) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const choroplethPointToLayer = useCallback((feature: GeoJSON.Feature, latlng: L.LatLng): L.Layer => {
    const zip = feature.properties?.zip as string | undefined
    const c = zip ? clustersByZipRef.current.get(zip) : undefined
    const s = c ? styleFor(c.count, densityBpRef.current, zoomRef.current) : { radius: 6, color: '#4F7489', fill: '#B7E0DE' }
    return L.circleMarker(latlng, { radius: s.radius, color: s.color, fillColor: s.fill, fillOpacity: 0.55, weight: 1.5 })
  }, [])

  // On-screen "By Shop" table — one row per (shop, zip), mirroring the
  // export's grouping (minus avg ticket/packages, which stay export-only).
  interface ShopZipRow { locationId: string; shopNumber: string; shopLabel: string; zip: string; city: string; region: string; count: number }
  const shopZipRows = useMemo(() => {
    const m = new Map<string, ShopZipRow>()
    for (const r of mappedRows) {
      if (!r.location_id) continue
      const l = loc.byId(r.location_id)
      const shopNumber = l?.name ?? r.location_id
      const key = `${r.location_id}|${r.zip ?? '—'}`
      let g = m.get(key)
      if (!g) {
        g = { locationId: r.location_id, shopNumber, shopLabel: shopNumberCityLabel(shopNumber, l?.shop_city), zip: r.zip ?? '—', city: normalizeCityCase(r.city ?? ''), region: r.region ?? '', count: 0 }
        m.set(key, g)
      }
      g.count++
    }
    return [...m.values()].sort((a, b) => a.shopNumber.localeCompare(b.shopNumber, undefined, { numeric: true }) || b.count - a.count)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mappedRows, loc.locations])

  const zipSearchQ = zipSearch.trim().toLowerCase()
  const visibleClusters = useMemo(
    () => zipSearchQ ? clusters.filter((c) => c.zip.toLowerCase().includes(zipSearchQ) || c.city.toLowerCase().includes(zipSearchQ) || c.region.toLowerCase().includes(zipSearchQ)) : clusters,
    [clusters, zipSearchQ],
  )
  const visibleShopZipRows = useMemo(
    () => zipSearchQ ? shopZipRows.filter((r) => r.zip.toLowerCase().includes(zipSearchQ) || r.city.toLowerCase().includes(zipSearchQ) || r.region.toLowerCase().includes(zipSearchQ) || r.shopLabel.toLowerCase().includes(zipSearchQ)) : shopZipRows,
    [shopZipRows, zipSearchQ],
  )

  // Clicking a zip circle scrolls the Visits-by-Zip table to that row, not
  // just highlighting it — with hundreds of zips loaded, "highlighted
  // somewhere in a long table" isn't findable without this.
  useEffect(() => {
    if (!selectedZip) return
    const el = zipRowRefs.current.get(selectedZip)
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedZip, zipExportMode, visibleClusters, visibleShopZipRows])

  function ordersForZip(zip: string): OrderRow[] {
    return mappedRows.filter((r) => (r.zip ?? '—') === zip)
  }
  useEffect(() => { ordersForZipRef.current = ordersForZip })

  function ordersForShopZip(locationId: string, zip: string): OrderRow[] {
    return mappedRows.filter((r) => r.location_id === locationId && (r.zip ?? '—') === zip)
  }

  // Order modal packages — fetched only once the modal actually opens, for
  // just that modal's order set (same reasoning as the export: package data
  // isn't part of the page's normal query).
  useEffect(() => {
    if (!orderModal) { setOrderModalPackages(null); return }
    let cancelled = false
    fetchPackageNamesByOrderIds(orderModal.rows.map((o) => o.id))
      .then((m) => { if (!cancelled) setOrderModalPackages(m) })
      .catch(() => { if (!cancelled) setOrderModalPackages(new Map()) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderModal])

  function exportOrderModal(format: 'csv' | 'xlsx') {
    if (!orderModal || !orderModal.rows.length) return
    setOrderModalExporting(format)
    try {
      const headers = ['Order #', 'Shop', 'Customer', 'City', 'Zip', 'Total', 'Finalized', 'Package(s)']
      const dataRows = orderModal.rows.map((o) => {
        const l = o.location_id ? loc.byId(o.location_id) : undefined
        return [
          o.order_id,
          l ? shopNumberCityLabel(l.name, l.shop_city) : (o.location_id ?? '—'),
          [o.first_name, o.last_name].filter(Boolean).join(' ') || '—',
          o.city || '—',
          o.zip || '—',
          o.final_price ?? 0,
          dateShort(o.order_finalized_at),
          (orderModalPackages?.get(o.id) ?? []).join(', '),
        ]
      })
      const fileBase = `heatmap-orders-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...dataRows].map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
        XLSX.utils.book_append_sheet(wb, ws, 'Orders')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`)
      }
      toast.success('Export downloaded')
    } finally {
      setOrderModalExporting(null)
    }
  }

  // Visits by Zip export — richer than the on-screen table (which stays a
  // simple zip aggregate): per (zip) or per (shop, zip) row, includes
  // average ticket and a count-per-package breakdown. Packages aren't part
  // of the page's normal query (would mean joining a child table for every
  // order just to render a map/table that doesn't need it), so they're
  // fetched only when actually exporting, chunked the same way
  // DroptopOrdersPage.tsx already does for the same table.
  async function fetchPackageNamesByOrderIds(orderIds: string[]): Promise<Map<string, string[]>> {
    const sb = supabase as any
    // CHUNK bounds the input (.in() list size); PAGE properly paginates
    // each chunk's OUTPUT. Chunking input alone isn't enough — this
    // project's Supabase "Max Rows" API setting silently caps every
    // response at 1000 regardless of .limit(), and a chunk of order ids
    // can produce more result rows than input ids (an order can have
    // multiple packages), so an unpaginated .in() could silently drop
    // rows past 1000 with no error. Same fix as the main orders loop:
    // keep fetching by (id) cursor until a genuinely empty page.
    const CHUNK = 200
    const PAGE = 1000
    // Chunks used to run one-at-a-time — fine when a full month's worth of
    // orders was a few hundred, but a real company-wide export (167k+
    // orders = 800+ chunks) at ~150-300ms each meant 2+ minutes of purely
    // sequential round trips. Bounded concurrency (8 in flight at a time,
    // same pattern already used server-side in skybitz-tank-sync) cuts
    // that by roughly the concurrency factor without firing all 800+ at
    // the database simultaneously. Safe to write into a shared Map from
    // concurrent workers — each chunk owns a disjoint slice of order ids,
    // so no two workers ever write the same key.
    const CONCURRENCY = 8
    const byOrder = new Map<string, string[]>()
    const slices: string[][] = []
    for (let i = 0; i < orderIds.length; i += CHUNK) slices.push(orderIds.slice(i, i + CHUNK))

    async function fetchSlice(slice: string[]) {
      let cursor: string | null = null
      for (;;) {
        let q = sb.schema('inventory').from('droptop_order_packages').select('id, order_id, name')
          .in('order_id', slice).order('id', { ascending: true }).limit(PAGE)
        if (cursor) q = q.gt('id', cursor)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        const batch = (data ?? []) as { id: string; order_id: string; name: string | null }[]
        for (const p of batch) {
          if (!p.name) continue
          const arr = byOrder.get(p.order_id) ?? []
          arr.push(p.name)
          byOrder.set(p.order_id, arr)
        }
        if (batch.length === 0) break
        cursor = batch[batch.length - 1].id
      }
    }

    let next = 0
    async function worker() {
      while (next < slices.length) {
        const slice = slices[next++]
        await fetchSlice(slice)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slices.length) }, worker))
    return byOrder
  }

  // Fallback snapshot — a fresh Canvas render of the same cluster data/
  // colors the live map shows, used when there's no real map to shoot
  // (Hide Map is on) or html2canvas itself fails for some reason (a tile
  // host without CORS, a browser blocking canvas readback, etc). Never the
  // primary path anymore now that html2canvas is available, but kept as a
  // "never come back with nothing" safety net.
  function renderClusterSnapshot(lines: string[]): Promise<Blob | null> {
    const W = 900, H = 620, PAD = 40
    const canvas = document.createElement('canvas')
    canvas.width = W; canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return Promise.resolve(null)
    ctx.fillStyle = '#F2F1E6' // cream
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#002745' // navy
    ctx.font = 'bold 20px Arial'
    ctx.fillText(lines[0], PAD, 34)
    ctx.font = '13px Arial'
    ctx.fillStyle = '#4F7489' // inky
    lines.slice(1).forEach((l, i) => ctx.fillText(l, PAD, 58 + i * 18))

    const mapTop = 58 + Math.max(1, lines.length - 1) * 18 + 16
    const mapBottom = H - 24
    const mapH = mapBottom - mapTop
    ctx.strokeStyle = 'rgba(0,39,69,0.15)'
    ctx.strokeRect(PAD, mapTop, W - 2 * PAD, mapH)

    if (clusters.length) {
      const lats = clusters.map((c) => c.lat), lngs = clusters.map((c) => c.lng)
      const minLat = Math.min(...lats), maxLat = Math.max(...lats)
      const minLng = Math.min(...lngs), maxLng = Math.max(...lngs)
      const latSpan = Math.max(0.05, maxLat - minLat), lngSpan = Math.max(0.05, maxLng - minLng)
      const maxCount = Math.max(...clusters.map((c) => c.count))
      // Largest first so a big zip's circle doesn't bury a small
      // neighboring one entirely.
      for (const c of [...clusters].sort((a, b) => b.count - a.count)) {
        const x = PAD + ((c.lng - minLng) / lngSpan) * (W - 2 * PAD)
        const y = mapTop + (1 - (c.lat - minLat) / latSpan) * mapH
        const r = 3 + Math.sqrt(c.count / maxCount) * 20
        ctx.globalAlpha = 0.75
        ctx.fillStyle = gradientColor(percentileRank(c.count, densityBp.sorted))
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
      }
      ctx.globalAlpha = 1
    } else {
      ctx.fillStyle = '#4F7489'
      ctx.font = '14px Arial'
      ctx.fillText('No orders in this range', PAD + 12, mapTop + mapH / 2)
    }
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  }

  // Copies a real screenshot of the live Leaflet map (tiles, pins, circles
  // — whatever's actually on screen right now) via html2canvas, plus a
  // text summary (period, shop selection, and any Region/Market/AM/Owner
  // filters in effect), to the clipboard as one clipboard item, so pasting
  // into chat/email/a doc picks up whichever it supports. Falls back to
  // renderClusterSnapshot above when there's no map to shoot or the real
  // capture fails.
  async function copyHeatmap() {
    const lines: string[] = [`Customer Heatmap — ${range.start} to ${range.end}`]
    if (shopIds.length > 0 && shopIds.length <= 5) lines.push(`Shops: ${shopLabels.join(', ')}`)
    else lines.push(shopIds.length ? `${shopIds.length} shops selected` : 'All shops')
    if (filterOwners.length) lines.push(`Owner: ${filterOwners.join(', ')}`)
    if (filterRegions.length) lines.push(`Region: ${filterRegions.join(', ')}`)
    if (filterMarkets.length) lines.push(`Market: ${filterMarkets.join(', ')}`)
    if (filterAMs.length) lines.push(`Area Manager: ${filterAMs.join(', ')}`)
    if (hideFleetOrders) lines.push('Fleet orders hidden')

    let blob: Blob | null = null
    if (!hideMap && mapWrapperRef.current) {
      try {
        const html2canvas = (await import('html2canvas')).default
        const canvas = await html2canvas(mapWrapperRef.current, {
          useCORS: true, backgroundColor: '#F2F1E6', logging: false,
        })
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      } catch {
        // A tile host without CORS, a browser blocking canvas readback,
        // etc — fall through to the stylized re-render rather than
        // failing the whole copy.
        blob = null
      }
    }
    if (!blob) blob = await renderClusterSnapshot(lines)

    const plain = lines.join('\n')
    try {
      if (blob && typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'image/png': blob,
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(plain)
      }
      toast.success('Heatmap copied to clipboard')
    } catch { toast.error('Copy failed') }
  }

  async function exportVisits(format: 'csv' | 'xlsx') {
    if (!mappedRows.length) { toast.error('Nothing to export for this range'); return }
    setExporting(format)
    try {
      const orderIds = mappedRows.map((r) => r.id)
      const packagesByOrder = await fetchPackageNamesByOrderIds(orderIds)
      const allPackageNames = [...new Set([...packagesByOrder.values()].flat())].sort()

      interface Group { shopNumber: string; shopLabel: string; zip: string; city: string; region: string; count: number; ticketTotal: number; packageCounts: Map<string, number> }
      const groups = new Map<string, Group>()
      for (const r of mappedRows) {
        const shopLoc = r.location_id ? loc.byId(r.location_id) : undefined
        const shopNumber = zipExportMode === 'by-shop' ? (shopLoc?.name ?? r.location_id ?? '—') : ''
        // shopNumberCityLabel(), not a manual `${shopNumber}-${shopCity}`
        // concat — some locations' shop_city already comes prefixed with
        // the shop number as its raw stored value ("1-Thomasville", not
        // just "Thomasville"), so concatenating naively doubled it up into
        // "1-1-Thomasville". Same bug, same fix already applied to every
        // other shop-label spot in this file (the on-screen ShopZipRow
        // table, the order modal) — this export path was the one place
        // still doing it manually.
        const shopLabel = zipExportMode === 'by-shop' ? shopNumberCityLabel(shopNumber, shopLoc?.shop_city) : ''
        const key = `${shopNumber}|${r.zip ?? '—'}`
        let g = groups.get(key)
        if (!g) { g = { shopNumber, shopLabel, zip: r.zip ?? '—', city: normalizeCityCase(r.city ?? ''), region: r.region ?? '', count: 0, ticketTotal: 0, packageCounts: new Map() }; groups.set(key, g) }
        g.count++
        g.ticketTotal += r.final_price ?? 0
        for (const name of packagesByOrder.get(r.id) ?? []) g.packageCounts.set(name, (g.packageCounts.get(name) ?? 0) + 1)
      }
      const sorted = [...groups.values()].sort((a, b) => a.shopNumber.localeCompare(b.shopNumber, undefined, { numeric: true }) || b.count - a.count)

      const baseHeaders = zipExportMode === 'by-shop'
        ? ['Shop Number', 'Shop', 'Zip', 'City', 'Region', 'Customer Count', 'Avg Ticket']
        : ['Zip', 'City', 'Region', 'Customer Count', 'Avg Ticket']
      const headers = [...baseHeaders, ...allPackageNames]
      const dataRows = sorted.map((g) => {
        const avgTicket = money(g.ticketTotal / g.count)
        const base = zipExportMode === 'by-shop'
          ? [g.shopNumber, g.shopLabel, g.zip, g.city, g.region, g.count, avgTicket]
          : [g.zip, g.city, g.region, g.count, avgTicket]
        // Blank instead of 0 for a package this row had none of — reads
        // cleaner in a spreadsheet with lots of package columns.
        return [...base, ...allPackageNames.map((name) => g.packageCounts.get(name) || '')]
      })

      // Title + date range above the real table so the export is
      // self-describing once it's out of the app (renamed, forwarded,
      // opened weeks later) — a blank row separates it from the header row.
      const title = zipExportMode === 'by-shop' ? 'Visits by Zip and Shop' : 'Visits by Zip'
      const sheetRows: (string | number)[][] = [[title], [`${range.start} to ${range.end}`], [], headers, ...dataRows]

      const fileBase = `customer-heatmap-visits-${zipExportMode}-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = sheetRows.map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet(sheetRows)
        XLSX.utils.book_append_sheet(wb, ws, 'Visits by Zip')
        const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
        triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`)
      }
      toast.success('Export downloaded')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(null)
    }
  }

  // Store pins — one per shop that actually has orders in this (now
  // pin-filter-scoped) view, not every shop company-wide. Sourced from
  // filteredRows rather than re-applying the Region/Market/AM filters here
  // too — filteredRows already only contains orders from matching shops, so
  // this stays in sync with the heatmap by construction instead of two
  // independent filter copies. core.locations' latitude/longitude (the
  // shop's own geocoded address, maintained on the Map Routes tab) is what
  // places these — a different coordinate source than the zip-centroid
  // lat/lng the customer clusters use. Each pin carries its market's shared
  // color (getMarketSolidColor, same function/list Map & Routes uses) so
  // the two pages agree on what color a given market is.
  const shopPins = useMemo(() => {
    const ids = new Set<string>()
    // Rollup preview has no raw rows to read location_id off of — the
    // rollup RPC's location_ids per zip (already carried on each
    // ZipCluster for "Shared Only" matching) is the only source available,
    // so pins fall back to that instead of silently showing none. Real bug
    // this fixes: pins vanished entirely whenever showRollupPreview was
    // true, since filteredRows is always empty in that mode.
    if (showRollupPreview) {
      for (const c of clusters) for (const id of c.locationIds) ids.add(id)
    } else {
      for (const r of filteredRows) if (r.location_id) ids.add(r.location_id)
    }
    return [...ids]
      .map((id) => loc.byId(id))
      .filter((l): l is NonNullable<typeof l> => !!l && l.latitude != null && l.longitude != null)
      .map((l) => ({ loc: l, color: getMarketSolidColor(loc.fieldValue(l.id, 'market'), allMarkets) }))
    // depends on loc.locations (stable across renders), not the loc object
    // itself, which useLocations() recreates every render
  }, [filteredRows, clusters, showRollupPreview, loc.locations, allMarkets]) // eslint-disable-line react-hooks/exhaustive-deps

  // Plain OpenStreetMap tiles — see index.css's .map-tiles-dark comment for
  // why (CartoDB's raster basemaps now need a key and are being retired).
  const tileUrl = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  const tileAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Customer Heatmap</h1>
          <p className="text-xs text-inky mt-0.5">
            Where orders in this date range came from, by zip-code cluster. Populated by Config → Data Connections'
            Droptop — Orders sync.
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <Button size="sm" variant="secondary" onClick={() => void copyHeatmap()}
            title="Copy a snapshot image + summary (period, shop/filter selection) to the clipboard">
            Copy
          </Button>
          <PeriodPicker period={period} onPeriodChange={setPeriod} customStart={customStart} customEnd={customEnd}
            onCustomStartChange={setCustomStart} onCustomEndChange={setCustomEnd} earliestDate={earliestDate} />
          {shopIds.length >= 2 && (
            <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
              {(['all', 'shared'] as const).map((m) => (
                <button key={m} onClick={() => setMatchMode(m)}
                  className={['px-2 py-1.5 uppercase tracking-wide transition-colors', matchMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                  title={m === 'all' ? 'Show all customers for any selected location' : 'Only zips with a customer at every selected location'}>
                  {m === 'all' ? 'All Customers' : 'Shared Only'}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {error && (
        <p className="text-xs font-mono text-[#C0392B] border border-[#C0392B]/30 bg-[#C0392B]/5 rounded px-2 py-1.5">{error}</p>
      )}

      {/* Region/Market/AM/Shop(s) — deliberately OUTSIDE the loading/empty/
          content branches below so they're usable WHILE a load (rollup or
          full) is still in progress, not just after it finishes. Per
          explicit request: narrowing the selection here restarts the pull
          on the new selection instead of waiting out whatever was already
          running — both fetch effects above depend on effectiveLocationKey,
          so changing these cancels the in-flight fetch for the old
          selection and starts a fresh, narrower one immediately. */}
      <div className="flex items-end gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Owner</span>
          <MultiSelectDropdown options={ownerOptions} selected={filterOwners} onChange={setFilterOwners} placeholder="Corporate + Franchise" countNoun="owners" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Region</span>
          <MultiSelectDropdown options={regionOptions} selected={filterRegions} onChange={setFilterRegions} placeholder="All Regions" countNoun="regions" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Market</span>
          <MultiSelectDropdown options={marketOptions} selected={filterMarkets} onChange={setFilterMarkets} placeholder="All Markets" countNoun="markets" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Area Manager</span>
          <MultiSelectDropdown options={amOptions} selected={filterAMs} onChange={setFilterAMs} placeholder="All AMs" countNoun="AMs" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
          <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels} placeholder="All Shops" countNoun="shops" searchable />
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Fleet Orders</span>
          <span className="flex items-center gap-1.5 h-[30px]" title="Fleet/B2B orders often show up geographically wrong — the vehicle's registered address is frequently not where it's actually driven">
            <Toggle checked={hideFleetOrders} onChange={setHideFleetOrders} size="sm" color="cyan" />
            <span className="text-xs font-mono text-inky">{hideFleetOrders ? 'Hidden' : 'Shown'}</span>
          </span>
        </label>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Package(s)</span>
          <MultiSelectDropdown options={packageOptions} selected={packageFilters} onChange={setPackageFilters} placeholder="All Packages" countNoun="packages" searchable />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Product ID</span>
          <MultiSelectDropdown options={productIdOptions} selected={productIdFilters} onChange={setProductIdFilters} placeholder="All Products" countNoun="products" searchable />
        </div>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Oil Only</span>
          <span className="flex items-center gap-1.5 h-[30px]" title="Only orders with at least one oil product (quart-uom) sold — forces full detail, same as Fleet Orders">
            <Toggle checked={oilOnly} onChange={setOilOnly} size="sm" color="cyan" />
            <span className="text-xs font-mono text-inky">{oilOnly ? 'On' : 'Off'}</span>
          </span>
        </label>
      </div>

      {loading ? (
        <LoadingProgress
          fraction={loadProgress.total ? loadProgress.loaded / loadProgress.total : null}
          countText={
            loadProgress.total
              ? `Loading orders — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
              : loadProgress.loaded > 0
                ? `Loading orders — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                : 'Loading orders…'
          }
          messages={[
            'Pulling orders by zip code…',
            'Matching shops to markets…',
            'Rolling up visit counts…',
            'Mixing the gradient…',
          ]}
        />
      ) : showRollupPreview && rollupClusters === null ? (
        <div className="py-16 flex flex-col items-center gap-3">
          <div className="h-2 w-full max-w-md rounded-full bg-sky/40 animate-pulse" />
          <p className="text-[11px] font-mono text-inky/70">Loading fast preview from cached data…</p>
          <Button size="sm" variant="secondary" onClick={() => setFullDetailRequested(true)}>
            Skip preview — load full detail instead
          </Button>
        </div>
      ) : !showRollupPreview && rows.length === 0 ? (
        <Card><CardBody>
          <p className="text-xs font-mono text-inky/60">
            No orders for this range{shopIds.length ? ' at these shop(s)' : ''} yet. Run the Droptop — Orders sync
            from Config → Data Connections, then come back here.
          </p>
        </CardBody></Card>
      ) : (
        <>
          {/* View toggles — Region/Market/AM/Shop(s) moved above (see the
              comment there for why); these stay here since they're only
              meaningful once there's actually a map to show. */}
          <div className="flex items-end gap-2 flex-wrap">
            <button onClick={() => setHideMap((v) => !v)}
              className={['px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wide transition-colors',
                hideMap ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:bg-navy/10'].join(' ')}
              title="Skip rendering the map — just the stats and Visits by Zip table below, for a quicker load">
              {hideMap ? 'Show Map' : 'Hide Map'}
            </button>
            <button onClick={() => setShowPins((v) => !v)}
              disabled={hideMap}
              className={['px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wide transition-colors disabled:opacity-40',
                showPins ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:bg-navy/10'].join(' ')}
              title="Show or hide store location pins">
              Pins
            </button>
            <button onClick={() => setShowPinLabels((v) => !v)}
              className={['px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wide transition-colors',
                showPinLabels ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:bg-navy/10'].join(' ')}
              title="Show the shop number above each store pin">
              Labels
            </button>
            <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
              {(['circles', 'choropleth'] as const).map((m) => (
                <button key={m} onClick={() => setMapViewMode(m)}
                  className={['px-2 py-1.5 uppercase tracking-wide transition-colors', mapViewMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                  title={m === 'circles' ? 'Density circles, sized and colored by order count' : 'Actual zip outlines, colored the same way as the circles'}>
                  {m === 'circles' ? 'Circles' : 'Choropleth'}
                </button>
              ))}
            </div>
            {mapViewMode === 'choropleth' && noBoundaryCount > 0 && (
              <button onClick={() => setHideNoBoundaryZips((v) => !v)}
                className={['px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wide transition-colors',
                  hideNoBoundaryZips ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:bg-navy/10'].join(' ')}
                title={`${noBoundaryCount.toLocaleString()} zip(s) on this map have no boundary on file and show as a plain dot — toggle to hide them instead`}>
                {hideNoBoundaryZips ? `Hiding ${noBoundaryCount.toLocaleString()} No-Boundary` : `${noBoundaryCount.toLocaleString()} No Boundary`}
              </button>
            )}
            <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
              {(['zip', 'address'] as const).map((m) => (
                <button key={m} onClick={() => setCoordinateMode(m)}
                  className={['px-2 py-1.5 uppercase tracking-wide transition-colors', coordinateMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                  title={m === 'zip' ? 'Every order plots at its zip code’s center point' : 'Geocoded orders plot at their real address (Data Connections → Run Geocoding); orders not yet geocoded still fall back to zip centroid'}>
                  {m === 'zip' ? 'Zip Centroid' : 'Address-Level'}
                </button>
              ))}
            </div>
            {coordinateMode === 'address' && (
              <span className="text-[10px] font-mono text-inky/50 self-center">
                {geocodedOrderCount.toLocaleString()} of {filteredRows.length.toLocaleString()} orders geocoded
              </span>
            )}
            <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
              {(['normal', 'tall'] as const).map((m) => (
                <button key={m} onClick={() => setMapHeightMode(m)}
                  className={['px-2 py-1.5 uppercase tracking-wide transition-colors', mapHeightMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                  title={m === 'tall' ? 'Grow the map card in place — filters and stats above stay visible' : 'Normal map height'}>
                  {m === 'tall' ? 'Tall' : 'Normal'}
                </button>
              ))}
            </div>
            <button onClick={() => setIsMapFullscreen(true)}
              className="p-1.5 rounded border border-navy/30 bg-cream text-inky hover:bg-navy/10 transition-colors"
              title="Expand the map to fill the browser window">
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>

          {showRollupPreview && (
            <p className="flex items-center gap-2 flex-wrap text-[11px] font-mono text-sky border border-sky/30 bg-sky/5 rounded px-2 py-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-sky" />
              Fast preview from cached data (updated nightly — up to ~24h behind). Individual orders, export, and the
              exact "Not On Map" list need full detail.
              <Button size="sm" variant="secondary" loading={rollupLoading} onClick={() => setFullDetailRequested(true)}>
                Load Full Detail
              </Button>
            </p>
          )}

          {(showRollupPreview
            ? (rollupTotals?.mapped ?? 0) + (rollupTotals?.unmapped ?? 0) === 0
            : filteredRows.length === 0) ? (
            <Card><CardBody>
              <p className="text-xs font-mono text-inky/60">
                No orders match the selected Region/Market/AM filter for this range. Clear a filter above to widen it.
              </p>
            </CardBody></Card>
          ) : (
            <>
              <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px] cursor-pointer hover:border-sky transition-colors"
              onClick={() => setOrderModal({ title: `Orders (${filteredRows.length})`, rows: filteredRows })}>
              <CardBody className="py-3">
                <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Orders</p>
                <p className="text-lg font-heading font-bold text-navy">
                  {(showRollupPreview ? (rollupTotals?.mapped ?? 0) + (rollupTotals?.unmapped ?? 0) : filteredRows.length).toLocaleString()}
                </p>
              </CardBody>
            </Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Zip Clusters</p>
              <p className="text-lg font-heading font-bold text-navy">{clusters.length.toLocaleString()}</p>
            </CardBody></Card>
            {clusters[0] && (
              <Card className="flex-1 min-w-[140px] cursor-pointer hover:border-sky transition-colors"
                onClick={() => setSelectedZip(clusters[0].zip)}>
                <CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Top Zip</p>
                  <p className="text-sm font-mono font-bold text-navy">
                    {clusters[0].zip} {clusters[0].city && `— ${normalizeCityCase(clusters[0].city)}`} <span className="text-inky/60">({clusters[0].count})</span>
                  </p>
                </CardBody>
              </Card>
            )}
            {(showRollupPreview ? (rollupTotals?.unmapped ?? 0) > 0 : unmappedRows.length > 0) && (
              <Card className="flex-1 min-w-[140px] cursor-pointer hover:border-sky transition-colors"
                onClick={() => setOrderModal({ title: `Not On Map (${unmappedRows.length})`, rows: unmappedRows })}>
                <CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Not On Map</p>
                  <p className="text-lg font-heading font-bold text-[#E67E22]">
                    {showRollupPreview ? '~' : ''}{(showRollupPreview ? (rollupTotals?.unmapped ?? 0) : unmappedRows.length).toLocaleString()}
                  </p>
                  <p className="text-[10px] font-mono text-inky/50">{showRollupPreview ? 'approx. — load full detail to see which' : 'no zip match — click to see which'}</p>
                </CardBody>
              </Card>
            )}
          </div>

          {clusters.length === 0 ? (
            <Card><CardBody>
              <p className="text-xs font-mono text-inky/60">
                {matchMode === 'shared' ? 'No zip is shared across every selected shop for this range.' : 'No mapped orders for this range.'}
              </p>
            </CardBody></Card>
          ) : (
            <>
              {/* isolate: Leaflet's own panes/controls run up to z-index 1000,
                  but .leaflet-container never sets a z-index on itself, so
                  without a stacking context of its own here those values
                  leak out and out-rank the shop dropdown (z-40) and order
                  modal (z-50) at the page's root stacking level. `isolate`
                  contains all of Leaflet's internal stacking inside this div
                  so it can never climb above app UI outside it. */}
              {!hideMap && (
              // `contents` makes this outer div invisible to layout when not
              // fullscreen (the inner mapWrapperRef div below sits exactly
              // where it always did) — avoids duplicating the whole
              // MapContainer tree for the two cases. Fullscreen swaps it to
              // a fixed full-viewport overlay instead.
              <div className={isMapFullscreen ? 'fixed inset-0 z-[1000] bg-cream p-4 flex flex-col' : 'contents'}>
                {isMapFullscreen && (
                  <div className="flex justify-end mb-2">
                    <button onClick={() => setIsMapFullscreen(false)}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded border border-navy/30 bg-cream text-navy hover:bg-navy/10 transition-colors text-[10px] font-mono uppercase tracking-wide">
                      <Minimize2 className="w-3.5 h-3.5" /> Exit Fullscreen (Esc)
                    </button>
                  </div>
                )}
              <div ref={mapWrapperRef}
                className={['isolate rounded border border-navy/30 overflow-hidden', isMapFullscreen ? 'flex-1' : ''].join(' ')}
                style={isMapFullscreen ? undefined : { height: mapHeightMode === 'tall' ? 960 : 640 }}>
                <MapContainer center={mapCenter} zoom={5} preferCanvas style={{ height: '100%', width: '100%' }}>
                  {/* crossOrigin lets html2canvas (Copy button) actually read
                      the tile images into a canvas instead of tainting it —
                      OSM's tile server sends CORS headers precisely to
                      support this. Passed straight through to the
                      underlying Leaflet TileLayer as a layer option. */}
                  <TileLayer url={tileUrl} attribution={tileAttribution} className={dark ? 'map-tiles-dark' : undefined} crossOrigin={true} />
                  <FocusZip target={focusTarget} />
                  <ZoomTracker onZoom={setZoom} />
                  <MapResizeHandler resizeKey={`${isMapFullscreen}-${mapHeightMode}`} />
                  <DeselectOnMapClick onDeselect={() => setSelectedZip(null)} />
                  {showPins && shopPins.map(({ loc: l, color }) => (
                    <Marker key={l.id} position={[l.latitude as number, l.longitude as number]}
                      icon={makeShopPinIcon(color, showPinLabels ? l.name : null)}>
                      <Tooltip>
                        <span className="font-mono text-xs font-bold">{shopNumberCityLabel(l.name, l.shop_city)}</span>
                      </Tooltip>
                    </Marker>
                  ))}
                  {/* Choropleth: ONE merged layer for every zip (see
                      choroplethFeatureCollection's own comment for why —
                      one React-managed Leaflet layer per zip stopped
                      scaling once a company-wide load routinely put
                      5,000-7,000+ zips on the map at once). Style/tooltip/
                      click content stay current via refs and the
                      .setStyle() effect above, not via re-rendering this
                      layer. `key` is intentionally omitted — remounting on
                      every render would defeat the entire point. */}
                  {mapViewMode === 'choropleth' && (
                    <GeoJSONLayer
                      ref={choroplethLayerRef}
                      data={choroplethFeatureCollection}
                      style={{ color: '#4F7489', fillColor: '#B7E0DE', fillOpacity: 0.55, weight: 1.5 }}
                      onEachFeature={onEachChoroplethFeature}
                      pointToLayer={choroplethPointToLayer}
                    />
                  )}
                  {/* Circles mode keeps one CircleMarker per zip — lighter
                      per-shape than a GeoJSON polygon, and canvas-rendered
                      (preferCanvas above) rather than SVG, which is the
                      standard Leaflet scaling path for many simple shapes. */}
                  {mapViewMode === 'circles' && clusters.map((c) => {
                    const style = styleFor(c.count, densityBp, zoom)
                    const eventHandlers = {
                      // stopPropagation so this doesn't also trigger
                      // DeselectOnMapClick's background-click handler —
                      // clicking the already-selected zip again toggles it
                      // off (a second way to "click out" besides clicking
                      // elsewhere on the map).
                      click: (e: L.LeafletMouseEvent) => { L.DomEvent.stopPropagation(e); setSelectedZip((prev) => (prev === c.zip ? null : c.zip)) },
                      dblclick: (e: L.LeafletMouseEvent) => {
                        L.DomEvent.stopPropagation(e)
                        setOrderModal({ title: `Orders — ${c.zip}${c.city ? ` (${c.city}, ${c.region})` : ''}`, rows: ordersForZip(c.zip) })
                      },
                    }
                    return (
                      <CircleMarker
                        key={c.zip}
                        center={[c.lat, c.lng]}
                        radius={style.radius}
                        pathOptions={{ color: style.color, fillColor: style.fill, fillOpacity: 0.55, weight: 1.5 }}
                        eventHandlers={eventHandlers}
                      >
                        <Tooltip>
                          <span className="font-mono text-xs">
                            {c.zip} {c.city && `— ${c.city}, ${c.region}`}<br />{c.count} order{c.count !== 1 ? 's' : ''}
                          </span>
                        </Tooltip>
                      </CircleMarker>
                    )
                  })}
                  {/* Selection ring — a circular indicator instead of the
                      browser's default square focus outline (suppressed
                      globally for Leaflet paths, see index.css). */}
                  {focusTarget && (
                    <CircleMarker
                      center={[focusTarget.lat, focusTarget.lng]}
                      radius={styleFor(focusTarget.count, densityBp, zoom).radius + 6}
                      pathOptions={{ color: '#002745', weight: 2, dashArray: '4 3', fillOpacity: 0 }}
                      interactive={false}
                    />
                  )}
                </MapContainer>
              </div>
              </div>
              )}

              {/* Legend — a continuous gradient by each zip's own order-count
                  percentile among the zips CURRENTLY on the map (not a
                  fixed threshold, and not grouped by shop/location) —
                  narrowing by shop, region, market, AM, or date range
                  recomputes every zip's percentile against that new,
                  smaller set. */}
              {!hideMap && (
              <div className="flex items-center gap-4 text-[10px] font-mono text-inky/70 flex-wrap">
                <span className="flex items-center gap-1.5" title="Color reflects each zip's order-count percentile among every zip currently on the map">
                  <span className="w-24 h-2.5 rounded-full inline-block" style={{ background: `linear-gradient(to right, ${GRADIENT_STOPS.map(([, c]) => c).join(', ')})` }} />
                  Fewer orders <span className="text-inky/40">→</span> More orders
                </span>
                <span className="flex items-center gap-1.5">
                  <svg width="11" height="15" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">
                    <path d="M11 0C4.9 0 0 4.9 0 11c0 8.25 11 19 11 19s11-10.75 11-19C22 4.9 17.1 0 11 0z" fill="#002745" />
                    <circle cx="11" cy="11" r="4.5" fill="#B7E0DE" />
                  </svg>
                  Store location (colored by market)
                </span>
                <span className="ml-auto text-inky/50" title="Recomputed against whatever's currently loaded — narrower filters mean fewer zips to rank against, so the same raw order count can land in a different bucket">
                  Percentile of THIS view's own zips, not a fixed order count — not grouped by shop
                </span>
              </div>
              )}

              {/* Visits by zip — click a row to see its orders; the Total
                  by Zip / By Shop toggle now switches this table's own
                  grouping too, not just the export. */}
              <Card>
                <CardBody className="flex flex-col gap-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="text-xs font-mono text-navy uppercase tracking-wide">
                      Visits by Zip ({zipExportMode === 'by-shop' ? visibleShopZipRows.length : visibleClusters.length})
                    </span>
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
                        {(['total', 'by-shop'] as const).map((m) => (
                          <button key={m} onClick={() => m === 'by-shop' && showRollupPreview ? setFullDetailRequested(true) : setZipExportMode(m)}
                            className={['px-2 py-1 uppercase tracking-wide transition-colors', zipExportMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                            title={m === 'total' ? 'One row per zip, totaled across shops' : showRollupPreview ? 'Needs full detail — the fast preview only has zip totals, not the per-shop split' : 'One row per shop + zip combination'}>
                            {m === 'total' ? 'Total by Zip' : 'By Shop'}
                          </button>
                        ))}
                      </div>
                      <Button size="sm" variant="secondary" loading={exporting === 'csv'}
                        onClick={() => showRollupPreview ? setFullDetailRequested(true) : exportVisits('csv')}
                        title={showRollupPreview ? 'Needs full detail — click to load it, then export' : undefined}>
                        {showRollupPreview ? 'Load Full Detail to Export' : 'Export CSV'}
                      </Button>
                      {!showRollupPreview && (
                        <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} onClick={() => exportVisits('xlsx')}>Export Excel</Button>
                      )}
                    </div>
                  </div>
                  <Input value={zipSearch} onChange={(e) => setZipSearch(e.target.value)} placeholder="Search zip, city, or region…" className="max-w-xs" />
                  <div className="overflow-x-auto rounded border border-navy/30 max-h-96 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead className="sticky top-0 bg-cream">
                        <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                          {zipExportMode === 'by-shop' && <th className="px-3 py-2 text-left">Shop</th>}
                          <th className="px-3 py-2 text-left">Zip</th>
                          <th className="px-3 py-2 text-left">City</th>
                          <th className="px-3 py-2 text-left">Region</th>
                          <th className="px-3 py-2 text-right">Orders</th>
                          {zipExportMode === 'total' && <th className="px-3 py-2 text-right">% of Total</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {zipExportMode === 'by-shop' ? visibleShopZipRows.map((r, i) => (
                          <tr key={`${r.shopNumber}|${r.zip}|${i}`}
                            ref={(el) => { if (el) zipRowRefs.current.set(r.zip, el) }}
                            className={[
                              'border-b border-navy/10 cursor-pointer hover:bg-sky/10',
                              r.zip === selectedZip ? 'bg-sky/20' : '',
                            ].join(' ')}
                            onClick={() => setOrderModal({ title: `Orders — ${r.shopLabel}, ${r.zip}${r.city ? ` (${r.city}, ${r.region})` : ''}`, rows: ordersForShopZip(r.locationId, r.zip) })}>
                            <td className="px-3 py-1.5 text-navy whitespace-nowrap">{r.shopLabel}</td>
                            <td className="px-3 py-1.5 text-navy">{r.zip}</td>
                            <td className="px-3 py-1.5 text-navy">{r.city || '—'}</td>
                            <td className="px-3 py-1.5 text-navy">{r.region || '—'}</td>
                            <td className="px-3 py-1.5 text-navy text-right">{r.count}</td>
                          </tr>
                        )) : visibleClusters.map((c) => (
                          <tr key={c.zip}
                            ref={(el) => { if (el) zipRowRefs.current.set(c.zip, el) }}
                            className={[
                              'border-b border-navy/10 cursor-pointer hover:bg-sky/10',
                              c.zip === selectedZip ? 'bg-sky/20' : '',
                            ].join(' ')}
                            onClick={() => setOrderModal({ title: `Orders — ${c.zip}${c.city ? ` (${c.city}, ${c.region})` : ''}`, rows: ordersForZip(c.zip) })}>
                            <td className="px-3 py-1.5 text-navy">{c.zip}</td>
                            <td className="px-3 py-1.5 text-navy">{normalizeCityCase(c.city) || '—'}</td>
                            <td className="px-3 py-1.5 text-navy">{c.region || '—'}</td>
                            <td className="px-3 py-1.5 text-navy text-right">{c.count}</td>
                            <td className="px-3 py-1.5 text-inky/70 text-right">{mappedRows.length ? ((c.count / mappedRows.length) * 100).toFixed(1) : '0.0'}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </>
          )}
        </>
          )}
        </>
      )}

      {orderModal && (
        <Modal open onClose={() => setOrderModal(null)} title={orderModal.title} size="2xl">
          {showRollupPreview ? (
            // Every zip/shop/Total-Orders/Not-On-Map click now always opens
            // this modal, even in rollup preview (which has no raw rows) —
            // this message is the reason, rather than silently opening on
            // an empty table or redirecting away without saying why.
            <div className="flex flex-col items-center gap-3 py-10">
              <p className="text-xs font-mono text-inky/70 text-center max-w-sm">
                Load full detail to see order list — this is a fast preview from cached zip-level totals; individual orders aren't loaded yet.
              </p>
              <Button size="sm" onClick={() => { setOrderModal(null); setFullDetailRequested(true) }}>
                Load Full Detail
              </Button>
            </div>
          ) : (
            <>
          <div className="flex justify-end gap-2 mb-2">
            <Button size="sm" variant="secondary" loading={orderModalExporting === 'csv'} onClick={() => exportOrderModal('csv')}>Export CSV</Button>
            <Button size="sm" variant="secondary" loading={orderModalExporting === 'xlsx'} onClick={() => exportOrderModal('xlsx')}>Export Excel</Button>
          </div>
          <div className="overflow-x-auto rounded border border-navy/30 max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0 bg-cream">
                <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Order #</th>
                  <th className="px-3 py-2 text-left">Shop</th>
                  <th className="px-3 py-2 text-left">Customer</th>
                  <th className="px-3 py-2 text-left">City</th>
                  <th className="px-3 py-2 text-left">Zip</th>
                  <th className="px-3 py-2 text-right">Total</th>
                  <th className="px-3 py-2 text-left">Finalized</th>
                  <th className="px-3 py-2 text-left">Package(s)</th>
                </tr>
              </thead>
              <tbody>
                {orderModal.rows.map((o) => {
                  const shopLoc = o.location_id ? loc.byId(o.location_id) : undefined
                  return (
                    <tr key={o.id} className="border-b border-navy/10">
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_id}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{shopLoc ? shopNumberCityLabel(shopLoc.name, shopLoc.shop_city) : (o.location_id ?? '—')}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{[o.first_name, o.last_name].filter(Boolean).join(' ') || '—'}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{normalizeCityCase(o.city ?? '') || '—'}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.zip || '—'}</td>
                      <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(o.final_price)}</td>
                      <td className="px-3 py-1.5 text-navy whitespace-nowrap">{dateShort(o.order_finalized_at)}</td>
                      <td className="px-3 py-1.5 text-navy">{orderModalPackages ? ((orderModalPackages.get(o.id) ?? []).join(', ') || '—') : '…'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
