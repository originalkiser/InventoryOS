import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapPin, Settings } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { usePersistedColumnLayout } from '@/hooks/useColumnPrefs'
import { useCustomFields } from '@/hooks/useCustomFields'
import { SCHEMA_FIELDS as LOCATION_SCHEMA_FIELDS } from '@/modules/config/tabs/LocationsTab'
import { ColumnManagerModal, type ColItem } from './ColumnManagerModal'
import { Badge, Button, Card, CardBody, Combobox, Modal, SbLoader, Toggle } from '@/components/ui'
import { IssueFormModal } from '@/modules/issues/IssueFormModal'
import { ExceptionReportModal } from '@/modules/exceptions/ExceptionReportModal'
import type { ExceptionReport } from '@/modules/exceptions/exceptions'
import { LocationCommsModal } from '@/modules/comms/LocationCommsModal'
import type { LocationComm } from '@/modules/comms/comms'
import { TankEmailModal } from './TankEmailModal'
import { ExceptionEditModal } from '@/modules/orders-v2/ExceptionEditModal'
import { isValvoline, isReladyne } from '@/modules/orders-v2/useOrdersV2'
import { resolveScheduleDescription } from '@/modules/orders-v2/engine'
import type { DeliverySchedule } from '@/modules/orders-v2/types'
import { TANK_EMAIL_DEFAULT, type TankEmailKind, type TankEmailTemplate, buildMonitorEmailLog, backfillTodayBlanket, buildPendingCommSet, backfillPendingBlanket } from './tankEmail'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useCustomShopConfig, useCustomShopConfigPackageOptions, formatFieldValue } from './useCustomShopConfig'
import { CustomShopConfigModal } from './CustomShopConfigModal'
import { orderDayFromDelivery } from '@/lib/orderDay'
import { baseProductId } from '@/lib/productFamily'
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
  // for the On Hand / Daily Usage / Days of Supply columns. equivalent_products
  // lists any sibling case-type product ids (same base family, e.g. 5W30D +
  // 5W30BB) whose own on-hand/usage got folded into this row's own — same
  // combine Orders v2's generation engine already does, so a shop selling or
  // receiving under the "wrong" case type still shows real usage here.
  usage?: { on_hands: number | null; daily_usage: number | null; updated_at: string | null; equivalent_products?: { product_id: string; on_hand: number; daily_usage: number | null }[] } | null
  // Joined from inventory.ov2_product_exceptions by product_id — Orders v2's
  // shop+product floor/ceiling override, if one's been set for this row.
  exception?: { floor_qty: number | null; ceiling_qty: number | null; ceiling_unit: string | null } | null
}
interface IssueRow {
  id: string; title: string | null; status_id: string | null; issue_notes: string | null
  start_date: string | null; target_resolution_date: string | null; resolved_date: string | null
}

// Per-device view customization: ids hidden from each section. Sidebar-field
// and order-config-column hide/reorder moved to the cross-device,
// per-user usePersistedColumnLayout below (2026-09-25) — tank monitor
// columns and the other options here are unchanged and stay device-local.
interface ViewPrefs { tank: string[]; nonVmiOfflineBtn?: boolean; tankView?: 'configuration' | 'onhand'; onHandIgnoreVmi?: boolean; boxesSideBySide?: boolean }

// A tank monitor not reporting in > 2 days reads as offline (⚠ marker,
// offline-email eligibility, and the On Hand view's per-product callout).
const STALE_MS = 2 * 86400000
const isStaleReading = (d: string | null | undefined) => !!d && Date.now() - new Date(d).getTime() > STALE_MS

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
// Copy-only — same convention as TankMonitorsPage.tsx's own num1(): a
// pasted table shouldn't carry a raw on-hand/available/capacity reading's
// full floating-point tail (e.g. "18.489649999999997", since on_hand/
// available_capacity are computed as capacity minus a raw sensor reading
// and are essentially never exactly round). Kept separate from num() above
// so the on-screen display's own precision is untouched.
const num1 = (v: number | null | undefined) => (v == null ? '' : v.toLocaleString(undefined, { maximumFractionDigits: 1 }))
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

// Sidebar field list — declarative {id, label, render} entries (2026-09-25,
// replacing the old inline-JSX-only array keyed by label) so a future field
// (e.g. a planned Valvoline delivery-schedule field, to land between RD
// Distributor and Address) is a one-line insert here rather than a
// structural rewrite. `render` returns null to omit a field entirely for
// this shop (e.g. the NC-only inspection-station field) — everything else
// always renders, even with an empty value ("—" is shown by the caller).
// `id` is the STABLE key hide/reorder preferences are keyed by; `label` is
// just display text and can change freely without affecting a user's saved
// layout.
interface SidebarFieldCtx {
  location: Location | undefined
  shopId: string
  shopLabel: (id: string | null) => string
  rdOrderDay: string
  rdDeliveryDay: string
  rdDistributor: string
  addressStr: string
  inNC: boolean
  // Valvoline's own ov2_location_schedules row for this shop, if any (see
  // load()'s own fetch) — null both when the shop has no Valvoline vendor
  // relationship at all and while still loading, so the field simply
  // doesn't render rather than showing a misleading "—" either way.
  valvolineSchedule: DeliverySchedule | null
}
interface SidebarFieldValue { value: string; note?: string; mapQuery?: string }
interface SidebarFieldDef { id: string; label: string; render: (ctx: SidebarFieldCtx) => SidebarFieldValue | null }
interface ResolvedSidebarField { id: string; label: string; value: string; note?: string; mapQuery?: string }

const SIDEBAR_FIELDS: SidebarFieldDef[] = [
  { id: 'location', label: 'Location', render: (ctx) => ({ value: locVal(ctx.location, 'shop_city') || ctx.shopLabel(ctx.shopId) }) },
  { id: 'market', label: 'Market', render: (ctx) => ({ value: locVal(ctx.location, 'market') }) },
  { id: 'area_manager', label: 'Area Manager', render: (ctx) => ({ value: locVal(ctx.location, 'area_manager') }) },
  { id: 'am_phone', label: 'AM Cell', render: (ctx) => ({ value: locVal(ctx.location, 'am_phone') }) },
  { id: 'rdo', label: 'RDO', render: (ctx) => ({ value: locVal(ctx.location, 'director') }) },
  { id: 'rd_order_day', label: 'RD Order Day', render: (ctx) => ({ value: ctx.rdOrderDay, note: relativeDay(ctx.rdOrderDay) ?? undefined }) },
  { id: 'rd_delivery_day', label: 'RD Delivery Day', render: (ctx) => ({ value: ctx.rdDeliveryDay, note: relativeDay(ctx.rdDeliveryDay) ?? undefined }) },
  { id: 'rd_distributor', label: 'RD Distributor', render: (ctx) => ({ value: ctx.rdDistributor }) },
  {
    id: 'valvoline_schedule', label: 'Valvoline Delivery Schedule',
    render: (ctx) => (ctx.valvolineSchedule
      ? { value: resolveScheduleDescription(ctx.valvolineSchedule, { orderDate: format(new Date(), 'yyyy-MM-dd') }) }
      : null),
  },
  { id: 'address', label: 'Address', render: (ctx) => ({ value: ctx.addressStr, mapQuery: ctx.addressStr || undefined }) },
  { id: 'store_phone', label: 'Shop Phone', render: (ctx) => ({ value: locVal(ctx.location, 'store_phone') }) },
  { id: 'acquisition_date', label: 'Acquisition Date', render: (ctx) => ({ value: locVal(ctx.location, 'acquisition_date'), note: sinceLabel(locVal(ctx.location, 'acquisition_date')) ?? undefined }) },
  { id: 'nc_inspection', label: 'NC Inspection Station', render: (ctx) => (ctx.inNC ? { value: locVal(ctx.location, 'inspection_station_id') } : null) },
]
const SIDEBAR_DEFAULT_IDS = SIDEBAR_FIELDS.map((f) => f.id)

// core.locations columns already covered by one of the hand-crafted
// "special" fields above (same underlying column, different framing/label —
// e.g. `director` is already shown as "RDO") — excluded from the generic
// Locations Global Config field list below so Manage Fields never offers two
// entries for the same data under different names.
const SIDEBAR_SPECIAL_COLUMN_KEYS = new Set([
  'shop_city', 'market', 'area_manager', 'am_phone', 'director',
  'address', 'store_phone', 'acquisition_date', 'inspection_station_id',
  'reladyne_delivery_day',
])

