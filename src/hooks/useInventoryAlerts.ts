import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import type { Location } from '@/types'

// Inventory alerts — cross-shop configuration gaps surfaced in one place.
// Raw flags are computed + cached once per company; the current user's location
// exclusions and per-alert ignores are applied in the hook so the sidebar badge
// and the page stay in sync.

export interface AlertShop { id: string; label: string; detail: string }
export interface AlertGroup { key: string; title: string; hint?: string; shops: AlertShop[] }

const RELADYNE_MIN = 10
const VALVOLINE_MIN = 3
const IGNORE_KEY = 'inventory_alert_ignores'

async function fetchRaw(companyId: string): Promise<{ rawGroups: AlertGroup[]; locById: Record<string, Location> }> {
  const sb = supabase as any
  const [{ data: locs }, { data: vends }, cfgCountRes] = await Promise.all([
    sb.schema('core').from('locations').select('*').eq('company_id', companyId),
    sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
    sb.schema('inventory').from('location_order_config').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
  ])
  const allLocs = (locs ?? []) as Location[]
  const locById: Record<string, Location> = {}
  for (const l of allLocs) locById[l.id] = l
  const locations = allLocs.filter((l) => l.active)
  const vendorName: Record<string, string> = {}
  for (const v of (vends ?? []) as any[]) vendorName[v.id] = v.name ?? ''

  const PAGE = 1000
  const pages = Math.max(1, Math.ceil((cfgCountRes.count ?? 0) / PAGE))
  const cfgPages = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.schema('inventory').from('location_order_config').select('location_id, vendor_id, product_id').eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)))
  const configs = cfgPages.flatMap((r: any) => (r.data ?? []) as any[])

  const rd = new Map<string, Set<string>>(); const val = new Map<string, Set<string>>()
  for (const c of configs) {
    if (!c.location_id || !c.product_id) continue
    const vl = (c.vendor_id ? vendorName[c.vendor_id] : '').toLowerCase()
    const add = (m: Map<string, Set<string>>) => { if (!m.has(c.location_id)) m.set(c.location_id, new Set()); m.get(c.location_id)!.add(String(c.product_id)) }
    if (vl.includes('reladyne')) add(rd)
    if (vl.includes('valvoline')) add(val)
  }

  const labelOf = (l: any) => l.shop_city || l.name || l.id
  const bySortLabel = (a: AlertShop, b: AlertShop) => a.label.localeCompare(b.label, undefined, { numeric: true })
  // "Valvoline #" is the base column valvoline_account_num on core.locations.
  const valvolineAcct = (l: any) => String(l.valvoline_account_num ?? (l.metadata as any)?.valvoline_account_num ?? '').trim()

  const rdDeliveryDay = (l: any) => String(l.reladyne_delivery_day ?? (l.metadata as any)?.reladyne_delivery_day ?? '').trim()

  const rdLow: AlertShop[] = locations.flatMap((l) => { const n = rd.get(l.id)?.size ?? 0; return n < RELADYNE_MIN ? [{ id: l.id, label: labelOf(l), detail: `${n} configured` }] : [] }).sort(bySortLabel)
  const valLow: AlertShop[] = locations.flatMap((l) => { const n = val.get(l.id)?.size ?? 0; return n < VALVOLINE_MIN ? [{ id: l.id, label: labelOf(l), detail: `${n} configured` }] : [] }).sort(bySortLabel)
  const missingAcct: AlertShop[] = locations.flatMap((l) => valvolineAcct(l) ? [] : [{ id: l.id, label: labelOf(l), detail: 'No Valvoline Account #' }]).sort(bySortLabel)
  const noRdDay: AlertShop[] = locations.flatMap((l) => rdDeliveryDay(l) ? [] : [{ id: l.id, label: labelOf(l), detail: 'No RelaDyne delivery day' }]).sort(bySortLabel)

  const rawGroups: AlertGroup[] = [
    { key: 'reladyne-low', title: `Shops with fewer than ${RELADYNE_MIN} RelaDyne products configured`, hint: 'Configure their RelaDyne order profile in Inventory Config → Order Config.', shops: rdLow },
    { key: 'no-reladyne-delivery-day', title: 'Shops with no RelaDyne delivery day', hint: 'Set the Reladyne Delivery Day in Global Config → Locations.', shops: noRdDay },
    { key: 'valvoline-low', title: `Shops with fewer than ${VALVOLINE_MIN} Valvoline products configured`, hint: 'Add Valvoline products to their order config.', shops: valLow },
    { key: 'missing-valvoline-acct', title: 'Shops missing a Valvoline Account #', hint: 'Set the Valvoline # in Global Config → Locations.', shops: missingAcct },
  ]
  return { rawGroups, locById }
}

