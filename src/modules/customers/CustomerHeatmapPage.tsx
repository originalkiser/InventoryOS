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
import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDarkMode } from '@/hooks/useDarkMode'
import { useDateRangePeriod } from '@/hooks/useDateRangePeriod'
import { useEarliestOrderDate } from '@/hooks/useEarliestOrderDate'
import { PeriodPicker } from '@/components/shared/PeriodPicker'
import { Card, CardBody, MultiSelectDropdown, Modal, SbLoader } from '@/components/ui'

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

// Store-location pin — visually distinct (teardrop, not a circle) from the
// customer-density CircleMarkers so a shop's own marker doesn't get lost
// among or mistaken for a zip cluster right on top of it.
const shopPinIcon = L.divIcon({
  className: 'shop-pin-marker',
  html: '<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">'
    + '<path d="M11 0C4.9 0 0 4.9 0 11c0 8.25 11 19 11 19s11-10.75 11-19C22 4.9 17.1 0 11 0z" fill="#002745" stroke="#F2F1E6" stroke-width="1.5"/>'
    + '<circle cx="11" cy="11" r="4.5" fill="#B7E0DE"/>'
    + '</svg>',
  iconSize: [22, 30],
  iconAnchor: [11, 30], // tip points at the actual coordinate
  tooltipAnchor: [0, -26],
})

