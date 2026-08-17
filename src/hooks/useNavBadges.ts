import { useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useInventoryAlertsStore } from './useInventoryAlerts'

// Count badges shown on nav items (sidebar / dashboard / top bar). Loaded once
// per company and cached. `inventory-alerts` comes from useInventoryAlerts
// (exclusion + ignore filtered); the rest are computed here.

const isClosed = (s: string | null) => { const n = (s ?? '').toLowerCase(); return n.includes('closed') || n.includes('complete') || n.includes('resolved') }

async function computeTankOfflineShops(companyId: string): Promise<number> {
  const sb = supabase as any
  const PAGE = 1000
  const { count } = await sb.schema('inventory').from('tank_monitors').select('id', { count: 'exact', head: true }).eq('company_id', companyId)
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
    sb.schema('inventory').from('tank_monitors')
      .select('location_id, source_location, system_tank_id, serial_rtu_id, product_id, keep_fill, inventory_time, reading_date')
      .eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)))
  const all = results.flatMap((r: any) => (r.data ?? []) as any[])
  const rtime = (m: any) => { const v = m.inventory_time ?? m.reading_date; return v ? new Date(v).getTime() : 0 }
  // Latest reading per tank.
  const latest = new Map<string, any>()
  for (const m of all) {
    const key = `${m.location_id ?? m.source_location ?? ''}|${m.system_tank_id ?? m.serial_rtu_id ?? m.product_id ?? ''}`
    const ex = latest.get(key)
    if (!ex || rtime(m) > rtime(ex)) latest.set(key, m)
  }
  const mons = [...latest.values()]
  const latestReading = Math.max(0, ...mons.map(rtime))
  const shops = new Set<string>()
  for (const m of mons) {
    if (!m.location_id || !m.keep_fill) continue // only VMI/keepfill monitors matter
    const t = rtime(m)
    if (t && latestReading - t > 86400000) shops.add(m.location_id) // >1 day behind = offline
  }
  return shops.size
}

async function computeBadges(companyId: string): Promise<Record<string, number>> {
  const sb = supabase as any
  const [excRes, commRes, issRes, issStatRes, tankOffline] = await Promise.all([
    sb.schema('inventory').from('exception_reports').select('status').eq('company_id', companyId),
    sb.schema('inventory').from('location_comms').select('status').eq('company_id', companyId),
    sb.schema('platform').from('issues').select('status_id').eq('company_id', companyId).is('deleted_at', null),
    sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
    computeTankOfflineShops(companyId),
  ])
  const statusName: Record<string, string> = {}
  for (const s of (issStatRes.data ?? []) as any[]) statusName[s.id] = s.name ?? ''
  return {
    'exception-reporting': ((excRes.data ?? []) as any[]).filter((r) => !isClosed(r.status)).length,
    'location-comms': ((commRes.data ?? []) as any[]).filter((r) => !isClosed(r.status)).length,
    issues: ((issRes.data ?? []) as any[]).filter((r) => !isClosed(statusName[r.status_id] ?? '')).length,
    'tank-monitors': tankOffline,
  }
}

interface State {
  counts: Record<string, number>
  loadedFor: string | null
  loading: boolean
  load: (companyId: string) => Promise<void>
  reload: (companyId: string) => Promise<void>
}

export const useNavBadgesStore = create<State>((set, get) => ({
  counts: {}, loadedFor: null, loading: false,
  load: async (companyId) => {
    const s = get()
    if (s.loading || s.loadedFor === companyId) return
    set({ loading: true })
    try { const counts = await computeBadges(companyId); set({ counts, loadedFor: companyId, loading: false }) }
    catch { set({ loading: false }) }
  },
  reload: async (companyId) => { set({ loadedFor: null }); await get().load(companyId) },
}))

// Per-key badge count (triggers the load). inventory-alerts merges the alerts store.
export function useNavBadge(key: string): number {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const load = useNavBadgesStore((s) => s.load)
  useEffect(() => { if (companyId) load(companyId) }, [companyId, load])
  const alert = useInventoryAlertsStore((s) => s.derivedCount)
  const count = useNavBadgesStore((s) => s.counts[key] ?? 0)
  return key === 'inventory-alerts' ? alert : count
}
