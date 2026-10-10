// Data layer for the Droptop Orders page's summary: the four rollup RPCs in the `inventory` schema (get_sales_by_day / get_package_mix /
// get_product_mix / get_vehicle_makes). They read the daily rollup tables (refreshed 8am and 9am ET), so the numbers are as of the last
// refresh, not live. All four are SECURITY INVOKER — they run as the logged-in user and RLS applies — and take shop-local 'YYYY-MM-DD'
// dates (no timezone math here). A null/omitted array param means "no filter"; "all shops" is null, never a list of every shop id.
//
// Rules that shape the helpers below:
//  - package_mix.orders is NOT additive across packages (an order with two packages counts under each), so it is never summed; order counts
//    and order revenue come from get_sales_by_day only.
//  - Package revenue is price after discount, so it won't equal order revenue.
//  - Vehicle make is the order's first vehicle; voids are excluded by the rollups.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { isM5, type Classification } from './PackageMappingPage'

export interface SalesByDayRow { order_date: string; location_id: string | null; orders: number; revenue: number; subtotal: number }
export interface PackageMixRow { package_name: string; orders: number; packages_sold: number; revenue: number }
export interface ProductMixRow { product_id: string; product_type: string | null; brand_name: string | null; uom: string | null; quantity: number; price_total: number; cost_total: number }
export interface ShopStatsRow { location_id: string | null; oil_packages: number; m5_packages: number; quarts: number }
export interface VehicleMakeRow { vehicle_make: string; orders: number; revenue: number }

export interface RollupParams {
  start: string
  end: string
  /** null = every shop. */
  locationIds: string[] | null
  /** Empty = every make. */
  vehicleMakes: string[]
}

const orNull = <T,>(a: T[] | null | undefined): T[] | null => (a && a.length ? a : null)

type RpcCall = (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown[]>
const callRpc: RpcCall = async (name, args, signal) => {
  let q = (supabase as any).schema('inventory').rpc(name, args)
  if (signal) q = q.abortSignal(signal)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as unknown[]
}

const num = (v: unknown) => Number(v ?? 0)

export async function getSalesByDay(p: RollupParams, signal?: AbortSignal): Promise<SalesByDayRow[]> {
  const rows = await callRpc('get_sales_by_day', { p_start: p.start, p_end: p.end, p_location_ids: orNull(p.locationIds), p_vehicle_makes: orNull(p.vehicleMakes) }, signal)
  return (rows as SalesByDayRow[]).map((r) => ({ ...r, orders: num(r.orders), revenue: num(r.revenue), subtotal: num(r.subtotal) }))
}
export async function getPackageMix(p: RollupParams, packageNames: string[] = [], signal?: AbortSignal): Promise<PackageMixRow[]> {
  const rows = await callRpc('get_package_mix', { p_start: p.start, p_end: p.end, p_location_ids: orNull(p.locationIds), p_package_names: orNull(packageNames), p_vehicle_makes: orNull(p.vehicleMakes) }, signal)
  return (rows as PackageMixRow[]).map((r) => ({ ...r, orders: num(r.orders), packages_sold: num(r.packages_sold), revenue: num(r.revenue) }))
}
export async function getProductMix(p: RollupParams, productTypes: string[] = [], signal?: AbortSignal): Promise<ProductMixRow[]> {
  const rows = await callRpc('get_product_mix', { p_start: p.start, p_end: p.end, p_location_ids: orNull(p.locationIds), p_product_types: orNull(productTypes), p_vehicle_makes: orNull(p.vehicleMakes) }, signal)
  return (rows as ProductMixRow[]).map((r) => ({ ...r, quantity: num(r.quantity), price_total: num(r.price_total), cost_total: num(r.cost_total) }))
}
export async function getVehicleMakes(p: Pick<RollupParams, 'start' | 'end' | 'locationIds'>, signal?: AbortSignal): Promise<VehicleMakeRow[]> {
  const rows = await callRpc('get_vehicle_makes', { p_start: p.start, p_end: p.end, p_location_ids: orNull(p.locationIds) }, signal)
  return (rows as VehicleMakeRow[]).map((r) => ({ ...r, orders: num(r.orders), revenue: num(r.revenue) }))
}

export async function getShopStats(p: RollupParams, signal?: AbortSignal): Promise<ShopStatsRow[]> {
  const rows = await callRpc('get_orders_shop_stats', { p_start: p.start, p_end: p.end, p_location_ids: orNull(p.locationIds), p_vehicle_makes: orNull(p.vehicleMakes) }, signal)
  return (rows as ShopStatsRow[]).map((r) => ({ ...r, oil_packages: num(r.oil_packages), m5_packages: num(r.m5_packages), quarts: num(r.quarts) }))
}

// ── Derived summary (pure; unit tested) ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OrdersSummary {
  totals: { count: number; revenue: number; avg_order_value: number; avg_quarts_per_oil_order: number; m5_pct: number | null }
  by_package: { name: string; orders: number; sold: number; revenue: number }[]
  by_shop: { location_id: string | null; count: number; revenue: number }[]
  /** Latest order_date present in the sales rollup for the range, or null when there are no orders. */
  dataThrough: string | null
}