const money = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const dateShort = (v: string | null) => v ? new Date(v).toLocaleDateString() : '—'

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

  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const labelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const idToLabel = useMemo(() => new Map(loc.includedOptions.map((o) => [o.value, o.label])), [loc.includedOptions])
  const shopIds = useMemo(() => shopLabels.map((l) => labelToId.get(l)).filter((v): v is string => !!v), [shopLabels, labelToId])

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
      // Keyset pagination, not OFFSET — same fix already applied to
      // ProductUsageTab.tsx/useConfigTab.ts for the same reason. Loads
      // every order in range/shop scope, mapped or not — the "Not On Map"
      // card/modal needs the unmapped ones too, so there's no separate
      // count-only query anymore; everything comes from one load.
      const PAGE = 1000
      const all: OrderRow[] = []
      let cursor: string | null = null
      for (;;) {
        let q = sb.schema('inventory').from('droptop_orders')
          .select('id, location_id, order_id, first_name, last_name, city, region, zip, lat, lng, final_price, order_finalized_at')
          .eq('company_id', companyId)
          .gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
          .order('id', { ascending: true }).limit(PAGE)
        if (shopIds.length) q = q.in('location_id', shopIds)
        if (cursor) q = q.gt('id', cursor)
        const { data, error: err } = await q
        if (err) { if (!cancelled) setError(err.message); break }
        const batch = (data ?? []) as OrderRow[]
        all.push(...batch)
        if (batch.length < PAGE) break
        cursor = batch[batch.length - 1].id
      }
      if (cancelled) return
      setRows(all)
      setLoading(false)
    }
    run().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, shopIds.join(','), range.start, range.end]) // eslint-disable-line react-hooks/exhaustive-deps

  const mappedRows = useMemo(() => rows.filter((r) => r.lat != null && r.lng != null), [rows])
  const unmappedRows = useMemo(() => rows.filter((r) => r.lat == null || r.lng == null), [rows])

  const allClusters = useMemo<ZipCluster[]>(() => {
    const byZip = new Map<string, ZipCluster>()
    for (const r of mappedRows) {
      const key = r.zip || `${r.lat},${r.lng}`
      const existing = byZip.get(key)
      if (existing) { existing.count++; if (r.location_id) existing.locationIds.add(r.location_id) }
      else byZip.set(key, {
        zip: r.zip ?? '—', city: r.city ?? '', region: r.region ?? '', lat: r.lat as number, lng: r.lng as number,
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

  function ordersForZip(zip: string): OrderRow[] {
    return mappedRows.filter((r) => (r.zip ?? '—') === zip)
  }

  // Store pins — one per shop that actually has orders in this view (not
  // every shop company-wide, which would clutter the map with locations
  // unrelated to what's currently being looked at). core.locations'
  // latitude/longitude (the shop's own geocoded address, maintained on the
  // Map Routes tab) is what places these — a different coordinate source
  // than the zip-centroid lat/lng the customer clusters use.
  const shopPins = useMemo(() => {
    const ids = new Set<string>()
    for (const r of rows) if (r.location_id) ids.add(r.location_id)
    return [...ids]
      .map((id) => loc.byId(id))
      .filter((l): l is NonNullable<typeof l> => !!l && l.latitude != null && l.longitude != null)
    // depends on loc.locations (stable across renders), not the loc object
    // itself, which useLocations() recreates every render
  }, [rows, loc.locations]) // eslint-disable-line react-hooks/exhaustive-deps

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
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Shop(s)</span>
            <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels} placeholder="All Shops" countNoun="shops" searchable />
          </div>
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
          <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px] cursor-pointer hover:border-sky transition-colors"
              onClick={() => setOrderModal({ title: `Orders (${rows.length})`, rows })}>
              <CardBody className="py-3">
                <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Orders</p>
                <p className="text-lg font-heading font-bold text-navy">{rows.length.toLocaleString()}</p>
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
                    {clusters[0].zip} {clusters[0].city && `— ${clusters[0].city}`} <span className="text-inky/60">({clusters[0].count})</span>
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
              <div className="rounded border border-navy/30 overflow-hidden" style={{ height: 640 }}>
                <MapContainer center={mapCenter} zoom={5} style={{ height: '100%', width: '100%' }}>
                  <TileLayer url={tileUrl} attribution={tileAttribution} className={dark ? 'map-tiles-dark' : undefined} />
                  <FocusZip target={focusTarget} />
                  <ZoomTracker onZoom={setZoom} />
                  {shopPins.map((l) => (
                    <Marker key={l.id} position={[l.latitude as number, l.longitude as number]} icon={shopPinIcon}>
                      <Tooltip>
                        <span className="font-mono text-xs font-bold">{l.name} — {l.shop_city ?? ''}</span>
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
                        eventHandlers={{ click: () => setSelectedZip(c.zip) }}
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

              {/* Legend */}
              <div className="flex items-center gap-4 text-[10px] font-mono text-inky/70 flex-wrap">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#B7E0DE', border: '1.5px solid #4F7489' }} />Bottom half of zips</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#E67E22' }} />Above median</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#C0392B' }} />Top 20%</span>
                <span className="flex items-center gap-1.5">
                  <svg width="11" height="15" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">
                    <path d="M11 0C4.9 0 0 4.9 0 11c0 8.25 11 19 11 19s11-10.75 11-19C22 4.9 17.1 0 11 0z" fill="#002745" />
                    <circle cx="11" cy="11" r="4.5" fill="#B7E0DE" />
                  </svg>
                  Store location
                </span>
                <span className="ml-auto text-inky/50">Colored by percentile of this range's own zips, not a fixed scale</span>
              </div>

              {/* Visits by zip — click a row to see its orders. */}
              <Card>
                <CardBody className="flex flex-col gap-2">
                  <span className="text-xs font-mono text-navy uppercase tracking-wide">Visits by Zip ({clusters.length})</span>
                  <div className="overflow-x-auto rounded border border-navy/30 max-h-96 overflow-y-auto">
                    <table className="w-full text-xs font-mono">
                      <thead className="sticky top-0 bg-cream">
                        <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                          <th className="px-3 py-2 text-left">Zip</th>
                          <th className="px-3 py-2 text-left">City</th>
                          <th className="px-3 py-2 text-left">Region</th>
                          <th className="px-3 py-2 text-right">Orders</th>
                          <th className="px-3 py-2 text-right">% of Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {clusters.map((c) => (
                          <tr key={c.zip} className="border-b border-navy/10 cursor-pointer hover:bg-sky/10"
                            onClick={() => setOrderModal({ title: `Orders — ${c.zip}${c.city ? ` (${c.city}, ${c.region})` : ''}`, rows: ordersForZip(c.zip) })}>
                            <td className="px-3 py-1.5 text-navy">{c.zip}</td>
                            <td className="px-3 py-1.5 text-navy">{c.city || '—'}</td>
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

      {orderModal && (
        <Modal open onClose={() => setOrderModal(null)} title={orderModal.title} size="lg">
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
                </tr>
              </thead>
              <tbody>
                {orderModal.rows.map((o) => (
                  <tr key={o.id} className="border-b border-navy/10">
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.order_id}</td>
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.location_id ? (idToLabel.get(o.location_id) ?? o.location_id) : '—'}</td>
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{[o.first_name, o.last_name].filter(Boolean).join(' ') || '—'}</td>
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.city || '—'}</td>
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{o.zip || '—'}</td>
                    <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{money(o.final_price)}</td>
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{dateShort(o.order_finalized_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  )
}
