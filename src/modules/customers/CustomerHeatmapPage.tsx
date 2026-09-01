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
import { useEffect, useMemo, useRef, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, Tooltip, useMap, useMapEvents } from 'react-leaflet'
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
import { Button, Card, CardBody, Input, MultiSelectDropdown, Modal, SbLoader } from '@/components/ui'
import { getMarketSolidColor } from '@/lib/marketColors'

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
  final_price: number | null
  order_finalized_at: string | null
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

// Radius/color scale — same brand palette used everywhere else. Real
// customer geography is heavily skewed (a shop's own zip and its
// neighbors dominate, then a long tail of 1-2-order zips), so:
//   1. Radius scales by sqrt(count/max), not linearly — circle AREA
//      should be proportional to the value for a graduated-symbol map to
//      read correctly at a glance.
//   2. Color buckets are the median/80th-percentile of the actual loaded
//      cluster counts, not fixed fractions of max — robust to skew.
interface DensityBreakpoints { median: number; p80: number; max: number }

function densityBreakpoints(counts: number[]): DensityBreakpoints {
  if (!counts.length) return { median: 0, p80: 0, max: 0 }
  const sorted = [...counts].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { median: at(0.5), p80: at(0.8), max: sorted[sorted.length - 1] }
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
  if (count > bp.p80) return { radius, color: '#C0392B', fill: '#C0392B' } // top ~20% of zips
  if (count > bp.median) return { radius, color: '#E67E22', fill: '#E67E22' } // above the middle
  return { radius, color: '#4F7489', fill: '#B7E0DE' } // bottom half
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

// City names sometimes come through from Droptop as all-caps or all-lower
// ("PORT ARTHUR", "port arthur") — normalize those to title case for
// exports. Leaves anything already mixed-case alone (e.g. "McAllen") rather
// than guessing at capitalization rules for names this can't reliably get
// right.
function normalizeCityCase(city: string): string {
  if (!city) return city
  const isAllUpper = city === city.toUpperCase()
  const isAllLower = city === city.toLowerCase()
  if (!isAllUpper && !isAllLower) return city
  return city.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

// "#-City" label — some locations' shop_city already comes prefixed with
// the shop number itself ("169-Lexington" as the raw value, not just
// "Lexington"), so naively concatenating name + shop_city doubles it up
// ("169 — 169-Lexington"). Strips a redundant leading "<name>-" before
// rebuilding, so this is correct either way the data's shaped.
function shopNumberCityLabel(name: string, shopCity: string | null | undefined): string {
  const rawCity = normalizeCityCase(shopCity ?? '')
  const cleaned = rawCity.replace(new RegExp(`^${name}[\\s-]+`, 'i'), '')
  return cleaned ? `${name}-${cleaned}` : name
}

// Imperatively pans/zooms the map when the selected zip changes — a plain
// state change on <MapContainer center> only sets the *initial* view, not
// a live one, so this needs react-leaflet's useMap() the same way
// MapRoutesTab.tsx already does for its own pan/fit calls.
function FocusZip({ target }: { target: ZipCluster | null }) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 9), { duration: 0.6 })
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

