import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RefreshCw, ChevronRight, ChevronDown, ChevronUp, Settings, Plus, Pencil } from 'lucide-react'
import { Button, Card, CardBody, Input, Modal, SbLoader, Toggle } from '@/components/ui'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { OrdersV2SettingsBody } from './OrdersV2Settings'
import { OrderStepper } from './OrderStepper'
import { ExceptionEditModal } from './ExceptionEditModal'
import { ProductExceptionsManager } from './ProductExceptionsManager'
import { useProductExceptions } from './useProductExceptions'
import { useLastOrderedInfo } from './useLastOrderedInfo'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import {
  useDraft, useGenerationData, useOrderSettings, useVendorRules,
  buildGenerationInputs, eligibleLocations, draftOrderDow, draftAdHocLocationIds, shopsPerOrderDay, isOunceUnit,
  GLOBAL_EXCEPTION_LOCATION_ID, type DraftLineRow,
} from './useOrdersV2'
import { useVendors } from './useLookups'
import { generateOrder, nextDeliveryDate, resolveDeliveryDate, dosAfterDelivery, gallonsPerUnit, resolvedOrderType, daysOfSupply, daysBetween, unitsToTarget, capsFor, roundQty } from './engine'
import { FLAG_CLASS, FLAG_META, OVERRIDE_CELL, dos, money, num, dosAfterForQty, dShort } from './shared'
import { OrdersV2ReviewTable } from './OrdersV2ReviewTable'
import type { LineFlag, GenerationInput, OrderType, DeliverySchedule, WeekCalendar } from './types'

// New-table beta toggle (2026-09-25) — per-browser (localStorage), not a
// company-wide setting: the whole point is testing OrdersV2ReviewTable.tsx
// against real live orders without changing what anyone else sees, so it
// defaults OFF and only flips for whoever explicitly turns it on here.
const NEW_TABLE_KEY = 'ov2_review_new_table'
function loadNewTablePref(): boolean {
  try { return localStorage.getItem(NEW_TABLE_KEY) === '1' } catch { return false }
}

type SortKey = 'location' | 'capacity' | 'product' | 'qty' | 'dollars' | 'dos_after'

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Main table's column registry — id order here is the DEFAULT order/set;
// a user's own reorder/hide choices (columnPrefs below) override it. 'shop'
// can't be hidden (the expand-a-shop interaction lives on it), everything
// else is optional. Persisted to localStorage only (per-device), same
// scope as the location list's own "Customize columns" panel.
const MAIN_COLUMNS: { id: string; label: string }[] = [
  { id: 'shop', label: 'Shop' },
  { id: 'product', label: 'Product' },
  { id: 'uom', label: 'UOM' },
  { id: 'capacity', label: 'Capacity' },
  { id: 'on_hand', label: 'On Hand' },
  { id: 'usage_day', label: 'Usage/day' },
  { id: 'dos_now', label: 'DOS Now' },
  { id: 'last_ordered', label: 'Last Ordered' },
  { id: 'last_delivered', label: 'Last Delivered' },
  { id: 'delivery_date', label: 'Delivery' },
  { id: 'qty', label: 'Qty' },
  { id: 'on_hand_after', label: 'On Hand After' },
  { id: 'dos_after', label: 'DOS After' },
  { id: 'dos_at_delivery', label: 'DOS @ Delivery' },
  { id: 'dollars', label: '$' },
  { id: 'flags', label: 'Flags' },
  { id: 'actions', label: '' },
]
const DEFAULT_COLUMN_ORDER = MAIN_COLUMNS.map((c) => c.id)
const COLUMN_PREFS_KEY = 'ov2_review_columns'

function loadColumnPrefs(): { order: string[]; hidden: string[] } {
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY)
    if (!raw) return { order: DEFAULT_COLUMN_ORDER, hidden: [] }
    const parsed = JSON.parse(raw) as { order?: string[]; hidden?: string[] }
    // Merge in any column added since a user last saved prefs (e.g. this
    // release's new on_hand_after) — appended at the end rather than
    // silently missing from their customized order.
    const known = new Set(parsed.order ?? [])
    const order = [...(parsed.order ?? []), ...DEFAULT_COLUMN_ORDER.filter((id) => !known.has(id))]
    return { order, hidden: (parsed.hidden ?? []).filter((id) => id !== 'shop') }
  } catch {
    return { order: DEFAULT_COLUMN_ORDER, hidden: [] }
  }
}

const PO_DECISION_FLAGS: LineFlag[] = ['po_decision_override', 'po_decision_exclude', 'po_decision_combine']
/** Swaps in one of the three mutually-exclusive PO-coverage decision flags,
 * leaving covered_by_open_po (the trigger) and everything else untouched. */
function withPoDecision(flags: LineFlag[], decision: LineFlag): LineFlag[] {
  return [...flags.filter((f) => !PO_DECISION_FLAGS.includes(f)), decision]
}

/**
 * Step 2 — the working order. Generates on demand, then every edit autosaves
 * straight into the draft's lines so leaving the page loses nothing.
 */
