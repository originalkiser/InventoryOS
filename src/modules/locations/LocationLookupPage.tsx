import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapPin, Settings } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Badge, Button, Card, CardBody, Combobox, Modal, SbLoader } from '@/components/ui'
import { IssueFormModal } from '@/modules/issues/IssueFormModal'
import { ExceptionReportModal } from '@/modules/exceptions/ExceptionReportModal'
import type { ExceptionReport } from '@/modules/exceptions/exceptions'
import { LocationCommsModal } from '@/modules/comms/LocationCommsModal'
import type { LocationComm } from '@/modules/comms/comms'
import { TankEmailModal } from './TankEmailModal'
import { TANK_EMAIL_DEFAULT, type TankEmailKind, type TankEmailTemplate, buildMonitorEmailLog, backfillTodayBlanket, buildPendingCommSet, backfillPendingBlanket } from './tankEmail'
import { useAppSetting } from '@/hooks/useAppSetting'
import { orderDayFromDelivery } from '@/lib/orderDay'
import type { Issue, Location, MeetingNote, Project, TankMonitor } from '@/types'
import { format, differenceInCalendarDays, differenceInMonths } from 'date-fns'
import toast from 'react-hot-toast'

const LAST_SHOP_KEY = 'location-lookup:last-shop'
const VIEW_KEY = 'location-lookup:view'

interface TankRow {
  id: string; product_id: string | null; value: number | null; unit: string | null; serial_rtu_id: string | null; system_tank_id?: string | null
  on_hand: number | null; available_capacity: number | null; keep_fill: boolean | null; reading_date: string | null; inventory_time: string | null
  height: number | null; total_capacity: number | null; raw_capacity: number | null; level_inches: number | null
  updated_at?: string | null
  internal?: string // resolved internal product id (manual map → vendor parts)
}

// total_capacity is a stored generated column (on_hand + available_capacity);
// fall back to computing it for rows written before that column existed.
const tankCapacity = (t: TankRow) => t.total_capacity ?? ((t.on_hand ?? 0) + (t.available_capacity ?? 0))
// Some tanks have their working capacity (on_hand + available) deliberately
// reduced below the tank's real physical size — raw_capacity is the
// unreduced value straight from the SkyBitz feed, for comparison. Falls
// back to the (possibly-reduced) working capacity for tanks synced before
// this column existed, so it never shows blank.
const uncappedCapacity = (t: TankRow) => t.raw_capacity ?? tankCapacity(t)
// Tanks default to gallons — see normUnit below. Order-engine/product_usage
// figures are quart-based site-wide, so the On Hand view converts to match.
const toQuarts = (v: number | null, unit: string | null): number | null =>
  v == null ? null : (normUnit(unit) === 'Qts' ? v : v * 4)
interface ConfigRow {
  id: string; vendor_id: string | null; product_id: string | null
  capacity: number | null; order_trigger: number | null; order_limit: number | null
  metadata: Record<string, unknown> | null; updated_at?: string | null
  // Joined from inventory.product_usage by product_id — on hand / daily usage
  // for the On Hand / Daily Usage / Days of Supply columns.
  usage?: { on_hands: number | null; daily_usage: number | null; updated_at: string | null } | null
}
interface IssueRow {
  id: string; title: string | null; status_id: string | null; issue_notes: string | null
  start_date: string | null; target_resolution_date: string | null; resolved_date: string | null
}

// Per-device view customization: ids hidden from each section.
interface ViewPrefs { sidebar: string[]; tank: string[]; config: string[]; nonVmiOfflineBtn?: boolean; tankView?: 'configuration' | 'onhand' }

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const dateShort = (d: string | null | undefined) => { if (!d) return '—'; try { return format(new Date(d), 'MMM d, yyyy') } catch { return d } }
const dateTime = (d: string | null | undefined) => { if (!d) return '—'; try { return format(new Date(d), 'MMM d, yyyy · h:mm a') } catch { return d } }
const alignCls = (a: string) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left')
const metaLabel = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

// Newest timestamp across a set of rows (checking several candidate columns),
// returned as "MM-dd-yyyy" for the "last updated" card callouts. null if none.
function lastUpdated(rows: Array<Record<string, any>>, keys: string[]): string | null {
  let best = 0
  for (const r of rows) for (const k of keys) {
    const v = r?.[k]; if (!v) continue
    const t = new Date(v).getTime(); if (!isNaN(t) && t > best) best = t
  }
  if (!best) return null
  try { return format(new Date(best), 'MM-dd-yyyy') } catch { return null }
}

// Small "Updated MM-DD-YYYY" callout shown under a card header.
function UpdatedCallout({ date, onOpen, openTitle }: { date: string | null; onOpen?: () => void; openTitle?: string }) {
  if (!date && !onOpen) return null
  if (!onOpen) {
    return (
      <span className="self-start inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-sky/30 text-navy">
        Updated {date}
      </span>
    )
  }
  return (
    <button onClick={onOpen} title={openTitle ?? 'Open config'}
      className="group self-start inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono bg-sky/30 text-navy hover:bg-sky/50 transition-colors">
      {date ? `Updated ${date}` : 'Open config'}
      <span className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/60">↗</span>
    </button>
  )
}

// "2y 3m" / "8m" since a date — used for acquisition age.
function sinceLabel(dateStr: string): string | null {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  const months = differenceInMonths(new Date(), d)
  if (months < 0) return null
  const y = Math.floor(months / 12), m = months % 12
  if (y && m) return `${y}y ${m}m`
  return y ? `${y}y` : `${m}m`
}

// Normalize a tank unit string to a compact label. Tanks default to gallons.
const normUnit = (u: string | null | undefined): string | null => {
  if (!u) return null
  const s = u.trim().toLowerCase()
  if (s.startsWith('gal')) return 'Gal'
  if (s.startsWith('q')) return 'Qts'
  return null
}

// Relative callout for a weekday name vs today ("today" / "tomorrow" / "in 3 days" / "2 days ago").
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
function relativeDay(dayName: string): string | null {
  if (!dayName) return null
  const s = dayName.trim().toLowerCase()
  let target = WEEKDAYS.indexOf(s)
  if (target < 0) target = WEEKDAYS.findIndex((w) => w.startsWith(s.slice(0, 3)))
  if (target < 0) return null
  const today = new Date().getDay()
  const ahead = (target - today + 7) % 7 // days until next occurrence (0 = today)
  const ago = (today - target + 7) % 7 // days since last occurrence
  if (ahead === 0) return 'today'
  if (ahead === 1) return 'tomorrow'
  if (ago === 1) return 'yesterday'
  return ahead <= ago ? `in ${ahead} days` : `${ago} days ago`
}

// Read a location field: base column first, then metadata fallback.
function locVal(loc: Location | undefined, key: string): string {
  if (!loc) return ''
  const base = (loc as any)[key]
  if (base != null && base !== '') return String(base)
  const meta = (loc.metadata as any)?.[key]
  return meta == null ? '' : String(meta)
}

interface Col<T> { id: string; label: string; align: 'left' | 'right' | 'center'; render: (r: T) => ReactNode; sort?: (r: T) => string | number | null; tint?: boolean }

type SortState = { id: string; dir: 'asc' | 'desc' } | null
function applySort<T>(rows: T[], cols: Col<T>[], sort: SortState): T[] {
  if (!sort) return rows
  const col = cols.find((c) => c.id === sort.id)
  if (!col?.sort) return rows
  const get = col.sort
  return [...rows].sort((a, b) => {
    const av = get(a), bv = get(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })
    return sort.dir === 'asc' ? cmp : -cmp
  })
}
const nextSort = (cur: SortState, id: string): SortState => (cur?.id === id ? (cur.dir === 'asc' ? { id, dir: 'desc' } : null) : { id, dir: 'asc' })
const sortArrow = (sort: SortState, id: string) => (sort?.id === id ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '')

// Sort state persisted per table key, so a chosen column/direction survives
// refreshes and returns (localStorage — indefinite, not session-only).
function usePersistedSort(key: string) {
  const [sort, setSort] = useState<SortState>(() => {
    try { const raw = localStorage.getItem(key); if (raw) { const v = JSON.parse(raw); if (v && typeof v.id === 'string' && (v.dir === 'asc' || v.dir === 'desc')) return v as SortState } } catch { /* ignore */ }
    return null
  })
  useEffect(() => {
    try { if (sort) localStorage.setItem(key, JSON.stringify(sort)); else localStorage.removeItem(key) } catch { /* ignore */ }
  }, [key, sort])
  return [sort, setSort] as const
}