export function CustomerHeatmapPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { dark } = useDarkMode()
  const earliestDate = useEarliestOrderDate(companyId)
  const { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range } = useDateRangePeriod('heatmap:period', 'last_week')

  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [matchMode, setMatchMode] = useState<'all' | 'shared'>('all')
  const [rows, setRows] = useState<OrderRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedZip, setSelectedZip] = useState<string | null>(null)
  const [orderModal, setOrderModal] = useState<{ title: string; rows: OrderRow[] } | null>(null)
  const [zoom, setZoom] = useState(5)
  const [zipExportMode, setZipExportMode] = useState<'total' | 'by-shop'>('total')
  const [exporting, setExporting] = useState<'csv' | 'xlsx' | null>(null)

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
  const [filterRegions, setFilterRegions] = useState<string[]>([])
  const [filterMarkets, setFilterMarkets] = useState<string[]>([])
  const [filterAMs, setFilterAMs] = useState<string[]>([])
  const [zipSearch, setZipSearch] = useState('')
  const [orderModalPackages, setOrderModalPackages] = useState<Map<string, string[]> | null>(null)
  const [orderModalExporting, setOrderModalExporting] = useState<'csv' | 'xlsx' | null>(null)
  const zipRowRefs = useRef(new Map<string, HTMLTableRowElement>())

  // Dynamic based on Region/Market/AM — narrows which shops even show up
  // as pickable once one of those is set, rather than a full always-the-
  // same list. Doesn't prune an already-selected shop that a later filter
  // change makes invalid (it stays effectively selected, just hidden from
  // the visible checklist) — matches this page's existing "good enough,
  // not full cascade-pruning" precedent for the Region/Market/AM filters.
  const shopOptions = useMemo(() => {
    if (!filterRegions.length && !filterMarkets.length && !filterAMs.length) {
      return loc.includedOptions.map((o) => ({ value: o.label }))
    }
    return loc.includedOptions.filter((o) => {
      const l = loc.byId(o.value)
      if (!l) return false
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) return false
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) return false
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) return false
      return true
    }).map((o) => ({ value: o.label }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.includedOptions, filterRegions, filterMarkets, filterAMs])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

  // Company-wide market list (not just the currently-visible shops) so a
  // market's color-by-index stays the same regardless of what's filtered —
  // matching Map & Routes' own allMarkets, which is what makes the colors
  // consistent between the two pages.
  const allMarkets = useMemo(() => {
    const s = new Set(loc.locations.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))
    return [...s].sort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations])

  const regionOptions = useMemo(
    () => [...new Set(loc.locations.map((l) => l.region ?? '').filter(Boolean))].sort().map((v) => ({ value: v })),
    [loc.locations],
  )
  const marketOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'market')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions])
  const amOptions = useMemo(() => {
    let r = loc.locations
    if (filterRegions.length) r = r.filter((l) => filterRegions.includes(l.region ?? ''))
    if (filterMarkets.length) r = r.filter((l) => filterMarkets.includes(loc.fieldValue(l.id, 'market')))
    return [...new Set(r.map((l) => loc.fieldValue(l.id, 'area_manager')).filter(Boolean))].sort().map((v) => ({ value: v }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    setSelectedZip(null)
    const sb = supabase as any
    const startIso = `${range.start}T00:00:00.000Z`
    const endIso = `${range.end}T23:59:59.999Z`

    async function run() {
      // Keyset pagination by (order_finalized_at, id), not plain id — a
      // cursor ordered by id while filtering on order_finalized_at can't use
      // an index to seek to the matching date range (see
      // 20260907_droptop_orders_date_index.sql), which is what made a narrow
      // custom range time out even though a wide one loaded fine. Loads
      // every order in range/shop scope, mapped or not — the "Not On Map"
      // card/modal needs the unmapped ones too, so there's no separate
      // count-only query anymore; everything comes from one load.
      const PAGE = 1000
      const all: OrderRow[] = []
      let cursor: { date: string; id: string } | null = null
      for (;;) {
        let q = sb.schema('inventory').from('droptop_orders')
          .select('id, location_id, order_id, first_name, last_name, city, region, zip, lat, lng, final_price, order_finalized_at')
          .eq('company_id', companyId)
          .gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
          .order('order_finalized_at', { ascending: true })
          .order('id', { ascending: true }).limit(PAGE)
        if (shopIds.length) q = q.in('location_id', shopIds)
        if (cursor) q = q.or(`order_finalized_at.gt.${cursor.date},and(order_finalized_at.eq.${cursor.date},id.gt.${cursor.id})`)
        const { data, error: err } = await q
        if (err) { if (!cancelled) setError(err.message); break }
        const batch = (data ?? []) as OrderRow[]
        all.push(...batch)
        if (batch.length < PAGE) break
        const last = batch[batch.length - 1]
        cursor = { date: last.order_finalized_at ?? startIso, id: last.id }
      }
      if (cancelled) return
      setRows(all)
      setLoading(false)
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, shopIds.join(','), range.start, range.end]) // eslint-disable-line react-hooks/exhaustive-deps

  // Region/Market/AM pin filters now also scope the heatmap itself (zip
  // clusters, stats cards, Visits by Zip), not just which pins draw — an
  // order counts toward the heatmap only if its shop matches the active
  // filters. null = no restriction (every loaded order counts), matching
  // how shopPins itself used to filter before this was unified.
  const allowedLocationIds = useMemo(() => {
    if (!filterRegions.length && !filterMarkets.length && !filterAMs.length) return null
    const ids = new Set<string>()
    for (const l of loc.locations) {
      if (filterRegions.length && !filterRegions.includes(l.region ?? '')) continue
      if (filterMarkets.length && !filterMarkets.includes(loc.fieldValue(l.id, 'market'))) continue
      if (filterAMs.length && !filterAMs.includes(loc.fieldValue(l.id, 'area_manager'))) continue
      ids.add(l.id)
    }
    return ids
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.locations, filterRegions, filterMarkets, filterAMs])

  const filteredRows = useMemo(
    () => allowedLocationIds === null ? rows : rows.filter((r) => r.location_id && allowedLocationIds.has(r.location_id)),
    [rows, allowedLocationIds],
  )

  const mappedRows = useMemo(() => filteredRows.filter((r) => r.lat != null && r.lng != null), [filteredRows])
  const unmappedRows = useMemo(() => filteredRows.filter((r) => r.lat == null || r.lng == null), [filteredRows])

  const allClusters = useMemo<ZipCluster[]>(() => {
    const byZip = new Map<string, ZipCluster>()
    for (const r of mappedRows) {
      const key = r.zip || `${r.lat},${r.lng}`
      const existing = byZip.get(key)
      if (existing) { existing.count++; if (r.location_id) existing.locationIds.add(r.location_id) }
      else byZip.set(key, {
        zip: r.zip ?? '—', city: normalizeCityCase(r.city ?? ''), region: r.region ?? '', lat: r.lat as number, lng: r.lng as number,
        count: 1, locationIds: new Set(r.location_id ? [r.location_id] : []),
      })
    }
    return [...byZip.values()]
  }, [mappedRows])

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
    const CHUNK = 200
    const byOrder = new Map<string, string[]>()
    for (let i = 0; i < orderIds.length; i += CHUNK) {
      const slice = orderIds.slice(i, i + CHUNK)
      const { data, error } = await sb.schema('inventory').from('droptop_order_packages').select('order_id, name').in('order_id', slice)
      if (error) throw new Error(error.message)
      for (const p of (data ?? []) as { order_id: string; name: string | null }[]) {
        if (!p.name) continue
        const arr = byOrder.get(p.order_id) ?? []
        arr.push(p.name)
        byOrder.set(p.order_id, arr)
      }
    }
    return byOrder
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
        const shopCity = normalizeCityCase(shopLoc?.shop_city ?? '')
        const shopLabel = zipExportMode === 'by-shop' ? (shopCity ? `${shopNumber}-${shopCity}` : shopNumber) : ''
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

      const fileBase = `customer-heatmap-visits-${zipExportMode}-${range.start}-to-${range.end}`
      if (format === 'csv') {
        const esc = (s: unknown) => { const t = String(s ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
        const csv = [headers, ...dataRows].map((r) => r.map(esc).join(',')).join('\n')
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
      } else {
        const wb = XLSX.utils.book_new()
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows])
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
    for (const r of filteredRows) if (r.location_id) ids.add(r.location_id)
    return [...ids]
      .map((id) => loc.byId(id))
      .filter((l): l is NonNullable<typeof l> => !!l && l.latitude != null && l.longitude != null)
      .map((l) => ({ loc: l, color: getMarketSolidColor(loc.fieldValue(l.id, 'market'), allMarkets) }))
    // depends on loc.locations (stable across renders), not the loc object
    // itself, which useLocations() recreates every render
  }, [filteredRows, loc.locations, allMarkets]) // eslint-disable-line react-hooks/exhaustive-deps

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

      {loading ? (
        <div className="py-16"><SbLoader /></div>
      ) : rows.length === 0 ? (
        <Card><CardBody>
          <p className="text-xs font-mono text-inky/60">
            No orders for this range{shopIds.length ? ' at these shop(s)' : ''} yet. Run the Droptop — Orders sync
            from Config → Data Connections, then come back here.
          </p>
        </CardBody></Card>
      ) : (
        <>
          {/* Region/Market/AM/Labels — now scope the heatmap itself, not
              just the pins, so kept visible whenever there's raw data to
              filter (even if the current combination zeroes out the
              result) rather than nested inside the "has clusters" branch,
              which would otherwise strand the user with no way to widen
              a filter that produced zero matches. */}
          <div className="flex items-end gap-2 flex-wrap">
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
            <button onClick={() => setShowPins((v) => !v)}
              className={['px-2 py-1.5 rounded border text-[10px] font-mono uppercase tracking-wide transition-colors',
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
          </div>

          {filteredRows.length === 0 ? (
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
                <p className="text-lg font-heading font-bold text-navy">{filteredRows.length.toLocaleString()}</p>
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
            {unmappedRows.length > 0 && (
              <Card className="flex-1 min-w-[140px] cursor-pointer hover:border-sky transition-colors"
                onClick={() => setOrderModal({ title: `Not On Map (${unmappedRows.length})`, rows: unmappedRows })}>
                <CardBody className="py-3">
                  <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Not On Map</p>
                  <p className="text-lg font-heading font-bold text-[#E67E22]">{unmappedRows.length.toLocaleString()}</p>
                  <p className="text-[10px] font-mono text-inky/50">no zip match — click to see which</p>
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
              <div className="isolate rounded border border-navy/30 overflow-hidden" style={{ height: 640 }}>
                <MapContainer center={mapCenter} zoom={5} style={{ height: '100%', width: '100%' }}>
                  <TileLayer url={tileUrl} attribution={tileAttribution} className={dark ? 'map-tiles-dark' : undefined} />
                  <FocusZip target={focusTarget} />
                  <ZoomTracker onZoom={setZoom} />
                  <DeselectOnMapClick onDeselect={() => setSelectedZip(null)} />
                  {showPins && shopPins.map(({ loc: l, color }) => (
                    <Marker key={l.id} position={[l.latitude as number, l.longitude as number]}
                      icon={makeShopPinIcon(color, showPinLabels ? l.name : null)}>
                      <Tooltip>
                        <span className="font-mono text-xs font-bold">{shopNumberCityLabel(l.name, l.shop_city)}</span>
                      </Tooltip>
                    </Marker>
                  ))}
                  {clusters.map((c) => {
                    const style = styleFor(c.count, densityBp, zoom)
                    return (
                      <CircleMarker
                        key={c.zip}
                        center={[c.lat, c.lng]}
                        radius={style.radius}
                        pathOptions={{ color: style.color, fillColor: style.fill, fillOpacity: 0.55, weight: 1.5 }}
                        eventHandlers={{
                          // stopPropagation so this doesn't also trigger
                          // DeselectOnMapClick's background-click handler —
                          // clicking the already-selected circle again toggles
                          // it off (a second way to "click out" besides
                          // clicking elsewhere on the map).
                          click: (e) => { L.DomEvent.stopPropagation(e); setSelectedZip((prev) => (prev === c.zip ? null : c.zip)) },
                          dblclick: (e) => {
                            L.DomEvent.stopPropagation(e)
                            setOrderModal({ title: `Orders — ${c.zip}${c.city ? ` (${c.city}, ${c.region})` : ''}`, rows: ordersForZip(c.zip) })
                          },
                        }}
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

              {/* Legend — color is each zip's own order-count percentile
                  among the zips CURRENTLY on the map (not a fixed
                  threshold, and not grouped by shop/location) — narrowing
                  by shop, region, market, AM, or date range recomputes
                  every zip's percentile against that new, smaller set. */}
              <div className="flex items-center gap-4 text-[10px] font-mono text-inky/70 flex-wrap">
                <span className="flex items-center gap-1.5" title="This zip's order count is in the bottom half of every zip currently on the map">
                  <span className="w-3 h-3 rounded-full inline-block" style={{ background: '#B7E0DE', border: '1.5px solid #4F7489' }} />Bottom half of zips</span>
                <span className="flex items-center gap-1.5" title="This zip's order count is above the median of every zip currently on the map">
                  <span className="w-3 h-3 rounded-full inline-block" style={{ background: '#E67E22' }} />Above median</span>
                <span className="flex items-center gap-1.5" title="This zip's order count is in the top 20% of every zip currently on the map">
                  <span className="w-3 h-3 rounded-full inline-block" style={{ background: '#C0392B' }} />Top 20% of zips</span>
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
                          <button key={m} onClick={() => setZipExportMode(m)}
                            className={['px-2 py-1 uppercase tracking-wide transition-colors', zipExportMode === m ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}
                            title={m === 'total' ? 'One row per zip, totaled across shops' : 'One row per shop + zip combination'}>
                            {m === 'total' ? 'Total by Zip' : 'By Shop'}
                          </button>
                        ))}
                      </div>
                      <Button size="sm" variant="secondary" loading={exporting === 'csv'} onClick={() => exportVisits('csv')}>Export CSV</Button>
                      <Button size="sm" variant="secondary" loading={exporting === 'xlsx'} onClick={() => exportVisits('xlsx')}>Export Excel</Button>
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
