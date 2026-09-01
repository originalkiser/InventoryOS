// Customer Heatmap — where customers placing orders are physically coming
// from, by zip-code cluster, over a date range. Reads inventory.droptop_orders
// (populated by the droptop-sync-orders Edge Function — see Config -> Data
// Connections' "Droptop — Orders (Customers)" row) joined at sync time
// against inventory.zip_centroids for lat/lng, since Droptop's order/
// customer records carry an address but no coordinates.
//
// Deliberately orders-based, not a full customer-list pull (an earlier
// version of this page read inventory.droptop_customers, which pulled a
// shop's ENTIRE customer history regardless of recency — 10,000+ per
// location in practice). Orders are naturally date-bounded, so this stays
// fast and light: filtering already-synced data by date range is free, and
// pulling a range that hasn't been synced yet is one explicit action away.
//
// Resolution is zip-centroid, not rooftop-exact — a density view of which
// areas customers cluster in, not a pin-per-order map.
import { useEffect, useMemo, useState } from 'react'
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useDarkMode } from '@/hooks/useDarkMode'
import { Card, CardBody, Combobox, Button, SbLoader } from '@/components/ui'
import { useSyncTasksStore, DROPTOP_ORDERS_TASK_ID } from '@/stores/syncTasksStore'
import { runDroptopOrderSync } from '@/services/droptopService'
import toast from 'react-hot-toast'

interface OrderRow {
  id: string
  location_id: string | null
  city: string | null
  region: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  order_finalized_at: string | null
}

interface ZipCluster {
  zip: string
  city: string
  region: string
  lat: number
  lng: number
  count: number
}

// Radius/color scale — same brand palette used everywhere else. Two fixes
// over an earlier version that looked "off": real customer geography is
// heavily skewed (a shop's own zip and its immediate neighbors dominate,
// then a long tail of 1-2-order zips), which broke a scale based on a
// fixed fraction of the single max value — almost everything landed in
// the same "low" bucket since almost nothing gets within 33-66% of
// whichever zip happens to be the single biggest.
//   1. Radius scales by sqrt(count/max), not count/max linearly — circle
//      AREA (not radius) should be proportional to the value for a
//      graduated-symbol map to read correctly at a glance; linear radius
//      scaling makes low counts look proportionally far smaller than they
//      really are relative to the top one.
//   2. Color buckets are median/80th-percentile of the actual cluster
//      counts, not fixed fractions of max — robust to a skewed
//      distribution instead of collapsing everything below the top
//      handful of zips into one color.
interface DensityBreakpoints { median: number; p80: number; max: number }

function densityBreakpoints(counts: number[]): DensityBreakpoints {
  if (!counts.length) return { median: 0, p80: 0, max: 0 }
  const sorted = [...counts].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
  return { median: at(0.5), p80: at(0.8), max: sorted[sorted.length - 1] }
}

function styleFor(count: number, bp: DensityBreakpoints): { radius: number; color: string; fill: string } {
  const t = bp.max > 0 ? count / bp.max : 0
  const radius = 4 + Math.sqrt(t) * 22
  if (count > bp.p80) return { radius, color: '#C0392B', fill: '#C0392B' } // top ~20% of zips
  if (count > bp.median) return { radius, color: '#E67E22', fill: '#E67E22' } // above the middle
  return { radius, color: '#4F7489', fill: '#B7E0DE' } // bottom half
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10)
const today = () => new Date()
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d }