const TANK_COLS: Col<TankRow>[] = [
  { id: 'product', label: 'Product', align: 'left', render: (t) => t.product_id ?? '—', sort: (t) => t.product_id },
  { id: 'internal', label: 'Product ID', align: 'left', render: (t) => t.internal || t.product_id || '—', sort: (t) => t.internal || t.product_id },
  { id: 'serial', label: 'Serial #', align: 'left', render: (t) => t.serial_rtu_id ?? '—', sort: (t) => t.serial_rtu_id },
  { id: 'on_hand', label: 'On Hand', align: 'right', render: (t) => num(t.on_hand), sort: (t) => t.on_hand },
  { id: 'level_inches', label: 'Level (in)', align: 'right', render: (t) => num(t.level_inches), sort: (t) => t.level_inches },
  { id: 'available', label: 'Available', align: 'right', render: (t) => num(t.available_capacity), sort: (t) => t.available_capacity },
  { id: 'total_capacity', label: 'Capacity', align: 'right', render: (t) => num(tankCapacity(t)), sort: (t) => tankCapacity(t) },
  { id: 'uncapped_capacity', label: 'Uncapped Capacity', align: 'right', render: (t) => num(uncappedCapacity(t)), sort: (t) => uncappedCapacity(t) },
  { id: 'height', label: 'Height', align: 'right', render: (t) => num(t.height), sort: (t) => t.height },
  { id: 'keepfill', label: 'Keepfill', align: 'center', render: (t) => (t.keep_fill ? <Badge color="sky">yes</Badge> : <span className="text-inky/40">—</span>), sort: (t) => (t.keep_fill ? 1 : 0) },
  {
    id: 'updated', label: 'Last Update', align: 'left',
    sort: (t) => { const d = t.inventory_time ?? t.reading_date; return d ? new Date(d).getTime() : null },
    render: (t) => {
      const d = t.inventory_time ?? t.reading_date
      // A monitor that hasn't reported in > 2 days reads as offline. Non-VMI
      // tanks going offline are low-priority, so flag those orange, not red.
      const stale = !!d && Date.now() - new Date(d).getTime() > 2 * 86400000
      const cls = stale ? (t.keep_fill ? 'text-[#C0392B] font-bold' : 'text-[#E67E22] font-bold') : ''
      return <span className={cls} title={stale ? 'No reading in over 2 days — monitor may be offline' : undefined}>{dateTime(d)}{stale ? ' ⚠' : ''}</span>
    },
  },
]

const CONFIG_FIXED: Col<ConfigRow>[] = [
  { id: 'part', label: 'Part', align: 'left', render: (r) => r.product_id ?? '—', sort: (r) => r.product_id },
  { id: 'uom', label: 'UOM', align: 'left', render: (r) => String((r.metadata as any)?.uom ?? '—'), sort: (r) => String((r.metadata as any)?.uom ?? '') },
  { id: 'capacity', label: 'Capacity', align: 'right', render: (r) => num(r.capacity), sort: (r) => r.capacity },
  { id: 'max', label: 'Max', align: 'right', render: (r) => num(r.order_limit), sort: (r) => r.order_limit },
  { id: 'vmi', label: 'VMI', align: 'center', render: (r) => (String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? <Badge color="sky">VMI</Badge> : <span className="text-inky/40">—</span>), sort: (r) => (String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? 1 : 0) },
]
// Metadata keys that are plumbing, not config attributes — never shown as columns.
const CONFIG_META_EXCLUDE = new Set(['vmi', 'uom', 'vendor_id', 'location_id', 'vendor_name', 'location_label'])

// On Hand / Daily Usage / Days of Supply — appended to the right of VMI,
// tinted to set them apart since they come from inventory.product_usage
// rather than the order config row itself. Days of Supply is always
// computed here (on hand ÷ daily usage), not read from the table's own
// days_of_supply column, so it stays consistent with what's displayed.
const USAGE_COLS: Col<ConfigRow>[] = [
  { id: 'on_hand', label: 'On Hand', align: 'right', tint: true, render: (r) => (r.usage?.on_hands != null ? num(r.usage.on_hands) : '—'), sort: (r) => r.usage?.on_hands ?? null },
  { id: 'daily_usage', label: 'Daily Usage', align: 'right', tint: true, render: (r) => (r.usage?.daily_usage != null ? num(r.usage.daily_usage) : '—'), sort: (r) => r.usage?.daily_usage ?? null },
  {
    id: 'days_of_supply', label: 'Days of Supply', align: 'right', tint: true,
    render: (r) => {
      const oh = r.usage?.on_hands, du = r.usage?.daily_usage
      return oh != null && du != null && du > 0 ? (oh / du).toFixed(1) : '—'
    },
    sort: (r) => { const oh = r.usage?.on_hands, du = r.usage?.daily_usage; return oh != null && du != null && du > 0 ? oh / du : null },
  },
]
const USAGE_TINT = 'bg-[#2ECC71]/10'