// Left-column boxes (Shop Details + everything under it) — reorderable via
// "Left Column Layout" under Settings, see leftBoxOrder below.
const LEFT_BOX_LABELS: ColItem[] = [
  { id: 'shop_details', label: 'Shop Details' },
  { id: 'issues', label: 'Issues' },
  { id: 'exceptions', label: 'Exception Reports' },
  { id: 'comms', label: 'Location Comms' },
  { id: 'custom_config', label: 'Custom Shop Config' },
  { id: 'mentioned', label: 'Mentioned In' },
]
const LEFT_BOX_IDS = LEFT_BOX_LABELS.map((b) => b.id)

interface Col<T> { id: string; label: string; align: 'left' | 'right' | 'center'; render: (r: T) => ReactNode; sort?: (r: T) => string | number | null; tint?: boolean; width?: string }

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

// Orders v2's ceiling_unit values, abbreviated for this dense cell —
// "cases" here means whatever the product's own configured unit actually
// is (Case/Drum/Bay Box/Bulk), not literally the word "cases".
const CEILING_UNIT_ABBR: Record<string, string> = { cases: 'cases', gallons: 'gal', quarts: 'qts' }
function exceptionCellLines(exc: ConfigRow['exception']): string[] {
  if (!exc) return []
  const lines: string[] = []
  if (exc.floor_qty != null) lines.push(`Floor=${num(exc.floor_qty)}qts`)
  if (exc.ceiling_qty != null) lines.push(`Ceiling=${num(exc.ceiling_qty)}${CEILING_UNIT_ABBR[exc.ceiling_unit ?? ''] ?? exc.ceiling_unit ?? ''}`)
  return lines
}

function isVmiRow(r: ConfigRow): boolean {
  return String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes'
}
const CONFIG_FIXED: Col<ConfigRow>[] = [
  // Part/UOM are deliberately left unconstrained (no width, plus the shared
  // whitespace-nowrap in OrderConfigBlock's <td>/<th> below) — a real part
  // id or UOM word is what it is and shouldn't wrap to a second line. The
  // short numeric/status columns are narrowed instead (Capacity/Max/VMI/
  // Exception, and On Hand/Daily Usage/Days of Supply below), which is
  // where table-auto's leftover-width stretch was actually going to waste.
  { id: 'part', label: 'Part', align: 'left', render: (r) => r.product_id ?? '—', sort: (r) => r.product_id },
  { id: 'uom', label: 'UOM', align: 'left', render: (r) => String((r.metadata as any)?.uom ?? '—'), sort: (r) => String((r.metadata as any)?.uom ?? '') },
  { id: 'capacity', label: 'Capacity', align: 'right', width: 'w-20', render: (r) => num(r.capacity), sort: (r) => r.capacity },
  {
    id: 'exception', label: 'Exception', align: 'left', width: 'w-28',
    render: (r) => {
      const lines = exceptionCellLines(r.exception)
      if (lines.length === 0) return <span className="text-inky/30">+ Add</span>
      return <div className="flex flex-col leading-tight">{lines.map((l) => <span key={l}>{l}</span>)}</div>
    },
    sort: (r) => exceptionCellLines(r.exception).join(' ') || null,
  },
  { id: 'max', label: 'Max', align: 'right', width: 'w-16', render: (r) => num(r.order_limit), sort: (r) => r.order_limit },
  { id: 'vmi', label: 'VMI', align: 'center', width: 'w-14', render: (r) => (isVmiRow(r) ? <Badge color="sky">VMI</Badge> : <span className="text-inky/40">—</span>), sort: (r) => (isVmiRow(r) ? 1 : 0) },
]
// Metadata keys that are plumbing, not config attributes — never shown as columns.
const CONFIG_META_EXCLUDE = new Set(['vmi', 'uom', 'vendor_id', 'location_id', 'vendor_name', 'location_label'])

// On Hand / Daily Usage / Days of Supply — appended to the right of VMI,
// tinted to set them apart since they come from inventory.product_usage
// rather than the order config row itself. Days of Supply is always
// computed here (on hand ÷ daily usage), not read from the table's own
// days_of_supply column, so it stays consistent with what's displayed.
//
// A combined figure (see combinedUsageFor above) shows a visible sibling
// breakdown underneath — same "Combining On Hands"/"Combining Usage" shape
// Orders v2's own Review/Final Review tables already use for on-hand —
// rather than a bare number or a hover-only tooltip, so a total that's
// bigger than this one exact SKU's own reading doesn't read as a mistake,
// and the sibling's own contribution is visible without hovering. Direct
// feedback 2026-09-25 (first for On Hand, then the same treatment
// requested for Daily Usage): "have that like-product listed and amount
// ... underneath."
function CombinedBreakdownValue({ value, label, siblings, pick }: {
  value: string
  label: string
  siblings?: { product_id: string; on_hand: number; daily_usage: number | null }[]
  pick: (s: { product_id: string; on_hand: number; daily_usage: number | null }) => number | null
}) {
  if (!siblings?.length) return <>{value}</>
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span>{value}</span>
      <div className="text-[9px] text-inky/50 leading-tight font-normal text-right whitespace-normal">
        <div className="text-sky font-bold uppercase tracking-wide">{label}</div>
        {siblings.map((s) => <div key={s.product_id}>{s.product_id}: {num(pick(s))}</div>)}
      </div>
    </div>
  )
}
const USAGE_COLS: Col<ConfigRow>[] = [
  { id: 'on_hand', label: 'On Hand', align: 'right', width: 'w-20', tint: true, render: (r) => (r.usage?.on_hands != null ? <CombinedBreakdownValue value={num(r.usage.on_hands)} label="Combining On Hands" siblings={r.usage.equivalent_products} pick={(s) => s.on_hand} /> : '—'), sort: (r) => r.usage?.on_hands ?? null },
  { id: 'daily_usage', label: 'Daily Usage', align: 'right', width: 'w-24', tint: true, render: (r) => (r.usage?.daily_usage != null ? <CombinedBreakdownValue value={num(r.usage.daily_usage)} label="Combining Usage" siblings={r.usage.equivalent_products} pick={(s) => s.daily_usage} /> : '—'), sort: (r) => r.usage?.daily_usage ?? null },
  {
    id: 'days_of_supply', label: 'Days of Supply', align: 'right', width: 'w-24', tint: true,
    render: (r) => {
      const oh = r.usage?.on_hands, du = r.usage?.daily_usage
      return oh != null && du != null && du > 0 ? (oh / du).toFixed(1) : '—'
    },
    sort: (r) => { const oh = r.usage?.on_hands, du = r.usage?.daily_usage; return oh != null && du != null && du > 0 ? oh / du : null },
  },
]
const USAGE_TINT = 'bg-[#2ECC71]/10'

// Order-config column resizing (2026-09-25) — default pixel widths, used
// until a user drags a column to its own saved width. Roughly matches the
// old fixed Tailwind width classes (w-20/w-28/w-16/w-14/w-24) these columns
// used before real resizing existed.
const CONFIG_DEFAULT_WIDTH: Record<string, number> = {
  part: 150, uom: 90, capacity: 90, exception: 150, max: 80, vmi: 70,
  on_hand: 90, daily_usage: 100, days_of_supply: 110,
}
const CONFIG_META_DEFAULT_WIDTH = 140
function configColWidth(id: string, sizing: Record<string, number>): number {
  return sizing[id] ?? CONFIG_DEFAULT_WIDTH[id] ?? CONFIG_META_DEFAULT_WIDTH
}
// A column header's own drag-to-resize handle — this table predates the
// TanStack useTable/DataTable convergence (see TABLE_TEMPLATES.md), so this
// is a small hand-rolled equivalent of DataTable's own header.getResizeHandler()
// rather than pulling the whole table onto TanStack for one feature.
function ResizeHandle({ onResize }: { onResize: (deltaPx: number) => void }) {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    let lastX = e.clientX
    function onMove(ev: MouseEvent) {
      const delta = ev.clientX - lastX
      lastX = ev.clientX
      if (delta !== 0) onResize(delta)
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }
  return (
    <div
      onMouseDown={onMouseDown}
      onClick={(e) => e.stopPropagation()}
      title="Drag to resize column"
      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none touch-none bg-navy/10 hover:bg-sky/60 z-10"
    />
  )
}