export function CustomerHeatmapPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { dark } = useDarkMode()

  const [shopId, setShopId] = useState('')
  const [startDate, setStartDate] = useState(() => isoDate(daysAgo(30)))
  const [endDate, setEndDate] = useState(() => isoDate(today()))
  const [rows, setRows] = useState<OrderRow[]>([])
  const [totalOrders, setTotalOrders] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  // Bumped after a successful "Pull This Range" to force the display query
  // to re-run for the same start/end/shop — those state values don't
  // themselves change on a pull, so they wouldn't otherwise re-trigger it.
  const [reloadTick, setReloadTick] = useState(0)

  const load = useMemo(() => {
    let cancelled = false
    return { cancel: () => { cancelled = true }, isCancelled: () => cancelled }
  }, [companyId, shopId, startDate, endDate, reloadTick])

  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    setError(null)
    const sb = supabase as any
    const startIso = `${startDate}T00:00:00.000Z`
    const endIso = `${endDate}T23:59:59.999Z`

    async function run() {
      // Keyset pagination, not OFFSET — same fix already applied to
      // ProductUsageTab.tsx/useConfigTab.ts for the same reason: an
      // un-ranged/OFFSET-based select degrades badly once a table gets
      // large, and there's no reason to reintroduce that here.
      const PAGE = 1000
      const all: OrderRow[] = []
      let cursor: string | null = null
      for (;;) {
        let q = sb.schema('inventory').from('droptop_orders')
          .select('id, location_id, city, region, zip, lat, lng, order_finalized_at')
          .eq('company_id', companyId)
          .gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
          .not('lat', 'is', null)
          .order('id', { ascending: true }).limit(PAGE)
        if (shopId) q = q.eq('location_id', shopId)
        if (cursor) q = q.gt('id', cursor)
        const { data, error: err } = await q
        if (err) { if (!load.isCancelled()) setError(err.message); break }
        const batch = (data ?? []) as OrderRow[]
        all.push(...batch)
        if (batch.length < PAGE) break
        cursor = batch[batch.length - 1].id
      }
      if (load.isCancelled()) return

      // Separate count of everything in range (including no-coordinate
      // rows) for the "not on map" callout.
      let countQuery = sb.schema('inventory').from('droptop_orders')
        .select('id', { count: 'exact', head: true }).eq('company_id', companyId)
        .gte('order_finalized_at', startIso).lte('order_finalized_at', endIso)
      if (shopId) countQuery = countQuery.eq('location_id', shopId)
      const { count } = await countQuery
      if (load.isCancelled()) return

      setRows(all)
      setTotalOrders(count ?? all.length)
      setLoading(false)
    }
    run().catch((e) => { if (!load.isCancelled()) { setError(e instanceof Error ? e.message : 'Failed to load orders'); setLoading(false) } })
    return () => load.cancel()
  }, [companyId, shopId, startDate, endDate, reloadTick, load])

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

  const densityBp = useMemo(() => densityBreakpoints(clusters.map((c) => c.count)), [clusters])
  const mappedCount = rows.length
  const notMapped = Math.max(0, totalOrders - mappedCount)

  const mapCenter = useMemo((): [number, number] => {
    if (clusters.length > 0) return [clusters[0].lat, clusters[0].lng]
    return [39.5, -98.35] // continental US fallback
  }, [clusters.length > 0 ? clusters[0].zip : null]) // eslint-disable-line react-hooks/exhaustive-deps

  const shopOptions = useMemo(
    () => [{ value: '', label: 'All Shops' }, ...loc.includedOptions],
    [loc.includedOptions],
  )

  // Pulls fresh order data for exactly the currently-selected range/shop —
  // separate from Data Connections' routine "last 30 days" sync, for
  // exploring a custom range that hasn't been synced yet.
  async function pullThisRange() {
    if (!companyId) return
    setPulling(true)
    const store = useSyncTasksStore.getState()
    const shopLabel = shopId ? (shopOptions.find((o) => o.value === shopId)?.label ?? 'shop') : 'all shops'
    store.start(DROPTOP_ORDERS_TASK_ID, `Droptop Orders — ${startDate} to ${endDate} (${shopLabel})`)
    const onProgress = (p: { batch: number; totalBatches: number }) => store.setProgress(DROPTOP_ORDERS_TASK_ID, p.batch, p.totalBatches)
    const startUnix = Math.floor(new Date(`${startDate}T00:00:00.000Z`).getTime() / 1000)
    const endUnix = Math.floor(new Date(`${endDate}T23:59:59.999Z`).getTime() / 1000)
    try {
      const r = await runDroptopOrderSync(companyId, { startUnix, endUnix, ...(shopId ? { locationId: shopId } : {}) }, onProgress)
      const summary = `Pulled ${r.orders_upserted} orders (${r.locations_synced} shop${r.locations_synced === 1 ? '' : 's'})`
      store.finish(DROPTOP_ORDERS_TASK_ID, r.warnings?.length ? 'partial' : 'success', summary)
      toast.success(summary)
      setReloadTick((t) => t + 1) // re-trigger the display query for the same range/shop
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull failed'
      store.finish(DROPTOP_ORDERS_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    } finally {
      setPulling(false)
    }
  }

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
            Where orders in this date range came from, by zip-code cluster. Populated by Config → Data Connections'
            Droptop — Orders sync.
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Start</span>
            <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)}
              className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">End</span>
            <input type="date" value={endDate} min={startDate} max={isoDate(today())} onChange={(e) => setEndDate(e.target.value)}
              className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky" />
          </label>
          <div className="w-56">
            <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="All Shops" />
          </div>
          <Button size="sm" variant="secondary" loading={pulling} onClick={pullThisRange}
            title="Pull fresh order data from Droptop for exactly this range/shop — separate from the routine last-30-days sync">
            Pull This Range
          </Button>
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
            No mapped orders for this range{shopId ? ' at this shop' : ''} yet. Run the Droptop — Orders sync from
            Config → Data Connections (or click "Pull This Range" above), then come back here.
          </p>
        </CardBody></Card>
      ) : (
        <>
          <div className="flex gap-3 flex-wrap">
            <Card className="flex-1 min-w-[140px]"><CardBody className="py-3">
              <p className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Total Orders</p>
              <p className="text-lg font-heading font-bold text-navy">{totalOrders.toLocaleString()}</p>
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
                const style = styleFor(c.count, densityBp)
                return (
                  <CircleMarker
                    key={c.zip}
                    center={[c.lat, c.lng]}
                    radius={style.radius}
                    pathOptions={{ color: style.color, fillColor: style.fill, fillOpacity: 0.55, weight: 1.5 }}
                  >
                    <Tooltip>
                      <span className="font-mono text-xs">
                        {c.zip} {c.city && `— ${c.city}, ${c.region}`}<br />{c.count} order{c.count !== 1 ? 's' : ''}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </MapContainer>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-[10px] font-mono text-inky/70">
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#B7E0DE', border: '1.5px solid #4F7489' }} />Bottom half of zips</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#E67E22' }} />Above median</span>
            <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full inline-block" style={{ background: '#C0392B' }} />Top 20%</span>
            <span className="ml-auto text-inky/50">Colored by percentile of this range's own zips, not a fixed scale</span>
          </div>

          {/* Visits by zip — the same clusters as the map, as a plain
              sortable-by-eye table for anyone who wants the numbers
              directly rather than reading them off circle size/color. */}
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
                      <tr key={c.zip} className="border-b border-navy/10">
                        <td className="px-3 py-1.5 text-navy">{c.zip}</td>
                        <td className="px-3 py-1.5 text-navy">{c.city || '—'}</td>
                        <td className="px-3 py-1.5 text-navy">{c.region || '—'}</td>
                        <td className="px-3 py-1.5 text-navy text-right">{c.count}</td>
                        <td className="px-3 py-1.5 text-inky/70 text-right">{mappedCount ? ((c.count / mappedCount) * 100).toFixed(1) : '0.0'}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </>
      )}
    </div>
  )
}