export function deriveSummary(sales: SalesByDayRow[], packageMix: PackageMixRow[], productMix: ProductMixRow[], classification: Map<string, Classification>): OrdersSummary {
  let count = 0, revenue = 0
  let dataThrough: string | null = null
  const shops = new Map<string | null, { count: number; revenue: number }>()
  for (const r of sales) {
    count += r.orders; revenue += r.revenue
    if (r.orders > 0 && (!dataThrough || r.order_date > dataThrough)) dataThrough = r.order_date
    const s = shops.get(r.location_id) ?? { count: 0, revenue: 0 }
    s.count += r.orders; s.revenue += r.revenue
    shops.set(r.location_id, s)
  }
  // M5% = M5 package line items ÷ Oil Change package line items (packages sold — not orders, which would double count).
  let oilChanges = 0, m5 = 0
  for (const p of packageMix) {
    const c = classification.get(p.package_name)
    if (c === 'oil_change') oilChanges += p.packages_sold
    else if (c && isM5(c)) m5 += p.packages_sold
  }
  // Oil quarts: every quart-unit product sold, spread over the oil change packages sold.
  const quarts = productMix.filter((r) => (r.uom ?? '').trim().toUpperCase() === 'QT').reduce((n, r) => n + r.quantity, 0)
  return {
    totals: {
      count, revenue,
      avg_order_value: count > 0 ? revenue / count : 0,
      avg_quarts_per_oil_order: oilChanges > 0 ? quarts / oilChanges : 0,
      m5_pct: oilChanges > 0 ? (m5 / oilChanges) * 100 : null,
    },
    by_package: packageMix.map((p) => ({ name: p.package_name, orders: p.orders, sold: p.packages_sold, revenue: p.revenue })).sort((a, b) => b.sold - a.sold),
    by_shop: [...shops.entries()].map(([location_id, v]) => ({ location_id, ...v })),
    dataThrough,
  }
}

// ── Cache + hook ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { at: number; value: unknown }>()
const cached = async <T,>(key: string, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}
const ser = (p: RollupParams) => JSON.stringify([p.start, p.end, p.locationIds ? [...p.locationIds].sort() : null, [...p.vehicleMakes].sort()])
const serScope = (p: RollupParams) => JSON.stringify([p.start, p.end, p.locationIds ? [...p.locationIds].sort() : null])

export interface RollupData { sales: SalesByDayRow[]; packageMix: PackageMixRow[]; productMix: ProductMixRow[]; makes: VehicleMakeRow[] }

// Day-long browser cache: a named period (Last 30 Days...) is stored under its NAME, so coming back later the same day — or the next morning —
// shows the last summary at once (with a note and a Refresh button) instead of reloading. Stored compactly: the per-day sales rows are folded to
// one row per shop (dataThrough stays right), and product rows keep only what the summary and the option lists use.
const LS_PREFIX = 'droptop-orders:summary:'
const LS_INDEX = `${LS_PREFIX}index`
const LS_TTL_MS = 24 * 60 * 60 * 1000
const LS_MAX_ENTRIES = 8
interface Stored { savedAt: number; data: RollupData; shopStats: ShopStatsRow[] | null }
const lsKey = (tag: string, p: RollupParams) => `${LS_PREFIX}${JSON.stringify([tag, p.locationIds ? [...p.locationIds].sort() : null, [...p.vehicleMakes].sort()])}`

function readLocal(key: string): Stored | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const v = JSON.parse(raw) as Stored
    return Date.now() - v.savedAt < LS_TTL_MS ? v : null
  } catch { return null }
}
function writeLocal(key: string, data: RollupData, shopStats: ShopStatsRow[] | null) {
  try {
    const byShop = new Map<string | null, SalesByDayRow>()
    for (const r of data.sales) {
      const cur = byShop.get(r.location_id)
      if (!cur) byShop.set(r.location_id, { ...r })
      else { cur.orders += r.orders; cur.revenue += r.revenue; cur.subtotal += r.subtotal; if (r.orders > 0 && r.order_date > cur.order_date) cur.order_date = r.order_date }
    }
    const compact: Stored = {
      savedAt: Date.now(),
      data: { ...data, sales: [...byShop.values()], productMix: data.productMix.map((r) => ({ product_id: r.product_id, product_type: null, brand_name: null, uom: r.uom, quantity: r.quantity, price_total: 0, cost_total: 0 })) },
      shopStats,
    }
    const json = JSON.stringify(compact)
    if (json.length > 1_500_000) return
    localStorage.setItem(key, json)
    const idx = (JSON.parse(localStorage.getItem(LS_INDEX) ?? '[]') as string[]).filter((k) => k !== key)
    idx.push(key)
    while (idx.length > LS_MAX_ENTRIES) { const old = idx.shift(); if (old) localStorage.removeItem(old) }
    localStorage.setItem(LS_INDEX, JSON.stringify(idx))
  } catch { /* storage full or unavailable — just skip the cache */ }
}