export function LocationDetailView({ embedded = false }: { embedded?: boolean }) {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null
  // Every Locations Global Config column (+ custom fields) as optional Shop
  // Details fields (2026-09-25 ask) — generic, so a new field there needs no
  // matching change here.
  const { active: locationCustomFields } = useCustomFields('locations')
  const extraSidebarFields = useMemo((): SidebarFieldDef[] => {
    const schemaKeys = new Set(LOCATION_SCHEMA_FIELDS.map((f) => f.name))
    const cols: SidebarFieldDef[] = LOCATION_SCHEMA_FIELDS
      .filter((f) => !SIDEBAR_SPECIAL_COLUMN_KEYS.has(f.name))
      .map((f) => ({ id: f.name, label: f.label, render: (ctx) => ({ value: locVal(ctx.location, f.name) }) }))
    // A custom field sharing a key with a real column would just re-read the
    // same column above — skip it rather than list the same data twice.
    const custom: SidebarFieldDef[] = locationCustomFields
      .filter((f) => !schemaKeys.has(f.field_key))
      .map((f) => ({ id: `cf:${f.field_key}`, label: f.label, render: (ctx) => ({ value: locVal(ctx.location, f.field_key) }) }))
    return [...cols, ...custom]
  }, [locationCustomFields])
  // Unique per mounted instance, not just per shop — the full-page route
  // (kept mounted in the background by KeepAlivePages) and the "Shop Detail"
  // block in the floating quick-access panel can both be showing the same
  // shop at once (they share LAST_SHOP_KEY), and a Realtime channel topic
  // string has to be unique per subscription or the second .subscribe()
  // collides with the first — this was crashing the whole app (outside any
  // error boundary) when both were open on the same shop simultaneously.
  const instanceId = useRef(Math.random().toString(36).slice(2)).current

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
  // Valvoline's own ov2_location_schedules row for this shop (2026-09-25
  // direct ask — surfaced in the sidebar between RD Distributor and
  // Address, see SIDEBAR_FIELDS). null when there's no Valvoline vendor
  // relationship for this shop at all, not just "still loading."
  const [valvolineSchedule, setValvolineSchedule] = useState<DeliverySchedule | null>(null)
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
  // Array, not a single monitor — the On Hand view's rolled-up product rows
  // can scope an email to several offline monitors at once (see
  // renderOnHandUpdatedCell below); the Configuration view's single-monitor
  // click just wraps its one TankRow in a 1-element array.
  const [emailMonitorOverride, setEmailMonitorOverride] = useState<TankRow[] | null>(null)
  const [callout, setCallout] = useState<{ x: number; y: number; text: string } | null>(null)
  const [offlineTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_offline', TANK_EMAIL_DEFAULT.offline)
  const [lowvmiTpl] = useAppSetting<TankEmailTemplate>('tank_email_tpl_lowvmi', TANK_EMAIL_DEFAULT.lowvmi)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // Sidebar field order/hide + order-config column order/hide/width — real,
  // cross-device, per-user persistence (2026-09-25), replacing the old
  // localStorage-only ViewPrefs.sidebar/config hide lists. Same
  // column_prefs jsonb column + shape useColumnPrefs already uses for every
  // TanStack-table page in this app, just under these two table keys.
  const sidebarLayout = usePersistedColumnLayout('location_lookup.sidebar_fields')
  const configLayout = usePersistedColumnLayout('location_lookup.order_config_columns')
  // Left-column box order (Shop Details/Issues/Exceptions/Comms/Custom
  // Config/Mentioned In) — same persisted-layout shape, so a shop with a
  // very tall Shop Details card (now that any Locations Global Config
  // column can be added to it) can move Issues/Exceptions/Comms above it
  // instead of always scrolling past it.
  const leftBoxLayout = usePersistedColumnLayout('location_lookup.left_boxes')
  const [sidebarManagerOpen, setSidebarManagerOpen] = useState(false)
  const [configManagerOpen, setConfigManagerOpen] = useState(false)
  const [leftBoxManagerOpen, setLeftBoxManagerOpen] = useState(false)
  // Issues modal: list toggle (pending/resolved) + inline editor.
  // editIssue: undefined = editor closed, null = new issue, object = edit existing.
  const [issuesModalOpen, setIssuesModalOpen] = useState(false)
  const [modalView, setModalView] = useState<'pending' | 'resolved'>('pending')
  const [editIssue, setEditIssue] = useState<Partial<Issue> | null | undefined>(undefined)
  const [prefs, setPrefs] = useState<ViewPrefs>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(VIEW_KEY) || '{}')
      return { tank: p.tank ?? [], nonVmiOfflineBtn: p.nonVmiOfflineBtn ?? false, tankView: p.tankView === 'onhand' ? 'onhand' : 'configuration', onHandIgnoreVmi: p.onHandIgnoreVmi ?? false, boxesSideBySide: p.boxesSideBySide ?? false }
    }
    catch { return { tank: [], nonVmiOfflineBtn: false, tankView: 'configuration', onHandIgnoreVmi: false, boxesSideBySide: false } }
  })
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(prefs)) } catch { /* ignore */ } }, [prefs])
  const toggleTankHidden = (id: string) =>
    setPrefs((p) => ({ ...p, tank: p.tank.includes(id) ? p.tank.filter((x) => x !== id) : [...p.tank, id] }))
  const tankView = prefs.tankView ?? 'configuration'
  const setTankView = (v: 'configuration' | 'onhand') => setPrefs((p) => ({ ...p, tankView: v }))
  // "Ignore VMI" toggle (2026-09-25 direct ask) — the On Hand view is
  // normally VMI/keep-fill-only by design (see onHandRows' own comment:
  // that's the tank-vs-Droptop reconciliation use case), but deciding
  // whether a NOT-yet-VMI shop's tanks read closely enough to Droptop to be
  // worth switching needs the exact same comparison for its non-VMI tanks.
  const onHandIgnoreVmi = prefs.onHandIgnoreVmi ?? false
  const setOnHandIgnoreVmi = (v: boolean) => setPrefs((p) => ({ ...p, onHandIgnoreVmi: v }))

  // On Hand view: Droptop on-hand/usage (by resolved product id) and any
  // accepted variance baselines for this shop — both loaded in `load()`
  // below, alongside (not replacing) the existing configs-usage join.
  const [usageByProduct, setUsageByProduct] = useState<Map<string, { on_hands: number | null; daily_usage: number | null; updated_at: string | null }>>(new Map())
  const [idMappings, setIdMappings] = useState<{ old_product_id: string | null; new_product_id: string | null }[]>([])
  const [varianceBaselines, setVarianceBaselines] = useState<{ product_id: string; baseline_qty: number }[]>([])
  const [varianceModal, setVarianceModal] = useState<{ productId: string; rawVariance: number } | null>(null)
  // Which order-config row's Exception cell was clicked — add/edit that
  // row's floor/ceiling right here instead of needing Orders v2's own page.
  const [exceptionModalRow, setExceptionModalRow] = useState<ConfigRow | null>(null)
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
      // Raised to 5000 (2026-09-03, Max Rows now 10,000) — the exit
      // condition below only trusts a genuinely empty page.
      const PAGE = 5000
      const out: any[] = []
      let from = 0
      for (;;) {
        const { data, error } = await factory(from, from + PAGE - 1)
        if (error) break
        const batch = data ?? []
        out.push(...batch)
        // Exit only on a genuinely empty page, not "fewer than requested" —
        // the project's API "Max Rows" setting silently caps every response
        // at 1000 regardless of PAGE, so a full 1000-row page can still mean
        // there's more to fetch. See CustomerHeatmapPage.tsx/DroptopOrdersPage.tsx
        // for the incident this pattern caused elsewhere.
        if (batch.length === 0) break
        from += PAGE
      }
      return out
    }
    try {
      const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()
      // location_order_config + tank_monitors + product_id_mappings fetched
      // first (all small — one shop's own rows, plus a company-wide but tiny
      // mapping table) so the product_usage pull below can be scoped to only
      // the product FAMILIES this shop actually needs, instead of every
      // product the shop has ever had usage for — confirmed against
      // production that a shop's own product_usage rows (avg ~1,070) vastly
      // outnumber its configured products (avg ~21), and unscoped usage is
      // otherwise only ever joined onto a config row OR matched against a
      // tank monitor's product (the On Hand view's Droptop-vs-tank
      // comparison) below — nothing else on this page reads it. Tank
      // monitors matter here specifically because keep-fill/VMI products are
      // deliberately excluded from normal order config (confirmed against
      // production: 1,616 shop/product pairs have a tank monitor with no
      // matching location_order_config row at all), so scoping by config
      // alone would have silently dropped the On Hand view's Droptop data
      // for every keep-fill product. Either source's usage can also still be
      // keyed by a retired product id, so the filter includes any old id
      // that maps (product_id_mappings) onto a config's or a tank's product
      // id — filtering by the current ids alone would silently drop on-hand
      // data for anything that's ever been renamed.
      const [cfgRes, tankRes, mapRes] = await Promise.all([
        sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('location_id', shopId),
        sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).eq('location_id', shopId).order('product_id'),
        sb.schema('inventory').from('product_id_mappings').select('old_product_id, new_product_id').eq('company_id', companyId).then((r: any) => r).catch(() => ({ data: [] })),
      ])
      const configProducts = (cfgRes.data ?? []) as any[]
      const tankProducts = (tankRes.data ?? []) as any[]
      const neededPkeys = new Set([...configProducts, ...tankProducts].map((r) => pkey(r.product_id)).filter(Boolean))
      const usageIdSet = new Set<string>()
      for (const c of configProducts) if (c.product_id) usageIdSet.add(c.product_id)
      for (const t of tankProducts) if (t.product_id) usageIdSet.add(t.product_id)
      for (const m of ((mapRes?.data ?? []) as any[])) {
        if (m.old_product_id && m.new_product_id && neededPkeys.has(pkey(m.new_product_id))) usageIdSet.add(m.old_product_id)
      }
      const usageIdList = [...usageIdSet]
      // Widened from an exact-id list to a family-prefix match (same
      // "equivalent case types" convention as Orders v2's own generation
      // engine — baseProductId strips a trailing case-type suffix like "D"/
      // "BB") so a sibling SKU with no order-config row of its own (a case
      // type the shop isn't configured to order, or a manual mis-ring) still
      // gets pulled in for the on-hand/usage combine below. A family prefix
      // always matches its own exact id too (ilike(base%)), so this
      // subsumes the old exact-match list rather than needing both.
      const usageFamilies = [...new Set([...usageIdList].map((p) => pkey(baseProductId(p))).filter(Boolean))]

      const [usageRes, vendRes, issRes, statRes, supRes, excRes, commRes, partsRes, projRes, meetRes, baselineRes, prodExcRes, schedRes] = await Promise.all([
        usageFamilies.length === 0 ? Promise.resolve({ data: [] }) : fetchAllRows((from, to) =>
          sb.schema('inventory').from('product_usage')
            .select('product_id, on_hands, daily_usage, updated_at')
            .eq('company_id', companyId).eq('location_id', shopId)
            .or(usageFamilies.map((f) => `product_id.ilike.${f}%`).join(','))
            .order('product_id').range(from, to)
        ).then((data) => ({ data })).catch(() => ({ data: [] })),
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
        // Orders v2's shop+product floor/ceiling overrides — see the
        // Exception column below. Best-effort: newer table.
        sb.schema('inventory').from('ov2_product_exceptions').select('product_id, floor_qty, ceiling_qty, ceiling_unit').eq('company_id', companyId).eq('location_id', shopId).then((r: any) => r).catch(() => ({ data: [] })),
        // Valvoline Delivery Schedule sidebar field — best-effort: newer
        // table, and the vendor_id filter needs vendRes (fetched in this
        // same batch) resolved first, so this pulls every schedule row for
        // the shop and the match against Valvoline's own vendor id happens
        // just below instead.
        sb.schema('inventory').from('ov2_location_schedules').select('*').eq('company_id', companyId).eq('location_id', shopId).then((r: any) => r).catch(() => ({ data: [] })),
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
      // usage file predates the rename. (pkey is declared above, before the
      // fetch, since the scoped usage query needs it too.)
      const oldToNew = new Map<string, string>()
      for (const m of ((mapRes?.data ?? []) as any[])) {
        if (m.old_product_id && m.new_product_id) oldToNew.set(pkey(m.old_product_id), String(m.new_product_id))
      }
      // A shop with BOTH the old and new product_id independently configured
      // (location_order_config) is deliberately tracking them as two
      // separate real SKUs — e.g. a shop stocking both a drum AND bay boxes
      // of the same oil. Real bug found live 2026-09-25: shop 29's own
      // EURO-SYN-0W30D (drum) has real POS usage, but an unconditional
      // redirect here (matching Orders v2's own generation engine, since
      // fixed the same way — see useOrdersV2.ts's resolveMappedProductId)
      // folded it entirely into the bay-box row, showing this page's own
      // "no usage" for the drum too. Skipped only when this SHOP configures
      // both ids; every other shop (the common case: fully switched
      // packaging) still redirects exactly as before.
      const configuredProductKeys = new Set(configProducts.map((c) => pkey(c.product_id)).filter(Boolean))
      const resolveMapped = (rawId: string): string => {
        const mapped = oldToNew.get(pkey(rawId))
        if (!mapped) return rawId
        const bothConfigured = configuredProductKeys.has(pkey(rawId)) && configuredProductKeys.has(pkey(mapped))
        return bothConfigured ? rawId : mapped
      }
      const usageByProduct = new Map<string, { on_hands: number | null; daily_usage: number | null; updated_at: string | null }>()
      for (const u of ((usageRes?.data ?? []) as any[])) {
        if (!u.product_id) continue
        const resolved = pkey(resolveMapped(u.product_id))
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
      const resolvedKey = (pid: string) => pkey(resolveMapped(pid))
      const exceptionByProduct = new Map<string, { floor_qty: number | null; ceiling_qty: number | null; ceiling_unit: string | null }>()
      for (const e of ((prodExcRes?.data ?? []) as any[])) {
        if (!e.product_id) continue
        exceptionByProduct.set(resolvedKey(e.product_id), { floor_qty: e.floor_qty, ceiling_qty: e.ceiling_qty, ceiling_unit: e.ceiling_unit })
      }
      // Combine on-hand/usage across "equivalent case types" of the same
      // base product (e.g. 5W30D + 5W30BB both resolve to family "5W30") —
      // same convention Orders v2's generation engine already uses, so a
      // shop selling or receiving under a different case-type SKU (or a
      // straight-up mis-ring) still shows real usage on its own configured
      // row instead of reading as "no usage." On-hand and daily usage
      // combine as a pair (never one without the other) so Days of Supply
      // stays mathematically consistent; a sibling with zero/no on-hand
      // contributes nothing (excluded, not zeroed).
      const familyMembers = new Map<string, { product_id: string; on_hands: number; daily_usage: number | null }[]>()
      for (const [pid, u] of usageByProduct) {
        if (u.on_hands == null || Number(u.on_hands) <= 0) continue
        const fam = pkey(baseProductId(pid))
        if (!familyMembers.has(fam)) familyMembers.set(fam, [])
        familyMembers.get(fam)!.push({ product_id: pid, on_hands: Number(u.on_hands), daily_usage: u.daily_usage })
      }
      const combinedUsageFor = (r: { product_id: string | null; metadata: Record<string, unknown> | null }) => {
        if (!r.product_id) return null
        const ownKey = resolvedKey(r.product_id)
        const own = usageByProduct.get(ownKey) ?? null
        // Keep-fill/VMI on-hand comes from its own tank monitor reading, not
        // another case type's Droptop figure — never a combine target,
        // matching Orders v2's own vmiKeys exclusion.
        const isVmi = String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes'
        if (isVmi) return own
        const fam = pkey(baseProductId(ownKey))
        const siblings = (familyMembers.get(fam) ?? []).filter((s) => s.product_id !== ownKey)
        if (siblings.length === 0) return own
        const ownOnHand = own?.on_hands != null ? Number(own.on_hands) : 0
        const combinedOnHand = ownOnHand + siblings.reduce((sum, s) => sum + s.on_hands, 0)
        const usageSiblings = siblings.filter((s) => s.daily_usage != null && s.daily_usage > 0)
        const combinedUsage = own?.daily_usage != null || usageSiblings.length > 0
          ? Number(own?.daily_usage ?? 0) + usageSiblings.reduce((sum, s) => sum + Number(s.daily_usage), 0)
          : null
        return {
          on_hands: combinedOnHand, daily_usage: combinedUsage,
          updated_at: own?.updated_at ?? null,
          equivalent_products: siblings.map((s) => ({ product_id: s.product_id, on_hand: s.on_hands, daily_usage: s.daily_usage })),
        }
      }
      setConfigs(((cfgRes.data ?? []) as ConfigRow[]).map((r) => ({
        ...r,
        usage: combinedUsageFor(r),
        exception: r.product_id ? exceptionByProduct.get(resolvedKey(r.product_id)) ?? null : null,
      })))
      // Also exposed at component scope (not just baked into `configs`) —
      // the Tank Monitors "On Hand" view matches keep-fill tanks against
      // this same Droptop usage/on-hand data by their resolved product id.
      setUsageByProduct(usageByProduct)
      setIdMappings((mapRes?.data ?? []) as any[])
      setVarianceBaselines((baselineRes?.data ?? []) as any[])
      setVendorNames(Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, v.name])))
      const valvVendor = ((vendRes.data ?? []) as { id: string; name: string }[]).find((v) => isValvoline(v.name))
      const valvRow = valvVendor
        ? ((schedRes?.data ?? []) as any[]).find((r) => r.vendor_id === valvVendor.id)
        : null
      setValvolineSchedule(valvRow ? {
        type: valvRow.schedule_type, delivery_dow: valvRow.delivery_dow,
        week_a_dow: valvRow.week_a_dow, week_b_dow: valvRow.week_b_dow,
        biweekly_anchor_date: valvRow.biweekly_anchor_date ?? null,
        lead_business_days: Number(valvRow.lead_business_days ?? 4),
      } : null)
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
      .channel(`location-lookup-${shopId}-${instanceId}`)
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
    onlineMonitors: TankRow[]; offlineMonitors: TankRow[]
    droptopOnHand: number | null; droptopUsage: number | null
    rawVariance: number | null; baseline: number | null; netVariance: number | null
    dosMonitor: number | null; dosDroptop: number | null
  }
  const onHandRows = useMemo<OnHandRow[]>(() => {
    const groups = new Map<string, { productId: string; tankOnHandQt: number; totalCapacityQt: number; monitors: TankRow[] }>()
    for (const t of tanks) {
      if (!onHandIgnoreVmi && !t.keep_fill) continue
      const key = t.internal || t.product_id || ''
      if (!key) continue
      const qty = toQuarts(t.on_hand, t.unit) ?? 0
      const capQt = toQuarts(tankCapacity(t), t.unit) ?? 0
      const existing = groups.get(key)
      if (!existing) groups.set(key, { productId: key, tankOnHandQt: qty, totalCapacityQt: capQt, monitors: [t] })
      else {
        existing.tankOnHandQt += qty
        existing.totalCapacityQt += capQt
        existing.monitors.push(t)
      }
    }
    return [...groups.values()]
      .sort((a, b) => a.productId.localeCompare(b.productId, undefined, { sensitivity: 'base' }))
      .map((g) => {
        // Multiple physical tanks can share one product — split by whether
        // each is currently reporting, since the displayed date/callout
        // differs once even one of them goes stale (see
        // renderOnHandUpdatedCell for the full read of this split).
        const offlineMonitors = g.monitors.filter((t) => isStaleReading(t.inventory_time ?? t.reading_date))
        const onlineMonitors = g.monitors.filter((t) => !isStaleReading(t.inventory_time ?? t.reading_date))
        const newestOf = (rows: TankRow[]) => rows.reduce<string | null>((best, t) => {
          const d = t.inventory_time ?? t.reading_date
          return d && (!best || d > best) ? d : best
        }, null)
        // Surface the offline side's date once anything's offline — that's
        // the actionable/stale reading, not whichever monitor happens to be
        // freshest overall.
        const lastUpdate = offlineMonitors.length > 0 ? newestOf(offlineMonitors) : newestOf(onlineMonitors)
        const usage = usageByProduct.get(resolvedProductKey(g.productId))
        const droptopOnHand = usage?.on_hands ?? null
        const droptopUsage = usage?.daily_usage ?? null
        const rawVariance = droptopOnHand != null ? g.tankOnHandQt - droptopOnHand : null
        const baseline = baselineByProduct.get(resolvedProductKey(g.productId)) ?? null
        const netVariance = rawVariance != null ? rawVariance - (baseline ?? 0) : null
        const dosMonitor = droptopUsage && droptopUsage > 0 ? g.tankOnHandQt / droptopUsage : null
        const dosDroptop = droptopUsage && droptopUsage > 0 && droptopOnHand != null ? droptopOnHand / droptopUsage : null
        return {
          productId: g.productId, tankOnHandQt: g.tankOnHandQt, totalCapacityQt: g.totalCapacityQt,
          tankCount: g.monitors.length, lastUpdate, onlineMonitors, offlineMonitors,
          droptopOnHand, droptopUsage, rawVariance, baseline, netVariance, dosMonitor, dosDroptop,
        }
      })
  }, [tanks, usageByProduct, baselineByProduct, oldToNewMap, onHandIgnoreVmi])

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
  const offlineTanks = useMemo(() => tanks.filter((t) => isStaleReading(t.inventory_time ?? t.reading_date)), [tanks])
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

  // Per-monitor offline-email status — shared by the Configuration view's
  // single-monitor cell (renderUpdatedCell) and the On Hand view's rolled-up
  // per-product cell (renderOnHandUpdatedCell) below, so both surfaces agree
  // on what "emailed" / "pending" / "not yet emailed" mean for a given tank.
  type MonitorEmailStatus =
    | { kind: 'emailed'; date: string }
    | { kind: 'pending' }
    | { kind: 'not_vmi' }
    | { kind: 'none' }
  function monitorEmailStatus(t: TankRow): MonitorEmailStatus {
    const serial = t.serial_rtu_id || t.system_tank_id || ''
    const last = serial ? offlineLog.get(serial) : undefined
    if (last) return { kind: 'emailed', date: last }
    if (serial && offlinePendingSerials.has(serial)) return { kind: 'pending' }
    if (offlineTpl.vmiOnly !== false && !t.keep_fill) return { kind: 'not_vmi' }
    return { kind: 'none' }
  }
  function formatEmailStatus(s: MonitorEmailStatus): string {
    switch (s.kind) {
      case 'emailed': return `Last emailed ${format(new Date(s.date), 'MMM d, yyyy')}`
      case 'pending': return 'Pending — shop/AM hasn\'t responded yet (see Location Comms)'
      case 'not_vmi': return 'Not emailed — not on VMI/keepfill'
      case 'none': return 'Not yet emailed'
    }
  }
  // "Emailed together" is treated as the same calendar day, not necessarily
  // the exact same comm row — matches this file's own day-level granularity
  // everywhere else a "last emailed" date is shown.
  function sameEmailStatus(a: MonitorEmailStatus, b: MonitorEmailStatus): boolean {
    if (a.kind !== b.kind) return false
    if (a.kind === 'emailed' && b.kind === 'emailed') {
      return format(new Date(a.date), 'yyyy-MM-dd') === format(new Date(b.date), 'yyyy-MM-dd')
    }
    return true
  }
  // Combined callout text for a set of offline monitors on one rolled-up
  // product row: one shared status if they all agree, else a per-monitor
  // breakdown (ordinal "Monitor N" labels — serials aren't legible enough
  // to show directly in a tooltip) so a mixed "one emailed, one not" state
  // is never papered over with a single, misleading status line.
  function combinedOfflineStatus(monitors: TankRow[]): string {
    if (monitors.length <= 1) return monitors[0] ? formatEmailStatus(monitorEmailStatus(monitors[0])) : ''
    const sorted = [...monitors].sort((a, b) => (a.serial_rtu_id || a.system_tank_id || a.id).localeCompare(b.serial_rtu_id || b.system_tank_id || b.id))
    const statuses = sorted.map(monitorEmailStatus)
    const allSame = statuses.every((s) => sameEmailStatus(s, statuses[0]))
    if (allSame) return formatEmailStatus(statuses[0])
    return sorted.map((t, i) => `Monitor ${i + 1}: ${formatEmailStatus(monitorEmailStatus(t))}`).join(' · ')
  }

  // Stale/offline "Last Update" cell — same red/orange flag as the plain
  // render below. Hovering shows a fast, custom callout (not the native
  // browser tooltip) with whether/when we emailed about it; clicking an
  // offline reading opens the email draft scoped to just that monitor.
  function renderUpdatedCell(t: TankRow) {
    const d = t.inventory_time ?? t.reading_date
    const stale = isStaleReading(d)
    const cls = stale ? (t.keep_fill ? 'text-[#C0392B] font-bold' : 'text-[#E67E22] font-bold') : ''
    const title = stale ? formatEmailStatus(monitorEmailStatus(t)) : undefined
    return (
      <span
        className={`${cls} ${stale ? 'cursor-pointer hover:underline decoration-dotted' : ''}`}
        onMouseEnter={(e) => title && setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseMove={(e) => title && setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseLeave={() => setCallout(null)}
        onClick={() => { if (stale) { setEmailMonitorOverride([t]); setEmailKind('offline') } }}
      >
        {dateTime(d)}{stale ? ' ⚠' : ''}
      </span>
    )
  }

  // On Hand view's rolled-up "Last Update" cell — a product row can combine
  // several physical monitors. All rows here are keep-fill/VMI (onHandRows
  // only includes keep_fill tanks), so any offline monitor colors red, same
  // as the Configuration view's keep-fill branch.
  //   - all online: plain date (newest reading), no callout — unchanged
  //     from before this feature.
  //   - some online, some offline: shows the OFFLINE side's date (not the
  //     newer online one — the point is to surface the stale reading), with
  //     a "N online, M offline (<status>)" callout.
  //   - all offline: shows the newest of the offline dates, with just the
  //     status callout (no "N online" framing when there's nothing online
  //     to contrast against) — reduces to the exact single-monitor wording
  //     when the product only has one monitor at all.
  // Clicking scopes the email draft to every offline monitor on the row.
  function renderOnHandUpdatedCell(r: OnHandRow) {
    const { onlineMonitors, offlineMonitors } = r
    if (offlineMonitors.length === 0) return <span>{dateTime(r.lastUpdate)}</span>

    const title = onlineMonitors.length > 0
      ? `${onlineMonitors.length} monitor${onlineMonitors.length === 1 ? '' : 's'} online, ${offlineMonitors.length} monitor${offlineMonitors.length === 1 ? '' : 's'} offline (${combinedOfflineStatus(offlineMonitors)})`
      : combinedOfflineStatus(offlineMonitors)

    return (
      <span
        className="text-[#C0392B] font-bold cursor-pointer hover:underline decoration-dotted"
        onMouseEnter={(e) => setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseMove={(e) => setCallout({ x: e.clientX, y: e.clientY, text: title })}
        onMouseLeave={() => setCallout(null)}
        onClick={() => { setEmailMonitorOverride(offlineMonitors); setEmailKind('offline') }}
      >
        {dateTime(r.lastUpdate)} ⚠
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

  // Sidebar fields — resolved from the declarative SIDEBAR_FIELDS array
  // above plus every Locations Global Config column/custom field
  // (extraSidebarFields), then ordered/filtered by the user's own persisted
  // layout (drag reorder + hide, cross-device — see "Shop Details Fields"
  // under the page's Settings gear). A field whose render() returns null
  // (e.g. NC Inspection Station outside NC) is omitted entirely, same as the
  // old array literal's own conditional spread.
  const sidebarFieldsAll: ResolvedSidebarField[] = location ? [...SIDEBAR_FIELDS, ...extraSidebarFields]
    .map((f): ResolvedSidebarField | null => {
      const r = f.render({ location, shopId, shopLabel, rdOrderDay, rdDeliveryDay, rdDistributor, addressStr, inNC, valvolineSchedule })
      return r ? { id: f.id, label: f.label, value: r.value, note: r.note, mapQuery: r.mapQuery } : null
    })
    .filter((f): f is ResolvedSidebarField => !!f) : []
  const sidebarAllIds = sidebarFieldsAll.map((f) => f.id)
  const sidebarKnownOrder = sidebarLayout.order.filter((id) => sidebarAllIds.includes(id))
  const sidebarKnownSet = new Set(sidebarKnownOrder)
  // Only the original "special" fields auto-populate for a user who hasn't
  // customized their layout yet — a Global Config column/custom field must
  // be explicitly added via Manage Fields, so this list growing to ~100
  // options never floods an existing (or brand new) shop's Shop Details card
  // by itself.
  const sidebarOrderedIds = [...sidebarKnownOrder, ...SIDEBAR_DEFAULT_IDS.filter((id) => !sidebarKnownSet.has(id))]
  const visibleSidebar = sidebarOrderedIds
    .filter((id) => !sidebarLayout.hidden.includes(id))
    .map((id) => sidebarFieldsAll.find((f) => f.id === id))
    .filter((f): f is NonNullable<typeof f> => !!f)

  // Left-column box order/hide — reorder-only in spirit (no default-hidden
  // concept needed, all 6 boxes exist for every shop), same persisted-layout
  // shape as sidebar/order-config above.
  const leftBoxKnownOrder = leftBoxLayout.order.filter((id) => LEFT_BOX_IDS.includes(id))
  const leftBoxKnownSet = new Set(leftBoxKnownOrder)
  const leftBoxOrder = [...leftBoxKnownOrder, ...LEFT_BOX_IDS.filter((id) => !leftBoxKnownSet.has(id))]
    .filter((id) => !leftBoxLayout.hidden.includes(id))

  const visibleTankCols = TANK_COLS.filter((c) => !prefs.tank.includes(c.id))

  // Order-config columns — same persisted-layout shape as the sidebar
  // above, keyed separately. CONFIG_FIXED/USAGE_COLS are always in the
  // universe; meta columns come from allConfigMetaKeys (every metadata key
  // seen across ALL vendors' rows, computed above) so a column dragged/
  // hidden here applies consistently across every vendor's own order-config
  // block, even though a given vendor may only actually have some of them
  // (OrderConfigBlock filters its own rendered columns down to the ones its
  // rows actually carry, same as before this feature).
  const configDefaultOrder = [
    ...CONFIG_FIXED.filter((c) => c.id !== 'vmi').map((c) => c.id),
    ...allConfigMetaKeys.map((k) => `meta:${k}`),
    'vmi',
    ...USAGE_COLS.map((c) => c.id),
  ]
  const configLabelOf = (id: string): string => {
    const fixed = CONFIG_FIXED.find((c) => c.id === id); if (fixed) return fixed.label
    const usage = USAGE_COLS.find((c) => c.id === id); if (usage) return usage.label
    return id.startsWith('meta:') ? metaLabel(id.slice(5)) : id
  }
  const configAllColItems: ColItem[] = configDefaultOrder.map((id) => ({ id, label: configLabelOf(id) }))
  const configKnownOrder = configLayout.order.filter((id) => configDefaultOrder.includes(id))
  const configKnownSet = new Set(configKnownOrder)
  const configOrderedIds = [...configKnownOrder, ...configDefaultOrder.filter((id) => !configKnownSet.has(id))]
  const configShownIds = configOrderedIds.filter((id) => !configLayout.hidden.includes(id))

  function applyConfigShown(shown: string[]) {
    configLayout.setOrder(shown)
    configLayout.setHidden(configDefaultOrder.filter((id) => !shown.includes(id)))
  }
  function resetConfigColumns() {
    configLayout.setOrder([])
    configLayout.setHidden([])
    configLayout.setSizing({})
  }
  function handleConfigResize(id: string, delta: number) {
    configLayout.setSizing((prev) => {
      const cur = prev[id] ?? CONFIG_DEFAULT_WIDTH[id] ?? CONFIG_META_DEFAULT_WIDTH
      return { ...prev, [id]: Math.max(50, cur + delta) }
    })
  }
  function applySidebarShown(shown: string[]) {
    sidebarLayout.setOrder(shown)
    sidebarLayout.setHidden(sidebarAllIds.filter((id) => !shown.includes(id)))
  }
  function resetSidebarFields() {
    sidebarLayout.setOrder([])
    sidebarLayout.setHidden([])
  }
  function applyLeftBoxShown(shown: string[]) {
    leftBoxLayout.setOrder(shown)
    leftBoxLayout.setHidden(LEFT_BOX_IDS.filter((id) => !shown.includes(id)))
  }
  function resetLeftBoxes() {
    leftBoxLayout.setOrder([])
    leftBoxLayout.setHidden([])
  }

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
        case 'on_hand': return num1(t.on_hand)
        case 'available': return num1(t.available_capacity)
        case 'total_capacity': return num1(tankCapacity(t))
        case 'uncapped_capacity': return num1(uncappedCapacity(t))
        case 'level_inches': return num1(t.level_inches)
        case 'height': return num1(t.height)
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
      num1(r.tankOnHandQt),
      r.droptopOnHand == null ? '—' : num1(r.droptopOnHand),
      r.netVariance == null ? '—' : num1(r.netVariance),
      r.droptopUsage == null ? '—' : num1(r.droptopUsage),
      r.dosMonitor == null ? '—' : num1(r.dosMonitor),
      r.dosDroptop == null ? '—' : num1(r.dosDroptop),
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
            <CheckGroup title="Tank monitor columns" items={TANK_COLS.map((c) => ({ id: c.id, label: c.label }))} hidden={prefs.tank} onToggle={toggleTankHidden} />
            {/* Manage Columns for the other two tables used to be their own
                buttons next to each table's header — consolidated here so
                every column/field customization on this page lives behind
                one Settings entry point. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-navy/70 font-semibold">Manage Columns</span>
              <button onClick={() => setSidebarManagerOpen(true)} className="self-start text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy">Shop Details Fields</button>
              <button onClick={() => setConfigManagerOpen(true)} className="self-start text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy">Order Config Columns</button>
              <button onClick={() => setLeftBoxManagerOpen(true)} className="self-start text-[10px] font-mono text-inky border border-navy/30 rounded px-1.5 py-0.5 hover:border-navy">Left Column Layout</button>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-navy/70 font-semibold">Options</span>
              <label className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
                <input type="checkbox" checked={!!prefs.nonVmiOfflineBtn} onChange={() => setPrefs((p) => ({ ...p, nonVmiOfflineBtn: !p.nonVmiOfflineBtn }))} className="accent-sky" />
                Use non-VMI tanks for offline email button
              </label>
              <label className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer" title="Show Issues, Exception Reports, and Location Comms as a row instead of stacked">
                <input type="checkbox" checked={!!prefs.boxesSideBySide} onChange={() => setPrefs((p) => ({ ...p, boxesSideBySide: !p.boxesSideBySide }))} className="accent-sky" />
                Issues/Exceptions/Comms side by side
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
          {/* Left info — frozen while the tables/issues scroll. Rendered from
              leftBoxOrder (persisted, drag-reorderable via "Left Column
              Layout" under Settings) rather than a fixed sequence, so Issues/
              Exceptions/Comms can be moved above a Shop Details card that's
              grown tall from added Global Config fields. */}
          <div className={`self-start flex flex-col gap-3 ${embedded ? '' : 'lg:sticky'}`}
            style={!embedded ? { top: 'calc(var(--inv-navbar-h, 0px) + 4.5rem)' } : undefined}>
            {(() => {
              const boxContent: Record<string, ReactNode> = {
                shop_details: (
                  <Card>
                    <CardBody className="flex flex-col gap-2">
                      {!embedded && <Combobox options={shopOptions} value={shopId} onChange={setShopId} placeholder="Change shop…" />}
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Shop Details</span>
                      </div>
                      <dl className="flex flex-col gap-1.5">
                        {visibleSidebar.map((f) => (
                          <div key={f.id} className="relative flex flex-col rounded-lg border border-navy/15 bg-navy/[0.03] px-2.5 py-1.5">
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
                ),
                issues: <IssuesColumn pending={pendingIssues} resolved={resolvedIssues} onManage={openIssues} />,
                exceptions: <ExceptionsBox exceptions={exceptions} onAdd={openAddException} onEdit={openEditException} />,
                comms: <CommsBox comms={comms} onAdd={openAddComm} onEdit={openEditComm} />,
                custom_config: <CustomConfigBox locationId={shopId} locationLabel={loc.labelOf(shopId)} />,
                mentioned: (
                  <MentionedBox projects={mentionedProjects} meetings={mentionedMeetings}
                    onOpenProjects={() => navigate('/projects')} onOpenMeetings={() => navigate('/meetings')} />
                ),
              }
              // When "side by side" is on, Issues/Exceptions/Comms render as
              // one row together at the position of whichever of the three
              // appears FIRST in the user's own order, rather than each
              // taking its own slot — so reordering that trio relative to
              // Shop Details/Custom Config/Mentioned still works as expected.
              const sideBySideIds = ['issues', 'exceptions', 'comms']
              const rendered = new Set<string>()
              const nodes: ReactNode[] = []
              for (const id of leftBoxOrder) {
                if (rendered.has(id) || !boxContent[id]) continue
                if (prefs.boxesSideBySide && sideBySideIds.includes(id)) {
                  const group = sideBySideIds.filter((gid) => leftBoxOrder.includes(gid) && boxContent[gid])
                  group.forEach((gid) => rendered.add(gid))
                  nodes.push(
                    <div key="side-by-side-group" className="flex gap-3 flex-wrap items-start">
                      {group.map((gid) => <div key={gid} className="flex-1 min-w-[220px]">{boxContent[gid]}</div>)}
                    </div>,
                  )
                  continue
                }
                rendered.add(id)
                nodes.push(<div key={id}>{boxContent[id]}</div>)
              }
              return nodes
            })()}
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
                  {tankView === 'onhand' && (
                    <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky" title="Show every tank's comparison, not just VMI/keep-fill ones — useful for deciding whether a shop's tanks read close enough to Droptop to be worth switching to VMI.">
                      <Toggle checked={onHandIgnoreVmi} onChange={setOnHandIgnoreVmi} size="sm" color="cyan" />
                      Ignore VMI
                    </label>
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
                                  <span className="[overflow-wrap:normal]">{(c.id === 'on_hand' || c.id === 'available') && tankUnit ? `${c.label} (${tankUnit})` : c.label}</span>{sortArrow(tankSort, c.id)}
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
                    <p className="text-xs font-mono text-inky/60">
                      {onHandIgnoreVmi ? 'No tank monitors for this shop.' : 'No keep-fill/VMI tank monitors for this shop — try "Ignore VMI" to compare every tank.'}
                    </p>
                  ) : (
                    <div className="w-fit max-w-full self-start overflow-x-auto rounded border border-navy/30">
                      <table className="text-xs font-mono">
                        <thead>
                          <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                            {['Product ID', 'On Hand (Qts)', 'Droptop On Hand', 'Variance', 'Droptop Usage', 'DOS (Monitor)', 'DOS (Droptop)', 'Last Update'].map((h) => (
                              <th key={h} className="px-3 py-2 align-bottom max-w-[10ch] [overflow-wrap:normal] leading-tight text-right first:text-left last:text-left">{h}</th>
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
                                <td className="px-3 py-1.5 text-navy whitespace-nowrap text-left">{renderOnHandUpdatedCell(r)}</td>
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
                <span className="text-xs font-mono text-navy uppercase tracking-wide self-start">Order Configuration</span>
                {/* w-fit on this wrapper (not each Card) is what makes every
                    vendor's card share one common width — the widest table's
                    natural size — instead of each shrinking to its own,
                    independently-narrower content (RelaDyne vs. Valvoline
                    used to visibly misalign). Each Card below stretches to
                    fill this shrink-to-fit container via plain block sizing;
                    the container itself sizes to the widest child. */}
                <div className="w-fit max-w-full flex flex-col gap-4">
                  {configsByVendor.map(([vendor, rows]) => (
                    <OrderConfigBlock key={vendor} vendor={vendor} rows={rows} order={configShownIds} sizing={configLayout.sizing}
                      onResize={handleConfigResize}
                      onOpenConfig={() => navigate('/config?tab=order-config')}
                      onExceptionClick={setExceptionModalRow}
                    />
                  ))}
                </div>
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
          targets={[{ locationId: shopId, monitors: (emailMonitorOverride ?? (emailKind === 'offline' ? offlineTanks : keepfillTanks)) as unknown as TankMonitor[] }]}
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

      {exceptionModalRow && shopId && (
        <ExceptionEditModal
          open={!!exceptionModalRow}
          onClose={() => setExceptionModalRow(null)}
          locationId={shopId}
          productId={exceptionModalRow.product_id ?? ''}
          shopLabel={loc.fieldValue(shopId, 'shop_city') || loc.codeOf(shopId)}
          productLabel={exceptionModalRow.product_id ?? undefined}
          caseUnitLabel={String((exceptionModalRow.metadata as any)?.uom ?? '')}
          onSaved={load}
        />
      )}

      <ColumnManagerModal
        open={sidebarManagerOpen}
        onClose={() => setSidebarManagerOpen(false)}
        all={sidebarFieldsAll.map((f) => ({ id: f.id, label: f.label }))}
        shown={sidebarOrderedIds.filter((id) => !sidebarLayout.hidden.includes(id))}
        onChange={applySidebarShown}
        onReset={resetSidebarFields}
      />
      <ColumnManagerModal
        open={configManagerOpen}
        onClose={() => setConfigManagerOpen(false)}
        all={configAllColItems}
        shown={configShownIds}
        onChange={applyConfigShown}
        onReset={resetConfigColumns}
      />
      <ColumnManagerModal
        open={leftBoxManagerOpen}
        onClose={() => setLeftBoxManagerOpen(false)}
        all={LEFT_BOX_LABELS}
        shown={leftBoxOrder}
        onChange={applyLeftBoxShown}
        onReset={resetLeftBoxes}
      />
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

function CustomConfigBox({ locationId, locationLabel }: { locationId: string; locationLabel: string }) {
  const cfg = useCustomShopConfig()
  const packageOptions = useCustomShopConfigPackageOptions()
  const [editing, setEditing] = useState(false)
  const vals = cfg.valuesFor(locationId)
  const pkgs = cfg.packagesFor(locationId)
  const hasAny = vals.length > 0 || pkgs.length > 0
  const packageLabel = (key: string) => packageOptions.find((p) => p.package_key === key)?.display_name ?? key

  return (
    <div className={['rounded-lg border px-4 py-3 flex flex-col gap-2', hasAny ? 'border-sky/50 bg-sky/5' : 'border-navy/20 bg-cream'].join(' ')}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Custom Config</span>
        {hasAny && <Badge color="sky">Custom</Badge>}
      </div>
      {!hasAny ? (
        <span className="text-xs font-body text-inky/50">None</span>
      ) : (
        <div className="flex flex-col gap-1">
          {vals.map((v) => {
            const f = cfg.fields.find((x) => x.id === v.field_id)
            if (!f) return null
            return (
              <div key={v.id} className="text-xs font-body text-navy flex items-center justify-between gap-2">
                <span>{f.name}{v.package_key ? <span className="text-inky/50"> ({packageLabel(v.package_key)})</span> : null}</span>
                <span className="font-mono">{formatFieldValue(v.value, f.value_kind)}</span>
              </div>
            )
          })}
          {pkgs.length > 0 && (
            <div className="text-[10px] font-mono text-inky/60 mt-0.5">Applies to: {pkgs.map((p) => packageLabel(p.package_key)).join(', ')}</div>
          )}
        </div>
      )}
      <button onClick={() => setEditing(true)} className="text-[10px] font-mono text-sky text-left hover:underline">
        {hasAny ? 'Edit Custom Config' : '+ Add Custom Config'}
      </button>
      {editing && <CustomShopConfigModal cfg={cfg} packageOptions={packageOptions} locationId={locationId} locationLabel={locationLabel} onClose={() => setEditing(false)} />}
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

function OrderConfigBlock({ vendor, rows, order, sizing, onResize, onOpenConfig, onExceptionClick }: {
  vendor: string; rows: ConfigRow[]
  // `order` is the shared, user-customizable, already-hidden-filtered column
  // id order (see LocationDetailView's configShownIds) — the same order and
  // hide selections apply across every vendor's own block. `sizing` is the
  // shared column-width map (px), dragged via each header's ResizeHandle.
  order: string[]; sizing: Record<string, number>; onResize: (id: string, deltaPx: number) => void
  onOpenConfig: () => void; onExceptionClick: (row: ConfigRow) => void
}) {
  const navigate = useNavigate()
  const [sort, setSort] = usePersistedSort(`location-lookup:config-sort:${vendor}`)
  const columns = useMemo(() => {
    const metaKeys = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) if (!CONFIG_META_EXCLUDE.has(k)) metaKeys.add(k)
    const metaCols: Col<ConfigRow>[] = [...metaKeys].sort().map((k) => ({ id: `meta:${k}`, label: metaLabel(k), align: 'left', render: (r) => String((r.metadata as any)?.[k] ?? '—'), sort: (r) => String((r.metadata as any)?.[k] ?? '') }))
    const byId = new Map<string, Col<ConfigRow>>()
    for (const c of CONFIG_FIXED) byId.set(c.id, c)
    for (const c of metaCols) byId.set(c.id, c)
    for (const c of USAGE_COLS) byId.set(c.id, c)
    // Render exactly the shared, ordered `order` list — but only the ids
    // this vendor's own rows actually have (a meta column only exists here
    // if at least one of THIS vendor's rows carries that metadata key;
    // fixed/usage columns always apply), same per-vendor filtering as
    // before this feature, just driven by the shared order instead of a
    // fixed part/uom/capacity/… sequence.
    return order.map((id) => byId.get(id)).filter((c): c is Col<ConfigRow> => !!c)
  }, [rows, order])

  const sortedRows = useMemo(() => applySort(rows, columns, sort), [rows, columns, sort])
  const updated = useMemo(() => lastUpdated(rows as any[], ['updated_at']), [rows])
  // Newest inventory.product_usage sync among this vendor's products — shown
  // as its own callout since it's a different source/cadence than the order
  // config rows themselves.
  const usageUpdated = useMemo(() => lastUpdated(rows.map((r) => r.usage).filter(Boolean) as any[], ['updated_at']), [rows])
  // VMI row highlight — RelaDyne only for now (explicit ask), so a shop's
  // VMI status stays visible even if the VMI column itself is hidden via
  // Manage Columns. Shown as a legend rather than a header label since it's
  // a row-level cue, not a column.
  const showVmiLegend = isReladyne(vendor)
  const vmiCount = useMemo(() => rows.filter(isVmiRow).length, [rows])

  return (
    <Card className="w-full">
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
          {showVmiLegend && (
            <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-inky/70">
              <span className="w-8 h-3 rounded-sm bg-sky/40 border border-sky" />
              = VMI ({vmiCount} Product{vmiCount === 1 ? '' : 's'})
            </span>
          )}
        </div>
        {columns.length === 0 ? (
          <p className="text-xs font-mono text-inky/60">All config columns hidden — enable some under Settings → Manage Columns.</p>
        ) : (
          <div className="w-fit max-w-full self-start overflow-x-auto rounded border border-navy/30">
            <table className="text-xs font-mono table-fixed">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  {columns.map((c) => {
                    const w = configColWidth(c.id, sizing)
                    return (
                      <th key={c.id} style={{ width: w, minWidth: w }} className={`relative px-3 py-2 whitespace-nowrap ${alignCls(c.align)} ${c.tint ? USAGE_TINT : ''}`}>
                        <button onClick={() => setSort((s) => nextSort(s, c.id))} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-center max-w-full overflow-hidden text-ellipsis">
                          {c.label}{sortArrow(sort, c.id)}
                        </button>
                        <ResizeHandle onResize={(delta) => onResize(c.id, delta)} />
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => {
                  const rowIsVmi = showVmiLegend && isVmiRow(r)
                  return (
                  <tr key={r.id} className={`border-b border-navy/20 ${rowIsVmi ? 'bg-sky/10' : ''}`}>
                    {columns.map((c) => {
                      const w = configColWidth(c.id, sizing)
                      return c.id === 'exception' ? (
                        <td key={c.id}
                          style={{ width: w, minWidth: w, maxWidth: w }}
                          className={`px-3 py-1.5 text-navy overflow-hidden ${alignCls(c.align)} cursor-pointer hover:bg-sky/10 transition-colors`}
                          title="Click to add or edit a floor/ceiling exception for this product"
                          onClick={() => onExceptionClick(r)}
                        >
                          {c.render(r)}
                        </td>
                      ) : (
                        <td key={c.id} style={{ width: w, minWidth: w, maxWidth: w }} className={`px-3 py-1.5 text-navy whitespace-nowrap overflow-hidden text-ellipsis ${alignCls(c.align)} ${c.tint ? USAGE_TINT : ''}`}>{c.render(r)}</td>
                      )
                    })}
                  </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
