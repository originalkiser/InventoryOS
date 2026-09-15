import { useCallback, useEffect, useMemo, useState } from 'react'
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


// Page through a query in 1000-row chunks so we get the FULL table regardless of
// PostgREST's db-max-rows cap (a single .range(0, 99999) is silently truncated
// to the server limit). Requires a stable sort key (id) for correct paging.
//
// Fetched CONCURRENTLY (a count-only HEAD request up front for the page
// count, then a bounded worker pool — same shape as this codebase's other
// large-table pulls, e.g. Staffing Report's fetchAllPages) rather than one
// page at a time — found live 2026-09-16 that product_usage has grown to
// ~300k rows (300 pages), and a sequential loop turned "load Dashboard/On
// Hand" into 300 one-at-a-time round trips, each paying full PostgREST/
// network overhead on top of a sub-10ms query. Concurrency is capped
// (PAGE_CONCURRENCY) rather than firing all pages at once, which would
// just trade "slow" for "everyone's requests queue behind 300 simultaneous
// connections" — the exact kind of contention that made unrelated pages
// (Location Lookup, Staffing Report) feel slow during today's investigation.
const PAGE = 1000
const PAGE_CONCURRENCY = 6
async function fetchAll(table: string, columns: string, companyId: string): Promise<any[]> {
  const { count, error: countErr } = await sb
    .schema('inventory').from(table).select('id', { count: 'exact', head: true }).eq('company_id', companyId)
  if (countErr) throw countErr
  const totalPages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const results: any[][] = new Array(totalPages)
  let nextPage = 0
  async function worker() {
    for (;;) {
      const i = nextPage++
      if (i >= totalPages) return
      const { data, error } = await sb
        .schema('inventory').from(table)
        .select(columns).eq('company_id', companyId)
        .order('id', { ascending: true })
        .range(i * PAGE, i * PAGE + PAGE - 1)
      if (error) throw error
      results[i] = (data ?? []) as any[]
    }
  }
  await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, totalPages) }, worker))
  return results.flat()
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
interface InvCache { companyId: string; usage: ProductUsage[]; orderRows: any[]; fetchedAt: number }
let invCache: InvCache | null = null
let invFetchInFlight: { companyId: string; promise: Promise<InvCache> } | null = null
const CACHE_TTL = 5 * 60 * 1000

// Drop the cached inventory so the next useInventory mount (Dashboard / On Hand)
// pulls fresh. Call after any product_usage or order-config write.
export function invalidateInventoryCache() { invCache = null }

const orderKeySet = (rows: any[]) =>
  new Set(rows.map((r) => `${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}`))

export function useInventory() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { isExcluded } = useLocationExclusions()
  const [flagConfig, setFlagConfig] = useAppSetting<FlagConfig>('flag_config', DEFAULT_FLAG_CONFIG)
  const [exclude] = useAppSetting<boolean>(EXCLUDE_NOT_IN_ORDER_KEY, false)
  const { onlyConfig, setOnlyConfig, excludedCategories, setExcludedCategories } = useInventorySettings()
  const fresh = invCache?.companyId === companyId
  const [usage, setUsage] = useState<ProductUsage[]>(fresh ? invCache!.usage : [])
  const [orderKeys, setOrderKeys] = useState<Set<string>>(fresh ? orderKeySet(invCache!.orderRows) : new Set())
  const [loading, setLoading] = useState(!fresh)

  const load = useCallback(async (force = false) => {
    if (!companyId) return
    // Serve from cache when fresh unless a reload is forced.
    if (!force && invCache?.companyId === companyId && Date.now() - invCache.fetchedAt < CACHE_TTL) {
      setUsage(invCache.usage)
      setOrderKeys(orderKeySet(invCache.orderRows))
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      // Another kept-alive instance (Dashboard/On Hand/InventoryView can
      // all be mounted at once) may already be pulling this exact company —
      // join that instead of starting a second full pull.
      let inFlight = invFetchInFlight?.companyId === companyId ? invFetchInFlight.promise : null
      if (!inFlight || force) {
        const promise = (async (): Promise<InvCache> => {
          const [pu, oc] = await Promise.all([
            fetchAll('product_usage', '*', companyId),
            fetchAll('location_order_config', 'id, location_id, product_id', companyId),
          ])
          const entry = { companyId, usage: pu as ProductUsage[], orderRows: oc, fetchedAt: Date.now() }
          invCache = entry
          return entry
        })()
        invFetchInFlight = { companyId, promise }
        inFlight = promise
      }
      const entry = await inFlight
      setUsage(entry.usage)
      setOrderKeys(orderKeySet(entry.orderRows))
    } finally {
      setLoading(false)
      if (invFetchInFlight?.companyId === companyId) invFetchInFlight = null
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

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
    rows, stats, flagConfig, setFlagConfig, exclude, loading, reload,
    categories, onlyConfig, setOnlyConfig, excludedCategories, setExcludedCategories,
  }
}