export type RollupStatus = 'idle' | 'loading' | 'paused' | 'cancelled' | 'error'

/**
 * The page's summary data. Loads by itself on first use (from the day-long cache when there is one), then follows the filters: parallel calls after
 * a ~250ms debounce, results cached by params, the previous data staying on screen while the next load runs. Controls:
 *  - cancel(): abort the load in flight.
 *  - changing a filter WHILE a load is running pauses it (status 'paused') until apply() is called, so a half-chosen set of filters isn't loaded.
 *  - apply(): load with the current filters, skipping the day cache (also the Retry / Refresh).
 * The per-shop oil-change / M5 / quart numbers come from a second, slower call and arrive after the main summary (shopStatsLoading).
 */
export function useOrderRollups(enabled: boolean, params: RollupParams, cacheTag: string | null = null) {
  const [data, setData] = useState<RollupData | null>(null)
  const [shopStats, setShopStats] = useState<ShopStatsRow[] | null>(null)
  const [shopStatsLoading, setShopStatsLoading] = useState(false)
  const [status, setStatus] = useState<RollupStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [cachedAt, setCachedAt] = useState<number | null>(null)
  const [applied, setApplied] = useState<{ p: RollupParams; nonce: number; fresh: boolean } | null>(null)
  const statusRef = useRef<RollupStatus>('idle')
  statusRef.current = status
  const ctrlRef = useRef<AbortController | null>(null)
  const key = ser(params)
  const desired = useMemo(() => params, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  const appliedKey = applied ? ser(applied.p) : null

  // Follow the filters.
  useEffect(() => {
    if (!enabled) { ctrlRef.current?.abort(); setApplied(null); setStatus('idle'); return }
    if (applied === null) { setApplied({ p: desired, nonce: 0, fresh: false }); return }
    if (key === appliedKey) return
    if (statusRef.current === 'loading') { ctrlRef.current?.abort(); setShopStatsLoading(false); setStatus('paused'); return }
    if (statusRef.current === 'paused' || statusRef.current === 'cancelled') return // wait for the user
    const t = window.setTimeout(() => setApplied((a) => ({ p: desired, nonce: (a?.nonce ?? 0) + 1, fresh: false })), 250)
    return () => window.clearTimeout(t)
  }, [enabled, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load whatever is applied.
  useEffect(() => {
    if (!applied) return
    const p = applied.p
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setStatus('loading'); setError(null); setCachedAt(null)
    ;(async () => {
      try {
        const lk = cacheTag ? lsKey(cacheTag, p) : null
        const hit = !applied.fresh && lk ? readLocal(lk) : null
        let main: RollupData
        if (hit) {
          main = hit.data
          setData(main); setShopStats(hit.shopStats); setCachedAt(hit.savedAt); setStatus('idle')
          if (hit.shopStats) return
        } else {
          const [sales, packageMix, productMix, makes] = await Promise.all([
            cached(`sales:${ser(p)}`, () => getSalesByDay(p, ctrl.signal)),
            cached(`pkg:${ser(p)}`, () => getPackageMix(p, [], ctrl.signal)),
            cached(`prod:${ser(p)}`, () => getProductMix(p, [], ctrl.signal)),
            cached(`makes:${serScope(p)}`, () => getVehicleMakes(p, ctrl.signal)),
          ])
          if (ctrl.signal.aborted) return
          main = { sales, packageMix, productMix, makes }
          setData(main); setShopStats(null); setStatus('idle')
        }
        setShopStatsLoading(true)
        const ss = await cached(`shopstats:${ser(p)}`, () => getShopStats(p, ctrl.signal))
        if (ctrl.signal.aborted) return
        setShopStats(ss); setShopStatsLoading(false)
        if (lk) writeLocal(lk, main, ss)
      } catch (e) {
        if (ctrl.signal.aborted) return
        setError((e as Error).message || 'Failed to load the orders summary')
        setStatus('error'); setShopStatsLoading(false)
      }
    })()
    return () => ctrl.abort()
  }, [applied, cacheTag])

  const cancel = useCallback(() => { ctrlRef.current?.abort(); setShopStatsLoading(false); setStatus('cancelled') }, [])
  const apply = useCallback(() => setApplied((a) => ({ p: desired, nonce: (a?.nonce ?? 0) + 1, fresh: true })), [desired])

  return { data, shopStats, shopStatsLoading, status, loading: status === 'loading', error, cachedAt, cancel, apply }
}
