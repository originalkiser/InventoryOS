import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Copy, Mail, Columns3, EyeOff } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useLocationExclusions } from '@/hooks/useLocationExclusions'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Card, CardBody, Combobox, SbLoader, Badge, Button, Toggle, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { ColumnManagerModal } from './ColumnManagerModal'
import { TankEmailModal, type EmailTarget } from './TankEmailModal'
import { TankEmailTemplates } from './TankEmailTemplates'
import { TankProductMapping } from './TankProductMapping'
import { TANK_EMAIL_DEFAULT, type TankEmailKind, type TankEmailTemplate, buildMonitorEmailLog, backfillTodayBlanket, monitorIgnoreKey, DEFAULT_EMAIL_SKIP_DAYS } from './tankEmail'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import type { TankMonitor, Location, VendorPart } from '@/types'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const dt = (v: string | null | undefined) => { if (!v) return '—'; try { return format(new Date(v), 'MMM d, yyyy h:mm a') } catch { return String(v) } }
const metaOf = (l: Location | undefined, key: string): string => {
  if (!l) return ''
  const base = (l as any)[key]; if (base != null && base !== '') return String(base)
  const m = (l.metadata as any)?.[key]; return m == null ? '' : String(m)
}
const readingTime = (m: TankMonitor) => { const v = m.inventory_time ?? m.reading_date; return v ? new Date(v).getTime() : null }

interface MCol { id: string; label: string; render: (m: TankMonitor, ctx: Ctx) => ReactNode; sort?: (m: TankMonitor, ctx: Ctx) => string | number | null }
interface Ctx { shopOf: (id: string | null) => string; internalOf: (pid: string | null) => string }

const COLS: MCol[] = [
  { id: 'product', label: 'Product', render: (m) => m.product_id ?? '—', sort: (m) => m.product_id },
  { id: 'internal', label: 'Product ID (Internal)', render: (m, c) => c.internalOf(m.product_id), sort: (m, c) => c.internalOf(m.product_id) },
  { id: 'keepfill', label: 'VMI / Keepfill', render: (m) => (m.keep_fill ? <Badge color="sky">yes</Badge> : <span className="text-inky/40">—</span>), sort: (m) => (m.keep_fill ? 1 : 0) },
  { id: 'on_hand', label: 'On Hand (Gross)', render: (m) => num(m.on_hand), sort: (m) => m.on_hand },
  { id: 'available_capacity', label: 'Available Capacity', render: (m) => num(m.available_capacity), sort: (m) => m.available_capacity },
  { id: 'total_capacity', label: 'Total Capacity', render: (m) => num(m.total_capacity ?? ((m.on_hand ?? 0) + (m.available_capacity ?? 0))), sort: (m) => m.total_capacity ?? ((m.on_hand ?? 0) + (m.available_capacity ?? 0)) },
  { id: 'level_inches', label: 'Level (in)', render: (m) => num(m.level_inches), sort: (m) => m.level_inches },
  { id: 'height', label: 'Height', render: (m) => num(m.height), sort: (m) => m.height },
  { id: 'low_set_point_pct', label: 'Low Set Point (%)', render: (m) => num(m.low_set_point_pct), sort: (m) => m.low_set_point_pct },
  { id: 'volume_alarm_status', label: 'Volume Alarm', render: (m) => m.volume_alarm_status ?? '—', sort: (m) => m.volume_alarm_status },
  { id: 'battery_pct', label: "Bat' (%)", render: (m) => num(m.battery_pct), sort: (m) => m.battery_pct },
  { id: 'serial_rtu_id', label: 'Serial # (RTU ID)', render: (m) => m.serial_rtu_id ?? '—', sort: (m) => m.serial_rtu_id },
  { id: 'system_tank_id', label: 'System Tank ID', render: (m) => m.system_tank_id ?? '—', sort: (m) => m.system_tank_id },
  { id: 'key_note', label: 'Key Note', render: (m) => m.key_note ?? '—', sort: (m) => m.key_note },
  { id: 'inventory_time', label: 'Inventory Time', render: (m) => dt(m.inventory_time ?? m.reading_date), sort: (m) => readingTime(m) },
  { id: 'updated_at', label: 'Last Updated', render: (m) => dt(m.updated_at), sort: (m) => (m.updated_at ? new Date(m.updated_at).getTime() : null) },
]
const DEFAULT_ORDER = COLS.map((c) => c.id)
const SHOWN_KEY = 'tankmon:shown'
// Normalize a monitor's source location into a stable ignore key so an ignored
// unassigned shop stays ignored across re-uploads (trailing spaces etc.).
const srcKey = (s: string | null | undefined) => (s ?? '').trim() || '(blank)'

