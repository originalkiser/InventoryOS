import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocationExclusions, ownerBucket } from '@/hooks/useLocationExclusions'
import { LOCATION_COLUMNS_SANS_MONDAY_PAYLOAD } from '@/hooks/useLocations'
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

// Most recent run per data connection (Droptop, SkyBitz Tanks, ...) that
// didn't finish 'success' — feeds both the nav badge count and the "Data
// Connection Updates" section's default collapsed view.
async function fetchConnectionIssueCount(companyId: string): Promise<number> {
  const { data, error } = await (supabase as any)
    .schema('inventory').from('data_connection_sync_log')
    .select('connection, status, finished_at')
    .eq('company_id', companyId)
    .order('finished_at', { ascending: false })
    .limit(200)
  if (error || !data) return 0
  const latestByConnection = new Map<string, { status: string }>()
  for (const r of data as { connection: string; status: string }[]) {
    if (!latestByConnection.has(r.connection)) latestByConnection.set(r.connection, r)
  }
  return [...latestByConnection.values()].filter((r) => r.status !== 'success').length
}

async function fetchRaw(companyId: string): Promise<{ rawGroups: AlertGroup[]; locById: Record<string, Location>; connectionIssueCount: number }> {
  const sb = supabase as any
  const [{ data: locs }, { data: vends }, cfgCountRes, connectionIssueCount] = await Promise.all([
    sb.schema('core').from('locations').select(LOCATION_COLUMNS_SANS_MONDAY_PAYLOAD).eq('company_id', companyId),
    sb.schema('inventory').from('vendors').select('id, name').eq('company_id', companyId),
    sb.schema('inventory').from('location_order_config').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    fetchConnectionIssueCount(companyId),
  ])
  const allLocs = (locs ?? []) as Location[]
  const locById: Record<string, Location> = {}
  for (const l of allLocs) locById[l.id] = l
  // car_wash-classified locations never belong in an inventory alert —
  // they're not oil-change shops (see migration 20260909d / useLocations.ts's
  // isOperationalLocation, the same rule applied here directly since this
  // hook queries core.locations itself rather than through that hook).
  const locations = allLocs.filter((l) => l.active && l.location_type !== 'car_wash')
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
  // droptop_operation_id (not droptop_num, the separate "Droptop #" field
  // also in the Locations grid) is the actual key every Droptop sync
  // function scopes its own location query by (`.not('droptop_operation_id',
  // 'is', null)` — confirmed directly in data-connection-dispatcher/index.ts
  // and every droptop-sync-*/index.ts this session) — a shop with this
  // blank is fully invisible to every Droptop pull (orders, usage, on-hand,
  // purchase orders, time clock), not just one connection. Scoped to
  // Corporate only (matching Orders v2's own corporateIds convention) since
  // a Franchise shop may legitimately run its own separate POS with no
  // Droptop integration at all.
  const missingDroptopOpId: AlertShop[] = locations
    .filter((l) => ownerBucket(String((l as any).owner ?? (l.metadata as any)?.owner ?? '')) === 'Corporate')
    .flatMap((l) => String((l as any).droptop_operation_id ?? '').trim() ? [] : [{ id: l.id, label: labelOf(l), detail: 'No Droptop Operation ID' }])
    .sort(bySortLabel)

  const rawGroups: AlertGroup[] = [
    { key: 'reladyne-low', title: `Shops with fewer than ${RELADYNE_MIN} RelaDyne products configured`, hint: 'Configure their RelaDyne order profile in Inventory Config → Order Config.', shops: rdLow },
    { key: 'no-reladyne-delivery-day', title: 'Shops with no RelaDyne delivery day', hint: 'Set the Reladyne Delivery Day in Global Config → Locations.', shops: noRdDay },
    { key: 'valvoline-low', title: `Shops with fewer than ${VALVOLINE_MIN} Valvoline products configured`, hint: 'Add Valvoline products to their order config.', shops: valLow },
    { key: 'missing-valvoline-acct', title: 'Shops missing a Valvoline Account #', hint: 'Set the Valvoline # in Global Config → Locations.', shops: missingAcct },
    { key: 'missing-droptop-operation-id', title: 'Active corporate shops missing a Droptop Operation ID', hint: 'No Droptop data (orders, usage, on-hand, purchase orders, time clock) can be pulled for this shop at all until this is set — Global Config → Locations → "Droptop Operation ID".', shops: missingDroptopOpId },
  ]
  return { rawGroups, locById, connectionIssueCount }
}

