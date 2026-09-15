import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useInventorySettings } from '@/hooks/useInventorySettings'
import { EXCLUDE_NOT_IN_ORDER_KEY } from '@/modules/config/tabs/ProductUsageTab'
import { DEFAULT_FLAG_CONFIG, flagColorFor, isLow, type FlagColor, type FlagConfig } from '@/lib/flagScale'
import type { ProductUsage } from '@/types'

const sb = supabase as any

export interface InventoryRow {
  id: string
  location_id: string | null
  location_label: string
  product_id: string
  category: string | null
  daily_usage: number | null
  on_hands: number | null
  days_of_supply: number | null
  flag: FlagColor | null
  low: boolean
  inOrderConfig: boolean
}


// Page through a query in PAGE-row chunks so we get the FULL table regardless
// of PostgREST's db-max-rows cap (a single .range(0, 99999) is silently
// truncated to the server limit). Requires a stable sort key (id) for
// correct paging. PAGE=8000 stays under the project's own Max Rows setting
// (10,000, raised 2026-09-03 — see skybitz-tank-sync's own PAGE=5000 for the
// same precedent elsewhere) with headroom rather than sitting exactly at the
// cap; fewer, bigger pages means less total PostgREST/network round-trip
// overhead for the same ~300k rows.
//
// Fetched CONCURRENTLY (a count-only HEAD request up front for the page
// count, then a bounded worker pool — same shape as this codebase's other
// large-table pulls, e.g. Staffing Report's fetchAllPages) rather than one
// page at a time — found live 2026-09-16 that product_usage has grown to
// ~300k rows, and a sequential loop of small pages turned "load Dashboard/
// On Hand" into hundreds of one-at-a-time round trips, each paying full
// PostgREST/network overhead on top of a sub-10ms query. Concurrency is
// capped (PAGE_CONCURRENCY) rather than firing every page at once, which
// would just trade "slow" for "everyone's requests queue behind dozens of
// simultaneous connections" — the exact kind of contention that made
// unrelated pages (Location Lookup, Staffing Report) feel slow during the
// investigation that found this.
const PAGE = 8000
const PAGE_CONCURRENCY = 6
// `filter` narrows both the count and every page query the same way (e.g.
// scoping product_usage to a set of product ids) — applied to a fresh query
// builder each call since a PostgREST query builder can't be reused/cloned.
async function fetchAll(table: string, columns: string, companyId: string, filter?: (q: any) => any): Promise<any[]> {
  const base = (q: any) => (filter ? filter(q) : q)
  const { count, error: countErr } = await base(
    sb.schema('inventory').from(table).select('id', { count: 'exact', head: true }).eq('company_id', companyId),
  )
  if (countErr) throw countErr
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const results: any[][] = new Array(totalPages)
  let nextPage = 0
  async function worker() {
    for (;;) {
      const i = nextPage++
      if (i >= totalPages) return
      const { data, error } = await base(
        sb.schema('inventory').from(table).select(columns).eq('company_id', companyId),
      ).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)
      if (error) throw error
      results[i] = (data ?? []) as any[]
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, totalPages) }, worker))
  return results.flat()
}

// Found live 2026-09-15 checking out the "why does this pull so much data"
// complaint further: inventory.product_usage has grown to ~300k rows, but
// only ~50-ish distinct product ids are ever actually referenced by
// location_order_config (confirmed via direct SQL — 54 distinct configured
// product ids, matching just ~7,300 of the table's 299,550 rows). Every
// consumer of this hook (Dashboard, On Hand, InventoryView) only cares
// about configured products for the actual ordering workflow — the
// unconfigured 97%+ of rows were being fetched, paginated, and shipped over
// the wire for every load just so the "Only products in order config"
// toggle could be switched OFF to see them, a path confirmed against
// production to have never actually been used (the one company that had
// ever saved this setting had already turned it ON). So the default/common
// fetch now scopes product_usage server-side to whatever product ids
// location_order_config actually references company-wide (a plain .in())
// — location_order_config itself is fetched first specifically to get that
// id list, so this trades the previous full-table pull's page count for one
// small extra round trip. The exact (location, product) narrowing down to
// what's REALLY configured at each specific shop still happens client-side
// via `orderKeys` in `rows` below, unchanged — this server-side scope is
// intentionally the broader "used anywhere in the company" superset, which
// is already 97%+ of the win.
//
// Turning the "Only products in order config" toggle OFF is a genuine
// opt-in to see unconfigured products too, so that path still pulls the
// full unfiltered table exactly as before.
async function fetchUsage(companyId: string, scoped: boolean, configuredProductIds: string[]): Promise<any[]> {
  if (!scoped) return fetchAll('product_usage', '*', companyId)
  if (!configuredProductIds.length) return []
  return fetchAll('product_usage', '*', companyId, (q) => q.in('product_id', configuredProductIds))
}