export function OrdersV2Review() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()
  const { settings, loading: settingsLoading } = useOrderSettings()
  const { rulesFor } = useVendorRules()
  const { fetchInputs } = useGenerationData()
  const { draft, lines, loading, reload, replaceLines, patchLine, addLine, removeLine, setStatus } = useDraft(draftId || null)
  // Last Ordered/Last Delivered columns + on-hand plausibility flag
  // (2026-09-22 request) — called unconditionally (before the loading/
  // not-found early returns below) per Rules of Hooks; vendors.byId
  // tolerates a still-null draft.vendor_id fine.
  const lastOrderedInfo = useLastOrderedInfo(draft?.vendor_id ?? null, vendors.byId(draft?.vendor_id ?? null)?.name ?? null)
  // For the inline +/Edit button next to each line's Qty box — whether a
  // shop-specific or global exception already exists decides which icon
  // shows (Plus = add, Pencil = edit an existing one), matching Product
  // Exceptions' own page. rows is the full company-wide list (small table),
  // shared here rather than re-fetched per line.
  const { rows: exceptionRows, reload: reloadExceptions } = useProductExceptions()
  const [exceptionTarget, setExceptionTarget] = useState<{ locationId: string; productId: string } | null>(null)
  const exceptionFor = useCallback((locationId: string, productId: string) =>
    exceptionRows.find((r) => r.location_id === locationId && r.product_id === productId)
      ?? exceptionRows.find((r) => r.location_id === GLOBAL_EXCEPTION_LOCATION_ID && r.product_id === productId)
      ?? null,
    [exceptionRows])
  // Opened in place instead of navigating to /orders-v2/exceptions (per
  // request — leaving this page loses the whole review state and requires
  // reopening the order). needsRegenerate flags the Regenerate button
  // whenever something changed that this order's ALREADY-persisted lines
  // don't reflect yet: an exception applied to ALL shops (which can affect
  // shop/product combos not currently on screen), or the DOS targets card
  // below — not a plain qty edit, which the user already sees and controls
  // directly. A shop-specific exception is deliberately excluded: it only
  // ever affects the one shop/product the user is already looking at right
  // where they added it.
  const [exceptionsModalOpen, setExceptionsModalOpen] = useState(false)
  const [needsRegenerate, setNeedsRegenerate] = useState(false)
  const onExceptionChanged = useCallback((locationId?: string) => {
    reloadExceptions()
    if (locationId === GLOBAL_EXCEPTION_LOCATION_ID) setNeedsRegenerate(true)
  }, [reloadExceptions])
  // Manual raw-tank-name -> our_part_number overrides (Tank Monitors'
  // Product Mapping tab) — needed so a keep-fill product's tank reading
  // actually matches its order-config product_id (tank telemetry names
  // products however the provider does, e.g. "DMX SYN 0W20", never the
  // shop's canonical id). Same setting LocationLookupPage.tsx already
  // reads for its own on-hand display.
  const [tankProductMap] = useAppSetting<Record<string, string>>('tank_product_map', {})

  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 })
  const [showVmi, setShowVmi] = useState(false)
  // Direct ask (2026-09-24) — a way to jump straight to the lines the
  // engine deliberately ordered past configured capacity to reach the DOS
  // target (see engine.ts's exceedsCapacityForTarget), so the amount
  // ordered can be double-checked without scanning every line's flags.
  const [showOnlyOverCapacity, setShowOnlyOverCapacity] = useState(false)
  // Separate from showVmi above (which controls the main order-lines
  // table) — this one controls every "configured products for this shop"
  // list (the shop-expand row and Shops With No Orders below), which
  // should default to just what's actually being ordered.
  const [showConfigVmi, setShowConfigVmi] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('location')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const [filter, setFilter] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Collapsed by default — "Shops With No Orders" (see shopsWithNoOrders
  // below) is a review/audit list, not something that needs to be open on
  // every visit to this page.
  const [noOrdersOpen, setNoOrdersOpen] = useState(false)
  const [skipped, setSkipped] = useState<{ location_id: string; product_id: string; reason: string }[]>([])
  const [dayCounts, setDayCounts] = useState<number[]>([0, 0, 0, 0, 0, 0, 0])
  // Every candidate the engine considered for this run, not just the ones
  // that made it onto the draft — the smoothing panel needs the shop's
  // full config (including products it decided NOT to order) to show what
  // else could be pulled in, not just what already is.
  const [allInputs, setAllInputs] = useState<GenerationInput[]>([])
  // Which locations the last run even considered for this order day — null
  // means the vendor doesn't use order days at all (every location is
  // "eligible" so the distinction is meaningless). Stored from the same
  // run's own eligibleLocations() call so the "Shops With No Orders"
  // section below doesn't need to recompute it separately.
  const [eligibleLocationIds, setEligibleLocationIds] = useState<Set<string> | null>(null)
  // A product whose real-world tracking unit is ounces (global_products.
  // unit_of_measure, e.g. HM0806 = "Ounces") is converted to quarts before
  // it ever reaches the engine, since the deficit/capacity/DOS math all
  // assumes quarts throughout (see buildGenerationInputs' own comment) —
  // that conversion is correct and stays untouched. This is display-only:
  // for exactly these products, On Hand/Daily Usage/the order-amount
  // annotation are shown back in ounces (the unit that actually guides
  // ordering decisions for them) rather than their quarts-equivalent.
  const [ozProductIds, setOzProductIds] = useState<Set<string>>(new Set())
  // Per-shop delivery schedule data, kept in state (not just runGeneration's
  // own local closure) so the shop-expand sub-table's "DOS after delivery"
  // calc can resolve a delivery date for ANY shop it's showing — including
  // one that has no line at all yet, which the generation run's own
  // per-line delivery lookup never touches. Populated by both
  // loadCandidatesForDisplay (revisiting an already-generated draft) and
  // runGeneration (a fresh run) — same fetchInputs() call already fetches
  // this, it just wasn't kept around before.
  const [deliveryLookup, setDeliveryLookup] = useState<{
    schedules: Map<string, DeliverySchedule>; calendar: WeekCalendar; deliveryDow: Map<string, number | null>
  }>({ schedules: new Map(), calendar: new Map(), deliveryDow: new Map() })
  const deliveryFor = useCallback((locationId: string | null, fromDate: string): string | null => {
    const sched = deliveryLookup.schedules.get(locationId ?? '')
    return sched
      ? resolveDeliveryDate(fromDate, sched, deliveryLookup.calendar)
      : nextDeliveryDate(fromDate, deliveryLookup.deliveryDow.get(locationId ?? '') ?? null)
  }, [deliveryLookup])
  // Compact schedule description for the new Delivery column — direct
  // feedback 2026-09-24 ("show the delivery date and delivery schedule for
  // the Valvoline orders, this will help us sanity check the math on the on
  // hand after and the dos after"). Same shape/wording as
  // DeliverySchedulesCard.tsx's own `describe()` (that one reads a raw DB
  // row's `schedule_type`/etc.; this reads the parsed DeliverySchedule the
  // engine/review page already use) — kept as a separate small helper
  // rather than sharing, since the two operate on different row shapes.
  const describeSchedule = useCallback((locationId: string | null): string | null => {
    const sched = deliveryLookup.schedules.get(locationId ?? '')
    if (sched) {
      if (sched.type === 'plus_business_days') return `+${sched.lead_business_days} business days`
      if (sched.type === 'week_ab') {
        return `A: ${sched.week_a_dow == null ? '—' : DOW[sched.week_a_dow]} · B: ${sched.week_b_dow == null ? '—' : DOW[sched.week_b_dow]} (${sched.lead_business_days}d lead)`
      }
      return `${sched.delivery_dow == null ? '—' : DOW[sched.delivery_dow]} weekly (${sched.lead_business_days}d lead)`
    }
    // No per-vendor schedule configured (ov2_location_schedules) — falls
    // back to the RelaDyne weekday straight off the location list, same
    // source deliveryFor's own else-branch (nextDeliveryDate) uses.
    const dow = deliveryLookup.deliveryDow.get(locationId ?? '')
    return dow != null ? `${DOW[dow]} (Reladyne delivery day)` : null
  }, [deliveryLookup])
  // Main table column customize modal — hide/reorder, see MAIN_COLUMNS.
  const [columnPrefs, setColumnPrefs] = useState(loadColumnPrefs)
  const [columnModalOpen, setColumnModalOpen] = useState(false)
  const [useNewTable, setUseNewTableState] = useState(loadNewTablePref)
  function setUseNewTable(v: boolean) {
    setUseNewTableState(v)
    try { localStorage.setItem(NEW_TABLE_KEY, v ? '1' : '0') } catch { /* ignore */ }
  }
  const visibleColumnIds = useMemo(
    () => columnPrefs.order.filter((id) => !columnPrefs.hidden.includes(id)),
    [columnPrefs],
  )
  function saveColumnPrefs(next: { order: string[]; hidden: string[] }) {
    setColumnPrefs(next)
    try { localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }
  const orderDow = draft ? draftOrderDow(draft) : new Date().getDay()
  // Ad hoc drafts bypass the vendor's order-day schedule entirely (see
  // runGeneration below) — the weekday selector/labels further down don't
  // apply and would be actively misleading (implying day-based filtering
  // that isn't happening), so they're suppressed wherever this is true.
  const isAdHoc = draft ? !!draftAdHocLocationIds(draft) : false
  const [settingsModalOpen, setSettingsModalOpen] = useState(false)
  const [movingToFinal, setMovingToFinal] = useState(false)
  // Per-order DOS target/trigger/max — seeded from the real company settings
  // once they load, then edited freely without ever writing back to them
  // ("does not automatically update the settings", per request). Only
  // Regenerate (below) actually applies whatever's currently in these
  // fields; editing alone does nothing until then.
  const [dosOverride, setDosOverride] = useState<{ target: number; trigger: number; max: number } | null>(null)
  const dosOverrideSeeded = useRef(false)
  useEffect(() => {
    if (dosOverrideSeeded.current || settingsLoading) return
    dosOverrideSeeded.current = true
    setDosOverride({
      target: settings.days_of_supply_target,
      trigger: settings.days_of_supply_min_trigger,
      max: settings.days_of_supply_max,
    })
  }, [settings, settingsLoading])
  // What generation (and the DOS After color coding below) actually uses —
  // the real settings with just the three DOS fields swapped for whatever's
  // in the card, once seeded.
  const effectiveSettings = useMemo(
    () => (dosOverride ? { ...settings, days_of_supply_target: dosOverride.target, days_of_supply_min_trigger: dosOverride.trigger, days_of_supply_max: dosOverride.max } : settings),
    [settings, dosOverride],
  )

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  // A hand-edited qty updates DOS After the same way generation would have
  // computed it for that qty — was previously frozen at whatever
  // generation produced, silently going stale the moment someone typed a
  // different number. DOS @ Delivery is unaffected — it's existing on-hand
  // only, independent of qty (see dosAfterForQty's own comment).
  //
  // Also flips `included` the same way buildLine() itself decides it for a
  // freshly-generated line (included = units > 0), for every line except a
  // genuine VMI/keep-fill one — those stay excluded by design until an
  // explicit Include click, even with a qty typed in, so a quantity can be
  // previewed without committing to order it. This mattered little before
  // (VMI was the only case where qty and included could ever disagree) but
  // became a real point of confusion once Valvoline's "always list every
  // configured product" (alwaysListConfiguredProducts) started generating
  // regular, non-VMI qty:0/included:false placeholder rows — found live
  // 2026-09-24: a shop's not-yet-due product could be typed into (a real
  // qty) while the row stayed dimmed, since only the explicit Include
  // toggle used to flip that flag.
  const patchQty = useCallback((l: DraftLineRow, qty: number) => {
    const isVmi = l.flags?.includes('vmi_keepfill')
    patchLine(l.id, { qty, dos_after: dosAfterForQty(l, qty), ...(isVmi ? {} : { included: qty > 0 }) })
  }, [patchLine])

  // DOS After coloring, against this order's own target/max (the card
  // above, not necessarily the saved company settings) — over max is
  // orange (overstocked past the soft ceiling), at/above target but within
  // max is green (right where it should be), under target is red (the
  // order didn't get this product where it needs to be).
  const dosAfterColorClass = useCallback((v: number | null): string => {
    if (v == null || !dosOverride) return 'text-navy'
    if (v > dosOverride.max) return 'text-[#E67E22]'
    if (v >= dosOverride.target) return 'text-[#2ECC71]'
    return 'text-[#C0392B]'
  }, [dosOverride])

  // Read-only counterpart to runGeneration below — fetches/builds the same
  // candidate set (allInputs/eligibleLocationIds/ozProductIds) but never
  // touches the draft's persisted lines or status. Needed because
  // runGeneration only auto-fires once, for a brand-new empty draft (see
  // its own effect below) — revisiting an already-generated draft later
  // left allInputs at its initial empty state for the rest of the session,
  // which silently starved "Every product configured for this shop" down
  // to just the shop's already-ordered lines (found live 2026-09-22: shop
  // 212-Paris has 18 active RelaDyne configs, only 2 of which had lines,
  // and the expand view showed only those 2 instead of all 18). Runs once
  // per draft load, gated on allInputs still being empty so it never
  // fights a real (destructive) generation run.
  const loadCandidatesForDisplay = useCallback(async () => {
    if (!draft || !profile?.company_id) return
    try {
      const { configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, exceptions, days, schedules, calendar } = await fetchInputs(
        draft.vendor_id, settings.flag_cumulative_days,
      )
      const inputs = buildGenerationInputs(configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, [], [], tankProductMap, exceptions)
      setAllInputs(inputs)
      setOzProductIds(new Set(globalProducts.filter((g) => isOunceUnit(g.unit_of_measure)).map((g) => g.product_id)))
      setDeliveryLookup({ schedules, calendar, deliveryDow: new Map(days.map((d) => [d.location_id, d.delivery_dow])) })
      const adHocIds = draftAdHocLocationIds(draft)
      const eligibleIds = adHocIds
        ? new Set(adHocIds)
        : eligibleLocations(days, rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays, draft.order_date, draftOrderDow(draft))
      setEligibleLocationIds(eligibleIds)
    } catch (e) {
      // Never leave this silent — a failed fetch here previously left
      // allInputs empty with no explanation, reading as "no other products
      // configured" rather than "couldn't load." See fetchAll's own comment
      // in useOrdersV2.ts for the matching runGeneration-side fix.
      toast.error(e instanceof Error ? e.message : 'Failed to load configured products')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, profile?.company_id, fetchInputs, settings, rulesFor, vendors])

  useEffect(() => {
    if (draft && !loading && lines.length > 0 && allInputs.length === 0 && !generating && !vendors.loading) void loadCandidatesForDisplay()
  }, [draft, loading, lines.length, allInputs.length, generating, loadCandidatesForDisplay, vendors.loading])

  /** Run the engine and replace the draft's lines with the result. */
  const runGeneration = useCallback(async (dow?: number) => {
    if (!draft || !profile?.company_id) return
    // Refuses to run ahead of useVendors()'s own fetch — found live
    // 2026-09-23: rulesFor()'s usesOrderDays depends on
    // vendors.byId(draft.vendor_id)?.name, which is null/undefined until
    // that fetch resolves; isReladyne(undefined) reads as false, silently
    // disabling RelaDyne's whole order-day restriction for whichever run
    // raced ahead of it (auto-generate-on-open, with no user-interaction
    // delay, was the reliable trigger). Every caller (auto-generate, the
    // order-day dropdown, manual Regenerate) goes through this one
    // function, so guarding here protects all of them at once.
    if (vendors.loading) { toast.error('Still loading vendor data — try again in a moment'); return }
    const useDow = dow ?? draftOrderDow(draft)
    setGenerating(true)
    setGenProgress({ loaded: 0, total: 0 })
    try {
      const { configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, exceptions, days, schedules, calendar, history } = await fetchInputs(
        draft.vendor_id, settings.flag_cumulative_days,
        (loaded, total) => setGenProgress({ loaded, total }),
      )
      const inputs = buildGenerationInputs(configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, [], [], tankProductMap, exceptions)
      setAllInputs(inputs)
      setOzProductIds(new Set(globalProducts.filter((g) => isOunceUnit(g.unit_of_measure)).map((g) => g.product_id)))
      setDeliveryLookup({ schedules, calendar, deliveryDow: new Map(days.map((d) => [d.location_id, d.delivery_dow])) })
      // An ad hoc draft (explicit shop list, set at "Start New Order") wins
      // outright over the vendor's regular order-day schedule — the whole
      // point is to scope to exactly those shops regardless of what day it
      // is or whether the vendor even uses order days at all. Everything
      // else about generation (DOS targets, minimums, smoothing, flags)
      // runs identically; eligibleLocationIds is the one thing that changes.
      const adHocIds = draftAdHocLocationIds(draft)
      const eligibleIds = adHocIds
        ? new Set(adHocIds)
        : eligibleLocations(days, rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays, draft.order_date, useDow)
      setEligibleLocationIds(eligibleIds)
      const result = generateOrder(inputs, {
        settings: effectiveSettings,
        vendor: rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name),
        orderDate: draft.order_date,
        eligibleLocationIds: eligibleIds,
        history,
        // Keep-fill/VMI lines are always generated now (for the runway
        // check below) — the Review page's "Show VMI / keepfill" toggle
        // only controls whether they're visible in the table, and they
        // start excluded from the order total regardless (see buildLine).
        includeVmi: true,
      })

      // Days of supply at delivery uses the shop's configured delivery day.
      const deliveryDow = new Map(days.map((d) => [d.location_id, d.delivery_dow]))
      // A configured per-shop schedule wins; otherwise fall back to the
      // RelaDyne weekday from the location list. Shared by the delivery
      // math below and the keep-fill runway check further down.
      const deliveryFor = (locationId: string | null, fromDate: string) => {
        const sched = schedules.get(locationId ?? '')
        return sched
          ? resolveDeliveryDate(fromDate, sched, calendar)
          : nextDeliveryDate(fromDate, deliveryDow.get(locationId ?? '') ?? null)
      }

      // Keep-fill runway check — independent of the standard reorder
      // trigger, since a VMI product needs to last to its delivery AFTER
      // NEXT (the earliest a follow-up keep-fill order placed today could
      // realistically land) regardless of whether it's currently due for a
      // normal reorder. Checked against every VMI input, not just the ones
      // that cleared the trigger and became order lines, so a product with
      // enough days-of-supply to clear that generic threshold but not
      // enough to reach this specific date isn't missed.
      const keepfillAlerts = inputs.filter((i) => i.rule.vmi_keepfill_enabled).map((i) => {
        const deliver1 = deliveryFor(i.location_id, draft.order_date)
        const deliver2 = deliver1 ? deliveryFor(i.location_id, deliver1) : null
        const runwayDays = daysOfSupply(i.on_hand, i.daily_usage)
        const daysToDeliver2 = deliver2 ? daysBetween(draft.order_date, deliver2) : null
        return {
          location_id: i.location_id, product_id: i.product_id,
          on_hand: i.on_hand, daily_usage: i.daily_usage, runway_days: runwayDays,
          next_delivery: deliver1, delivery_after_next: deliver2,
          no_tank_data: i.on_hand == null,
          will_run_out: runwayDays != null && daysToDeliver2 != null && runwayDays < daysToDeliver2,
        }
      }).filter((a) => a.will_run_out || a.no_tank_data)
      const runOutKeys = new Set(keepfillAlerts.filter((a) => a.will_run_out).map((a) => `${a.location_id}|${a.product_id}`))
      // Flagged for a decision, never auto-resolved — see engine
      // buildGenerationInputs' pendingPoQty comment. A line here still
      // ordered its normal suggested quantity; the flag just means "an
      // open PO already has some of this outstanding, take a look."
      const openPoKeys = new Set(inputs.filter((i) => (i.pendingPoQty ?? 0) > 0).map((i) => `${i.location_id}|${i.product_id}`))

      const withDelivery = result.lines.map((l) => {
        const deliver = deliveryFor(l.location_id, draft.order_date)
        const key = `${l.location_id}|${l.product_id}`
        let flags = l.flags
        if (runOutKeys.has(key) && !flags.includes('keepfill_will_run_out')) flags = [...flags, 'keepfill_will_run_out' as const]
        if (openPoKeys.has(key) && !flags.includes('covered_by_open_po')) flags = [...flags, 'covered_by_open_po' as const]
        // DOS @ Delivery is the shop's EXISTING stock only, run down by usage
        // over the lead time — never the new order's gallons, which aren't
        // on the shelf until delivery day itself (see dosAfterDelivery).
        return { ...l, flags, dos_after_delivery: dosAfterDelivery(l.on_hand, l.daily_usage, draft.order_date, deliver) }
      })

      await replaceLines(withDelivery)
      setSkipped(result.skipped)
      const shops = new Set(withDelivery.map((l) => l.location_id)).size
      // Cache the shop count (and keep-fill alerts) on the header so the
      // landing page / Final Review can read them without loading every
      // line or re-fetching tank data.
      setDayCounts(shopsPerOrderDay(days))
      await (supabase as any).schema('inventory').from('ov2_order_drafts')
        .update({
          // Rebuilding this object from effectiveSettings (not spreading
          // draft.settings_snapshot) drops any other __-prefixed field that
          // isn't explicitly carried forward here — __adhoc_location_ids
          // has to be threaded through explicitly or a regenerate silently
          // reverts an ad hoc draft back to the vendor's regular schedule.
          settings_snapshot: { ...effectiveSettings, __shop_count: shops, __order_dow: useDow, __keepfill_alerts: keepfillAlerts, __adhoc_location_ids: adHocIds },
          // Never downgrade an already-finalized draft back to 'review' —
          // a completed order's own steps are now revisitable (e.g. to
          // regenerate after adding a global product exception, then
          // reformat/re-download the export), and this write would
          // otherwise silently misfile it into the Review tab on the
          // landing page while it's ALSO still sitting in Completed.
          status: draft.status === 'exported' ? 'exported' : 'review',
        })
        .eq('id', draft.id)
      await reload()
      setNeedsRegenerate(false)
      toast.success(`Generated ${withDelivery.length} line${withDelivery.length !== 1 ? 's' : ''} across ${shops} shop${shops !== 1 ? 's' : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }, [draft, profile?.company_id, fetchInputs, settings, effectiveSettings, rulesFor, replaceLines, reload, vendors])

  // Generate automatically the first time a fresh draft is opened. Guarded
  // by autoGenAttemptedRef (not just draft.status) — found live 2026-09-21:
  // when runGeneration() throws (a real fetch error, now surfaced instead
  // of swallowed — see fetchAll's own comment in useOrdersV2.ts), it never
  // reaches the status:'review' update, so draft.status stays 'generating'
  // forever. Without this guard, generating flipping true->false on the
  // failed attempt re-satisfies every condition below and this effect
  // re-fires immediately — an infinite retry loop hammering the same
  // failing query and re-toasting the same error on every pass. The ref is
  // keyed per draft id so switching to a different draft still auto-fires
  // once, and a genuinely successful run's reload() (new lines, status
  // 'review') exits the loop through lines.length/status same as before.
  const autoGenAttemptedRef = useRef<string | null>(null)
  useEffect(() => {
    // vendors.loading deliberately does NOT set autoGenAttemptedRef below —
    // this should just wait and re-fire once the fetch resolves (this
    // effect re-runs on every vendors.loading change since it's a dep),
    // not count as "already attempted" the way a real generation failure does.
    if (!draft || draft.status !== 'generating' || loading || lines.length !== 0 || generating || vendors.loading) return
    if (autoGenAttemptedRef.current === draft.id) return
    autoGenAttemptedRef.current = draft.id
    void runGeneration()
  }, [draft, loading, lines.length, generating, runGeneration, vendors.loading])

  // ---- grouping + derived numbers -----------------------------------------
  const groups = useMemo(() => {
    const m = new Map<string, DraftLineRow[]>()
    for (const l of lines) {
      const k = `${l.location_id}|${l.order_type}`
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(l)
    }
    return m
  }, [lines])

  const overrideCount = useMemo(() => lines.filter((l) => l.is_override).length, [lines])

  // Live "does this shop/order-type group still meet its minimum" check —
  // recomputed from the CURRENT included lines' qty/dollars, not the
  // engine's own below_minimum flag, which is stamped once at generation
  // time and goes stale the instant someone edits a qty or adds/removes a
  // line afterward (found live 2026-09-22: editing an order never updated
  // whether it still cleared the minimum). Mirrors generateOrder's own
  // dollars/units_per_order/case-type minimum resolution in engine.ts
  // exactly, so this reads the same threshold the engine itself used.
  // Per-product minimum types (units_per_product/gallons_per_product) are a
  // floor on each LINE, not the order total, and are deliberately left
  // alone here — recomputing those live would mean re-deriving engine.ts's
  // own applyPerProductMinimum/applyBulkPerProductMinimum logic in the UI.
  //
  // Case-type minimums (e.g. "6 bay boxes") were entirely missing from this
  // check until 2026-09-23 (a real Valvoline report never highlighted red
  // despite landing under its configured floor) — added below, scoped to
  // whatever case types actually appear somewhere in this draft's own line
  // set. A case type with zero lines in the draft at all is left alone
  // (can't tell live whether the shop has an eligible-but-never-added
  // product of that type — only generateOrder's own eligibleSpare pool
  // knows that — so this mirrors the engine's "no eligible product, rule
  // doesn't apply" exemption using what's actually available client-side).
  const groupMinimumStatus = useMemo(() => {
    const m = new Map<string, boolean>()
    if (!draft) return m
    const vendorRules = rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name)
    for (const [key, groupLines] of groups) {
      const orderType = key.split('|')[1] as OrderType
      const min = vendorRules.minimums[orderType] ?? {
        type: orderType === 'bulk' ? settings.bulk_minimum_type : settings.package_minimum_type,
        dollars: orderType === 'bulk' ? settings.order_minimum_dollars_bulk : settings.order_minimum_dollars_package,
        qty: orderType === 'bulk' ? settings.bulk_minimum_qty : settings.package_minimum_qty,
      }
      const included = groupLines.filter((l) => l.included)
      let meets = true
      if (min.type === 'dollars') {
        meets = included.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0) >= min.dollars
      } else if (min.type === 'units_per_order') {
        meets = included.reduce((s, l) => s + Number(l.qty), 0) >= (min.qty ?? 0)
      }
      for (const [caseType, minQtyRaw] of Object.entries(vendorRules.caseTypeMinimums ?? {})) {
        const minQty = Number(minQtyRaw)
        if (minQty <= 0) continue
        const ofType = groupLines.filter((l) => (l.uom ?? '') === caseType)
        if (!ofType.length) continue
        const total = ofType.filter((l) => l.included).reduce((s, l) => s + Number(l.qty), 0)
        if (total < minQty) meets = false
      }
      m.set(key, meets)
    }
    return m
  }, [groups, draft, settings, rulesFor, vendors])

  // Live per-line flags, replacing the two the engine only ever computed
  // once at generation time:
  //  - capacity_capped ("At capacity") used to fire whenever capacity was
  //    merely the BINDING constraint on the suggested qty — which includes
  //    landing EXACTLY at capacity, not actually going over it. Recomputed
  //    here from the line's current on-hand-after vs its real capacity, and
  //    only shown when genuinely over.
  //  - below_minimum — see groupMinimumStatus above.
  const liveFlags = useCallback((l: DraftLineRow): LineFlag[] => {
    let flags: LineFlag[] = ((l.flags ?? []) as LineFlag[]).filter((f) => f !== 'capacity_capped' && f !== 'below_minimum')
    const onHandAfter = Number(l.on_hand ?? 0) + Number(l.qty) * Number(l.quarts_per_unit ?? 1)
    if (l.max_capacity_gallons != null && onHandAfter > l.max_capacity_gallons) flags = [...flags, 'capacity_capped']
    if (l.included && groupMinimumStatus.get(`${l.location_id}|${l.order_type}`) === false) flags = [...flags, 'below_minimum']
    return flags
  }, [groupMinimumStatus])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let out = [...lines]
    if (!showVmi) out = out.filter((l) => !(l.flags ?? []).includes('vmi_keepfill'))
    if (showOnlyOverCapacity) out = out.filter((l) => (l.flags ?? []).includes('exceeded_capacity_for_dos_target' as LineFlag))
    if (q) out = out.filter((l) => `${shopLabel(l.location_id)} ${l.product_id} ${l.uom ?? ''}`.toLowerCase().includes(q))
    const dir = sortDir === 'asc' ? 1 : -1
    const secondary = (a: DraftLineRow, b: DraftLineRow) => {
      switch (sortKey) {
        case 'capacity': return dir * (Number(b.max_capacity_gallons ?? 0) - Number(a.max_capacity_gallons ?? 0))
        case 'product': return dir * a.product_id.localeCompare(b.product_id)
        case 'qty': return dir * (Number(a.qty) - Number(b.qty))
        case 'dollars': return dir * ((Number(a.qty) * Number(a.unit_cost ?? 0)) - (Number(b.qty) * Number(b.unit_cost ?? 0)))
        case 'dos_after': return dir * (Number(a.dos_after ?? 0) - Number(b.dos_after ?? 0))
        default: return Number(b.max_capacity_gallons ?? 0) - Number(a.max_capacity_gallons ?? 0)
      }
    }
    return [...out].sort((a, b) => {
      // Shops always group together, in numeric order, regardless of the
      // chosen sort — that only orders products within a shop, so a
      // multi-product shop never gets scattered across the table.
      const s = shopLabel(a.location_id).localeCompare(shopLabel(b.location_id), undefined, { numeric: true })
      return s !== 0 ? s : secondary(a, b)
    })
  }, [lines, filter, sortKey, sortDir, shopLabel, showVmi, showOnlyOverCapacity])

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(k); setSortDir(k === 'capacity' ? 'desc' : 'asc') }
  }

  // Alternates per shop (not per row), so multiple lines for the same shop
  // band together — makes it obvious at a glance whether adjacent rows are
  // one shop's multi-product order or a boundary between two shops.
  const bandOf = useMemo(() => {
    const m = new Map<string, boolean>()
    let prevShop: string | null = null
    let band = false
    for (const l of visible) {
      if (l.location_id !== prevShop) { band = !band; prevShop = l.location_id }
      m.set(l.id, band)
    }
    return m
  }, [visible])

  // Every candidate the engine saw for a shop, whether or not it ended up on
  // the draft — spans every order type, for "expand this shop to everything
  // configured for it" (see shopRows below).
  const inputsByLocation = useMemo(() => {
    const m = new Map<string, GenerationInput[]>()
    for (const i of allInputs) {
      if (!m.has(i.location_id)) m.set(i.location_id, [])
      m.get(i.location_id)!.push(i)
    }
    return m
  }, [allInputs])

  // Shops on the selected order day (eligibleLocationIds, from the same
  // run's own eligibleLocations() call) that ended up with no real order —
  // "real" meaning at least one included line with qty > 0; a shop whose
  // only lines are keep-fill/VMI (always generated for the runway check,
  // excluded from the order total regardless) still counts as "no orders"
  // here, since nothing on it is actually being ordered. null
  // eligibleLocationIds (vendor doesn't use order days) means this
  // distinction is meaningless, so the section doesn't show at all then.
  const shopsWithNoOrders = useMemo(() => {
    if (!eligibleLocationIds) return []
    const withOrders = new Set(lines.filter((l) => l.included && Number(l.qty) > 0).map((l) => l.location_id))
    return [...eligibleLocationIds].filter((id) => !withOrders.has(id))
      .sort((a, b) => shopLabel(a).localeCompare(shopLabel(b), undefined, { numeric: true }))
  }, [eligibleLocationIds, lines, shopLabel])

  // The specific (location, product) candidate behind a draft line — for
  // the "other case types on hand" sub-listing under the main On Hand
  // column, since own_on_hand/equivalent_products live on the generation
  // input, not the persisted line (see buildGenerationInputs).
  const inputByLineKey = useMemo(
    () => new Map(allInputs.map((i) => [`${i.location_id}|${i.product_id}`, i])),
    [allInputs],
  )

  // Three explicit choices for a line flagged covered_by_open_po — never
  // auto-resolved (see buildGenerationInputs' pendingPoQty comment).
  // "Combine" recomputes the suggested qty using the exact same targeting
  // formula the engine itself used (unitsToTarget/capsFor, now exported for
  // this), with the open PO's outstanding quantity added to on-hand first —
  // not a bespoke approximation of the real math.
  function decidePoOverride(l: DraftLineRow) {
    patchLine(l.id, { flags: withPoDecision(l.flags, 'po_decision_override'), included: true })
  }
  function decidePoExclude(l: DraftLineRow) {
    patchLine(l.id, { flags: withPoDecision(l.flags, 'po_decision_exclude'), included: false })
  }
  function decidePoCombine(l: DraftLineRow) {
    const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
    const pending = input?.pendingPoQty ?? 0
    if (!input || pending <= 0) return
    const adjusted: GenerationInput = { ...input, on_hand: Number(input.on_hand ?? 0) + pending }
    // unitsToTarget/capsFor only read ctx.settings — no need to reconstruct
    // eligibleLocationIds/history/includeVmi for this one-line recompute.
    const ctx = { settings } as unknown as Parameters<typeof unitsToTarget>[1]
    const caps = capsFor(adjusted, ctx)
    const want = unitsToTarget(adjusted, ctx)
    // 'up' when not capped, matching Pass 1's own target-seeking rounding
    // (see engine.ts) — a coarse package size should bias toward meeting
    // the target here too, not just on the initial generation.
    const newQty = roundQty(Math.min(want, caps.maxUnits), l.uom, settings.bulk_rounding_increment, want > caps.maxUnits ? 'down' : 'up')
    patchLine(l.id, { qty: newQty, dos_after: dosAfterForQty(l, newQty), flags: withPoDecision(l.flags, 'po_decision_combine'), included: newQty > 0 })
  }

  async function addConfiguredProduct(input: GenerationInput, qty: number) {
    if (qty <= 0) return
    const quartsPerUnit = gallonsPerUnit(input.rule)
    await addLine({
      location_id: input.location_id, product_id: input.product_id, order_type: resolvedOrderType(input.rule),
      uom: input.rule.uom, qty, system_qty: 0,
      unit_cost: input.rule.unit_cost, on_hand: input.on_hand, daily_usage: input.daily_usage,
      dos_before: daysOfSupply(input.on_hand, input.daily_usage),
      // Computed here instead of left null — a null dos_after used to only
      // get filled in the moment someone manually touched the qty box
      // afterward (via patchQty), so a freshly-added product showed a blank
      // DOS After until then even though everything needed to compute it
      // was already known at add time.
      dos_after: dosAfterForQty({ on_hand: input.on_hand, daily_usage: input.daily_usage, quarts_per_unit: quartsPerUnit }, qty),
      max_capacity_gallons: input.rule.max_capacity_gallons, quarts_per_unit: quartsPerUnit,
    })
  }

  // Every configured product for a shop, ordered products first (any real
  // line, whether or not it's currently included) then everything else the
  // shop is set up for but doesn't have a line yet — what the shop-name
  // expand row below shows.
  function shopRows(locId: string): { input?: GenerationInput; line?: DraftLineRow }[] {
    const candidates = inputsByLocation.get(locId) ?? []
    const shopLines = lines.filter((l) => l.location_id === locId)
    const lineByProduct = new Map(shopLines.map((l) => [l.product_id, l]))
    const candidateIds = new Set(candidates.map((c) => c.product_id))
    const rows: { input?: GenerationInput; line?: DraftLineRow }[] =
      candidates.map((c) => ({ input: c, line: lineByProduct.get(c.product_id) }))
    for (const l of shopLines) if (!candidateIds.has(l.product_id)) rows.push({ line: l })
    rows.sort((ra, rb) => {
      const rank = (r: typeof ra) => (r.line ? 0 : 1)
      const d = rank(ra) - rank(rb)
      if (d !== 0) return d
      return (ra.line?.product_id ?? ra.input?.product_id ?? '').localeCompare(rb.line?.product_id ?? rb.input?.product_id ?? '')
    })
    return rows
  }

  // Business days until this shop's next delivery for this order date — the
  // shop-expand sub-table's "DOS after" needs this to project on-hand
  // forward to the date the order would actually arrive, not just today.
  // 0 (no decay) when no delivery date is resolvable at all, same fallback
  // dosAfterDelivery itself uses in engine.ts.
  function leadDaysFor(locId: string): number {
    if (!draft) return 0
    const deliverDate = deliveryFor(locId, draft.order_date)
    return deliverDate ? Math.max(0, daysBetween(draft.order_date, deliverDate)) : 0
  }

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found. It may have been deleted.</p>

  const vendorName = vendors.byId(draft.vendor_id)?.name ?? 'All vendors'
  const usesOrderDays = rulesFor(draft.vendor_id, settings, vendors.byId(draft.vendor_id)?.name).usesOrderDays

  return (
    <div className="flex flex-col gap-4">
      <OrderStepper draftId={draft.id} current="review" />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Button size="sm" variant="muted" onClick={() => navigate('/orders-v2')} className="mb-1">← Orders v2</Button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Review Order</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendorName} · {draft.order_date}{isAdHoc ? ' · Ad hoc' : (usesOrderDays ? ` · ${DOW[orderDow]} shops` : '')} · {groups.size} shop/type group{groups.size !== 1 ? 's' : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy border border-sky/40 bg-sky/10 rounded px-2 py-1"
            title="Try the new sortable/filterable/resizable table alongside the existing one — off by default, only affects your own browser.">
            <Toggle checked={useNewTable} onChange={setUseNewTable} size="sm" color="cyan" />
            New Table (Beta)
          </label>
          <Button size="sm" variant="secondary" onClick={() => setExceptionsModalOpen(true)}>
            Product Exceptions
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setSettingsModalOpen(true)}>
            <Settings className="w-3.5 h-3.5 mr-1" /> Order Settings
          </Button>
          <Button size="sm" loading={movingToFinal} onClick={async () => {
            setMovingToFinal(true)
            // See runGeneration's own comment — a completed order stays
            // 'exported', it never gets pulled back into the Final Review
            // tab just because someone stepped through to revisit it.
            if (draft.status !== 'exported') await setStatus('final_review')
            navigate(`/orders-v2/draft/${draft.id}/final`)
          }}>
            Final Review →
          </Button>
        </div>
      </div>

      <Modal open={settingsModalOpen} onClose={() => setSettingsModalOpen(false)} title="Order Settings" size="xl">
        <OrdersV2SettingsBody />
      </Modal>

      {exceptionTarget && (
        <ExceptionEditModal
          open={!!exceptionTarget}
          onClose={() => setExceptionTarget(null)}
          locationId={exceptionTarget.locationId}
          productId={exceptionTarget.productId}
          shopLabel={shopLabel(exceptionTarget.locationId)}
          onSaved={onExceptionChanged}
        />
      )}

      <Modal open={exceptionsModalOpen} onClose={() => setExceptionsModalOpen(false)} title="Product Exceptions" size="xl">
        <ProductExceptionsManager onChanged={onExceptionChanged} />
      </Modal>

      {dosOverride && (
        <Card><CardBody className="flex items-center gap-4 flex-wrap py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">This order&apos;s DOS targets</span>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/50">Target</span>
            <input type="number" min={0} value={dosOverride.target}
              onChange={(e) => { setDosOverride((d) => (d ? { ...d, target: Number(e.target.value) || 0 } : d)); setNeedsRegenerate(true) }}
              className="w-20 bg-transparent border border-navy/25 rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/50">Min trigger</span>
            <input type="number" min={0} value={dosOverride.trigger}
              onChange={(e) => { setDosOverride((d) => (d ? { ...d, trigger: Number(e.target.value) || 0 } : d)); setNeedsRegenerate(true) }}
              className="w-20 bg-transparent border border-navy/25 rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/50">Max</span>
            <input type="number" min={0} value={dosOverride.max}
              onChange={(e) => { setDosOverride((d) => (d ? { ...d, max: Number(e.target.value) || 0 } : d)); setNeedsRegenerate(true) }}
              className="w-20 bg-transparent border border-navy/25 rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
          </label>
          <p className="text-[10px] font-mono text-inky/50 max-w-xs">
            Adjusts this order only — never saved to Order Settings.
            <span className="inline-flex items-center gap-1 ml-1">
              <span className="text-[#C0392B]">■</span> under target
              <span className="text-[#2ECC71]">■</span> at target
              <span className="text-[#E67E22]">■</span> over max
            </span>
          </p>
          {needsRegenerate && (
            <p className="text-[10px] font-mono text-[#E67E22] font-bold ml-auto">
              Changes require regenerating order for accuracy
            </p>
          )}
          <Button size="sm" variant="secondary" loading={generating} onClick={() => runGeneration()}
            className={needsRegenerate ? 'ring-2 ring-[#E67E22] ring-offset-2 ring-offset-cream animate-pulse' : 'ml-auto'}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regenerate
          </Button>
        </CardBody></Card>
      )}

      <Card><CardBody className="flex items-center gap-4 flex-wrap py-3">
        {/* The new table has its own built-in search + Manage Columns
            (DataTable's own toolbar) — shown here only for the old table to
            avoid two redundant search boxes / column controls on screen. */}
        {!useNewTable && (
          <Input placeholder="Search shop or product…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56" />
        )}
        <label className="flex items-center gap-2 text-xs font-mono text-inky">
          <Toggle checked={showVmi} onChange={setShowVmi} size="sm" color="cyan" />
          Show VMI / keepfill
        </label>
        <label className="flex items-center gap-2 text-xs font-mono text-inky">
          <Toggle checked={showOnlyOverCapacity} onChange={setShowOnlyOverCapacity} size="sm" color="cyan" />
          Show only over-capacity lines
        </label>
        {usesOrderDays && !isAdHoc && (
          <label className="flex items-center gap-2 text-xs font-mono text-inky">
            Order day
            <select value={String(orderDow)} onChange={(e) => void runGeneration(Number(e.target.value))}
              className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky">
              {DOW.map((d, i) => (
                <option key={d} value={i}>{d}{dayCounts[i] ? ` (${dayCounts[i]})` : ''}</option>
              ))}
            </select>
          </label>
        )}
        {isAdHoc && (
          <span className="rounded px-1.5 py-0.5 bg-sky/20 text-navy border border-sky/40 text-xs font-mono">
            Ad hoc · {eligibleLocationIds?.size ?? 0} shop{(eligibleLocationIds?.size ?? 0) !== 1 ? 's' : ''}
          </span>
        )}
        <span className="text-xs font-mono text-inky">
          {lines.length} line{lines.length !== 1 ? 's' : ''}
          {overrideCount > 0 && (
            <span className="ml-2 rounded px-1.5 py-0.5 bg-[#E67E22]/15 text-[#E67E22] border border-[#E67E22]/40">
              {overrideCount} override{overrideCount !== 1 ? 's' : ''}
            </span>
          )}
        </span>
        {!useNewTable && (
          <button
            onClick={() => setColumnModalOpen(true)}
            title="Show/hide and reorder this table's columns"
            className="inline-flex items-center gap-1 text-[10px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy hover:text-navy">
            <Settings className="w-3 h-3" /> Customize Columns
          </button>
        )}
        <span className="ml-auto text-xs font-mono text-navy">
          Order total {money(lines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0))}
        </span>
      </CardBody></Card>

      <ColumnCustomizeModal
        open={columnModalOpen}
        onClose={() => setColumnModalOpen(false)}
        columns={MAIN_COLUMNS}
        prefs={columnPrefs}
        onChange={saveColumnPrefs}
        defaultOrder={DEFAULT_COLUMN_ORDER}
      />

      {generating && (
        <LoadingProgress
          fraction={genProgress.total ? genProgress.loaded / genProgress.total : null}
          countText={
            genProgress.total
              ? `Loading order data — ${genProgress.loaded} of ${genProgress.total} sources (${Math.min(100, Math.round((genProgress.loaded / genProgress.total) * 100))}%)`
              : 'Loading order data…'
          }
          messages={[
            'Gathering on-hand levels…',
            'Calculating daily usage…',
            'Combining equivalent case types…',
            'Checking keep-fill tanks…',
            'Applying vendor minimums…',
            'Adjusting orders to meet minimums…',
          ]}
        />
      )}

      {!generating && lines.length === 0 && (
        <div className="py-8 flex flex-col gap-2">
          <p className="text-xs font-mono text-inky/60">Nothing to order for this run.</p>
          {usesOrderDays && !isAdHoc && dayCounts[orderDow] === 0 ? (
            <p className="text-xs font-mono text-[#C0392B]">
              No shops have {DOW[orderDow]} as their order day
              {dayCounts.some((c) => c > 0)
                ? ` — shops per day: ${DOW.map((d, i) => (dayCounts[i] ? `${d.slice(0, 3)} ${dayCounts[i]}` : null)).filter(Boolean).join(', ')}.`
                : '. No shop has a Reladyne Delivery Day set on the location list.'}
              {' '}Switch the order day above to run a different day&apos;s shops.
            </p>
          ) : (
            <p className="text-xs font-mono text-inky/60">
              {usesOrderDays && !isAdHoc && `${dayCounts[orderDow]} shop${dayCounts[orderDow] !== 1 ? 's' : ''} order on ${DOW[orderDow]}, but none `}
              {isAdHoc && `${eligibleLocationIds?.size ?? 0} selected shop${(eligibleLocationIds?.size ?? 0) !== 1 ? 's' : ''}, but none `}
              {!usesOrderDays && !isAdHoc && 'No product is '}
              below the minimum days-of-supply trigger. Check Order Settings, or that Product Usage has current
              on-hand and daily usage for these shops.
            </p>
          )}
        </div>
      )}

      {lines.length > 0 && useNewTable && (
        <OrdersV2ReviewTable
          lines={visible}
          draft={draft}
          shopLabel={shopLabel}
          ozProductIds={ozProductIds}
          lastOrderedInfo={lastOrderedInfo}
          deliveryFor={deliveryFor}
          describeSchedule={describeSchedule}
          liveFlags={liveFlags}
          dosAfterColorClass={dosAfterColorClass}
          groupMinimumStatus={groupMinimumStatus}
          patchQty={patchQty}
          exceptionFor={exceptionFor}
          onOpenException={(locationId, productId) => setExceptionTarget({ locationId, productId })}
          decidePoOverride={decidePoOverride}
          decidePoExclude={decidePoExclude}
          decidePoCombine={decidePoCombine}
          includeToggle={(l) => patchLine(l.id, { included: !l.included })}
          onRemoveLine={removeLine}
          expanded={expanded}
          onToggleExpand={(locId) => setExpanded((p) => { const n = new Set(p); n.has(locId) ? n.delete(locId) : n.add(locId); return n })}
          shopRows={shopRows}
          onAddConfiguredProduct={addConfiguredProduct}
          showConfigVmi={showConfigVmi}
          leadDaysFor={leadDaysFor}
          inputByLineKey={inputByLineKey}
        />
      )}

      {lines.length > 0 && !useNewTable && (
        <div className="overflow-auto rounded border border-navy/30 max-h-[calc(100vh-22rem)]">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10">
              <tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                {visibleColumnIds.map((id) => {
                  switch (id) {
                    case 'shop': return <Th key={id} onClick={() => toggleSort('location')} active={sortKey === 'location'} dir={sortDir}>Shop</Th>
                    case 'product': return <Th key={id} onClick={() => toggleSort('product')} active={sortKey === 'product'} dir={sortDir}>Product</Th>
                    case 'uom': return <Th key={id}>UOM</Th>
                    case 'capacity': return <Th key={id} onClick={() => toggleSort('capacity')} active={sortKey === 'capacity'} dir={sortDir}>Capacity</Th>
                    case 'on_hand': return <Th key={id}>On Hand</Th>
                    case 'usage_day': return <Th key={id}>Usage/day</Th>
                    case 'dos_now': return <Th key={id}>DOS Now</Th>
                    case 'last_ordered': return <Th key={id}>Last Ordered</Th>
                    case 'last_delivered': return <Th key={id}>Last Delivered</Th>
                    case 'delivery_date': return <Th key={id}>Delivery</Th>
                    case 'qty': return <Th key={id} onClick={() => toggleSort('qty')} active={sortKey === 'qty'} dir={sortDir}>Qty</Th>
                    case 'on_hand_after': return <Th key={id}>On Hand After</Th>
                    case 'dos_after': return <Th key={id} onClick={() => toggleSort('dos_after')} active={sortKey === 'dos_after'} dir={sortDir}>DOS After</Th>
                    case 'dos_at_delivery': return <Th key={id}>DOS @ Delivery</Th>
                    case 'dollars': return <Th key={id} onClick={() => toggleSort('dollars')} active={sortKey === 'dollars'} dir={sortDir}>$</Th>
                    case 'flags': return <Th key={id}>Flags</Th>
                    case 'actions': return <Th key={id} />
                    default: return null
                  }
                })}
              </tr>
            </thead>
            <tbody>
              {visible.map((l, idx) => {
                const dollars = Number(l.qty) * Number(l.unit_cost ?? 0)
                const locId = l.location_id ?? ''
                const isLastOfShop = idx === visible.length - 1 || visible[idx + 1].location_id !== l.location_id
                const shopOpen = expanded.has(locId)
                const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
                // Display-only ounce conversion (see ozProductIds' own
                // comment) — 32 oz/quart, the engine's own internal unit.
                const isOz = ozProductIds.has(l.product_id)
                const toOz = (v: number | null | undefined) => (v == null ? v : v * 32)
                const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
                const belowMin = l.included && groupMinimumStatus.get(`${l.location_id}|${l.order_type}`) === false
                const onHandAfter = Number(l.on_hand ?? 0) + Number(l.qty) * Number(l.quarts_per_unit ?? 1)
                const cellFor = (id: string): React.ReactNode => {
                  switch (id) {
                    case 'shop': return (
                      <td key={id} className="px-2 py-1 text-navy whitespace-nowrap">
                        <button
                          onClick={() => setExpanded((p) => { const n = new Set(p); n.has(locId) ? n.delete(locId) : n.add(locId); return n })}
                          title="Show every product configured for this shop"
                          className="inline-flex items-center gap-1 hover:underline hover:text-sky">
                          {shopOpen ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                          {shopLabel(l.location_id)}
                        </button>
                      </td>
                    )
                    case 'product': return <Td key={id}>{l.product_id}</Td>
                    case 'uom': return <Td key={id}>{l.uom ?? '—'}</Td>
                    case 'capacity': return <Td key={id} align="right">{num(isOz ? toOz(l.max_capacity_gallons) : l.max_capacity_gallons, 0)}</Td>
                    case 'on_hand': return (
                      <td key={id} className="px-2 py-1 text-right text-navy whitespace-nowrap">
                        {num(isOz ? toOz(input?.own_on_hand ?? l.on_hand) : (input?.own_on_hand ?? l.on_hand))}
                        {input?.equivalent_products && input.equivalent_products.length > 0 && (
                          <div className="text-[9px] text-inky/50 leading-tight font-normal">
                            <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
                            {input.equivalent_products.map((e) => (
                              <div key={e.product_id}>{e.product_id}: {num(e.on_hand)}</div>
                            ))}
                          </div>
                        )}
                        {info.onHandCheck && !info.onHandCheck.withinRange && (
                          <div className="text-[9px] text-[#C0392B] font-bold mt-0.5 normal-case"
                            title={`Based on the last delivery, on hand was expected to be roughly ${num(info.onHandCheck.expected)} (${num(info.onHandCheck.low)}–${num(info.onHandCheck.high)})`}>
                            ⚠ On hand may be off
                          </div>
                        )}
                      </td>
                    )
                    case 'usage_day': return <Td key={id} align="right">{num(isOz ? toOz(l.daily_usage) : l.daily_usage)}</Td>
                    case 'dos_now': return <Td key={id} align="right">{dos(l.dos_before)}</Td>
                    case 'last_ordered': return (
                      <td key={id} className="px-2 py-1 text-navy whitespace-nowrap">
                        {info.lastOrderDate ? (
                          <>
                            <div>{dShort(info.lastOrderDate)} · {num(info.lastOrderQty, 1)}{info.lastOrderUom ? ` ${info.lastOrderUom}` : ''}</div>
                            {info.eta && <div className="text-[9px] text-inky/50">ETA {dShort(info.eta)}</div>}
                          </>
                        ) : '—'}
                      </td>
                    )
                    case 'last_delivered': return (
                      <td key={id} className="px-2 py-1 text-navy whitespace-nowrap">
                        {info.lastDeliveredDate
                          ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)}${info.lastDeliveredUnit === 'gal' ? ' gal' : ''}`
                          : '—'}
                      </td>
                    )
                    case 'delivery_date': {
                      const deliverDate = deliveryFor(l.location_id, draft.order_date)
                      const schedDesc = describeSchedule(l.location_id)
                      return (
                        <td key={id} className="px-2 py-1 text-navy whitespace-nowrap">
                          <div>{deliverDate ? dShort(deliverDate) : '—'}</div>
                          {schedDesc && <div className="text-[9px] text-inky/50">{schedDesc}</div>}
                        </td>
                      )
                    }
                    case 'qty': return (
                      <td key={id} className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                        <div className="flex items-start justify-end gap-1">
                          <div>
                            <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                              onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
                              className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                            {l.quarts_per_unit != null && (
                              <div className="text-[10px] text-inky/50 mt-0.5">
                                {isOz
                                  ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)}oz`
                                  : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => setExceptionTarget({ locationId: l.location_id ?? '', productId: l.product_id })}
                            title={exceptionFor(l.location_id ?? '', l.product_id) ? 'Edit product exception' : 'Add product exception'}
                            className="text-inky/40 hover:text-navy flex-shrink-0 mt-1.5">
                            {exceptionFor(l.location_id ?? '', l.product_id) ? <Pencil className="w-3 h-3" /> : <Plus className="w-3.5 h-3.5" />}
                          </button>
                        </div>
                      </td>
                    )
                    case 'on_hand_after': return <Td key={id} align="right">{num(isOz ? toOz(onHandAfter) : onHandAfter)}</Td>
                    case 'dos_after': return <td key={id} className={`px-2 py-1 text-right whitespace-nowrap font-bold ${dosAfterColorClass(l.dos_after)}`}>{dos(l.dos_after)}</td>
                    case 'dos_at_delivery': return <Td key={id} align="right">{dos(l.dos_after_delivery)}</Td>
                    case 'dollars': return <Td key={id} align="right">{money(dollars)}</Td>
                    case 'flags': return (
                      <td key={id} className="px-2 py-1">
                        <Flags flags={liveFlags(l)} />
                        {l.note && <div className="text-[10px] font-mono text-inky/60 italic mt-0.5">{l.note}</div>}
                        {(l.flags ?? []).includes('covered_by_open_po') && (
                          <PoDecisionButtons line={l} onOverride={decidePoOverride} onExclude={decidePoExclude} onCombine={decidePoCombine} />
                        )}
                      </td>
                    )
                    case 'actions': return (
                      <Td key={id}>
                        <div className="flex items-center gap-1">
                          <button title={l.included ? 'Exclude from order' : 'Include in order'}
                            onClick={() => patchLine(l.id, { included: !l.included })}
                            className="text-[10px] border border-navy/30 rounded px-1 py-0.5 text-inky hover:border-navy">
                            {l.included ? 'Exclude' : 'Include'}
                          </button>
                          <button title="Remove line" onClick={() => removeLine(l.id)} className="text-inky/40 hover:text-[#C0392B]">✕</button>
                        </div>
                      </Td>
                    )
                    default: return null
                  }
                }
                return (
                  <Fragment key={l.id}>
                    <tr className={`border-b border-navy/15 ${l.included ? '' : 'opacity-45'} ${belowMin ? 'bg-[#C0392B]/10' : bandOf.get(l.id) ? 'bg-navy/[0.035]' : ''}`}>
                      {visibleColumnIds.map(cellFor)}
                    </tr>
                    {isLastOfShop && shopOpen && (
                      <tr className="border-b border-navy/15 bg-navy/[0.02]">
                        <td colSpan={visibleColumnIds.length} className="px-3 py-2">
                          <p className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-1">
                            Every product configured for {shopLabel(l.location_id)}
                            {(() => {
                              const dd = deliveryFor(l.location_id, draft.order_date)
                              const sd = describeSchedule(l.location_id)
                              return dd ? <span className="normal-case text-inky/50"> · Delivers {dShort(dd)}{sd ? ` (${sd})` : ''}</span> : null
                            })()}
                          </p>
                          <ShopConfiguredProductsTable
                            rows={shopRows(locId)}
                            onPatch={patchQty}
                            onAdd={addConfiguredProduct}
                            showVmi={showConfigVmi}
                            ozProductIds={ozProductIds}
                            exceptionFor={exceptionFor}
                            onOpenException={(locationId, productId) => setExceptionTarget({ locationId, productId })}
                            leadDays={leadDaysFor(locId)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {shopsWithNoOrders.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <button onClick={() => setNoOrdersOpen((o) => !o)} className="flex items-center gap-1.5 text-left w-full hover:text-navy">
            {noOrdersOpen ? <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />}
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">
              Shops With No Orders ({shopsWithNoOrders.length})
            </span>
          </button>
          {noOrdersOpen && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[10px] font-mono text-inky/50">
                  {isAdHoc ? 'Selected for this ad hoc order, but nothing' : `On ${DOW[orderDow]}'s order day, but nothing`} ended up included in this order — expand a shop to see everything configured for it and add items if something's missing.
                </p>
                <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/60 flex-shrink-0">
                  <Toggle checked={showConfigVmi} onChange={setShowConfigVmi} size="sm" color="cyan" />
                  Show VMI / keepfill suggestions
                </label>
              </div>
              {shopsWithNoOrders.map((locId) => {
                const shopOpen = expanded.has(locId)
                return (
                  <div key={locId} className="border-t border-navy/10 pt-1.5">
                    <button
                      onClick={() => setExpanded((p) => { const n = new Set(p); n.has(locId) ? n.delete(locId) : n.add(locId); return n })}
                      className="inline-flex items-center gap-1 text-xs font-mono text-navy hover:underline hover:text-sky">
                      {shopOpen ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
                      {shopLabel(locId)}
                    </button>
                    {shopOpen && (
                      <div className="mt-1">
                        {(() => {
                          const dd = deliveryFor(locId, draft.order_date)
                          const sd = describeSchedule(locId)
                          return dd ? (
                            <p className="text-[10px] font-mono text-inky/50 mb-1">Delivers {dShort(dd)}{sd ? ` (${sd})` : ''}</p>
                          ) : null
                        })()}
                        <ShopConfiguredProductsTable
                          rows={shopRows(locId)}
                          onPatch={patchQty}
                          onAdd={addConfiguredProduct}
                          showVmi={showConfigVmi}
                          ozProductIds={ozProductIds}
                          exceptionFor={exceptionFor}
                          onOpenException={(locationId, productId) => setExceptionTarget({ locationId, productId })}
                          leadDays={leadDaysFor(locId)}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardBody></Card>
      )}

      {skipped.length > 0 && (
        <Card><CardBody className="flex flex-col gap-1">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Not ordered ({skipped.length})</span>
          <div className="max-h-40 overflow-auto text-[11px] font-mono text-inky/70">
            {skipped.slice(0, 300).map((s, i) => (
              <div key={i}>{shopLabel(s.location_id)} · {s.product_id} — {s.reason.replace(/_/g, ' ')}</div>
            ))}
          </div>
        </CardBody></Card>
      )}
    </div>
  )
}

function Th({ children, onClick, active, dir }: {
  children?: React.ReactNode; onClick?: () => void; active?: boolean; dir?: 'asc' | 'desc'; align?: 'right'
}) {
  // Centered regardless of the data column's own alignment — the previous
  // left/right split (mirroring each Td's own align) read as random since
  // header text and data text don't need to match alignment the way a
  // sortable header benefits from sitting centered over its whole column.
  return (
    <th className="px-2 py-2 whitespace-nowrap text-center">
      {onClick ? (
        <button onClick={onClick} className="uppercase tracking-wide hover:text-navy inline-flex items-center justify-center gap-0.5 w-full">
          {children}{active && <span>{dir === 'asc' ? '▲' : '▼'}</span>}
        </button>
      ) : children}
    </th>
  )
}
function Td({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <td className={`px-2 py-1 text-navy whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>
}

/** Show/hide + reorder the main table's columns — same "pop up modal" shape
 * as the location list's own column customize panel, adapted for a plain
 * ordered-list-with-arrows reorder (no drag library) since this table isn't
 * built on @tanstack/react-table. Persisted to localStorage only, per
 * device — see MAIN_COLUMNS/loadColumnPrefs' own comments. */
function ColumnCustomizeModal({ open, onClose, columns, prefs, onChange, defaultOrder }: {
  open: boolean
  onClose: () => void
  columns: { id: string; label: string }[]
  prefs: { order: string[]; hidden: string[] }
  onChange: (next: { order: string[]; hidden: string[] }) => void
  defaultOrder: string[]
}) {
  const labelOf = (id: string) => (id === 'actions' ? 'Actions' : columns.find((c) => c.id === id)?.label || id)
  function move(id: string, dir: -1 | 1) {
    const idx = prefs.order.indexOf(id)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= prefs.order.length) return
    const next = [...prefs.order]
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    onChange({ ...prefs, order: next })
  }
  function toggle(id: string) {
    if (id === 'shop') return // always visible — the shop-expand interaction lives on it
    const hidden = prefs.hidden.includes(id) ? prefs.hidden.filter((h) => h !== id) : [...prefs.hidden, id]
    onChange({ ...prefs, hidden })
  }
  return (
    <Modal open={open} onClose={onClose} title="Customize Columns" size="sm">
      <div className="flex flex-col gap-3">
        <p className="text-xs font-mono text-inky/70">Check to show or hide a column, and use the arrows to reorder them.</p>
        <div className="flex flex-col gap-0.5 max-h-96 overflow-y-auto">
          {prefs.order.map((id, i) => (
            <div key={id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-navy/5">
              <input type="checkbox" checked={!prefs.hidden.includes(id)} disabled={id === 'shop'}
                onChange={() => toggle(id)} className="accent-navy w-3.5 h-3.5 flex-shrink-0" />
              <span className="text-xs font-mono text-navy flex-1">{labelOf(id)}</span>
              <button onClick={() => move(id, -1)} disabled={i === 0}
                className="text-inky/50 hover:text-navy disabled:opacity-20 disabled:hover:text-inky/50">
                <ChevronUp className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => move(id, 1)} disabled={i === prefs.order.length - 1}
                className="text-inky/50 hover:text-navy disabled:opacity-20 disabled:hover:text-inky/50">
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex justify-between items-center pt-2 border-t border-navy/10">
          <button onClick={() => onChange({ order: defaultOrder, hidden: [] })} className="text-[10px] font-mono text-inky/60 hover:text-navy underline">
            Reset to default
          </button>
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}

/** Every configured product for one shop — shared by the main table's
 * shop-name expand row and the "Shops With No Orders" section, so both
 * "why isn't this shop ordering more" and "why isn't this shop ordering
 * anything" use the exact same product list, columns, and add-a-line
 * behavior. */
export function ShopConfiguredProductsTable({ rows, onPatch, onAdd, showVmi, ozProductIds, exceptionFor, onOpenException, leadDays }: {
  rows: { input?: GenerationInput; line?: DraftLineRow }[]
  onPatch: (line: DraftLineRow, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
  // VMI/keep-fill candidates are always in this list (the shop's full
  // configured product set) but are noise for "what am I actually
  // ordering" — hidden by default, shown on request. A row counts as VMI
  // either via its own config (input) or, once ordered, the flag the
  // engine already stamped onto its line.
  showVmi: boolean
  // See OrdersV2Review's own ozProductIds comment — display-only ounce
  // conversion for a product tracked that way (e.g. HM0806).
  ozProductIds: Set<string>
  // See OrdersV2Review's own exceptionFor/exceptionTarget — same inline
  // +/Edit button as the main table, here too since this is the other
  // place a shop's full product list is reviewed.
  exceptionFor: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>['rows'][number] | null
  onOpenException: (locationId: string, productId: string) => void
  // Business days from the order date to this shop's next delivery — see
  // OrdersV2Review's own leadDaysFor comment. On Hand After/DOS After
  // project usage forward to that date before adding whatever's ordered,
  // rather than just adding the order to TODAY's on-hand.
  leadDays: number
}) {
  const visible = showVmi ? rows : rows.filter((r) =>
    !(r.input?.rule.vmi_keepfill_enabled || r.line?.flags?.includes('vmi_keepfill')))
  // Its own scrollable region with a sticky header, rather than relying on
  // the outer Review table's header to stay meaningful while scrolling
  // through this — found live 2026-09-22: the outer table's own frozen
  // header (different columns) stayed pinned while this sub-table's own
  // header scrolled away with it, leaving no correct header visible for a
  // shop with enough configured products to need scrolling.
  return (
    <div className="max-h-72 overflow-auto rounded border border-navy/10">
      <table className="w-full text-[11px] font-mono">
        <thead className="sticky top-0 z-10 bg-cream">
          <tr className="text-inky/60 uppercase">
            <td className="py-1 text-center">Product</td><td className="text-center">UOM</td>
            <td className="text-center">Capacity</td><td className="text-center">On Hand</td>
            <td className="text-center">Usage/Day</td><td className="text-center">DOS Now</td>
            <td className="text-center">Qty</td><td className="text-center">On Hand After</td><td className="text-center">DOS After</td>
            <td className="text-center">$</td><td className="text-center">Why</td>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <SmoothingRow key={r.line?.id ?? r.input?.product_id} input={r.input} line={r.line} onPatch={onPatch} onAdd={onAdd}
              isOz={ozProductIds.has(r.line?.product_id ?? r.input?.product_id ?? '')}
              exceptionFor={exceptionFor} onOpenException={onOpenException} leadDays={leadDays} />
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** One row in a shop's product list — an existing line (editable in place)
 * or a configured-but-not-ordered candidate (typing a qty adds it). Shared
 * by the smoothing panel and the shop-name expand row below the table. */
function SmoothingRow({ input, line, onPatch, onAdd, isOz, exceptionFor, onOpenException, leadDays }: {
  input?: GenerationInput; line?: DraftLineRow
  onPatch: (line: DraftLineRow, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
  isOz: boolean
  exceptionFor: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>['rows'][number] | null
  onOpenException: (locationId: string, productId: string) => void
  leadDays: number
}) {
  const productId = line?.product_id ?? input?.product_id ?? ''
  const locationId = line?.location_id ?? input?.location_id ?? ''
  const unitCost = Number(line?.unit_cost ?? input?.rule.unit_cost ?? 0)
  const uom = line?.uom ?? input?.rule.uom ?? null
  const capacity = line?.max_capacity_gallons ?? input?.rule.max_capacity_gallons ?? null
  const onHand = line?.on_hand ?? input?.on_hand ?? null
  const dailyUsage = line?.daily_usage ?? input?.daily_usage ?? null
  const dosNow = line?.dos_before ?? daysOfSupply(onHand, dailyUsage)
  const why = line?.triggered_smoothing ? 'triggered smoothing'
    : line?.added_by_smoothing ? 'added to reach minimum'
    : 'not on order'
  const whyClass = line?.triggered_smoothing ? 'text-[#C0392B]'
    : line?.added_by_smoothing ? 'text-sky'
    : 'text-inky/40'
  // Display-only — see ozProductIds' own comment on OrdersV2Review.
  const toOz = (v: number | null | undefined) => (v == null ? v : v * 32)
  const quartsPerUnit = line?.quarts_per_unit ?? (input ? gallonsPerUnit(input.rule) : null)
  // On Hand/DOS After now project to the shop's actual DELIVERY date, not
  // today — usage between now and delivery runs down the shelf first
  // (floored at 0), THEN whatever's ordered lands. Found live 2026-09-22:
  // with qty at 0 this used to just echo current on-hand/DOS Now back
  // unchanged, which reads as "ordering nothing changes nothing" when in
  // reality the shop keeps selling through it right up to delivery day.
  // Same lead-time convention as engine.ts's own dosAfterDelivery (0 days
  // of decay when no delivery date could be resolved at all).
  const qty = line ? Number(line.qty) : 0
  const remainingAtDelivery = Math.max(0, Number(onHand ?? 0) - Number(dailyUsage ?? 0) * leadDays)
  const onHandAfter = remainingAtDelivery + qty * Number(quartsPerUnit ?? 1)
  const dosAfter = Number(dailyUsage ?? 0) > 0 ? onHandAfter / Number(dailyUsage) : null

  return (
    <tr className="border-t border-navy/10 text-center">
      <td className="py-1 text-navy">{productId}</td>
      <td className="text-inky/70">{uom ?? '—'}</td>
      <td className="text-inky/70">{num(isOz ? toOz(capacity) : capacity, 0)}</td>
      <td className="text-inky/70">
        {num(isOz ? toOz(input?.own_on_hand ?? onHand) : (input?.own_on_hand ?? onHand))}
        {input?.equivalent_products && input.equivalent_products.length > 0 && (
          <div className="text-[9px] text-inky/50 leading-tight font-normal">
            <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
            {input.equivalent_products.map((e) => (
              <div key={e.product_id}>{e.product_id}: {num(e.on_hand)}</div>
            ))}
          </div>
        )}
      </td>
      <td className="text-inky/70">{num(isOz ? toOz(dailyUsage) : dailyUsage)}</td>
      <td className="text-inky/70">{dos(dosNow)}</td>
      <td>
        <div className="flex items-start justify-center gap-1">
          <div>
            {line ? (
              <input type="number" min={0} step={uom === 'bulk' ? 0.1 : 1} value={line.qty}
                onChange={(e) => onPatch(line, Number(e.target.value) || 0)}
                className="w-16 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-center text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
            ) : input ? (
              <input type="number" min={0} step={uom === 'bulk' ? 0.1 : 1} defaultValue="" placeholder="0"
                onBlur={(e) => { const v = Number(e.target.value) || 0; if (v > 0) onAdd(input, v) }}
                title="Add this product to the order"
                className="w-16 bg-transparent border border-navy/20 rounded px-1 py-0.5 text-center text-inky/60 focus:outline-none focus:ring-1 focus:ring-sky" />
            ) : null}
            {isOz && line && quartsPerUnit != null && (
              <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(line.qty) * quartsPerUnit * 32, 0)}oz</div>
            )}
          </div>
          {locationId && productId && (
            <button
              onClick={() => onOpenException(locationId, productId)}
              title={exceptionFor(locationId, productId) ? 'Edit product exception' : 'Add product exception'}
              className="text-inky/40 hover:text-navy flex-shrink-0 mt-0.5">
              {exceptionFor(locationId, productId) ? <Pencil className="w-3 h-3" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </td>
      <td className="text-inky/70">{num(isOz ? toOz(onHandAfter) : onHandAfter)}</td>
      <td className="text-inky/70">{dos(dosAfter)}</td>
      <td className="text-navy">{money(line ? Number(line.qty) * unitCost : 0)}</td>
      <td className={whyClass}>{why}</td>
    </tr>
  )
}

export function Flags({ flags }: { flags: LineFlag[] }) {
  if (!flags?.length) return <span className="text-inky/25">—</span>
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {flags.map((f) => {
        const meta = FLAG_META[f]
        if (!meta) return null
        return (
          <span key={f} title={meta.title}
            className={`rounded border px-1 py-0.5 text-[9px] whitespace-nowrap ${FLAG_CLASS[meta.tone]}`}>
            {meta.label}
          </span>
        )
      })}
    </span>
  )
}

/** Decision row for a covered_by_open_po line — Order Anyway / Exclude /
 * Combine, whichever's already chosen (if any) highlighted. Never picks a
 * default on its own; the line just sits at its normal suggested qty until
 * someone decides. */
export function PoDecisionButtons({ line, onOverride, onExclude, onCombine }: {
  line: DraftLineRow
  onOverride: (l: DraftLineRow) => void
  onExclude: (l: DraftLineRow) => void
  onCombine: (l: DraftLineRow) => void
}) {
  const flags = (line.flags ?? []) as LineFlag[]
  const chosen = PO_DECISION_FLAGS.find((f) => flags.includes(f))
  const btnCls = (active: boolean) =>
    `text-[9px] rounded border px-1 py-0.5 whitespace-nowrap ${active ? 'bg-sky text-navy border-sky' : 'border-navy/25 text-inky hover:border-navy'}`
  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      <button title="Order the full suggested quantity anyway" className={btnCls(chosen === 'po_decision_override')} onClick={() => onOverride(line)}>
        Order anyway
      </button>
      <button title="The open PO already covers this — exclude from the order" className={btnCls(chosen === 'po_decision_exclude')} onClick={() => onExclude(line)}>
        Exclude
      </button>
      <button title="Factor the open PO's outstanding quantity into on-hand and re-target the quantity" className={btnCls(chosen === 'po_decision_combine')} onClick={() => onCombine(line)}>
        Combine
      </button>
    </div>
  )
}
