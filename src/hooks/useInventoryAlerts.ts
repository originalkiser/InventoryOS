import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

// Inventory alerts — cross-shop configuration gaps surfaced in one place.
// Loaded once per company and cached so the sidebar badge and the page share it.

export interface AlertShop { id: string; label: string; detail: string }
export interface AlertGroup { key: string; title: string; hint?: string; shops: AlertShop[] }

const RELADYNE_MIN = 10
const VALVOLINE_MIN = 3

async function computeAlerts(companyId: string): Promise<AlertGroup[]> {
  const sb = supabase as any
  const [{ data: locs }, { data: vends }, cfgCountRes] = await Promise.all([
    sb.schema('core').from('locations').select('id, name, shop_city, active, metadata').eq('company_id', companyId),
    sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
    sb.schema('inventory').from('location_order_config').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
  ])
  const locations = ((locs ?? []) as any[]).filter((l) => l.active)
  const vendorName: Record<string, string> = {}
  for (const v of (vends ?? []) as any[]) vendorName[v.id] = v.name ?? ''

  // location_order_config can exceed the 1000-row cap — page through it.
  const PAGE = 1000
  const pages = Math.max(1, Math.ceil((cfgCountRes.count ?? 0) / PAGE))
  const cfgPages = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.schema('inventory').from('location_order_config').select('location_id, vendor_id, product_id').eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)))
  const configs = cfgPages.flatMap((r: any) => (r.data ?? []) as any[])

  // Distinct products per shop per vendor bucket.
  const rd = new Map<string, Set<string>>()
  const val = new Map<string, Set<string>>()
  for (const c of configs) {
    if (!c.location_id || !c.product_id) continue
    const vl = (c.vendor_id ? vendorName[c.vendor_id] : '').toLowerCase()
    const add = (m: Map<string, Set<string>>) => { if (!m.has(c.location_id)) m.set(c.location_id, new Set()); m.get(c.location_id)!.add(String(c.product_id)) }
    if (vl.includes('reladyne')) add(rd)
    if (vl.includes('valvoline')) add(val)
  }

  const labelOf = (l: any) => l.shop_city || l.name || l.id
  const bySortLabel = (a: AlertShop, b: AlertShop) => a.label.localeCompare(b.label, undefined, { numeric: true })
  const valvolineAcct = (l: any) => { const m = (l.metadata ?? {}) as Record<string, any>; return String(l.valvoline_account_num ?? m.valvoline_account_num ?? '').trim() }

  const rdLow: AlertShop[] = locations.flatMap((l) => { const n = rd.get(l.id)?.size ?? 0; return n < RELADYNE_MIN ? [{ id: l.id, label: labelOf(l), detail: `${n} configured` }] : [] }).sort(bySortLabel)
  const valLow: AlertShop[] = locations.flatMap((l) => { const n = val.get(l.id)?.size ?? 0; return n < VALVOLINE_MIN ? [{ id: l.id, label: labelOf(l), detail: `${n} configured` }] : [] }).sort(bySortLabel)
  const missingAcct: AlertShop[] = locations.filter((l) => !valvolineAcct(l)).map((l) => ({ id: l.id, label: labelOf(l), detail: 'No Valvoline Account #' })).sort(bySortLabel)

  return [
    { key: 'reladyne-low', title: `Shops with fewer than ${RELADYNE_MIN} RelaDyne products configured`, hint: 'Configure their RelaDyne order profile in Inventory Config → Order Config.', shops: rdLow },
    { key: 'valvoline-low', title: `Shops with fewer than ${VALVOLINE_MIN} Valvoline products configured`, hint: 'Add Valvoline products to their order config.', shops: valLow },
    { key: 'missing-valvoline-acct', title: 'Shops missing a Valvoline Account #', hint: 'Set the Valvoline Account # in Global Config → Locations.', shops: missingAcct },
  ]
}

interface AlertsState {
  groups: AlertGroup[]
  count: number
  loaded: boolean
  loading: boolean
  loadedCompany: string | null
  load: (companyId: string) => Promise<void>
  reload: (companyId: string) => Promise<void>
}

export const useInventoryAlertsStore = create<AlertsState>((set, get) => ({
  groups: [], count: 0, loaded: false, loading: false, loadedCompany: null,
  load: async (companyId) => {
    const s = get()
    if (s.loading) return
    if (s.loaded && s.loadedCompany === companyId) return
    set({ loading: true })
    try {
      const groups = await computeAlerts(companyId)
      set({ groups, count: groups.reduce((a, g) => a + g.shops.length, 0), loaded: true, loadedCompany: companyId, loading: false })
    } catch { set({ loading: false }) }
  },
  reload: async (companyId) => { set({ loaded: false, loadedCompany: null }); await get().load(companyId) },
}))

// Triggers the load and returns the current alert state.
export function useInventoryAlerts() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const groups = useInventoryAlertsStore((s) => s.groups)
  const count = useInventoryAlertsStore((s) => s.count)
  const loaded = useInventoryAlertsStore((s) => s.loaded)
  const loading = useInventoryAlertsStore((s) => s.loading)
  const load = useInventoryAlertsStore((s) => s.load)
  const reloadFn = useInventoryAlertsStore((s) => s.reload)
  useEffect(() => { if (companyId) load(companyId) }, [companyId, load])
  const reload = useCallback(() => { if (companyId) reloadFn(companyId) }, [companyId, reloadFn])
  return { groups, count, loaded, loading, reload }
}
