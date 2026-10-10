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
import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { isM5, type Classification } from './PackageMappingPage'

export interface SalesByDayRow { order_date: string; location_id: string | null; orders: number; revenue: number; subtotal: number }
export interface PackageMixRow { package_name: string; orders: number; packages_sold: number; revenue: number }
export interface ProductMixRow { product_id: string; product_type: string | null; brand_name: string | null; uom: string | null; quantity: number; price_total: number; cost_total: number }
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

/**
 * The page's summary data. Filters in, the four rollups out: fired in parallel after a ~250ms debounce, stale responses ignored (aborted + a
 * request id), results cached by serialized params for a few minutes, and the previous data stays on screen while the next load runs.
 */
export function useOrderRollups(enabled: boolean, params: RollupParams) {
  const [data, setData] = useState<RollupData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reqId = useRef(0)
  const key = ser(params)
  const p = useMemo(() => params, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!enabled) { setData(null); setError(null); setLoading(false); return }
    const id = ++reqId.current
    const ctrl = new AbortController()
    setLoading(true)
    const t = window.setTimeout(async () => {
      try {
        const [sales, packageMix, productMix, makes] = await Promise.all([
          cached(`sales:${ser(p)}`, () => getSalesByDay(p, ctrl.signal)),
          cached(`pkg:${ser(p)}`, () => getPackageMix(p, [], ctrl.signal)),
          cached(`prod:${ser(p)}`, () => getProductMix(p, [], ctrl.signal)),
          cached(`makes:${serScope(p)}`, () => getVehicleMakes(p, ctrl.signal)),
        ])
        if (id !== reqId.current) return
        setData({ sales, packageMix, productMix, makes })
        setError(null)
      } catch (e) {
        if (id !== reqId.current || ctrl.signal.aborted) return
        setError((e as Error).message || 'Failed to load the orders summary')
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    }, 250)
    return () => { window.clearTimeout(t); ctrl.abort() }
  }, [enabled, p])

  return { data, loading, error }
}