export function TankMonitorsPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const navigate = useNavigate()
  const { isExcluded } = useLocationExclusions()

  const [monitors, setMonitors] = useState<TankMonitor[]>([])
  const [parts, setParts] = useState<VendorPart[]>([])
  const [loading, setLoading] = useState(true)
  const [shopFilter, setShopFilter] = useState('')
  const [amFilter, setAmFilter] = useState('')
  const [offlineVmiOnly, setOfflineVmiOnly] = useState(true)
  const [ignored, setIgnored] = useAppSetting<string[]>('tank_low_vmi_ignore', [])
  const [matchIgnore, setMatchIgnore, matchIgnoreLoaded] = useAppSetting<string[]>('tank_match_ignore', [])
  const [showIgnored, setShowIgnored] = useState(false)
  const [offlineTpl, setOfflineTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_offline', TANK_EMAIL_DEFAULT.offline)
  const [lowvmiTpl, setLowvmiTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_lowvmi', TANK_EMAIL_DEFAULT.lowvmi)
  const saveTpl = (kind: TankEmailKind, tpl: TankEmailTemplate) => (kind === 'offline' ? setOfflineTpl(tpl) : setLowvmiTpl(tpl))
  const [emailKind, setEmailKind] = useState<TankEmailKind | null>(null)
  const [emailTargets, setEmailTargets] = useState<EmailTarget[]>([])
  const [prodMap, setProdMap] = useAppSetting<Record<string, string>>('tank_product_map', {})
  // Same skip settings as the email modal itself (shared app_settings keys)
  // so "already emailed" monitors drop out of Offline (and Low VMI) here
  // too, not just once you're inside the draft.
  const [skipEnabled, setSkipEnabled] = useAppSetting<boolean>('tank_email_skip_enabled', true)
  const [skipDays, setSkipDays] = useAppSetting<number>('tank_email_skip_days', DEFAULT_EMAIL_SKIP_DAYS)
  const [monitorIgnore, setMonitorIgnore] = useAppSetting<string[]>('tank_monitor_ignore', [])
  const [showIgnoredMonitors, setShowIgnoredMonitors] = useState(false)
  const [commsRows, setCommsRows] = useState<{ location_id: string | null; comm_date: string | null; updated_at: string; products: unknown; comm_type: string | null }[]>([])
  const loadCommsLog = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('location_comms')
      .select('location_id, comm_date, updated_at, products, comm_type').eq('company_id', companyId)
      .in('comm_type', ['Offline Tank Monitor', 'Low VMI Coverage'])
    if (error) return
    setCommsRows((data ?? []) as typeof commsRows)
  }, [companyId])
  useEffect(() => { loadCommsLog() }, [loadCommsLog])
  const offlineCommsRows = useMemo(() => commsRows.filter((r) => r.comm_type === 'Offline Tank Monitor'), [commsRows])
  const lowVmiCommsRows = useMemo(() => commsRows.filter((r) => r.comm_type === 'Low VMI Coverage'), [commsRows])

  // Location is hidden if the user excluded it (shared with the rest of the app).
  const isHidden = useCallback((id: string | null) => { const l = loc.byId(id); return !!l && isExcluded(l) }, [loc, isExcluded])

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const PAGE = 1000
    // Count first, then fetch every page — a single select() is capped at 1000
    // rows, which silently dropped shops (and broke the VMI counts).
    const [{ count }, partRes] = await Promise.all([
      sb.schema('inventory').from('tank_monitors').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
      sb.schema('inventory').from('vendor_parts').select('part_number, our_part_number, description').eq('company_id', companyId),
    ])
    const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE))
    const results = await Promise.all(Array.from({ length: pages }, (_, i) =>
      sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).order('id', { ascending: true }).range(i * PAGE, i * PAGE + PAGE - 1)))
    const all = results.flatMap((r: any) => (r.data ?? []) as TankMonitor[])
    // Collapse history to the latest reading per tank so counts reflect current
    // state (one row per tank), not every daily reading.
    const latest = new Map<string, TankMonitor>()
    for (const m of all) {
      const key = `${m.location_id ?? m.source_location ?? ''}|${m.system_tank_id ?? m.serial_rtu_id ?? m.product_id ?? ''}`
      const ex = latest.get(key)
      if (!ex || (readingTime(m) ?? 0) > (readingTime(ex) ?? 0)) latest.set(key, m)
    }
    setMonitors([...latest.values()])
    setParts((partRes.data ?? []) as VendorPart[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  // Raw monitor product → internal our_part_number via vendor parts. Tank
  // monitors report the vendor part DESCRIPTION (e.g. "DMX SB 5W20 BU"), so match
  // on description first, then part number as a fallback.
  const internalMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of parts) {
      const our = p.our_part_number
      if (!our) continue
      const desc = p.description ? String(p.description).toLowerCase().trim() : ''
      if (desc) m.set(desc, our)
      const pn = p.part_number ? String(p.part_number).toLowerCase().trim() : ''
      if (pn && !m.has(pn)) m.set(pn, our)
    }
    return m
  }, [parts])
  const ctx: Ctx = useMemo(() => ({
    shopOf: (id) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    // Manual mapping (Product Mapping tab) wins, then the Vendor Parts match.
    internalOf: (pid) => { if (!pid) return '—'; const k = pid.toLowerCase().trim(); return prodMap[k] || internalMap.get(k) || pid },
  }), [loc, internalMap, prodMap])

  // Distinct tank products + which of them still have no internal match.
  const tankProducts = useMemo(() => [...new Set(monitors.map((m) => m.product_id).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [monitors])
  const ourOptions = useMemo(() => [...new Set(parts.map((p) => p.our_part_number).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [parts])
  const unmatchedProducts = useMemo(() => tankProducts.filter((p) => { const k = p.toLowerCase().trim(); return !prodMap[k] && !internalMap.has(k) }), [tankProducts, prodMap, internalMap])

  const assigned = useMemo(() => monitors.filter((m) => m.location_id && !isHidden(m.location_id)), [monitors, isHidden])
  const unassigned = useMemo(() => monitors.filter((m) => !m.location_id && !matchIgnore.includes(srcKey(m.source_location))), [monitors, matchIgnore])

  // Filters (shop / area manager) applied to assigned monitors.
  const filtered = useMemo(() => assigned.filter((m) => {
    if (shopFilter && m.location_id !== shopFilter) return false
    if (amFilter && metaOf(loc.byId(m.location_id), 'area_manager') !== amFilter) return false
    return true
  }), [assigned, shopFilter, amFilter, loc])

  // Offline = last reading > 1 day behind the freshest reading in the dataset.
  const latestReading = useMemo(() => Math.max(0, ...monitors.map((m) => readingTime(m) ?? 0)), [monitors])
  const offlineCommsLog = useMemo(() => buildMonitorEmailLog(offlineCommsRows), [offlineCommsRows])
  // Once a shop's been emailed about a monitor, it drops out of Offline (and
  // the "Start email communication" count) for the skip window, so this tab
  // only shows what still needs a follow-up.
  const isRecentlyEmailed = useCallback((m: TankMonitor) => {
    const serial = m.serial_rtu_id || m.system_tank_id || ''
    if (!serial || !m.location_id) return false
    const shopRows = offlineCommsRows.filter((r) => r.location_id === m.location_id)
    const log = backfillTodayBlanket(offlineCommsLog.get(m.location_id) ?? new Map(), shopRows, [serial])
    const last = log.get(serial)
    return last != null && (Date.now() - new Date(last).getTime()) / 86400000 < skipDays
  }, [offlineCommsRows, offlineCommsLog, skipDays])
  // Exactly the badge's criteria — VMI/keepfill only (not the tab toggle),
  // assigned to a shop, offline, not ignored, not recently emailed. The
  // sidebar counts distinct shops across these.
  const alertMonitors = useMemo(() => filtered.filter((m) => {
    if (!m.location_id || !m.keep_fill) return false
    const t = readingTime(m); if (t == null || latestReading - t <= 86400000) return false
    if (monitorIgnore.includes(monitorIgnoreKey(m))) return false
    if (skipEnabled && isRecentlyEmailed(m)) return false
    return true
  }), [filtered, latestReading, skipEnabled, isRecentlyEmailed, monitorIgnore])
  const alertShopCount = useMemo(
    () => new Set(alertMonitors.map((m) => m.location_id)).size,
    [alertMonitors],
  )

  const offline = useMemo(() => filtered.filter((m) => {
    if (offlineVmiOnly && !m.keep_fill) return false
    const t = readingTime(m); if (t == null || latestReading - t <= 86400000) return false
    if (monitorIgnore.includes(monitorIgnoreKey(m))) return false
    if (skipEnabled && isRecentlyEmailed(m)) return false
    return true
  }), [filtered, latestReading, offlineVmiOnly, skipEnabled, isRecentlyEmailed, monitorIgnore])

  // Count of low-VMI shops (mirrors LowVmiView) for the tab badge.
  const lowVmiCount = useMemo(() => {
    const keepfillByShop = new Map<string, number>()
    for (const m of filtered) { if (!m.location_id || !m.keep_fill) continue; keepfillByShop.set(m.location_id, (keepfillByShop.get(m.location_id) ?? 0) + 1) }
    return loc.locations.filter((l) => {
      if (!l.active || isExcluded(l)) return false
      if (shopFilter && l.id !== shopFilter) return false
      if (amFilter && metaOf(l, 'area_manager') !== amFilter) return false
      if (ignored.includes(l.id)) return false
      return (keepfillByShop.get(l.id) ?? 0) < 4
    }).length
  }, [filtered, loc.locations, isExcluded, shopFilter, amFilter, ignored])

  const areaManagers = useMemo(() => [...new Set(loc.locations.filter((l) => !isExcluded(l)).map((l) => metaOf(l, 'area_manager')).filter(Boolean))].sort(), [loc.locations, isExcluded])
  const shopOptions = useMemo(() => loc.locations.filter((l) => l.active && !isExcluded(l)).map((l) => ({ value: l.id, label: l.shop_city || l.name })).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })), [loc.locations, isExcluded])

  // Group a monitor list into one email target per shop (sorted by shop label).
  const groupTargets = useCallback((rows: TankMonitor[]): EmailTarget[] => {
    const m = new Map<string, TankMonitor[]>()
    for (const r of rows) { if (!r.location_id) continue; if (!m.has(r.location_id)) m.set(r.location_id, []); m.get(r.location_id)!.push(r) }
    return [...m.entries()].map(([locationId, monitors]) => ({ locationId, monitors }))
      .sort((a, b) => ctx.shopOf(a.locationId).localeCompare(ctx.shopOf(b.locationId), undefined, { numeric: true }))
  }, [ctx])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Tank Monitors</h1>
          <p className="text-xs text-inky mt-0.5">All monitors across shops. Match unassigned shops, spot offline monitors, and find low VMI coverage.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate('/config?tab=tank-monitor')}>Upload / Update Data ↗</Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="w-60"><Combobox options={[{ value: '', label: 'All shops' }, ...shopOptions]} value={shopFilter} onChange={setShopFilter} placeholder="Filter by shop…" /></div>
        <div className="w-80"><Combobox options={[{ value: '', label: 'All area managers' }, ...areaManagers.map((a) => ({ value: a, label: a }))]} value={amFilter} onChange={setAmFilter} placeholder="Filter by area manager…" /></div>
        {(shopFilter || amFilter) && <button onClick={() => { setShopFilter(''); setAmFilter('') }} className="text-[11px] font-mono text-inky hover:text-navy hover:underline">Clear filters</button>}
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          <TabsTrigger value="alerts">Alerts{alertShopCount ? ` (${alertShopCount})` : ''}</TabsTrigger>
          <TabsTrigger value="all">All Monitors ({filtered.length})</TabsTrigger>
          <TabsTrigger value="offline">Offline ({offline.length})</TabsTrigger>
          <TabsTrigger value="lowvmi">Low VMI Coverage{lowVmiCount ? ` (${lowVmiCount})` : ''}</TabsTrigger>
          <TabsTrigger value="mapping">Product Mapping{unmatchedProducts.length ? ` (${unmatchedProducts.length})` : ''}</TabsTrigger>
          <TabsTrigger value="templates">Email Templates</TabsTrigger>
        </TabsList>

        <TabsContent value="all">
          {loading || !matchIgnoreLoaded ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div> : (
            <div className="flex flex-col gap-4">
              {matchIgnore.length > 0 && (
                <div className="text-[11px] font-mono">
                  <button onClick={() => setShowIgnored((o) => !o)} className="text-inky hover:text-navy hover:underline">
                    {matchIgnore.length} unassigned shop{matchIgnore.length !== 1 ? 's' : ''} ignored {showIgnored ? '▾' : '▸'}
                  </button>
                  {showIgnored && (
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      {matchIgnore.map((s) => (
                        <span key={s} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-navy">
                          {s || '(blank)'}<button onClick={() => setMatchIgnore(matchIgnore.filter((x) => x !== s))} title="Un-ignore" className="text-inky/50 hover:text-[#C0392B]">✕</button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {unassigned.length > 0 && <UnassignedMatcher rows={unassigned} shopOptions={shopOptions} companyId={companyId} onMatched={load} onReloadLocations={loc.reload} matchIgnore={matchIgnore} setMatchIgnore={setMatchIgnore} />}
              <MonitorTable rows={filtered} ctx={ctx} shopOf={ctx.shopOf} />
            </div>
          )}
        </TabsContent>

        {/* Alerts — the shops behind the sidebar count. Same rules as Offline
            but always VMI-only and shop-assigned, since that's what the badge
            counts; no toggles here so the two can't drift apart. */}
        <TabsContent value="alerts">
          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : alertMonitors.length === 0 ? (
            <p className="text-xs font-mono text-inky/50 py-8">
              Nothing needs action — every VMI monitor is reporting, ignored, or already emailed within the last {skipDays} days.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3 mb-3 flex-wrap">
                <span className="text-xs font-body text-inky">
                  <strong className="text-navy">{alertShopCount}</strong> shop{alertShopCount !== 1 ? 's' : ''} need action —
                  {' '}{alertMonitors.length} offline VMI monitor{alertMonitors.length !== 1 ? 's' : ''} not yet emailed about.
                </span>
                <Button size="sm" className="ml-auto" onClick={() => { setEmailTargets(groupTargets(alertMonitors)); setEmailKind('offline') }}>
                  <Mail className="w-3.5 h-3.5 mr-1" /> Start email communication ({groupTargets(alertMonitors).length})
                </Button>
              </div>
              <MonitorTable rows={alertMonitors} ctx={ctx} shopOf={ctx.shopOf}
                onIgnore={(m) => { setMonitorIgnore([...monitorIgnore, monitorIgnoreKey(m)]); refreshNavBadges() }} />
            </>
          )}
        </TabsContent>

        <TabsContent value="offline">
          <div className="flex items-center gap-3 mb-2 flex-wrap">
            <label className="flex items-center gap-1.5 text-xs font-mono text-navy">
              <input type="checkbox" checked={skipEnabled} onChange={(e) => setSkipEnabled(e.target.checked)} className="accent-sky" />
              Skip tanks emailed in last
              <input type="number" min={1} value={skipDays} disabled={!skipEnabled}
                onChange={(e) => setSkipDays(Math.max(1, Number(e.target.value) || 1))}
                className="w-12 bg-cream border border-navy/30 rounded px-1 py-0.5 text-center disabled:opacity-40" />
              days
            </label>
          </div>
          <div className="flex items-center gap-3 mb-3 flex-wrap">
            <Toggle checked={offlineVmiOnly} onChange={setOfflineVmiOnly} label="VMI/keepfill only" color="cyan" />
            <span className="text-[11px] font-mono text-inky/50">Non-VMI tanks going quiet usually don't matter.</span>
            {offline.length > 0 && (
              <Button size="sm" className="ml-auto" onClick={() => { setEmailTargets(groupTargets(offline)); setEmailKind('offline') }}>
                <Mail className="w-3.5 h-3.5 mr-1" /> Start email communication ({groupTargets(offline).length})
              </Button>
            )}
          </div>
          {monitorIgnore.length > 0 && (
            <div className="text-[11px] font-mono mb-2">
              <button onClick={() => setShowIgnoredMonitors((o) => !o)} className="text-inky/60 hover:text-navy hover:underline">
                {monitorIgnore.length} monitor{monitorIgnore.length !== 1 ? 's' : ''} ignored {showIgnoredMonitors ? '▾' : '▸'}
              </button>
              {showIgnoredMonitors && (
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                  {monitorIgnore.map((key) => {
                    const m = monitors.find((mo) => monitorIgnoreKey(mo) === key)
                    const label = m ? `${ctx.shopOf(m.location_id)} — ${ctx.internalOf(m.product_id)}` : key
                    return (
                      <span key={key} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-navy">
                        {label}
                        <button onClick={() => { setMonitorIgnore(monitorIgnore.filter((x) => x !== key)); refreshNavBadges() }} title="Un-ignore this monitor" className="text-inky/50 hover:text-[#C0392B]">✕</button>
                      </span>
                    )
                  })}
                  <button onClick={() => { setMonitorIgnore([]); refreshNavBadges() }} className="text-inky/50 hover:text-navy hover:underline self-center">reset all</button>
                </div>
              )}
            </div>
          )}
          {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : offline.length === 0 ? <p className="text-xs font-mono text-inky/50 py-8">No offline monitors — all reported within 1 day of the latest upload.</p>
            : <MonitorTable rows={offline} ctx={ctx} shopOf={ctx.shopOf}
                onIgnore={(m) => { setMonitorIgnore([...monitorIgnore, monitorIgnoreKey(m)]); refreshNavBadges() }} />}
        </TabsContent>

        <TabsContent value="lowvmi">
          <LowVmiView monitors={filtered} loc={loc} isExcluded={isExcluded} shopFilter={shopFilter} amFilter={amFilter} ignored={ignored} setIgnored={setIgnored} ctx={ctx}
            skipEnabled={skipEnabled} setSkipEnabled={setSkipEnabled} skipDays={skipDays} setSkipDays={setSkipDays} lowVmiCommsRows={lowVmiCommsRows}
            onStartEmail={(targets) => { setEmailTargets(targets); setEmailKind('lowvmi') }} />
        </TabsContent>

        <TabsContent value="mapping">
          <TankProductMapping map={prodMap} onChange={setProdMap} unmatched={unmatchedProducts} allTankProducts={tankProducts} ourOptions={ourOptions} />
        </TabsContent>

        <TabsContent value="templates">
          <TankEmailTemplates offline={offlineTpl} lowvmi={lowvmiTpl} onSave={saveTpl} />
        </TabsContent>
      </Tabs>

      {emailKind && (
        <TankEmailModal
          open
          onClose={() => setEmailKind(null)}
          kind={emailKind}
          template={emailKind === 'offline' ? offlineTpl : lowvmiTpl}
          targets={emailTargets}
          internalOf={ctx.internalOf}
          onLogged={loadCommsLog}
        />
      )}
    </div>
  )
}

// ── Monitor table: click-header sort + shared Manage Columns modal ───────────
function MonitorTable({ rows, ctx, shopOf, onIgnore }: { rows: TankMonitor[]; ctx: Ctx; shopOf: (id: string | null) => string; onIgnore?: (m: TankMonitor) => void }) {
  // `shown` is the ordered list of visible column ids (managed by the shared
  // ColumnManagerModal). The Shop column is always shown + sticky, separately.
  const [shown, setShown] = useState<string[]>(() => {
    try { const s = JSON.parse(localStorage.getItem(SHOWN_KEY) || 'null'); if (Array.isArray(s) && s.length) { const k = s.filter((id: string) => DEFAULT_ORDER.includes(id)); if (k.length) return k } } catch { /* ignore */ }
    return DEFAULT_ORDER
  })
  const [mgrOpen, setMgrOpen] = useState(false)
  const [sort, setSort] = useState<{ id: string; dir: 'asc' | 'desc' } | null>(null)
  useEffect(() => { localStorage.setItem(SHOWN_KEY, JSON.stringify(shown)) }, [shown])
  const colOf = (id: string) => COLS.find((c) => c.id === id)!

  const sortVal = useCallback((m: TankMonitor, id: string): string | number | null => {
    if (id === 'shop') return shopOf(m.location_id)
    const c = colOf(id); return c?.sort ? c.sort(m, ctx) : null
  }, [ctx, shopOf])

  const sorted = useMemo(() => {
    if (!sort) return rows
    return [...rows].sort((a, b) => {
      const av = sortVal(a, sort.id), bv = sortVal(b, sort.id)
      if (av == null && bv == null) return 0; if (av == null) return 1; if (bv == null) return -1
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })
      return sort.dir === 'asc' ? cmp : -cmp
    })
  }, [rows, sort, sortVal])

  const toggleSort = (id: string) => setSort((s) => (s?.id === id ? (s.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'asc' }))
  const arrow = (id: string) => (sort?.id === id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

  const thBase = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky top-0 z-20 cursor-pointer select-none hover:text-navy'
  const tdBase = 'px-2 py-1.5 border-b border-navy/15 whitespace-nowrap text-navy'
  const stickyShop = 'sticky left-0 z-30 w-[170px] min-w-[170px]'

  const cellText = (id: string, m: TankMonitor): string => {
    if (id === 'keepfill') return m.keep_fill ? 'VMI' : ''
    if (id === 'internal') return ctx.internalOf(m.product_id)
    if (id === 'inventory_time') return dt(m.inventory_time ?? m.reading_date)
    if (id === 'updated_at') return dt(m.updated_at)
    const c = colOf(id); const v = c.sort ? c.sort(m, ctx) : null
    return v == null ? '' : String(v)
  }
  async function copyTable() {
    const header = ['Shop', ...shown.map((id) => colOf(id).label)].join('\t')
    const body = sorted.map((m) => [shopOf(m.location_id), ...shown.map((id) => cellText(id, m))].join('\t'))
    try { await navigator.clipboard.writeText([header, ...body].join('\n')); toast.success('Copied to clipboard') }
    catch { toast.error('Copy failed') }
  }

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No monitors for this view.</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end gap-2">
        <button onClick={copyTable} title="Copy table for email" className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy"><Copy className="w-3 h-3" /> Copy</button>
        <button onClick={() => setMgrOpen(true)} className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy"><Columns3 className="w-3 h-3" /> Manage Columns</button>
      </div>
      <div className="overflow-auto max-h-[calc(100vh-18rem)] rounded border border-navy/30">
        <table className="text-xs font-mono border-collapse">
          <thead>
            <tr>
              <th className={`${thBase} ${stickyShop} left-0 z-40`} onClick={() => toggleSort('shop')} title="Sort by shop">Shop{arrow('shop')}</th>
              {shown.map((id) => (
                <th key={id} className={thBase} onClick={() => toggleSort(id)} title="Sort by this column">{colOf(id).label}{arrow(id)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((m, idx) => {
              // Opaque bands so the sticky Shop column can share them (a
              // translucent band would let scrolled columns bleed through).
              const band = idx % 2 ? 'bg-[#ECEBD8] dark:bg-[#0D2035]' : 'bg-cream'
              return (
                <tr key={m.id} className={band}>
                  <td className={`${tdBase} sticky left-0 z-10 ${band} ${stickyShop} font-semibold`}>
                    <div className="flex items-center gap-1">
                      {onIgnore && (
                        <button onClick={() => onIgnore(m)} title="Ignore this monitor" className="flex-shrink-0 text-inky/40 hover:text-[#C0392B]">
                          <EyeOff className="w-3 h-3" />
                        </button>
                      )}
                      <span className="truncate" title={shopOf(m.location_id)}>{shopOf(m.location_id)}</span>
                    </div>
                  </td>
                  {shown.map((id) => <td key={id} className={tdBase}>{colOf(id).render(m, ctx)}</td>)}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ColumnManagerModal
        open={mgrOpen}
        onClose={() => setMgrOpen(false)}
        all={COLS.map((c) => ({ id: c.id, label: c.label }))}
        shown={shown}
        onChange={setShown}
        onReset={() => setShown(DEFAULT_ORDER)}
      />
    </div>
  )
}

// ── Unassigned shop matcher ─────────────────────────────────────────────────
function UnassignedMatcher({ rows, shopOptions, companyId, onMatched, onReloadLocations, matchIgnore, setMatchIgnore }: {
  rows: TankMonitor[]; shopOptions: { value: string; label: string }[]; companyId: string; onMatched: () => void; onReloadLocations: () => void
  matchIgnore: string[]; setMatchIgnore: (v: string[]) => void
}) {
  // Group by the normalized ignore key so an ignored shop stays hidden across
  // re-uploads; keep a representative raw source_location for the DB match.
  const groups = useMemo(() => {
    const m = new Map<string, { count: number; raw: string }>()
    for (const r of rows) { const k = srcKey(r.source_location); const g = m.get(k); if (g) g.count += 1; else m.set(k, { count: 1, raw: r.source_location ?? '' }) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [rows])
  const [pick, setPick] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  async function match(key: string, raw: string) {
    const locationId = pick[key]
    if (!locationId) { toast.error('Pick a shop to match'); return }
    setBusy(key)
    const sb = supabase as any
    // Add the POS mapping + assign existing unmatched rows with this source.
    const { error: mapErr } = await sb.schema('core').from('pos_location_map').insert({ company_id: companyId, pos_string: raw, location_id: locationId })
    if (mapErr && !String(mapErr.message).toLowerCase().includes('duplicate')) { toast.error(mapErr.message); setBusy(null); return }
    const { error: updErr } = await sb.schema('inventory').from('tank_monitors').update({ location_id: locationId }).eq('company_id', companyId).eq('source_location', raw)
    if (updErr) { toast.error(updErr.message); setBusy(null); return }
    toast.success('Shop matched'); setBusy(null); onReloadLocations(); onMatched()
  }

  return (
    <Card className="border-[#E67E22]/40 bg-[#E67E22]/5">
      <CardBody className="flex flex-col gap-2">
        <div className="text-[10px] font-mono uppercase tracking-widest text-[#E67E22] font-bold">Unassigned shops ({groups.length}) — match to a location</div>
        <p className="text-[11px] font-mono text-inky/60">These monitor rows didn't match a location via the POS mapping. Matching adds the mapping to Global Config → Location Mapping.</p>
        <div className="flex flex-col gap-1.5">
          {groups.map(([key, { count, raw }]) => (
            <div key={key} className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-mono text-navy w-48 truncate" title={key}>{key}</span>
              <span className="text-[10px] font-mono text-inky/50">{count} monitor(s)</span>
              <div className="w-56"><Combobox options={shopOptions} value={pick[key] ?? ''} onChange={(v) => setPick((p) => ({ ...p, [key]: v }))} placeholder="Match to shop…" /></div>
              <Button size="sm" loading={busy === key} onClick={() => match(key, raw)} disabled={!pick[key]}>Match</Button>
              <button onClick={() => setMatchIgnore([...matchIgnore, key])} className="text-[11px] font-mono text-inky hover:text-navy hover:underline" title="Hold — stays ignored across uploads">Ignore</button>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  )
}

// ── Low VMI coverage ────────────────────────────────────────────────────────
function LowVmiView({ monitors, loc, isExcluded, shopFilter, amFilter, ignored, setIgnored, ctx, skipEnabled, setSkipEnabled, skipDays, setSkipDays, lowVmiCommsRows, onStartEmail }: {
  monitors: TankMonitor[]; loc: ReturnType<typeof useLocations>; isExcluded: (l: Location) => boolean; shopFilter: string; amFilter: string; ignored: string[]; setIgnored: (v: string[]) => void; ctx: Ctx
  skipEnabled: boolean; setSkipEnabled: (v: boolean) => void; skipDays: number; setSkipDays: (v: number) => void
  lowVmiCommsRows: { location_id: string | null; comm_date: string | null; updated_at: string; products: unknown }[]
  onStartEmail: (targets: EmailTarget[]) => void
}) {
  const [showIgnoredList, setShowIgnoredList] = useState(false)
  const byShop = useMemo(() => {
    const m = new Map<string, TankMonitor[]>()
    for (const mon of monitors) { if (!mon.location_id) continue; if (!m.has(mon.location_id)) m.set(mon.location_id, []); m.get(mon.location_id)!.push(mon) }
    return m
  }, [monitors])

  // Once a shop's been emailed about its low VMI coverage, it drops out for
  // the skip window — matches the Offline tab's "skip tanks emailed" toggle.
  const lowVmiLog = useMemo(() => buildMonitorEmailLog(lowVmiCommsRows), [lowVmiCommsRows])
  const isRecentlyEmailed = useCallback((locationId: string) => {
    const serials = (byShop.get(locationId) ?? []).filter((m) => m.keep_fill).map((m) => m.serial_rtu_id || m.system_tank_id || '')
    const shopRows = lowVmiCommsRows.filter((r) => r.location_id === locationId)
    const log = backfillTodayBlanket(lowVmiLog.get(locationId) ?? new Map(), shopRows, serials)
    if (log.size === 0) return false
    const mostRecent = [...log.values()].reduce((a, b) => (a > b ? a : b))
    return (Date.now() - new Date(mostRecent).getTime()) / 86400000 < skipDays
  }, [byShop, lowVmiLog, lowVmiCommsRows, skipDays])

  const shops = useMemo(() => loc.locations.filter((l) => {
    if (!l.active || isExcluded(l)) return false
    if (shopFilter && l.id !== shopFilter) return false
    if (amFilter && metaOf(l, 'area_manager') !== amFilter) return false
    const keepfill = (byShop.get(l.id) ?? []).filter((mo) => mo.keep_fill).length
    return keepfill < 4
  }).sort((a, b) => (a.shop_city || a.name).localeCompare(b.shop_city || b.name, undefined, { numeric: true })), [loc.locations, byShop, shopFilter, amFilter, isExcluded])

  const visible = shops.filter((l) => !ignored.includes(l.id) && !(skipEnabled && isRecentlyEmailed(l.id)))
  const toggleIgnore = (id: string) => setIgnored(ignored.includes(id) ? ignored.filter((x) => x !== id) : [...ignored, id])
  const emailTargets = (): EmailTarget[] => visible.map((l) => ({ locationId: l.id, monitors: (byShop.get(l.id) ?? []).filter((m) => m.keep_fill) }))

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-1.5 text-xs font-mono text-navy">
        <input type="checkbox" checked={skipEnabled} onChange={(e) => setSkipEnabled(e.target.checked)} className="accent-sky" />
        Skip tanks emailed in last
        <input type="number" min={1} value={skipDays} disabled={!skipEnabled}
          onChange={(e) => setSkipDays(Math.max(1, Number(e.target.value) || 1))}
          className="w-12 bg-cream border border-navy/30 rounded px-1 py-0.5 text-center disabled:opacity-40" />
        days
      </label>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs font-mono text-inky/60">Shops with fewer than 4 monitors on VMI/Keepfill. Ignore shops that will never need more.</p>
        {visible.length > 0 && (
          <Button size="sm" onClick={() => onStartEmail(emailTargets())}>
            <Mail className="w-3.5 h-3.5 mr-1" /> Start email communication ({visible.length})
          </Button>
        )}
      </div>
      {visible.length === 0 ? <p className="text-xs font-mono text-inky/50 py-6">All shops meet the 4-monitor VMI threshold (or are ignored).</p> : visible.map((l) => {
        const mons = byShop.get(l.id) ?? []
        const keepfill = mons.filter((m) => m.keep_fill).length
        return (
          <Card key={l.id}>
            <CardBody className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-heading font-bold text-navy">{l.shop_city || l.name}</span>
                  <Badge color={keepfill === 0 ? 'red' : 'orange'}>{keepfill} on VMI</Badge>
                  <span className="text-[10px] font-mono text-inky/50">{mons.length} total monitor(s)</span>
                </div>
                <button onClick={() => toggleIgnore(l.id)} className="text-[11px] font-mono text-inky hover:text-navy hover:underline">Ignore</button>
              </div>
              {mons.length === 0 ? (
                <span className="text-xs font-body italic text-inky/50">No monitors configured</span>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {mons.map((m) => (
                    <span key={m.id} className="inline-flex items-center gap-1 rounded border border-navy/15 bg-navy/[0.03] px-2 py-0.5 text-[11px] font-mono text-navy">
                      {ctx.internalOf(m.product_id)}{m.keep_fill && <Badge color="sky">VMI</Badge>}
                    </span>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        )
      })}
      {ignored.length > 0 && (
        <div className="text-[11px] font-mono">
          <button onClick={() => setShowIgnoredList((o) => !o)} className="text-inky/60 hover:text-navy hover:underline">
            {ignored.length} shop{ignored.length !== 1 ? 's' : ''} ignored {showIgnoredList ? '▾' : '▸'}
          </button>
          {showIgnoredList && (
            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {ignored.map((id) => (
                <span key={id} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-navy">
                  {loc.byId(id)?.shop_city || loc.byId(id)?.name || id}
                  <button onClick={() => setIgnored(ignored.filter((x) => x !== id))} title="Un-ignore this shop" className="text-inky/50 hover:text-[#C0392B]">✕</button>
                </span>
              ))}
              <button onClick={() => setIgnored([])} className="text-inky/50 hover:text-navy hover:underline self-center">reset all</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