// Module-level cache shared across every useInventory consumer (Dashboard,
// On Hand, InventoryView). Survives route changes so returning to a page is
// instant; a manual reload() or the 5-minute TTL forces a fresh pull.
//
// invFetchInFlight de-dupes the OTHER real problem this uncovered: this app
// deliberately keeps the last 3 visited pages mounted in the background
// (KeepAlivePages.tsx), so Dashboard, On Hand, and InventoryView can all be
// alive at once — each independently mounting this hook. Without this
// guard, all of them would race their own full ~300-page pull the instant
// none has populated the cache yet (e.g. right after a hard refresh),
// multiplying the exact load problem the concurrency cap above is trying
// to bound. Later callers for the same company just await the one already
// in flight instead of starting their own.
// `scoped` records which product_usage pull an entry holds — the fast
// configured-products-only fetch, or the full unfiltered table (see
// fetchUsage above) — so a company toggling "Only products in order
// config" off mid-session correctly triggers the other, genuinely
// different fetch instead of serving a cache built for the other mode.
interface InvCache { companyId: string; scoped: boolean; usage: ProductUsage[]; orderRows: any[]; fetchedAt: number }
let invCache: InvCache | null = null
let invFetchInFlight: { companyId: string; scoped: boolean; promise: Promise<InvCache> } | null = null
const CACHE_TTL = 5 * 60 * 1000

// Drop the cached inventory so the next useInventory mount (Dashboard / On Hand)
// pulls fresh. Call after any product_usage or order-config write.
export function invalidateInventoryCache() { invCache = null }

const orderKeySet = (rows: any[]) =>
  new Set(rows.map((r) => `${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}`))