export function LocationDetailView({ embedded = false }: { embedded?: boolean }) {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null

  const [searchParams] = useSearchParams()
  const [shopId, setShopId] = useState<string>(() => { try { return localStorage.getItem(LAST_SHOP_KEY) ?? '' } catch { return '' } })
  // Deep-link support: /location-lookup?shop=<id> (e.g. from Inventory Alerts).
  useEffect(() => { const s = searchParams.get('shop'); if (s) setShopId(s) }, [searchParams])
  const [supplemental, setSupplemental] = useState<Record<string, string> | null>(null)
  const [tankRows, setTankRows] = useState<TankRow[]>([])
  const [vendorParts, setVendorParts] = useState<{ part_number: string | null; our_part_number: string | null; description: string | null }[]>([])
  const [prodMap] = useAppSetting<Record<string, string>>('tank_product_map', {})
  const [configs, setConfigs] = useState<ConfigRow[]>([])
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({})
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [statusNames, setStatusNames] = useState<Record<string, string>>({})
  const [exceptions, setExceptions] = useState<ExceptionReport[]>([])
  const [excModalOpen, setExcModalOpen] = useState(false)
  const [editingExc, setEditingExc] = useState<Partial<ExceptionReport> | null>(null)
  const [comms, setComms] = useState<LocationComm[]>([])
  const [commModalOpen, setCommModalOpen] = useState(false)
  const [editingComm, setEditingComm] = useState<Partial<LocationComm> | null>(null)
  const [mentionedProjects, setMentionedProjects] = useState<Project[]>([])
  const [mentionedMeetings, setMentionedMeetings] = useState<MeetingNote[]>([])
  const [tankSort, setTankSort] = usePersistedSort('location-lookup:tank-sort')
  const [emailKind, setEmailKind] = useState<TankEmailKind | null>(null)
  const [emailMonitorOverride, setEmailMonitorOverride] = useState<TankRow | null>(null)
  const [callout, setCallout] = useState<{ x: number; y: number; text: string } | null>(null)
  const [offlineTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_offline', TANK_EMAIL_DEFAULT.offline)
  const [lowvmiTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_lowvmi', TANK_EMAIL_DEFAULT.lowvmi)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // Issues modal: list toggle (pending/resolved) + inline editor.
  // editIssue: undefined = editor closed, null = new issue, object = edit existing.
  const [issuesModalOpen, setIssuesModalOpen] = useState(false)
  const [modalView, setModalView] = useState<'pending' | 'resolved'>('pending')
  const [editIssue, setEditIssue] = useState<Partial<Issue> | null | undefined>(undefined)
  const [prefs, setPrefs] = useState<ViewPrefs>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')
      return { sidebar: p.sidebar ?? [], tank: p.tank ?? [], config: p.config ?? [], nonVmiOfflineBtn: p.nonVmiOfflineBtn ?? false, tankView: p.tankView === 'onhand' ? 'onhand' : 'configuration' }
    }
    catch { return { sidebar: [], tank: [], config: [], nonVmiOfflineBtn: false, tankView: 'configuration' } }
  })
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(prefs)) } catch { /* ignore */ } }, [prefs])
  const toggleHidden = (group: 'sidebar' | 'tank' | 'config', id: string) =>
    setPrefs((p) => ({ ...p, [group]: p[group].includes(id) ? p[group].filter((x) => x !== id) : [...p[group], id] }))
  const tankView = prefs.tankView ?? 'configuration'
  const setTankView = (v: 'configuration' | 'onhand') => setPrefs((p) => ({ ...p, tankView: v }))

  // On Hand view: Droptop on-hand/usage (by resolved product id) and any
  // accepted variance baselines for this shop — both loaded in `load()`
  // below, alongside (not replacing) the existing configs-usage join.
  const [usageByProduct, setUsageByProduct] = useState<Map<string, { on_hands: number | null; daily_usage: number | null; updated_at: string | null }>>(new Map())
  const [idMappings, setIdMappings] = useState<{ old_product_id: string | null; new_product_id: string | null }[]>([])
  const [varianceBaselines, setVarianceBaselines] = useState<{ product_id: string; baseline_qty: number }[]>([])
  const [varianceModal, setVarianceModal] = useState<{ productId: string; rawVariance: number } | null>(null)
  const [savingBaseline, setSavingBaseline] = useState(false)
  const [variancePct] = useAppSetting<number>('tank_variance_cushion_pct', 14)

  const location = loc.byId(shopId)

  const load = useCallback(async () => {
    if (!companyId || !shopId) return
    setLoading(true); setError(null)
    const sb = supabase as any
    // PostgREST caps an un-ranged select at 1000 rows and truncates silently
    // (no error) — a shop with ~1200 product_usage rows was quietly losing
    // whichever ones sorted past row 1000, showing blank on-hand for them in
    // the order config with no indication anything was cut off. Same fix
    // pattern already used in droptop-sync-usage/skybitz-tank-sync for the
    // exact same failure mode.
    async function fetchAllRows(factory: (from: number, to: number) => any): Promise<any[]> {
      const PAGE = 1000
      const out: any[] = []
      let from = 0
      for (;;) {
        const { data, error } = await factory(from, from + PAGE - 1)
        if (error) break
        const batch = data ?? []
        out.push(...batch)
        if (batch.length < PAGE) break
        from += PAGE
      }
      return out
    }
    try {
      const [tankRes, cfgRes, usageRes, mapRes, vendRes, issRes, statRes, supRes, excRes, commRes, partsRes, projRes, meetRes, baselineRes] = await Promise.all([
        sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).eq('location_id', shopId).order('product_id'),
        sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('location_id', shopId),
        fetchAllRows((from, to) =>
          sb.schema('inventory').from('product_usage')
            .select('product_id, on_hands, daily_usage, updated_at')
            .eq('company_id', companyId).eq('location_id', shopId)
            .order('product_id').range(from, to)
        ).then((data) => ({ data })).catch(() => ({ data: [] })),
        sb.schema('inventory').from('product_id_mappings').select('old_product_id, new_product_id').eq('company_id', companyId).then((r: any) => r).catch(() => ({ data: [] })),
        sb.schema('inventory').from('vendors').select('id, name').eq('company_id', companyId),
        sb.schema('platform').from('issues').select('*').eq('company_id', companyId).eq('location_id', shopId).is('deleted_at', null).order('created_at', { ascending: false }),
        sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
        sb.schema('core').from('location_supplemental').select('data').eq('company_id', companyId).eq('location_id', shopId).maybeSingle().then((r: any) => r).catch(() => ({ data: null })),
        sb.schema('inventory').from('exception_reports').select('*').eq('company_id', companyId).eq('location_id', shopId).order('date_of_finding', { ascending: false, nullsFirst: false }).then((r: any) => r).catch(() => ({ data: [] })),
        sb.schema('inventory').from('location_comms').select('*').eq('company_id', companyId).eq('location_id', shopId).order('comm_date', { ascending: false, nullsFirst: false }).then((r: any) => r).catch(() => ({ data: [] })),
        // Company-wide, not location-scoped — same 1000-row cap risk as
        // product_usage above once the catalog grows past it.
        fetchAllRows((from, to) =>
          sb.schema('inventory').from('vendor_parts')
            .select('part_number, our_part_number, description')
            .eq('company_id', companyId)
            .order('id').range(from, to)
        ).then((data) => ({ data })).catch(() => ({ data: [] })),
        // Best-effort: location_ids is a newer column that may not exist yet.
        sb.schema('inventory').from('projects').select('id, project_name, status').eq('company_id', companyId).is('deleted_at', null).contains('location_ids', [shopId]).then((r: any) => r).catch(() => ({ data: [] })),
        sb.schema('inventory').from('meeting_notes').select('id, title, meeting_date').eq('company_id', companyId).contains('location_ids', [shopId]).order('meeting_date', { ascending: false, nullsFirst: false }).then((r: any) => r).catch(() => ({ data: [] })),
        // Best-effort: brand-new table, may not be migrated in production yet.
        sb.schema('inventory').from('tank_variance_baselines').select('product_id, baseline_qty').eq('company_id', companyId).eq('location_id', shopId).then((r: any) => r).catch(() => ({ data: [] })),
      ])
      // Collapse to the newest reading per tank (serial, then system id, then
      // row id) so leftover duplicate readings don't stack or inflate counts.
      const rawTanks = (tankRes.data ?? []) as TankRow[]
      const rtime = (t: TankRow) => { const v = t.inventory_time ?? t.reading_date; return v ? new Date(v).getTime() : 0 }
      const latestByTank = new Map<string, TankRow>()
      for (const t of rawTanks) {
        const key = String(t.serial_rtu_id ?? (t as any).system_tank_id ?? t.id).toLowerCase().trim()
        const ex = latestByTank.get(key)
        if (!ex || rtime(t) > rtime(ex)) latestByTank.set(key, t)
      }
      setTankRows([...latestByTank.values()])
      setVendorParts((partsRes?.data ?? []) as any[])

      // Product Usage is often still keyed by retired product ids while the
      // order config already uses the new ones. Resolve each usage row through
      // product_id_mappings (old -> new) and sum anything landing on the same
      // product, so a config row shows what's actually on hand even when the
      // usage file predates the rename.
      const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()
      const oldToNew = new Map<string, string>()
      for (const m of ((mapRes?.data ?? []) as any[])) {
        if (m.old_product_id && m.new_product_id) oldToNew.set(pkey(m.old_product_id), String(m.new_product_id))
      }
      const usageByProduct = new Map<string, { on_hands: number | null; daily_usage: number | null; updated_at: string | null }>()
      for (const u of ((usageRes?.data ?? []) as any[])) {
        if (!u.product_id) continue
        const resolved = pkey(oldToNew.get(pkey(u.product_id)) ?? u.product_id)
        const cur = usageByProduct.get(resolved)
        const add = (a: number | null, b: unknown) => (b == null ? a : (a ?? 0) + Number(b))
        usageByProduct.set(resolved, {
          on_hands: add(cur?.on_hands ?? null, u.on_hands),
          daily_usage: add(cur?.daily_usage ?? null, u.daily_usage),
          updated_at: !cur?.updated_at || (u.updated_at && u.updated_at > cur.updated_at) ? (u.updated_at ?? cur?.updated_at ?? null) : cur.updated_at,
        })
      }
      // Resolve the config row's own product_id through the same mapping
      // before looking it up — usageByProduct's keys are all post-resolution
      // (new ids), so looking a config row up by its raw (possibly still-old)
      // id missed every product a mapping actually applies to, even when the
      // config and usage rows agreed on the same literal id pre-mapping.
      const resolvedKey = (pid: string) => pkey(oldToNew.get(pkey(pid)) ?? pid)
      setConfigs(((cfgRes.data ?? []) as ConfigRow[]).map((r) => ({ ...r, usage: r.product_id ? usageByProduct.get(resolvedKey(r.product_id)) ?? null : null })))
      // Also exposed at component scope (not just baked into `configs`) —
      // the Tank Monitors "On Hand" view matches keep-fill tanks against
      // this same Droptop usage/on-hand data by their resolved product id.
      setUsageByProduct(usageByProduct)
      setIdMappings((mapRes?.data ?? []) as any[])
      setVarianceBaselines((baselineRes?.data ?? []) as any[])
      setVendorNames(Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, v.name])))
      setIssues((issRes.data ?? []) as IssueRow[])
      setStatusNames(Object.fromEntries(((statRes.data ?? []) as any[]).map((s) => [s.id, s.name])))
      setSupplemental((supRes?.data?.data ?? null) as Record<string, string> | null)
      setExceptions((excRes?.data ?? []) as ExceptionReport[])
      setComms((commRes?.data ?? []) as LocationComm[])
      setMentionedProjects((projRes?.data ?? []) as Project[])
      setMentionedMeetings((meetRes?.data ?? []) as MeetingNote[])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load location detail')
    } finally {
      setLoading(false)
    }
  }, [companyId, shopId])

  useEffect(() => { load() }, [load])
  useEffect(() => { try { if (shopId) localStorage.setItem(LAST_SHOP_KEY, shopId) } catch { /* ignore */ } }, [shopId])

  // Push, not pull: an issue, exception, or comm logged for THIS shop from
  // anywhere else in the app (another user, another tab) reloads this page
  // live — the whole point being avoided is two people finding out about
  // the same problem independently and duplicating each other's work.
  // Same postgres_changes pattern IssuesPage.tsx already uses. One
  // location_id=eq.<shopId> filter per table (Realtime only supports a
  // single column filter), events on all three coalesced into one reload
  // rather than three separate ones when e.g. an Exception Reporting comm
  // writes both a location_comms row and an exception_reports row at once.
  useEffect(() => {
    if (!companyId || !shopId) return
    let debounce: ReturnType<typeof setTimeout>
    const reload = () => { clearTimeout(debounce); debounce = setTimeout(load, 400) }
    const channel = supabase
      .channel(`location-lookup-${shopId}`)
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'issues', filter: `location_id=eq.${shopId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'exception_reports', filter: `location_id=eq.${shopId}` }, reload)
      .on('postgres_changes', { event: '*', schema: 'inventory', table: 'location_comms', filter: `location_id=eq.${shopId}` }, reload)
      .subscribe()
    return () => { clearTimeout(debounce); void supabase.removeChannel(channel) }
  }, [companyId, shopId, load])

  const configsByVendor = useMemo(() => {
    const groups = new Map<string, ConfigRow[]>()
    for (const c of configs) {
      const name = c.vendor_id ? (vendorNames[c.vendor_id] ?? 'Unassigned Vendor') : 'Unassigned Vendor'
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name)!.push(c)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [configs, vendorNames])

  // All config columns (fixed + discovered metadata) for the customize panel.
  const allConfigMetaKeys = useMemo(() => {
    const s = new Set<string>()
    for (const c of configs) for (const k of Object.keys(c.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) s.add(k)
    return [...s].sort()
  }, [configs])

  const isPending = (s: string) => { const n = s.toLowerCase(); return n.includes('pending') || n.includes('open') }
  const isResolved = (s: string) => { const n = s.toLowerCase(); return n.includes('resolved') || n.includes('closed') || n.includes('complete') }
  const pendingIssues = issues.filter((i) => isPending(statusNames[i.status_id ?? ''] ?? ''))
  const resolvedIssues = issues.filter((i) => isResolved(statusNames[i.status_id ?? ''] ?? ''))

  // Resolve each tank's internal product id (manual Product Mapping first, then
  // the Vendor Parts description/part match) and attach it to the rendered rows.
  const internalMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of vendorParts) {
      const our = p.our_part_number; if (!our) continue
      const desc = p.description ? String(p.description).toLowerCase().trim() : ''
      if (desc) m.set(desc, our)
      const pn = p.part_number ? String(p.part_number).toLowerCase().trim() : ''
      if (pn && !m.has(pn)) m.set(pn, our)
    }
    return m
  }, [vendorParts])
  const tanks = useMemo(() => tankRows.map((t) => {
    const k = t.product_id ? t.product_id.toLowerCase().trim() : ''
    return { ...t, internal: (k && (prodMap[k] || internalMap.get(k))) || t.product_id || '' }
  }), [tankRows, internalMap, prodMap])

  // On Hand view: same old-id -> new-id resolution product_usage matching
  // already uses elsewhere on this page (see load()'s configs-usage join) —
  // duplicated here rather than lifted out of load(), so that existing,
  // working join is left untouched.
  const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()
  const oldToNewMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of idMappings) if (r.old_product_id && r.new_product_id) m.set(pkey(r.old_product_id), String(r.new_product_id))
    return m
  }, [idMappings])
  const resolvedProductKey = (pid: string) => pkey(oldToNewMap.get(pkey(pid)) ?? pid)
  const baselineByProduct = useMemo(() => new Map(varianceBaselines.map((b) => [pkey(b.product_id), Number(b.baseline_qty)])), [varianceBaselines])
  // The larger of a flat qt floor and a percentage of the tank's total
  // capacity — see the Tank Monitors Settings tab for what drives the pct.
  const varianceThreshold = (capacityQt: number) => Math.max(100, (variancePct / 100) * capacityQt)

  // Keep-fill/VMI tanks only — this comparison (tank sensor vs Droptop's own
  // tracked on-hand) is specifically the VMI reconciliation use case.
  // Multiple physical tanks on the same product are combined into one row.
  interface OnHandRow {
    productId: string; tankOnHandQt: number; totalCapacityQt: number; lastUpdate: string | null; tankCount: number
    droptopOnHand: number | null; droptopUsage: number | null
    rawVariance: number | null; baseline: number | null; netVariance: number | null
    dosMonitor: number | null; dosDroptop: number | null
  }
  const onHandRows = useMemo<OnHandRow[]>(() => {
    const groups = new Map<string, { productId: string; tankOnHandQt: number; totalCapacityQt: number; lastUpdate: string | null; tankCount: number }>()
    for (const t of tanks) {
      if (!t.keep_fill) continue
      const key = t.internal || t.product_id || ''
      if (!key) continue
      const qty = toQuarts(t.on_hand, t.unit) ?? 0
      const capQt = toQuarts(tankCapacity(t), t.unit) ?? 0
      const tUpdated = t.inventory_time ?? t.reading_date
      const existing = groups.get(key)
      if (!existing) groups.set(key, { productId: key, tankOnHandQt: qty, totalCapacityQt: capQt, lastUpdate: tUpdated, tankCount: 1 })
      else {
        existing.tankOnHandQt += qty
        existing.totalCapacityQt += capQt
        existing.tankCount += 1
        if (tUpdated && (!existing.lastUpdate || tUpdated > existing.lastUpdate)) existing.lastUpdate = tUpdated
      }
    }
    return [...groups.values()]
      .sort((a, b) => a.productId.localeCompare(b.productId, undefined, { sensitivity: 'base' }))
      .map((g) => {
        const usage = usageByProduct.get(resolvedProductKey(g.productId))
        const droptopOnHand = usage?.on_hands ?? null
        const droptopUsage = usage?.daily_usage ?? null
        const rawVariance = droptopOnHand != null ? g.tankOnHandQt - droptopOnHand : null
        const baseline = baselineByProduct.get(resolvedProductKey(g.productId)) ?? null
        const netVariance = rawVariance != null ? rawVariance - (baseline ?? 0) : null
        const dosMonitor = droptopUsage && droptopUsage > 0 ? g.tankOnHandQt / droptopUsage : null
        const dosDroptop = droptopUsage && droptopUsage > 0 && droptopOnHand != null ? droptopOnHand / droptopUsage : null
        return { ...g, droptopOnHand, droptopUsage, rawVariance, baseline, netVariance, dosMonitor, dosDroptop }
      })
  }, [tanks, usageByProduct, baselineByProduct, oldToNewMap])

  async function saveVarianceBaseline(productId: string, value: number) {
    if (!companyId || !shopId) return
    setSavingBaseline(true)
    const sb = supabase as any
    const canonicalId = resolvedProductKey(productId)
    const { error: saveErr } = await sb.schema('inventory').from('tank_variance_baselines')
      .upsert({
        company_id: companyId, location_id: shopId, product_id: canonicalId,
        baseline_qty: value, accepted_by: profile?.id ?? null,
        accepted_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,location_id,product_id' })
    setSavingBaseline(false)
    if (saveErr) { toast.error('Failed to save baseline'); return }
    toast.success('New baseline accepted')
    setVarianceModal(null)
    load()
  }

  // "Last updated" for the tank card = newest reading/write across its monitors.
  const tanksUpdated = useMemo(() => lastUpdated(tankRows as any[], ['updated_at', 'inventory_time', 'reading_date']), [tankRows])

  // Keepfill tanks first, then non-keepfill — each alpha-sorted by product.
  const sortedTanks = useMemo(() => {
    const byProduct = (a: TankRow, b: TankRow) =>
      (a.product_id ?? '').localeCompare(b.product_id ?? '', undefined, { sensitivity: 'base' })
    return [...tanks.filter((t) => t.keep_fill).sort(byProduct), ...tanks.filter((t) => !t.keep_fill).sort(byProduct)]
  }, [tanks])

  // Monitors not reporting in > 2 days read as offline (matches the ⚠ marker).
  const offlineTanks = useMemo(() => {
    const now = Date.now()
    return tanks.filter((t) => { const d = t.inventory_time ?? t.reading_date; return d ? now - new Date(d).getTime() > 2 * 86400000 : false })
  }, [tanks])
  // Low VMI coverage: fewer than 4 monitors on keepfill (matches Tank Monitors page).
  const keepfillTanks = useMemo(() => tanks.filter((t) => t.keep_fill), [tanks])
  const lowVmiFlag = keepfillTanks.length < 4
  // Split offline tanks by VMI so the email button reflects urgency: VMI offline
  // is red; non-VMI offline is only surfaced (orange) when opted in via Customize.
  const vmiOffline = useMemo(() => offlineTanks.filter((t) => t.keep_fill), [offlineTanks])
  const nonVmiOffline = useMemo(() => offlineTanks.filter((t) => !t.keep_fill), [offlineTanks])
  const showOfflineBtn = vmiOffline.length > 0 || (!!prefs.nonVmiOfflineBtn && nonVmiOffline.length > 0)

  const offlineCommRows = useMemo(
    () => comms.filter((c) => c.comm_type === 'Offline Tank Monitor')
      .map((c) => ({ location_id: c.location_id, comm_date: c.comm_date, updated_at: c.updated_at, products: c.products, status: c.status })),
    [comms],
  )

  // Per-serial last-emailed dates from the Offline Monitor email log for this
  // shop — powers the "Last emailed …" callout on stale/offline readings below.
  // A same-day comm logged without specific serials (legacy rows, or logged
  // by hand outside the email flow) is backfilled to cover today's offline
  // monitors, so the callout doesn't wrongly say "not yet emailed".
  const offlineLog = useMemo(() => {
    const bySerial = buildMonitorEmailLog(offlineCommRows).get(shopId) ?? new Map<string, string>()
    const serials = offlineTanks.map((t) => t.serial_rtu_id || t.system_tank_id || '')
    return backfillTodayBlanket(bySerial, offlineCommRows, serials)
  }, [offlineCommRows, shopId, offlineTanks])

  // Still-open comm covering a monitor (any age — no skip-days window), same
  // check Tank Monitors' Alerts tab uses to exclude a monitor from the list.
  // Without this the tooltip can say "Not yet emailed" for a monitor that's
  // missing from Alerts for exactly this reason — technically true (no dated
  // log entry exists) but misleading, since the real reason is a pending
  // comm nobody's resolved yet, not that no one's reached out.
  const offlinePendingSerials = useMemo(() => {
    const base = buildPendingCommSet(offlineCommRows).get(shopId) ?? new Set<string>()
    const serials = offlineTanks.map((t) => t.serial_rtu_id || t.system_tank_id || '')
    return backfillPendingBlanket(base, offlineCommRows, serials)
  }, [offlineCommRows, shopId, offlineTanks])

  // Stale/offline "Last Update" cell — same red/orange flag as the plain
  // render below. Hovering shows a fast, custom callout (not the native
  // browser tooltip) with whether/when we emailed about it; clicking an
  // offline reading opens the email draft scoped to just that monitor.
  function renderUpdatedCell(t: TankRow) {
    const d = t.inventory_time ?? t.reading_date
    const stale = !!d && Date.now() - new Date(d).getTime() > 2 * 86400000
    const cls = stale ? (t.keep_fill ? 'text-[#C0392B] font-bold' : 'text-[#E67E22] font-bold') : ''
    let title: string | undefined
    if (stale) {
      const serial = t.serial_rtu_id || t.system_tank_id || ''
      const last = serial ? offlineLog.get(serial) : undefined
      if (last) title = `Last emailed ${format(new Date(last), 'MMM d, yyyy')}`
      else if (serial && offlinePendingSerials.has(serial)) title = 'Pending — shop/AM hasn\'t responded yet (see Location Comms)'
      else if (offlineTpl.vmiOnly !== false && !t.keep_fill) title = 'Not emailed — not on VMI/keepfill'
      else title = 'Not yet emailed'
    }
    return (
      <span
        className={`${cls} ${stale ? 'cursor-pointer hover:underline decoration-dotted' : ''}`}
        onMouseEnter={(e) => title && setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseMove={(e) => title && setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseLeave={() => setCallout(null)}
        onClick={() => { if (stale) { setEmailMonitorOverride(t); setEmailKind('offline') } }}
      >
        {dateTime(d)}{stale ? ' ⚠' : ''}
      </span>
    )
  }

  // Unit shown on the On Hand header: use a shared row unit if present, else default to gallons.
  const tankUnit = useMemo(() => {
    const units = new Set(tanks.map((t) => normUnit(t.unit)).filter(Boolean) as string[])
    return units.size === 1 ? [...units][0] : units.size === 0 ? 'Gal' : null
  }, [tanks])

  // Shop display + options use shop_city only ("234-Stockbridge") — no "### —" prefix.
  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'
  const shopOptions = useMemo(
    () => loc.locations.filter((l) => l.active && !loc.isExcluded(l)).map((l) => ({ value: l.id, label: l.shop_city || l.name }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    [loc.locations, loc.isExcluded],
  )

  function openIssues(view: 'pending' | 'resolved') { setModalView(view); setEditIssue(undefined); setIssuesModalOpen(true) }
  async function deleteIssue(id: string) {
    const { error: delErr } = await (supabase as any).schema('platform').from('issues')
      .update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (delErr) { toast.error('Failed to delete issue'); return }
    toast.success('Issue deleted'); load()
  }

  // Exceptions write the same inventory.exception_reports the Exception Reporting page reads.
  async function saveException(fields: Partial<ExceptionReport>, id?: string) {
    const sb = supabase as any
    const base = { ...fields, company_id: companyId, updated_by: profile?.id ?? null, last_change_source: 'manual', updated_at: new Date().toISOString() }
    const { error: sErr } = id
      ? await sb.schema('inventory').from('exception_reports').update(base).eq('id', id)
      : await sb.schema('inventory').from('exception_reports').insert(base)
    if (sErr) { toast.error(sErr.message); return }
    toast.success(id ? 'Exception updated' : 'Exception logged'); load()
  }
  async function deleteException(id: string) {
    const { error: delErr } = await (supabase as any).schema('inventory').from('exception_reports').delete().eq('id', id)
    if (delErr) { toast.error('Failed to delete exception'); return }
    toast.success('Exception deleted'); load()
  }
  function openAddException() { setEditingExc({ location_id: shopId }); setExcModalOpen(true) }
  function openEditException(e: ExceptionReport) { setEditingExc(e); setExcModalOpen(true) }
  function openAddComm() { setEditingComm({ location_id: shopId }); setCommModalOpen(true) }
  function openEditComm(c: LocationComm) { setEditingComm(c); setCommModalOpen(true) }
  async function deleteComm(id: string) {
    const { error: delErr } = await (supabase as any).schema('inventory').from('location_comms').delete().eq('id', id)
    if (delErr) { toast.error('Failed to delete communication'); return }
    toast.success('Communication deleted'); load()
  }

  const rdDistributor = useMemo(() => {
    if (supplemental) {
      const keys = Object.keys(supplemental)
      // Primary source: the supplemental "Confirmed Branch/AD Assignment" column.
      const confirmed = keys.find((k) => k.includes('confirmed') && k.includes('branch'))
      if (confirmed && supplemental[confirmed]) return String(supplemental[confirmed])
      const dist = keys.find((k) => k.includes('distributor'))
      if (dist && supplemental[dist]) return String(supplemental[dist])
    }
    return locVal(location, 'rd_distributor')
  }, [supplemental, location])

  const locUpdated = location ? lastUpdated([location as any], ['updated_at', 'last_synced_at']) : null
  const stateVal = locVal(location, 'state')
  const inNC = ['nc', 'north carolina'].includes(stateVal.trim().toLowerCase())
  const rdOrderDay = location ? orderDayFromDelivery(location.reladyne_delivery_day) : ''
  const rdDeliveryDay = locVal(location, 'reladyne_delivery_day')
  const addressStr = location ? [locVal(location, 'address'), locVal(location, 'city'), locVal(location, 'state'), locVal(location, 'zip')].filter(Boolean).join(', ') : ''
  const sidebar: { label: string; value: string; note?: string; mapQuery?: string }[] = location ? [
    { label: 'Location', value: locVal(location, 'shop_city') || shopLabel(shopId) },
    { label: 'Area Manager', value: locVal(location, 'area_manager') },
    { label: 'AM Cell', value: locVal(location, 'am_phone') },
    { label: 'RDO', value: locVal(location, 'director') },
    { label: 'RD Order Day', value: rdOrderDay, note: relativeDay(rdOrderDay) ?? undefined },
    { label: 'RD Delivery Day', value: rdDeliveryDay, note: relativeDay(rdDeliveryDay) ?? undefined },
    { label: 'RD Distributor', value: rdDistributor },
    { label: 'Address', value: addressStr, mapQuery: addressStr || undefined },
    { label: 'Shop Phone', value: locVal(location, 'store_phone') },
    { label: 'Acquisition Date', value: locVal(location, 'acquisition_date'), note: sinceLabel(locVal(location, 'acquisition_date')) ?? undefined },
    ...(inNC ? [{ label: 'NC Inspection Station', value: locVal(location, 'inspection_station_id') }] : []),
  ] : []

  const visibleSidebar = sidebar.filter((f) => !prefs.sidebar.includes(f.label))
  const visibleTankCols = TANK_COLS.filter((c) => !prefs.tank.includes(c.id))

  // Copy the (sorted, visible) tank table as a formatted HTML table (with a
  // plain-text fallback) so it pastes into email with gridlines + banded rows.
  async function copyTanks() {
    const cols = visibleTankCols
    const rows = tankSort ? applySort(tanks, TANK_COLS, tankSort) : sortedTanks
    const unitCols = new Set(['on_hand', 'available', 'total_capacity', 'uncapped_capacity'])
    const label = (c: Col<TankRow>) => (unitCols.has(c.id) && tankUnit ? `${c.label} (${tankUnit})` : c.label)
    // Every id in TANK_COLS needs a case here — anything unhandled falls to
    // `default` and silently copies as an empty cell (which is how the
    // "Product ID (Internal)" column ended up blank in pasted tables).
    const text = (c: Col<TankRow>, t: TankRow): string => {
      switch (c.id) {
        case 'product': return t.product_id ?? ''
        case 'internal': return t.internal || t.product_id || ''
        case 'serial': return t.serial_rtu_id ?? ''
        case 'on_hand': return t.on_hand == null ? '' : String(t.on_hand)
        case 'available': return t.available_capacity == null ? '' : String(t.available_capacity)
        case 'total_capacity': return String(tankCapacity(t))
        case 'uncapped_capacity': return String(uncappedCapacity(t))
        case 'level_inches': return t.level_inches == null ? '' : String(t.level_inches)
        case 'height': return t.height == null ? '' : String(t.height)
        case 'keepfill': return t.keep_fill ? 'yes' : ''
        case 'updated': return dateTime(t.inventory_time ?? t.reading_date)
        default: return ''
      }
    }
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const align = (c: Col<TankRow>) => (c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : 'left')

    const title = `${shopLabel(shopId)} — Tank Monitors (Configuration)`
    // Bold <td> rather than <th>: Outlook/Word drop the colour off <th> and
    // fall back to black. That fallback used to land on a navy fill (white
    // text intended) — unreadable once the color's dropped. Header fill is
    // sky blue instead so the same black fallback stays legible; the intended
    // color is also wrapped in a legacy <font color> tag for when it does
    // survive. Same fix as tableHtml() in tankEmail.ts.
    const thStyle = (c: Col<TankRow>) => `border:1px solid #002745;background:#B7E0DE;color:#002745;padding:4px 8px;text-align:${align(c)};font-weight:bold;`
    const head = `<tr>${cols.map((c) => `<td style="${thStyle(c)}"><font color="#002745">${esc(label(c))}</font></td>`).join('')}</tr>`
    const body = rows.map((t, i) => {
      const bg = i % 2 ? '#F2F1E6' : '#FFFFFF'
      return `<tr>${cols.map((c) => `<td style="border:1px solid #4F7489;padding:3px 8px;text-align:${align(c)};background:${bg};">${esc(text(c, t))}</td>`).join('')}</tr>`
    }).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#002745;">`
      + `<div style="font-weight:bold;margin-bottom:4px;">${esc(title)}</div>`
      + `<table style="border-collapse:collapse;font-size:12px;"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    const plain = [title, cols.map(label).join('\t'), ...rows.map((t) => cols.map((c) => text(c, t)).join('\t'))].join('\n')

    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(plain)
      }
      toast.success('Copied to clipboard')
    } catch { toast.error('Copy failed') }
  }

  // Copy the On Hand view — same HTML-table-with-plain-text-fallback
  // approach and sky-blue header as copyTanks() above, for the same
  // Outlook-legibility reason.
  async function copyOnHand() {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const cols = ['Product ID', 'On Hand (Qts)', 'Droptop On Hand (Qts)', 'Variance (Qts)', 'Droptop Usage (Qts/day)', 'DOS (Monitor)', 'DOS (Droptop)', 'Last Update']
    const text = (r: OnHandRow): string[] => [
      r.productId,
      num(r.tankOnHandQt),
      r.droptopOnHand == null ? '—' : num(r.droptopOnHand),
      r.netVariance == null ? '—' : num(r.netVariance),
      r.droptopUsage == null ? '—' : num(r.droptopUsage),
      r.dosMonitor == null ? '—' : num(r.dosMonitor),
      r.dosDroptop == null ? '—' : num(r.dosDroptop),
      dateTime(r.lastUpdate),
    ]
    const title = `${shopLabel(shopId)} — Tank Monitors (On Hand)`
    const thStyle = `border:1px solid #002745;background:#B7E0DE;color:#002745;padding:4px 8px;text-align:left;font-weight:bold;`
    const head = `<tr>${cols.map((c) => `<td style="${thStyle}"><font color="#002745">${esc(c)}</font></td>`).join('')}</tr>`
    const body = onHandRows.map((r, i) => {
      const bg = i % 2 ? '#F2F1E6' : '#FFFFFF'
      return `<tr>${text(r).map((v) => `<td style="border:1px solid #4F7489;padding:3px 8px;background:${bg};">${esc(v)}</td>`).join('')}</tr>`
    }).join('')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#002745;">`
      + `<div style="font-weight:bold;margin-bottom:4px;">${esc(title)}</div>`
      + `<table style="border-collapse:collapse;font-size:12px;"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
    const plain = [title, cols.join('\t'), ...onHandRows.map((r) => text(r).join('\t'))].join('\n')

    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        })])
      } else {
        await navigator.clipboard.writeText(plain)
      }
      toast.success('Copied to clipboard')
    } catch { toast.error('Copy failed') }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      {embedded && (
        <div className="sticky top-0 z-30 bg-cream dark:bg-[#0e2638] border-b border-navy/20 shadow-sm -mt-2 -mx-2 px-2 pt-2 pb-2">
          <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Search a shop…" />
        </div>
      )}
      {!embedded && (
        <div className="sticky z-30 bg-cream pt-1 pb-2 flex items-end justify-between flex-wrap gap-3" style={{ top: 'var(--inv-navbar-h, 0px)' }}>
          <div>
            <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Inventory Location Lookup</h1>
            {shopId
              ? <p className="text-sm font-heading font-bold text-navy mt-0.5">{shopLabel(shopId)}</p>
              : <p className="text-xs text-inky mt-0.5">Pick a shop to see its tanks, order configuration, and issues.</p>}
          </div>
          {!shopId && (
            <div className="w-80"><Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Search a shop…" /></div>
          )}
          {/* Absolute, so it rides along in the header's corner without taking
              part in the flex row — nothing here shifts when it appears.
              -right-1: see InventoryShortcuts.tsx for why plain right-0
              lands 4px left of the quick-access FAB nub below it. */}
          {shopId && (
            <button onClick={() => setCustomizeOpen((o) => !o)}
              title={customizeOpen ? 'Done customizing' : 'Customize columns'}
              aria-label={customizeOpen ? 'Done customizing' : 'Customize columns'}
              className={`absolute top-1 -right-1 flex items-center justify-center rounded-full p-2 shadow-lg transition-colors ${customizeOpen ? 'bg-sky text-navy hover:bg-sky/80' : 'bg-navy/80 text-cream hover:bg-navy'}`}>
              <Settings className="w-4 h-4" />
            </button>
          )}
        </div>
      )}

      {shopId && customizeOpen && (
        <Card>
          <CardBody className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <CheckGroup title="Left panel fields" items={sidebar.map((f) => ({ id: f.label, label: f.label }))} hidden={prefs.sidebar} onToggle={(id) => toggleHidden('sidebar', id)} />
            <CheckGroup title="Tank monitor columns" items={TANK_COLS.map((c) => ({ id: c.id, label: c.label }))} hidden={prefs.tank} onToggle={(id) => toggleHidden('tank', id)} />
            <CheckGroup title="Order config columns" items={[...CONFIG_FIXED.map((c) => ({ id: c.id, label: c.label })), ...allConfigMetaKeys.map((k) => ({ id: `meta:${k}`, label: metaLabel(k) })), ...USAGE_COLS.map((c) => ({ id: c.id, label: c.label }))]} hidden={prefs.config} onToggle={(id) => toggleHidden('config', id)} />
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-navy/70 font-semibold">Options</span>
              <label className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
                <input type="checkbox" checked={!!prefs.nonVmiOfflineBtn} onChange={() => setPrefs((p) => ({ ...p, nonVmiOfflineBtn: !p.nonVmiOfflineBtn }))} className="accent-sky" />
                Use non-VMI tanks for offline email button
              </label>
            </div>
          </CardBody>
        </Card>
      )}

      {!shopId ? (
        <p className="text-xs font-mono text-inky/60 py-4">{embedded ? 'Pick a shop above to see its tanks, config, and issues.' : 'Select a shop above to begin.'}</p>
      ) : loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
      ) : error ? (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
      ) : (
        <div className={`grid grid-cols-1 gap-4 items-start ${embedded ? '' : 'lg:grid-cols-[280px_1fr]'}`}>
          {/* Left info — frozen while the tables/issues scroll */}
          <div className={`self-start flex flex-col gap-3 ${embedded ? '' : 'lg:sticky'}`}
            style={!embedded ? { top: 'calc(var(--inv-navbar-h, 0px) + 4.5rem)' } : undefined}>
            <Card>
              <CardBody className="flex flex-col gap-2">
                {!embedded && <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Change shop…" />}
                <dl className="flex flex-col gap-1.5 mt-1">
                  {visibleSidebar.map((f) => (
                    <div key={f.label} className="relative flex flex-col rounded-lg border border-navy/15 bg-navy/[0.03] px-2.5 py-1.5">
                      {f.mapQuery && (
                        <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(f.mapQuery)}`} target="_blank" rel="noopener noreferrer"
                          title="Open in Google Maps" className="absolute top-1.5 right-1.5 inline-flex items-center text-inky hover:text-sky">
                          <MapPin className="w-4 h-4" />
                        </a>
                      )}
                      <dt className="text-[10px] font-mono font-semibold uppercase tracking-wide text-navy/70">{f.label}</dt>
                      <dd className="text-xs font-body text-navy break-words">
                        {f.value || '—'}
                        {f.note && <span className="ml-1.5 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-sky/40 text-navy">{f.note}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
                <UpdatedCallout date={locUpdated} onOpen={() => navigate('/global-config?tab=locations')} openTitle="Open Locations config" />
              </CardBody>
            </Card>
            <IssuesColumn pending={pendingIssues} resolved={resolvedIssues} onManage={openIssues} />
            <ExceptionsBox exceptions={exceptions} onAdd={openAddException} onEdit={openEditException} />
            <CommsBox comms={comms} onAdd={openAddComm} onEdit={openEditComm} />
            <MentionedBox projects={mentionedProjects} meetings={mentionedMeetings}
              onOpenProjects={() => navigate('/projects')} onOpenMeetings={() => navigate('/meetings')} />
          </div>

          {/* Main */}
          <div className="flex flex-col gap-4">
            <Card className="w-fit max-w-full">
              <CardBody className="flex flex-col gap-2">
                <div className="flex items-center gap-3 self-start flex-wrap">
                  <span className="text-xs font-mono text-navy uppercase tracking-wide">
                    Tank Monitors ({tanks.length})
                  </span>
                  <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
                    {(['configuration', 'onhand'] as const).map((v) => (
                      <button key={v} onClick={() => setTankView(v)}
                        className={['px-2 py-1 uppercase tracking-wide transition-colors', tankView === v ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                        {v === 'configuration' ? 'Configuration' : 'On Hand'}
                      </button>
                    ))}
                  </div>
                  {tankView === 'configuration' && tanks.length > 0 && (
                    <button onClick={copyTanks} title="Copy table for email" className="text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy inline-flex items-center gap-1">Copy</button>
                  )}
                  {tankView === 'onhand' && onHandRows.length > 0 && (
                    <button onClick={copyOnHand} title="Copy table for email" className="text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy inline-flex items-center gap-1">Copy</button>
                  )}
                  {showOfflineBtn && (
                    <button onClick={() => { setEmailMonitorOverride(null); setEmailKind('offline') }} title="Draft an email for offline monitors"
                      className={`text-[10px] font-mono border rounded px-1.5 py-0.5 inline-flex items-center gap-1 ${vmiOffline.length > 0 ? 'text-[#C0392B] border-[#C0392B]/40 hover:border-[#C0392B]' : 'text-[#E67E22] border-[#E67E22]/40 hover:border-[#E67E22]'}`}>
                      ✉ Offline ({offlineTanks.length})
                    </button>
                  )}
                  {!loading && lowVmiFlag && (
                    <button onClick={() => { setEmailMonitorOverride(null); setEmailKind('lowvmi') }} title="Draft a low VMI coverage email" className="text-[10px] font-mono text-[#E67E22] border border-[#E67E22]/40 rounded px-1.5 py-0.5 hover:border-[#E67E22] inline-flex items-center gap-1">✉ Low VMI</button>
                  )}
                </div>
                <UpdatedCallout date={tanks.length > 0 ? tanksUpdated : null} onOpen={() => navigate('/config?tab=tank-monitor')} openTitle="Open Tank Monitor config" />
                {tankView === 'configuration' ? (
                  tanks.length === 0 ? (
                    <p className="text-xs font-mono text-inky/60">No tank monitor readings for this shop.</p>
                  ) : visibleTankCols.length === 0 ? (
                    <p className="text-xs font-mono text-inky/60">All tank columns hidden — enable some under Customize.</p>
                  ) : (
                    <div className="w-fit max-w-full self-start overflow-x-auto rounded border border-navy/30">
                      <table className="text-xs font-mono">
                        <thead>
                          <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                            {visibleTankCols.map((c) => (
                              <th key={c.id} className={`px-3 py-2 align-bottom max-w-[10ch] ${alignCls(c.align)}`}>
                                <button onClick={() => setTankSort((s) => nextSort(s, c.id))} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-start gap-0.5 text-left leading-tight">
                                  <span className="break-words">{(c.id === 'on_hand' || c.id === 'available') && tankUnit ? `${c.label} (${tankUnit})` : c.label}</span>{sortArrow(tankSort, c.id)}
                                </button>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(tankSort ? applySort(tanks, TANK_COLS, tankSort) : sortedTanks).map((t) => (
                            <tr key={t.id} className="border-b border-navy/20">
                              {visibleTankCols.map((c) => <td key={c.id} className={`px-3 py-1.5 text-navy whitespace-nowrap ${alignCls(c.align)}`}>{c.id === 'updated' ? renderUpdatedCell(t) : c.render(t)}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )
                ) : (
                  onHandRows.length === 0 ? (
                    <p className="text-xs font-mono text-inky/60">No keep-fill/VMI tank monitors for this shop.</p>
                  ) : (
                    <div className="w-fit max-w-full self-start overflow-x-auto rounded border border-navy/30">
                      <table className="text-xs font-mono">
                        <thead>
                          <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                            {['Product ID', 'On Hand (Qts)', 'Droptop On Hand', 'Variance', 'Droptop Usage', 'DOS (Monitor)', 'DOS (Droptop)', 'Last Update'].map((h) => (
                              <th key={h} className="px-3 py-2 align-bottom max-w-[10ch] break-words leading-tight text-right first:text-left last:text-left">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {onHandRows.map((r) => {
                            const threshold = varianceThreshold(r.totalCapacityQt)
                            const flagged = r.netVariance != null && Math.abs(r.netVariance) > threshold
                            return (
                              <tr key={r.productId} className="border-b border-navy/20">
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-left">{r.productId}{r.tankCount > 1 && <span className="text-inky/50"> ({r.tankCount} tanks)</span>}</td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-right">{num(r.tankOnHandQt)}</td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-right">{r.droptopOnHand == null ? '—' : num(r.droptopOnHand)}</td>
                                <td className="px-3 py-1.5 whitespace-nowrap text-right">
                                  {r.netVariance == null ? (
                                    <span className="text-inky/40">—</span>
                                  ) : (
                                    <span
                                      className={`${flagged ? 'text-[#E67E22] font-bold cursor-pointer hover:underline decoration-dotted' : 'text-navy'}`}
                                      title={flagged ? 'Click to accept a new baseline variance' : undefined}
                                      onClick={() => flagged && setVarianceModal({ productId: r.productId, rawVariance: r.rawVariance ?? 0 })}
                                    >
                                      {num(r.netVariance)}{r.baseline != null && <span className="text-inky/40"> (net)</span>}
                                    </span>
                                  )}
                                </td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-right">{r.droptopUsage == null ? '—' : num(r.droptopUsage)}</td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-right">{r.dosMonitor == null ? '—' : num(r.dosMonitor)}</td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-right">{r.dosDroptop == null ? '—' : num(r.dosDroptop)}</td>
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-left">{dateTime(r.lastUpdate)}</td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )
                )}
              </CardBody>
            </Card>

            {configsByVendor.length === 0 ? (
              <Card><CardBody><p className="text-xs font-mono text-inky/60">No order configuration for this shop.</p></CardBody></Card>
            ) : (
              <div className="flex flex-col gap-4">
                {configsByVendor.map(([vendor, rows]) => (
                  <OrderConfigBlock key={vendor} vendor={vendor} rows={rows} hidden={prefs.config} onOpenConfig={() => navigate('/config?tab=order-config')} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {shopId && embedded && (
        <button onClick={() => setCustomizeOpen((o) => !o)}
          title={customizeOpen ? 'Done customizing' : 'Customize columns'}
          aria-label={customizeOpen ? 'Done customizing' : 'Customize columns'}
          className={`self-end flex items-center justify-center rounded-full p-2 transition-colors ${customizeOpen ? 'bg-sky text-navy hover:bg-sky/80' : 'bg-navy/80 text-cream hover:bg-navy'}`}>
          <Settings className="w-4 h-4" />
        </button>
      )}

      {/* Issues list — toggle pending/resolved, edit inline without leaving the page. */}
      <Modal open={issuesModalOpen && editIssue === undefined} onClose={() => setIssuesModalOpen(false)} title={`Issues — ${loc.labelOf(shopId)}`} size="lg">
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="inline-flex rounded-lg border border-navy/20 overflow-hidden text-xs font-mono">
            {(['pending', 'resolved'] as const).map((v) => (
              <button key={v} onClick={() => setModalView(v)}
                className={['px-3 py-1.5 uppercase tracking-wide transition-colors', modalView === v ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
                {v === 'pending' ? `Pending (${pendingIssues.length})` : `Resolved (${resolvedIssues.length})`}
              </button>
            ))}
          </div>
          <Button size="sm" onClick={() => setEditIssue({ location_id: shopId } as Partial<Issue>)}>+ New Issue</Button>
        </div>
        <div className="flex flex-col gap-2 max-h-[60vh] overflow-auto">
          {(modalView === 'pending' ? pendingIssues : resolvedIssues).map((i) => {
            const pastDue = modalView === 'pending' && !!i.target_resolution_date &&
              differenceInCalendarDays(new Date(), new Date(i.target_resolution_date + 'T00:00:00')) > 0
            return (
              <button key={i.id} onClick={() => setEditIssue(i as unknown as Partial<Issue>)}
                className="text-left rounded-lg border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-body text-navy flex-1 truncate">{i.title || 'Untitled issue'}</span>
                  <Badge color={modalView === 'pending' ? 'amber' : 'green'}>{statusNames[i.status_id ?? ''] ?? '—'}</Badge>
                  {pastDue && <Badge color="red">Past due</Badge>}
                </div>
                <div className="text-[10px] font-mono text-inky/60 flex flex-wrap gap-x-3 mt-1">
                  <span>Start {dateShort(i.start_date)}</span>
                  <span>Target {dateShort(i.target_resolution_date)}</span>
                  {modalView === 'resolved' && <span>Resolved {dateShort(i.resolved_date)}</span>}
                </div>
              </button>
            )
          })}
          {(modalView === 'pending' ? pendingIssues : resolvedIssues).length === 0 && (
            <p className="text-xs font-mono text-inky/50 py-6 text-center">No {modalView} issues for this shop.</p>
          )}
        </div>
      </Modal>

      {editIssue !== undefined && (
        <IssueFormModal
          open
          existing={editIssue}
          onClose={() => setEditIssue(undefined)}
          onSaved={() => { setEditIssue(undefined); load() }}
          onDelete={deleteIssue}
        />
      )}

      <ExceptionReportModal open={excModalOpen} onClose={() => setExcModalOpen(false)} existing={editingExc}
        onSubmit={saveException} onDelete={deleteException} />

      <LocationCommsModal open={commModalOpen} onClose={() => setCommModalOpen(false)} existing={editingComm}
        lockedLocationId={shopId} onSaved={load} onDelete={deleteComm} />

      {emailKind && shopId && (
        <TankEmailModal
          open
          onClose={() => { setEmailKind(null); setEmailMonitorOverride(null) }}
          kind={emailKind}
          template={emailKind === 'offline' ? offlineTpl : lowvmiTpl}
          targets={[{ locationId: shopId, monitors: (emailMonitorOverride ? [emailMonitorOverride] : emailKind === 'offline' ? offlineTanks : keepfillTanks) as unknown as TankMonitor[] }]}
          internalOf={(pid) => pid ?? ''}
          onLogged={load}
        />
      )}
      {callout && (
        <div
          className="fixed z-[70] pointer-events-none rounded bg-navy text-cream text-[11px] font-mono px-2 py-1 shadow-lg max-w-[240px]"
          style={{ left: callout.x + 14, top: callout.y + 14 }}
        >
          {callout.text}
        </div>
      )}

      {varianceModal && (
        <VarianceBaselineModal
          productId={varianceModal.productId}
          initialValue={varianceModal.rawVariance}
          saving={savingBaseline}
          onClose={() => setVarianceModal(null)}
          onSave={(v) => saveVarianceBaseline(varianceModal.productId, v)}
        />
      )}
    </div>
  )
}

// "Accept new baseline variance" — prepopulated with today's raw gap
// (tank on-hand minus Droptop on-hand) but freely adjustable. Whatever gets
// saved becomes the new absolute offset the On Hand view nets future
// readings against — it replaces any prior baseline for this product,
// it doesn't add to it.
function VarianceBaselineModal({ productId, initialValue, saving, onClose, onSave }: {
  productId: string; initialValue: number; saving: boolean; onClose: () => void; onSave: (v: number) => void
}) {
  const [value, setValue] = useState(String(Math.round(initialValue * 100) / 100))
  return (
    <Modal open onClose={onClose} title={`Accept New Baseline Variance — ${productId}`} size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-mono text-inky/70">
          Sets the new "normal" gap between the tank monitor's on-hand and Droptop's on-hand for this product at this
          shop. The On Hand view will flag future variance only when it drifts meaningfully away from this new value.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-inky uppercase tracking-wide">New baseline (quarts)</span>
          <input
            type="number" step="0.1" value={value} onChange={(e) => setValue(e.target.value)}
            className="bg-cream border border-navy/30 rounded px-2 py-1.5 text-sm font-mono text-navy focus:outline-none focus:border-sky"
            autoFocus
          />
        </label>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button size="sm" loading={saving} onClick={() => { const n = Number(value); if (!isNaN(n)) onSave(n) }}>Accept Baseline</Button>
        </div>
      </div>
    </Modal>
  )
}

// Full-page wrapper — the same detail view, with page chrome.
export function LocationLookupPage() {
  return <LocationDetailView />
}

function IssuesColumn({ pending, resolved, onManage }: { pending: IssueRow[]; resolved: IssueRow[]; onManage: (v: 'pending' | 'resolved') => void }) {
  const top = pending[0]
  const start = top?.start_date ? new Date(top.start_date + 'T00:00:00') : null
  const daysOpen = start ? differenceInCalendarDays(new Date(), start) : null
  const pastDue = !!top?.target_resolution_date && differenceInCalendarDays(new Date(), new Date(top.target_resolution_date + 'T00:00:00')) > 0
  return (
    <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', pending.length ? 'border-[#E67E22]/50 bg-[#E67E22]/10' : 'border-navy/20 bg-cream'].join(' ')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Issues</span>
        <div className="flex items-center gap-3">
          <span className={['text-sm font-heading font-bold', pending.length ? 'text-[#E67E22]' : 'text-navy'].join(' ')}>{pending.length} <span className="text-[10px] font-mono font-normal text-inky/60">open</span></span>
          <span className="text-sm font-heading font-bold text-[#2ECC71]">{resolved.length} <span className="text-[10px] font-mono font-normal text-inky/60">resolved</span></span>
        </div>
      </div>
      {top ? (
        <button onClick={() => onManage('pending')} className="text-left rounded border border-navy/15 bg-cream/70 hover:bg-cream px-2 py-1.5">
          <div className="text-xs font-body text-navy break-words">{top.title}</div>
          {pastDue && <div className="mt-0.5"><Badge color="red">Past due</Badge></div>}
          <div className="text-[10px] font-mono text-inky/60 flex flex-wrap gap-x-3 mt-0.5">
            <span>Start {dateShort(top.start_date)}</span>
            <span>Target {dateShort(top.target_resolution_date)}</span>
            {daysOpen != null && <span className={pastDue ? 'text-[#C0392B] font-bold' : ''}>{daysOpen}d open</span>}
          </div>
        </button>
      ) : (
        <span className="text-xs font-body text-inky/50">No open issues</span>
      )}
      {pending.length > 1 && <span className="text-[10px] font-mono text-inky/50">+{pending.length - 1} more open</span>}
      <button onClick={() => onManage('pending')} className="text-[10px] font-mono text-sky text-left hover:underline">Manage Issues →</button>
    </div>
  )
}

function ExceptionsBox({ exceptions, onAdd, onEdit }: { exceptions: ExceptionReport[]; onAdd: () => void; onEdit: (e: ExceptionReport) => void }) {
  const isClosed = (s: string | null) => (s ?? '').toLowerCase().includes('closed')
  const open = exceptions.filter((e) => !isClosed(e.status))
  return (
    <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', open.length ? 'border-[#C0392B]/40 bg-[#C0392B]/5' : 'border-navy/20 bg-cream'].join(' ')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Exception Reports</span>
        <span className={['text-lg font-heading font-bold', open.length ? 'text-[#C0392B]' : 'text-navy'].join(' ')}>{open.length}</span>
      </div>
      {exceptions.length === 0 ? (
        <span className="text-xs font-body text-inky/50">None</span>
      ) : exceptions.slice(0, 5).map((e) => (
        <button key={e.id} onClick={() => onEdit(e)} className="text-left rounded border border-navy/15 bg-cream/70 hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
          <div className="text-xs font-body text-navy break-words">{[e.report_type, e.issue].filter(Boolean).join(' · ') || 'Exception'}</div>
          {e.status && <div className="mt-0.5"><Badge color={isClosed(e.status) ? 'green' : 'amber'}>{e.status}</Badge></div>}
          <div className="text-[10px] font-mono text-inky/60 mt-0.5">Found {dateShort(e.date_of_finding)}</div>
        </button>
      ))}
      <button onClick={onAdd} className="text-[10px] font-mono text-sky text-left hover:underline">+ Add Exception</button>
    </div>
  )
}

function CommsBox({ comms, onAdd, onEdit }: { comms: LocationComm[]; onAdd: () => void; onEdit: (c: LocationComm) => void }) {
  const isClosed = (s: string | null) => (s ?? '').toLowerCase().includes('closed')
  const open = comms.filter((c) => !isClosed(c.status))
  return (
    <div className="rounded-lg border border-navy/20 bg-cream px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Location Comms</span>
        <span className="text-lg font-heading font-bold text-navy">{open.length}</span>
      </div>
      {comms.length === 0 ? (
        <span className="text-xs font-body text-inky/50">None</span>
      ) : comms.slice(0, 5).map((c) => (
        <button key={c.id} onClick={() => onEdit(c)} className="text-left rounded border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
          <div className="text-xs font-body text-navy break-words">{[c.comm_type, c.contact_method].filter(Boolean).join(' · ') || 'Communication'}</div>
          {c.status && <div className="mt-0.5"><Badge color={isClosed(c.status) ? 'green' : 'amber'}>{c.status}</Badge></div>}
          <div className="text-[10px] font-mono text-inky/60 mt-0.5">{dateShort(c.comm_date)}{(c.products ?? []).length ? ` · ${(c.products ?? []).length} product(s)` : ''}</div>
        </button>
      ))}
      <button onClick={onAdd} className="text-[10px] font-mono text-sky text-left hover:underline">+ Add Communication</button>
    </div>
  )
}

function MentionedBox({ projects, meetings, onOpenProjects, onOpenMeetings }: {
  projects: Project[]; meetings: MeetingNote[]; onOpenProjects: () => void; onOpenMeetings: () => void
}) {
  if (projects.length === 0 && meetings.length === 0) return null
  return (
    <div className="rounded-lg border border-navy/20 bg-cream px-4 py-3 flex flex-col gap-2.5">
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Mentioned</span>
      {projects.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-inky/50">Projects ({projects.length})</span>
          {projects.slice(0, 5).map((p) => (
            <button key={p.id} onClick={onOpenProjects} className="text-left rounded border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
              <div className="text-xs font-body text-navy break-words">{p.project_name || '(untitled project)'}</div>
              {p.status && <div className="mt-0.5"><Badge color="cyan">{p.status}</Badge></div>}
            </button>
          ))}
        </div>
      )}
      {meetings.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-inky/50">Meetings ({meetings.length})</span>
          {meetings.slice(0, 5).map((m) => (
            <button key={m.id} onClick={onOpenMeetings} className="text-left rounded border border-navy/15 bg-navy/[0.03] hover:bg-navy/[0.06] transition-colors px-2 py-1.5">
              <div className="text-xs font-body text-navy break-words">{m.title || '(untitled meeting)'}</div>
              <div className="text-[10px] font-mono text-inky/60 mt-0.5">{dateShort(m.meeting_date)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function CheckGroup({ title, items, hidden, onToggle }: { title: string; items: { id: string; label: string }[]; hidden: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] font-mono uppercase tracking-widest text-navy/70 font-semibold">{title}</span>
      {items.length === 0 ? <span className="text-[11px] font-mono text-inky/40 italic">None</span> : items.map((it) => (
        <label key={it.id} className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
          <input type="checkbox" checked={!hidden.includes(it.id)} onChange={() => onToggle(it.id)} className="accent-sky" />
          {it.label}
        </label>
      ))}
    </div>
  )
}

function OrderConfigBlock({ vendor, rows, hidden, onOpenConfig }: { vendor: string; rows: ConfigRow[]; hidden: string[]; onOpenConfig: () => void }) {
  const navigate = useNavigate()
  const [sort, setSort] = usePersistedSort(`location-lookup:config-sort:${vendor}`)
  const columns = useMemo(() => {
    const metaKeys = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) metaKeys.add(k)
    const metaCols: Col<ConfigRow>[] = [...metaKeys].sort().map((k) => ({ id: `meta:${k}`, label: metaLabel(k), align: 'left', render: (r) => String((r.metadata as any)?.[k] ?? '—'), sort: (r) => String((r.metadata as any)?.[k] ?? '') }))
    // part, uom, capacity, max, [meta…], vmi, [on hand, daily usage, days of
    // supply] — then drop hidden columns.
    const vmi = CONFIG_FIXED.find((c) => c.id === 'vmi')!
    const ordered = [...CONFIG_FIXED.filter((c) => c.id !== 'vmi'), ...metaCols, vmi, ...USAGE_COLS]
    return ordered.filter((c) => !hidden.includes(c.id))
  }, [rows, hidden])

  const sortedRows = useMemo(() => applySort(rows, columns, sort), [rows, columns, sort])
  const updated = useMemo(() => lastUpdated(rows as any[], ['updated_at']), [rows])
  // Newest inventory.product_usage sync among this vendor's products — shown
  // as its own callout since it's a different source/cadence than the order
  // config rows themselves.
  const usageUpdated = useMemo(() => lastUpdated(rows.map((r) => r.usage).filter(Boolean) as any[], ['updated_at']), [rows])

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <span className="text-xs font-mono text-navy uppercase tracking-wide self-start">
          {vendor} Order Config ({rows.length})
        </span>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <UpdatedCallout date={updated} onOpen={onOpenConfig} openTitle={`Open ${vendor} Order Config`} />
          {usageUpdated && (
            <button onClick={() => navigate('/config?tab=product-usage')} title="Open Product Usage config"
              className="group inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono bg-[#2ECC71]/20 text-navy hover:bg-[#2ECC71]/35 transition-colors">
              Updated {usageUpdated}
              <span className="opacity-0 group-hover:opacity-100 transition-opacity text-navy/60">↗</span>
            </button>
          )}
        </div>
        {columns.length === 0 ? (
          <p className="text-xs font-mono text-inky/60">All config columns hidden — enable some under Customize.</p>
        ) : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  {columns.map((c) => (
                    <th key={c.id} className={`px-3 py-2 ${alignCls(c.align)} ${c.tint ? USAGE_TINT : ''}`}>
                      <button onClick={() => setSort((s) => nextSort(s, c.id))} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-center">
                        {c.label}{sortArrow(sort, c.id)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr key={r.id} className="border-b border-navy/20">
                    {columns.map((c) => <td key={c.id} className={`px-3 py-1.5 text-navy ${alignCls(c.align)} ${c.tint ? USAGE_TINT : ''}`}>{c.render(r)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
