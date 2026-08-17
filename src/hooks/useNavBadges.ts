import { useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useInventoryAlertsStore } from './useInventoryAlerts'
import { isStaleRecord } from '@/lib/staleness'
import { buildMonitorEmailLog, backfillTodayBlanket, DEFAULT_EMAIL_SKIP_DAYS } from '@/modules/locations/tankEmail'
import { DEFAULT_EXCEPTION_CONFIG } from '@/modules/exceptions/exceptions'
import { DEFAULT_COMMS_CONFIG } from '@/modules/comms/comms'

// Count badges shown on nav items (sidebar / dashboard / top bar). Loaded once
// per company and cached. `inventory-alerts` comes from useInventoryAlerts
// (exclusion + ignore filtered); the rest are computed here.

// A status counts as closed only when it reads as "closed" or "resolved";
// anything else (incl. blank / any pending state) is treated as open.
const isClosed = (s: string | null) => { const n = (s ?? '').toLowerCase(); return n.includes('closed') || n.includes('resolved') }

async function fetchAppSetting(sb: any, companyId: string, key: string): Promise<any> {
  const { data } = await sb.schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', key).maybeSingle()
  return data?.value
}

// Only counts shops that still need action: VMI/keepfill monitors offline
// (>1 day behind the latest upload) that haven't already been emailed about
// within the configured skip window — matches the "Start email
// communication" filtering on the Tank Monitors page and the Location
// Lookup offline callout, so the badge only reflects outstanding work.
async function computeTankOfflineShops(companyId: string): Promise<number> {
  const sb = supabase as any
  const PAGE = 1000
  const [{ count }, skipEnabledRaw, skipDaysRaw] = await Promise.all([
    sb.schema('inventory').from('tank_monitors').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    fetchAppSetting(sb, companyId, 'tank_email_skip_enabled'),
    fetchAppSetting(sb, companyId, 'tank_email_skip_days'),
  ])
  const skipEnabled = skipEnabledRaw ?? true
  const skipDays = Number(skipDaysRaw ?? DEFAULT_EMAIL_SKIP_DAYS)
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
  const [results, commsRes] = await Promise.all([
    Promise.all(Array.from({ length: pages }, (_, i) =>
      sb.schema('inventory').from('tank_monitors')
        .select('location_id, source_location, system_tank_id, serial_rtu_id, product_id, keep_fill, inventory_time, reading_date')
        .eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1))),
    sb.schema('inventory').from('location_comms').select('location_id, comm_date, updated_at, products').eq('company_id', companyId).eq('comm_type', 'Offline Tank Monitor'),
  ])
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

  const commsRows = (commsRes.data ?? []) as { location_id: string | null; comm_date: string | null; updated_at: string; products: unknown }[]
  const emailLog = buildMonitorEmailLog(commsRows)

  // Offline VMI monitors, grouped by shop.
  const offlineByShop = new Map<string, any[]>()
  for (const m of mons) {
    if (!m.location_id || !m.keep_fill) continue // only VMI/keepfill monitors matter
    const t = rtime(m)
    if (!t || latestReading - t <= 86400000) continue // >1 day behind = offline
    if (!offlineByShop.has(m.location_id)) offlineByShop.set(m.location_id, [])
    offlineByShop.get(m.location_id)!.push(m)
  }

  const shops = new Set<string>()
  for (const [locId, list] of offlineByShop) {
    if (!skipEnabled) { shops.add(locId); continue }
    const shopRows = commsRows.filter((r) => r.location_id === locId)
    const serials = list.map((m) => m.serial_rtu_id || m.system_tank_id || '')
    const log = backfillTodayBlanket(emailLog.get(locId) ?? new Map(), shopRows, serials)
    const stillNeedsAction = list.some((m) => {
      const serial = m.serial_rtu_id || m.system_tank_id || ''
      const last = serial ? log.get(serial) : undefined
      if (!last) return true
      return (Date.now() - new Date(last).getTime()) / 86400000 >= skipDays
    })
    if (stillNeedsAction) shops.add(locId)
  }
  return shops.size
}

async function computeBadges(companyId: string): Promise<Record<string, number>> {
  const sb = supabase as any
  const [excRes, commRes, issRes, issStatRes, tankOffline, excCfgRaw, commCfgRaw] = await Promise.all([
    sb.schema('inventory').from('exception_reports').select('status, date_of_finding, metadata').eq('company_id', companyId),
    sb.schema('inventory').from('location_comms').select('status, comm_date, metadata').eq('company_id', companyId),
    sb.schema('platform').from('issues').select('status_id').eq('company_id', companyId).is('deleted_at', null),
    sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
    computeTankOfflineShops(companyId),
    fetchAppSetting(sb, companyId, 'exception_config'),
    fetchAppSetting(sb, companyId, 'comms_config'),
  ])
  const statusName: Record<string, string> = {}
  for (const s of (issStatRes.data ?? []) as any[]) statusName[s.id] = s.name ?? ''
  const excStaleDays = Number(excCfgRaw?.staleDays ?? DEFAULT_EXCEPTION_CONFIG.staleDays)
  const commStaleDays = Number(commCfgRaw?.staleDays ?? DEFAULT_COMMS_CONFIG.staleDays)
  return {
    // Only rows that still need action: not closed, and stale (old enough,
    // not currently bumped) — matches the red-highlight rows on each page.
    'exception-reporting': ((excRes.data ?? []) as any[]).filter((r) => isStaleRecord(r.status, r.date_of_finding, r.metadata, excStaleDays)).length,
    'location-comms': ((commRes.data ?? []) as any[]).filter((r) => isStaleRecord(r.status, r.comm_date, r.metadata, commStaleDays)).length,
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

// Recompute the badge counts now — call after any mutation that changes a
// tracked count (exception/comm/issue status, tank readings) so badges tick
// down immediately instead of waiting for the next load.
export function refreshNavBadges() {
  const companyId = useAuthStore.getState().profile?.company_id
  if (companyId) void useNavBadgesStore.getState().reload(companyId)
}

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
