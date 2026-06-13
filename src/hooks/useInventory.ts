import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
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

export function useInventory() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [flagConfig, setFlagConfig] = useAppSetting<FlagConfig>('flag_config', DEFAULT_FLAG_CONFIG)
  const [exclude] = useAppSetting<boolean>(EXCLUDE_NOT_IN_ORDER_KEY, false)
  const [usage, setUsage] = useState<ProductUsage[]>([])
  const [orderKeys, setOrderKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [pu, oc] = await Promise.all([
      sb.from('product_usage').select('*').eq('company_id', companyId),
      sb.from('location_order_configs').select('location_id, product_id').eq('company_id', companyId),
    ])
    setUsage((pu.data ?? []) as ProductUsage[])
    setOrderKeys(new Set(((oc.data ?? []) as any[]).map((r) => `${r.location_id ?? ''}|${String(r.product_id ?? '').toLowerCase()}`)))
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  const rows = useMemo<InventoryRow[]>(() => usage.map((u) => {
    const inOrderConfig = orderKeys.has(`${u.location_id ?? ''}|${String(u.product_id ?? '').toLowerCase()}`)
    // When excluding, products not in the order config are not flagged.
    const flaggable = !exclude || inOrderConfig
    const flag = flaggable ? flagColorFor(u.days_of_supply, flagConfig) : null
    return {
      id: u.id, location_id: u.location_id, location_label: loc.labelOf(u.location_id),
      product_id: u.product_id, daily_usage: u.daily_usage, on_hands: u.on_hands, days_of_supply: u.days_of_supply,
      flag, low: flaggable && isLow(u.days_of_supply, flagConfig), inOrderConfig,
    }
  }), [usage, orderKeys, exclude, flagConfig, loc])

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

  return { rows, stats, flagConfig, setFlagConfig, exclude, loading, reload: load }
}