// `auto: false` skips the automatic fetch-on-mount — for a surface where
// this data is nice-to-have but not the reason the page was opened (the
// Dashboard's Inventory Health tile; see loadNow below), so visiting it
// doesn't cost a product_usage pull nobody asked for. Every other consumer
// (On Hand, the Location Lookup / overlay InventoryView) omits this and
// keeps the original eager-load behavior. If a warm cache already exists
// for this company+scope (e.g. On Hand was visited earlier this session)
// it's still shown immediately regardless of `auto` — only a genuinely
// fresh fetch is skipped.
export function useInventory(opts?: { auto?: boolean }) {
  const auto = opts?.auto ?? true
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { isExcluded } = useLocationExclusions()
  const [flagConfig, setFlagConfig] = useAppSetting<FlagConfig>('flag_config', DEFAULT_FLAG_CONFIG)
  const [exclude] = useAppSetting<boolean>(EXCLUDE_NOT_IN_ORDER_KEY, false)
  const { onlyConfig, setOnlyConfig, excludedCategories, setExcludedCategories } = useInventorySettings()
  const fresh = invCache?.companyId === companyId && invCache.scoped === onlyConfig
  const [usage, setUsage] = useState<ProductUsage[]>(fresh ? invCache!.usage : [])
  const [orderKeys, setOrderKeys] = useState<Set<string>>(fresh ? orderKeySet(invCache!.orderRows) : new Set())
  const [loading, setLoading] = useState(auto && !fresh)
  // Distinct from `loading`: false only while auto-load is skipped and
  // nobody has asked for the data yet — the state a placeholder+button
  // checks for, since `loading` alone can't distinguish "haven't tried"
  // from "currently fetching".
  const [loaded, setLoaded] = useState(fresh)
  const wantsLoad = useRef(auto || fresh)

  const load = useCallback(async (force = false) => {
    if (!companyId) return
    // Serve from cache when fresh (same company AND same scope — see
    // InvCache's own comment) unless a reload is forced.
    if (!force && invCache?.companyId === companyId && invCache.scoped === onlyConfig && Date.now() - invCache.fetchedAt < CACHE_TTL) {
      setUsage(invCache.usage)
      setOrderKeys(orderKeySet(invCache.orderRows))
      setLoading(false)
      setLoaded(true)
      return
    }
    setLoading(true)
    try {
      // Another kept-alive instance (Dashboard/On Hand/InventoryView can
      // all be mounted at once) may already be pulling this exact company
      // in this exact scope — join that instead of starting a second pull.
      let inFlight = invFetchInFlight?.companyId === companyId && invFetchInFlight.scoped === onlyConfig ? invFetchInFlight.promise : null
      if (!inFlight || force) {
        const promise = (async (): Promise<InvCache> => {
          // location_order_config first (small/fast) so a scoped usage pull
          // knows which product ids to ask for — see fetchUsage's comment.
          const oc = await fetchAll('location_order_config', 'id, location_id, product_id', companyId)
          const configuredProductIds = [...new Set(oc.map((r: any) => r.product_id).filter(Boolean))] as string[]
          const pu = await fetchUsage(companyId, onlyConfig, configuredProductIds)
          const entry: InvCache = { companyId, scoped: onlyConfig, usage: pu as ProductUsage[], orderRows: oc, fetchedAt: Date.now() }
          invCache = entry
          return entry
        })()
        invFetchInFlight = { companyId, scoped: onlyConfig, promise }
        inFlight = promise
      }
      const entry = await inFlight
      setUsage(entry.usage)
      setOrderKeys(orderKeySet(entry.orderRows))
    } finally {
      setLoading(false)
      setLoaded(true)
      if (invFetchInFlight?.companyId === companyId && invFetchInFlight.scoped === onlyConfig) invFetchInFlight = null
    }
  }, [companyId, onlyConfig])

  // Skips the fetch entirely when auto=false and nobody has loaded yet
  // (wantsLoad starts false in that case) — but once loadNow() flips it on,
  // a later companyId/onlyConfig change (this effect's real deps, via
  // `load`'s own identity) still re-fetches normally, same as an eager
  // consumer.
  useEffect(() => { if (wantsLoad.current) load() }, [load])
  const loadNow = useCallback(() => { wantsLoad.current = true; return load() }, [load])

  // Distinct categories present in the data — feeds the dashboard category filter.
  const categories = useMemo(
    () => Array.from(new Set(usage.map((u) => String(u.category ?? '').trim()).filter(Boolean))).sort(),
    [usage],
  )

  const rows = useMemo<InventoryRow[]>(() => {
    const excludedCatSet = new Set(excludedCategories.map((c) => c.trim().toLowerCase()))
    return usage
      // Hide rows for locations the user has excluded (listing/dashboard scope).
      .filter((u) => { const l = loc.byId(u.location_id); return !l || !isExcluded(l) })
      // Drop excluded product categories.
      .filter((u) => !excludedCatSet.has(String(u.category ?? '').trim().toLowerCase()))
      // Optionally keep only products present in the order config.
      .filter((u) => !onlyConfig || orderKeys.has(`${u.location_id ?? ''}|${String(u.product_id ?? '').toLowerCase()}`))
      .map((u) => {
        const inOrderConfig = orderKeys.has(`${u.location_id ?? ''}|${String(u.product_id ?? '').toLowerCase()}`)
        // When excluding, products not in the order config are not flagged.
        const flaggable = !exclude || inOrderConfig
        const flag = flaggable ? flagColorFor(u.days_of_supply, flagConfig) : null
        return {
          id: u.id, location_id: u.location_id, location_label: loc.labelOf(u.location_id),
          product_id: u.product_id, category: u.category ?? null,
          daily_usage: u.daily_usage, on_hands: u.on_hands, days_of_supply: u.days_of_supply,
          flag, low: flaggable && isLow(u.days_of_supply, flagConfig), inOrderConfig,
        }
      })
  }, [usage, orderKeys, exclude, onlyConfig, excludedCategories, flagConfig, loc, isExcluded])

  // D4 callout aggregates.
  const stats = useMemo(() => {
    const flagged = rows.filter((r) => r.flag === 'red' || r.flag === 'amber')
    const byShop = new Map<string, number>()
    for (const r of flagged) byShop.set(r.location_label, (byShop.get(r.location_label) ?? 0) + 1)
    const shopsWithCritical = byShop.size
    let worstShop = '—', worstCount = 0
    for (const [shop, n] of byShop) if (n > worstCount) { worstCount = n; worstShop = shop }
    const shopsTracked = new Set(rows.map((r) => r.location_label)).size
    return {
      shopsWithCritical,
      totalProducts: rows.length,
      flaggedProducts: flagged.length,
      avgFlaggedPerShop: shopsTracked ? +(flagged.length / shopsTracked).toFixed(1) : 0,
      worstShop, worstCount,
    }
  }, [rows])

  const reload = useCallback(() => load(true), [load])
  return {
    rows, stats, flagConfig, setFlagConfig, exclude, loading, loaded, loadNow, reload,
    categories, onlyConfig, setOnlyConfig, excludedCategories, setExcludedCategories,
  }
}