async function fetchIgnores(companyId: string): Promise<string[]> {
  const { data } = await (supabase as any).schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', IGNORE_KEY).maybeSingle()
  return Array.isArray(data?.value) ? (data.value as string[]) : []
}
async function saveIgnores(companyId: string, ignores: string[]) {
  await (supabase as any).schema('platform').from('app_settings')
    .upsert({ company_id: companyId, key: IGNORE_KEY, value: ignores, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' })
    .then(({ error }: any) => { if (error) console.warn('[inventory-alerts] ignore save failed:', error.message) })
}

interface AlertsState {
  rawGroups: AlertGroup[]
  locById: Record<string, Location>
  ignores: string[]
  derivedCount: number // exclusion + ignore filtered; written by the hook for the nav badge
  loaded: boolean; loading: boolean; loadedCompany: string | null
  load: (companyId: string) => Promise<void>
  reload: (companyId: string) => Promise<void>
  setIgnore: (companyId: string, key: string, on: boolean) => Promise<void>
}

export const useInventoryAlertsStore = create<AlertsState>((set, get) => ({
  rawGroups: [], locById: {}, ignores: [], derivedCount: 0, loaded: false, loading: false, loadedCompany: null,
  load: async (companyId) => {
    const s = get()
    if (s.loading) return
    if (s.loaded && s.loadedCompany === companyId) return
    set({ loading: true })
    try {
      const [{ rawGroups, locById }, ignores] = await Promise.all([fetchRaw(companyId), fetchIgnores(companyId)])
      set({ rawGroups, locById, ignores, loaded: true, loadedCompany: companyId, loading: false })
    } catch { set({ loading: false }) }
  },
  reload: async (companyId) => { set({ loaded: false, loadedCompany: null }); await get().load(companyId) },
  setIgnore: async (companyId, key, on) => {
    const cur = get().ignores
    const next = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key)
    set({ ignores: next })
    await saveIgnores(companyId, next)
  },
}))

// Triggers the load and returns exclusion/ignore-filtered alert state.
export function useInventoryAlerts() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const rawGroups = useInventoryAlertsStore((s) => s.rawGroups)
  const locById = useInventoryAlertsStore((s) => s.locById)
  const ignores = useInventoryAlertsStore((s) => s.ignores)
  const loaded = useInventoryAlertsStore((s) => s.loaded)
  const loading = useInventoryAlertsStore((s) => s.loading)
  const load = useInventoryAlertsStore((s) => s.load)
  const reloadFn = useInventoryAlertsStore((s) => s.reload)
  const setIgnore = useInventoryAlertsStore((s) => s.setIgnore)
  const { isExcluded } = useLocationExclusions()

  useEffect(() => { if (companyId) load(companyId) }, [companyId, load])

  const { groups, ignoredGroups, count, ignoredCount } = useMemo(() => {
    const ig = new Set(ignores)
    const included = (s: AlertShop) => { const l = locById[s.id]; return l ? !isExcluded(l) : true }
    const groups = rawGroups.map((g) => ({ ...g, shops: g.shops.filter((s) => included(s) && !ig.has(`${g.key}|${s.id}`)) }))
    const ignoredGroups = rawGroups.map((g) => ({ ...g, shops: g.shops.filter((s) => included(s) && ig.has(`${g.key}|${s.id}`)) })).filter((g) => g.shops.length)
    const count = groups.reduce((a, g) => a + g.shops.length, 0)
    const ignoredCount = ignoredGroups.reduce((a, g) => a + g.shops.length, 0)
    return { groups, ignoredGroups, count, ignoredCount }
  }, [rawGroups, locById, ignores, isExcluded])

  // Publish the filtered count so the sidebar badge reads it without re-deriving.
  useEffect(() => { useInventoryAlertsStore.setState({ derivedCount: count }) }, [count])

  const reload = useCallback(() => { if (companyId) reloadFn(companyId) }, [companyId, reloadFn])
  const ignore = useCallback((groupKey: string, shopId: string) => { if (companyId) setIgnore(companyId, `${groupKey}|${shopId}`, true) }, [companyId, setIgnore])
  const unignore = useCallback((groupKey: string, shopId: string) => { if (companyId) setIgnore(companyId, `${groupKey}|${shopId}`, false) }, [companyId, setIgnore])

  return { groups, ignoredGroups, count, ignoredCount, loaded, loading, reload, ignore, unignore }
}
