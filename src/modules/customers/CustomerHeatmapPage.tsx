// Customer Heatmap — where Droptop customers are physically coming from,
// by zip-code cluster. Reads inventory.droptop_customers (populated by the
// droptop-sync-customers Edge Function — see Config -> Data Connections)
// joined at sync time against inventory.zip_centroids for lat/lng, since
// Droptop's customer records carry an address but no coordinates.
//
// Resolution is zip-centroid, not rooftop-exact — a density view of which
// areas customers cluster in, not a pin-per-customer map. A customer whose
// zip isn't in zip_centroids yet has no lat/lng and is excluded here (see
// the "not on the map" count below) rather than mis-plotted.
import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDarkMode } from '@/hooks/useDarkMode'
import { Card, CardBody, Combobox, SbLoader } from '@/components/ui'

interface CustomerRow {
  id: string
  location_id: string | null
  city: string | null
  region: string | null
  zip: string | null
  lat: number | null
  lng: number | null
}

interface ZipCluster {
  zip: string
  city: string
  region: string
  lat: number
  lng: number
  count: number
}

// Radius/color scale — same brand palette used everywhere else, just
// stepped by density so a handful of customers reads very differently
// from a couple hundred at a glance.
function styleFor(count: number, max: number): { radius: number; color: string; fill: string } {
  const t = max > 0 ? count / max : 0
  const radius = 5 + t * 25
  if (t > 0.66) return { radius, color: '#C0392B', fill: '#C0392B' }
  if (t > 0.33) return { radius, color: '#E67E22', fill: '#E67E22' }
  return { radius, color: '#4F7489', fill: '#B7E0DE' }
}

export function CustomerHeatmapPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { dark } = useDarkMode()

  const [shopId, setShopId] = useState('')
  const [rows, setRows] = useState<CustomerRow[]>([])
  const [totalCustomers, setTotalCustomers] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const sb = supabase as any

    async function load() {
      // Keyset pagination, not OFFSET — see ProductUsageTab.tsx's own fix
      // for why an un-ranged/OFFSET-based select degrades badly once a
      // company's customer table gets into the tens of thousands of rows.
      const PAGE = 1000
      const all: CustomerRow[] = []
      let cursor: string | null = null
      for (;;) {
        let q = sb.schema('inventory').from('droptop_customers')
          .select('id, location_id, city, region, zip, lat, lng')
          .eq('company_id', companyId)
          .not('lat', 'is', null)
          .order('id', { ascending: true }).limit(PAGE)
        if (shopId) q = q.eq('location_id', shopId)
        if (cursor) q = q.gt('id', cursor)
        const { data, error: err } = await q
        if (err) { if (!cancelled) setError(err.message); break }
        const batch = (data ?? []) as CustomerRow[]
        all.push(...batch)
        if (batch.length < PAGE) break
        cursor = batch[batch.length - 1].id
      }
      if (cancelled) return

      // Separate count of everything (including no-coordinate rows) for the
      // "N not shown on the map" callout — cheap head-count query.
      let countQuery = sb.schema('inventory').from('droptop_customers')
        .select('id', { count: 'exact', head: true }).eq('company_id', companyId)
      if (shopId) countQuery = countQuery.eq('location_id', shopId)
      const { count } = await countQuery
      if (cancelled) return

      setRows(all)
      setTotalCustomers(count ?? all.length)
      setLoading(false)
    }
    load().catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Failed to load customers'); setLoading(false) } })
    return () => { cancelled = true }
  }, [companyId, shopId])

  const clusters = useMemo<ZipCluster[]>(() => {
    const byZip = new Map<string, ZipCluster>()
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue
      const key = r.zip || `${r.lat},${r.lng}`
      const existing = byZip.get(key)
      if (existing) existing.count++
      else byZip.set(key, { zip: r.zip ?? '—', city: r.city ?? '', region: r.region ?? '', lat: r.lat, lng: r.lng, count: 1 })
    }
    return [...byZip.values()].sort((a, b) => b.count - a.count)
  }, [rows])

  const maxCount = clusters.length ? clusters[0].count : 0
  const mappedCount = rows.length
  const notMapped = Math.max(0, totalCustomers - mappedCount)

  const mapCenter = useMemo((): [number, number] => {
    if (clusters.length > 0) return [clusters[0].lat, clusters[0].lng]
    return [39.5, -98.35] // continental US fallback
  }, [clusters.length > 0 ? clusters[0].zip : null]) // eslint-disable-line react-hooks/exhaustive-deps

  const shopOptions = useMemo(
    () => [{ value: '', label: 'All Shops' }, ...loc.includedOptions],
    [loc.includedOptions],
  )

  const tileUrl = dark
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
  const tileAttribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Customer Heatmap</h1>
          <p className="text-xs text-inky mt-0.5">
            Where Droptop customers are coming from, by zip-code cluster. Populated by Config → Data Connections'
            Droptop — Customers sync.
          </p>
        </div>
        <div className="w-64">
          <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="All Shops" />
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
            No mapped customers yet{shopId ? ' for this shop' : ''}. Run the Droptop — Customers sync from Config →
            Data Connections, then come back here.
          </p>
        </CardBody></Card>
      ) : (
        <>
          <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Customers</p>
              <p className="text-lg font-heading font-bold text-navy">{totalCustomers.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Zip Clusters</p>
              <p className="text-lg font-heading font-bold text-navy">{clusters.length.toLocaleString()}</p>
            </CardBody></Card>
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Top Zip</p>
              <p className="text-sm font-mono font-bold text-navy">
                {clusters[0]?.zip} {clusters[0]?.city && `— ${clusters[0].city}`} <span className="text-inky/60">({clusters[0]?.count})</span>
              </p>
            </CardBody></Card>
            {notMapped > 0 && (
              <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
                <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Not On Map</p>
                <p className="text-lg font-heading font-bold text-[#E67E22]">{notMapped.toLocaleString()}</p>
                <p className="text-[10px] font-mono text-inky/50">no zip match in zip_centroids yet</p>
              </CardBody></Card>
            )}
          </div>

          <div className="rounded border border-navy/30 overflow-hidden" style={{ height: 640 }}>
            <MapContainer center={mapCenter} zoom={5} style={{ height: '100%', width: '100%' }}>
              <TileLayer url={tileUrl} attribution={tileAttribution} />
              {clusters.map((c) => {
                const style = styleFor(c.count, maxCount)
                return (
                  <CircleMarker
                    key={c.zip}
                    center={[c.lat, c.lng]}
                    radius={style.radius}
                    pathOptions={{ color: style.color, fillColor: style.fill, fillOpacity: 0.55, weight: 1.5 }}
                  >
                    <Tooltip>
                      <span className="font-mono text-xs">
                        {c.zip} {c.city && `— ${c.city}, ${c.region}`}<br />{c.count} customer{c.count !== 1 ? 's' : ''}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </MapContainer>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-[10px] font-mono text-inky/70">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#B7E0DE', border: '1.5px solid #4F7489' }} />Low density</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#E67E22' }} />Medium</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#C0392B' }} />High</span>
            <span className="ml-auto text-inky/50">Circle size + color both scale with customer count per zip</span>
          </div>
        </>
      )}
    </div>
  )
}