// Latest RelaDyne order-check result (written by orders-v2/rdOrderCheck.ts) — "N lines from <date>'s orders
// aren't on RelaDyne's open sales orders". Not a per-shop alert, so it's carried separately from rawGroups.
export interface RdOrderCheckAlert { date: string; missing: number; orderCount: number; checkedAt: string }
async function fetchRdOrderCheck(companyId: string): Promise<RdOrderCheckAlert | null> {
  const { data } = await (supabase as any).schema('platform').from('app_settings').select('value')
    .eq('company_id', companyId).eq('key', 'rd_order_check_summary').maybeSingle()
  const v = data?.value
  if (!v || typeof v.date !== 'string' || !(Number(v.missing) > 0)) return null
  // A result more than a week old is stale — whatever it flagged has long since been dealt with or lost relevance.
  if (Date.now() - new Date(v.date + 'T00:00:00').getTime() > 8 * 86400000) return null
  return { date: v.date, missing: Number(v.missing), orderCount: Number(v.orderCount ?? 0), checkedAt: String(v.checkedAt ?? '') }
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
  connectionIssueCount: number // latest run per data connection that isn't 'success'
  rdOrderCheck: RdOrderCheckAlert | null // RelaDyne order lines missing from the open sales orders (counts as 1 alert)
  derivedCount: number // exclusion + ignore filtered shops + connectionIssueCount; written by the hook for the nav badge
  loaded: boolean; loading: boolean; loadedCompany: string | null
  load: (companyId: string) => Promise<void>
  reload: (companyId: string) => Promise<void>
  setIgnore: (companyId: string, key: string, on: boolean) => Promise<void>
}

export const useInventoryAlertsStore = create<AlertsState>((set, get) => ({
  rawGroups: [], locById: {}, ignores: [], connectionIssueCount: 0, rdOrderCheck: null, derivedCount: 0, loaded: false, loading: false, loadedCompany: null,
  load: async (companyId) => {
    const s = get()
    if (s.loading) return
    if (s.loaded && s.loadedCompany === companyId) return
    set({ loading: true })
    try {
      const [{ rawGroups, locById, connectionIssueCount }, ignores, rdOrderCheck] = await Promise.all([fetchRaw(companyId), fetchIgnores(companyId), fetchRdOrderCheck(companyId)])
      set({ rawGroups, locById, ignores, connectionIssueCount, rdOrderCheck, loaded: true, loadedCompany: companyId, loading: false })
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
  const connectionIssueCount = useInventoryAlertsStore((s) => s.connectionIssueCount)
  const rdOrderCheck = useInventoryAlertsStore((s) => s.rdOrderCheck)
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

  // Publish the filtered count (+ non-success connection runs) so the
  // sidebar badge reads it without re-deriving.
  const rdAlertCount = rdOrderCheck ? 1 : 0
  useEffect(() => { useInventoryAlertsStore.setState({ derivedCount: count + connectionIssueCount + rdAlertCount }) }, [count, connectionIssueCount, rdAlertCount])

  const reload = useCallback(() => { if (companyId) reloadFn(companyId) }, [companyId, reloadFn])
  const ignore = useCallback((groupKey: string, shopId: string) => { if (companyId) setIgnore(companyId, `${groupKey}|${shopId}`, true) }, [companyId, setIgnore])
  const unignore = useCallback((groupKey: string, shopId: string) => { if (companyId) setIgnore(companyId, `${groupKey}|${shopId}`, false) }, [companyId, setIgnore])

  return { groups, ignoredGroups, count, ignoredCount, connectionIssueCount, rdOrderCheck, loaded, loading, reload, ignore, unignore }
}
