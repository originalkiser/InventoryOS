import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { useAppSetting } from '@/hooks/useAppSetting'
import { EXCLUDE_NOT_IN_ORDER_KEY } from '@/modules/config/tabs/ProductUsageTab'
import { DEFAULT_FLAG_CONFIG, flagColorFor, isLow, type FlagColor, type FlagConfig } from '@/lib/flagScale'
import type { ProductUsage } from '@/types'

const sb = supabase as any

export interface InventoryRow {
  id: string
  location_id: string | null
  location_label: string
  product_id: string
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
const PAGE = 1000
async function fetchAll(table: string, columns: string, companyId: string): Promise<any[]> {
  let from = 0
  const all: any[] = []
  for (;;) {
    const { data, error } = await sb
      .schema('inventory').from(table)
      .select(columns).eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as any[]
    all.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return all
}

// Module-level cache shared across every useInventory consumer (Dashboard,
// On Hand, InventoryView). Survives route changes so returning to a page is
// instant; a manual reload() or the 5-minute TTL forces a fresh pull.
interface InvCache { companyId: string; usage: ProductUsage[]; orderRows: any[]; fetchedAt: number }
let invCache: InvCache | null = null
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
      const [pu, oc] = await Promise.all([
        fetchAll('product_usage', '*', companyId),
        fetchAll('location_order_config', 'id, location_id, product_id', companyId),
      ])
      invCache = { companyId, usage: pu as ProductUsage[], orderRows: oc, fetchedAt: Date.now() }
      setUsage(pu as ProductUsage[])
      setOrderKeys(orderKeySet(oc))
    } finally {
      setLoading(false)
    }
  }, [companyId])

  useEffect(() => { load() }, [load])

  const rows = useMemo<InventoryRow[]>(() => usage
    // Hide rows for locations the user has excluded (listing/dashboard scope).
    .filter((u) => { const l = loc.byId(u.location_id); return !l || !isExcluded(l) })
    .map((u) => {
      const inOrderConfig = orderKeys.has(`${u.location_id ?? ''}|${String(u.product_id ?? '').toLowerCase()}`)
      // When excluding, products not in the order config are not flagged.
      const flaggable = !exclude || inOrderConfig
      const flag = flaggable ? flagColorFor(u.days_of_supply, flagConfig) : null
      return {
        id: u.id, location_id: u.location_id, location_label: loc.labelOf(u.location_id),
        product_id: u.product_id, daily_usage: u.daily_usage, on_hands: u.on_hands, days_of_supply: u.days_of_supply,
        flag, low: flaggable && isLow(u.days_of_supply, flagConfig), inOrderConfig,
      }
    }), [usage, orderKeys, exclude, flagConfig, loc, isExcluded])

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
  return { rows, stats, flagConfig, setFlagConfig, exclude, loading, reload }
}
