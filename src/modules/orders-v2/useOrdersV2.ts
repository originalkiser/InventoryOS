// Orders v2 — data access. All Supabase calls for the module live here so
// the pages stay presentational and the engine stays pure.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { orderDayFromDelivery, parseWeekday } from '@/lib/orderDay'
import toast from 'react-hot-toast'
import {
  DEFAULT_ORDER_SETTINGS, orderTypeOf,
  type DeliverySchedule, type DraftStatus, type GeneratedLine, type MinimumType,
  type OrderMinimum, type OrderSettings, type OrderType, type ProductRule,
  type VendorRules, type WeekCalendar,
} from './types'

const sb = () => supabase as any
const PAGE = 1000

/** Page through a table so a big company isn't silently truncated at ~1000 rows. */
async function fetchAll<T>(schema: string, table: string, select: string, companyId: string, extra?: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    let q = sb().schema(schema).from(table).select(select).eq('company_id', companyId)
    if (extra) q = extra(q)
    const { data, error } = await q.order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) break
    const batch = (data ?? []) as T[]
    out.push(...batch)
    // Exit only on a genuinely empty page — the project's API "Max Rows"
    // setting silently caps every response at 1000 regardless of the
    // requested range, so a full page here doesn't mean "last page."
    if (batch.length === 0) break
    from += PAGE
  }
  return out
}

// ── Module settings ─────────────────────────────────────────────────────

export function useOrderSettings() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [settings, setSettings] = useState<OrderSettings>(DEFAULT_ORDER_SETTINGS)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('ov2_settings')
      .select('*').eq('company_id', companyId).maybeSingle()
    if (data) setSettings({ ...DEFAULT_ORDER_SETTINGS, ...data })
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const save = useCallback(async (next: OrderSettings) => {
    if (!companyId) return
    setSettings(next)
    const { error } = await sb().schema('inventory').from('ov2_settings')
      .upsert({ ...next, company_id: companyId, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'company_id' })
    if (error) { toast.error(error.message); return }
    toast.success('Order settings saved')
  }, [companyId, profile?.id])

  return { settings, loading, save, reload: load }
}

// ── Vendor rules ────────────────────────────────────────────────────────

export interface VendorRuleRow {
  id: string; vendor_id: string; order_type: OrderType
  minimum_dollars: number; minimum_type: MinimumType; minimum_qty: number | null
}
export interface CaseLimitRow { id: string; vendor_id: string; case_type: string; minimum_qty: number }

/** Order-day restrictions are RelaDyne-specific today. */
export const isReladyne = (vendorName: string | null | undefined) => /reladyne/i.test(vendorName ?? '')

export function useVendorRules() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [minimums, setMinimums] = useState<VendorRuleRow[]>([])
  const [caseLimits, setCaseLimits] = useState<CaseLimitRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [m, c] = await Promise.all([
      fetchAll<VendorRuleRow>('inventory', 'ov2_vendor_order_minimums', 'id, vendor_id, order_type, minimum_dollars, minimum_type, minimum_qty', companyId),
      fetchAll<CaseLimitRow>('inventory', 'ov2_vendor_case_type_minimums', 'id, vendor_id, case_type, minimum_qty', companyId),
    ])
    setMinimums(m); setCaseLimits(c); setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  /** Engine-shaped rules for one vendor, falling back to module defaults. */
  const rulesFor = useCallback((vendorId: string | null, settings: OrderSettings, vendorName?: string | null): VendorRules => {
    const pick = (type: OrderType): OrderMinimum => {
      const row = minimums.find((x) => x.vendor_id === vendorId && x.order_type === type)
      if (row) return { type: row.minimum_type ?? 'dollars', dollars: Number(row.minimum_dollars ?? 0), qty: row.minimum_qty ?? null }
      return type === 'bulk'
        ? { type: settings.bulk_minimum_type, dollars: settings.order_minimum_dollars_bulk, qty: settings.bulk_minimum_qty }
        : { type: settings.package_minimum_type, dollars: settings.order_minimum_dollars_package, qty: settings.package_minimum_qty }
    }
    return {
      vendor_id: vendorId,
      minimums: { package: pick('package'), bulk: pick('bulk') },
      caseTypeMinimums: Object.fromEntries(
        caseLimits.filter((x) => x.vendor_id === vendorId).map((x) => [x.case_type, Number(x.minimum_qty)]),
      ),
      // Order/delivery weekdays are a RelaDyne arrangement; other vendors can
      // be ordered any day, so the restriction simply doesn't apply to them.
      usesOrderDays: isReladyne(vendorName),
    }
  }, [minimums, caseLimits])

  async function saveMinimum(
    vendorId: string, orderType: OrderType, dollars: number,
    minimumType: MinimumType = 'dollars', qty: number | null = null,
  ) {
    if (!companyId) return
    const { error } = await sb().schema('inventory').from('ov2_vendor_order_minimums')
      .upsert({ company_id: companyId, vendor_id: vendorId, order_type: orderType, minimum_dollars: dollars,
        minimum_type: minimumType, minimum_qty: qty,
        updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,vendor_id,order_type' })
    if (error) { toast.error(error.message); return }
    toast.success('Minimum saved'); load()
  }

  async function saveCaseLimit(vendorId: string, caseType: string, qty: number) {
    if (!companyId) return
    const { error } = await sb().schema('inventory').from('ov2_vendor_case_type_minimums')
      .upsert({ company_id: companyId, vendor_id: vendorId, case_type: caseType, minimum_qty: qty,
        updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,vendor_id,case_type' })
    if (error) { toast.error(error.message); return }
    toast.success('Case limit saved'); load()
  }

  async function removeCaseLimit(id: string) {
    const { error } = await sb().schema('inventory').from('ov2_vendor_case_type_minimums').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    load()
  }

  return { minimums, caseLimits, loading, rulesFor, saveMinimum, saveCaseLimit, removeCaseLimit, reload: load }
}

// ── Drafts ──────────────────────────────────────────────────────────────

export interface DraftRow {
  id: string
  vendor_id: string | null
  order_date: string
  status: DraftStatus
  notes: string | null
  settings_snapshot: Record<string, unknown>
  created_by: string | null
  created_at: string
  last_edited_by: string | null
  updated_at: string
}

export interface DraftLineRow extends GeneratedLine {
  id: string
  draft_id: string
  dos_after_delivery: number | null
  is_override: boolean
}

export function useDrafts() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('ov2_order_drafts')
      .select('*').eq('company_id', companyId).order('updated_at', { ascending: false })
    setDrafts((data ?? []) as DraftRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  /**
   * A draft becomes a real row the moment the user starts one, so it appears
   * on the landing page for everyone and survives a closed browser.
   */
  async function createDraft(
    vendorId: string | null, orderDate: string, settings: OrderSettings, orderDow?: number | null,
  ): Promise<string | null> {
    if (!companyId) return null
    const { data, error } = await sb().schema('inventory').from('ov2_order_drafts').insert({
      company_id: companyId, vendor_id: vendorId, order_date: orderDate, status: 'generating',
      // __order_dow rides along with the settings snapshot so the draft
      // remembers which weekday's shops it was built for.
      settings_snapshot: { ...settings, __order_dow: orderDow ?? null },
      created_by: profile?.id ?? null, last_edited_by: profile?.id ?? null,
    }).select('id').single()
    if (error) { toast.error(error.message); return null }
    await load()
    return data.id as string
  }

  async function deleteDraft(id: string) {
    const { error } = await sb().schema('inventory').from('ov2_order_drafts').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Draft deleted'); load()
  }

  return { drafts, loading, createDraft, deleteDraft, reload: load }
}

export interface DraftAggregate { products: number; gallons: number; cost: number }

/**
 * Per-draft product/gallon/cost totals for the landing page's status
 * tables. Read live from the lines table (not cached on the draft header
 * the way ov2_order_history's totals are at finalize time) since a draft
 * is still being edited — a cached figure would go stale on every line
 * edit made from the Review/Final Review pages.
 */
export function useDraftAggregates(draftIds: string[]) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [aggregates, setAggregates] = useState<Record<string, DraftAggregate>>({})
  const key = draftIds.slice().sort().join(',')

  useEffect(() => {
    let cancelled = false
    if (!companyId || !key) { setAggregates({}); return }
    ;(async () => {
      const rows = await fetchAll<{ draft_id: string; qty: number; unit_cost: number | null; quarts_per_unit: number | null; included: boolean }>(
        'inventory', 'ov2_order_draft_lines', 'draft_id, qty, unit_cost, quarts_per_unit, included', companyId,
        (q: any) => q.in('draft_id', key.split(',')),
      )
      if (cancelled) return
      const out: Record<string, DraftAggregate> = {}
      for (const r of rows) {
        if (!r.included || Number(r.qty) <= 0) continue
        const agg = out[r.draft_id] ?? (out[r.draft_id] = { products: 0, gallons: 0, cost: 0 })
        agg.products += 1
        agg.cost += Number(r.qty) * Number(r.unit_cost ?? 0)
        if (r.quarts_per_unit) agg.gallons += (Number(r.qty) * Number(r.quarts_per_unit)) / 4
      }
      setAggregates(out)
    })()
    return () => { cancelled = true }
  }, [companyId, key])

  return aggregates
}

// ── Single draft (+ lines) ──────────────────────────────────────────────

export function useDraft(draftId: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [draft, setDraft] = useState<DraftRow | null>(null)
  const [lines, setLines] = useState<DraftLineRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId || !draftId) { setLoading(false); return }
    setLoading(true)
    const [{ data: d }, ls] = await Promise.all([
      sb().schema('inventory').from('ov2_order_drafts').select('*').eq('id', draftId).maybeSingle(),
      fetchAll<DraftLineRow>('inventory', 'ov2_order_draft_lines', '*', companyId, (q: any) => q.eq('draft_id', draftId)),
    ])
    setDraft((d ?? null) as DraftRow | null)
    setLines(ls)
    setLoading(false)
  }, [companyId, draftId])
  useEffect(() => { load() }, [load])

  /** Replace the draft's lines with a fresh generation run. */
  async function replaceLines(generated: (GeneratedLine & { dos_after_delivery?: number | null })[]) {
    if (!companyId || !draftId) return
    await sb().schema('inventory').from('ov2_order_draft_lines').delete().eq('draft_id', draftId)
    // JSON has no Infinity/NaN — both serialise to null, which then trips the
    // NOT NULL columns. Numbers are pinned here so a bad figure surfaces as a
    // zero to fix in review rather than a failed insert.
    const numOr = (v: unknown, fallback: number | null) =>
      (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

    const payload = generated.map((l) => ({
      company_id: companyId, draft_id: draftId,
      location_id: l.location_id, product_id: l.product_id, order_type: l.order_type, uom: l.uom,
      system_qty: numOr(l.system_qty, 0), qty: numOr(l.qty, 0), is_override: false, included: l.included,
      unit_cost: numOr(l.unit_cost, null), on_hand: numOr(l.on_hand, null), daily_usage: numOr(l.daily_usage, null),
      dos_before: numOr(l.dos_before, null), dos_after: numOr(l.dos_after, null),
      dos_after_delivery: numOr(l.dos_after_delivery, null),
      max_capacity_gallons: numOr(l.max_capacity_gallons, null), quarts_per_unit: numOr(l.quarts_per_unit, null), flags: l.flags,
      added_by_smoothing: l.added_by_smoothing, triggered_smoothing: l.triggered_smoothing,
    }))
    const CHUNK = 500
    for (let i = 0; i < payload.length; i += CHUNK) {
      const { error } = await sb().schema('inventory').from('ov2_order_draft_lines').insert(payload.slice(i, i + CHUNK))
      if (error) { toast.error(error.message); return }
    }
    await load()
  }

  /** Autosave a single line edit; marks it as a user override for the UI. */
  async function patchLine(id: string, patch: Partial<DraftLineRow>, markOverride = true) {
    // Reverting qty back to what the engine originally proposed clears the
    // override flag too — it marks "I changed this," not a permanent tag
    // once the change is undone.
    const current = lines.find((l) => l.id === id)
    const reverted = markOverride && patch.qty != null && current != null && Number(patch.qty) === Number(current.system_qty)
    const overridePatch = markOverride ? { is_override: !reverted } : {}
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch, ...overridePatch } : l)))
    const body: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString(), ...overridePatch }
    const { error } = await sb().schema('inventory').from('ov2_order_draft_lines').update(body).eq('id', id)
    if (error) toast.error(error.message)
    void touch()
  }

  async function addLine(row: Partial<DraftLineRow> & { location_id: string; product_id: string; order_type: OrderType }) {
    if (!companyId || !draftId) return
    const { error } = await sb().schema('inventory').from('ov2_order_draft_lines').insert({
      company_id: companyId, draft_id: draftId, is_override: true, included: true,
      system_qty: 0, qty: row.qty ?? 1, flags: [], ...row,
    })
    if (error) { toast.error(error.message); return }
    await load(); void touch()
  }

  async function removeLine(id: string) {
    setLines((prev) => prev.filter((l) => l.id !== id))
    const { error } = await sb().schema('inventory').from('ov2_order_draft_lines').delete().eq('id', id)
    if (error) toast.error(error.message)
    void touch()
  }

  /** Record who last touched the draft — drives the landing page's columns. */
  async function touch(patch: Partial<DraftRow> = {}) {
    if (!draftId) return
    const body = { ...patch, last_edited_by: profile?.id ?? null, updated_at: new Date().toISOString() }
    setDraft((d) => (d ? { ...d, ...body } as DraftRow : d))
    await sb().schema('inventory').from('ov2_order_drafts').update(body).eq('id', draftId)
  }

  const setStatus = (status: DraftStatus) => touch({ status })

  return { draft, lines, loading, reload: load, replaceLines, patchLine, addLine, removeLine, touch, setStatus }
}

// ── Generation inputs ───────────────────────────────────────────────────

export interface OrderConfigRow { location_id: string; product_id: string; vendor_id: string | null; capacity: number | null; order_limit: number | null; metadata: Record<string, unknown> | null }
export interface UsageRow { location_id: string; product_id: string; on_hands: number | null; daily_usage: number | null }
export interface TankOnHandRow { location_id: string | null; product_id: string | null; on_hand: number | null }
export interface PurchaseOrderRow { id: string; location_id: string | null; po_status: string | null }
export interface PoItemRow {
  purchase_order_id: string; product_id: string | null
  quantity: number | null; received_quantity: number | null; remaining_quantity: number | null
  purchase_uom: string | null
}
export interface VendorPartRow {
  vendor_id: string | null; our_part_number: string | null; unit_of_measure: string | null; metadata: Record<string, unknown> | null
  // description/part_number added for the tank-monitor product-name match
  // below (buildGenerationInputs' tankOnHandMap) — same automatic
  // description/part_number -> our_part_number match LocationLookupPage.tsx
  // already does for its own "internal id" column.
  description?: string | null; part_number?: string | null
}
export interface GlobalProductRow { product_id: string; unit_of_measure: string | null }
export interface UomMappingRow { vendor_id: string | null; from_unit: string; to_unit: string; factor: number; order_type: OrderType | null }
// Derived from core.locations.reladyne_delivery_day rather than a table of
// its own — the location list is already the source of truth for it.
export interface VendorDayRow { location_id: string; order_dow: number | null; delivery_dow: number | null }

/**
 * Everything the engine needs, pulled once per generation run: the shop's
 * order config (the only products eligible), per-product rules, current
 * usage, per-vendor order days, and prior orders for the flag rules.
 */
export function useGenerationData() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null

  const fetchInputs = useCallback(async (
    vendorId: string | null, lookbackDays: number,
    // Fires once per source table as it finishes (out of the fixed total
    // below) — coarse, since a couple of these tables page through tens of
    // thousands of rows internally while others return instantly, but
    // enough to drive a real progress bar instead of a bare spinner for
    // what's usually the slowest step in generating an order.
    onProgress?: (loaded: number, total: number) => void,
  ) => {
    if (!companyId) return { configs: [], rules: [], usage: [], productMappings: [], vendorParts: [], uomMappings: [], globalProducts: [], tankOnHand: [], openPurchaseOrders: [], poItems: [], days: [], schedules: new Map(), calendar: new Map(), history: [] as any[] }
    const since = new Date(); since.setDate(since.getDate() - Math.max(1, lookbackDays))
    const sinceStr = since.toISOString().slice(0, 10)

    const FETCH_STEPS = 14 // 13 fetchAll calls below + the trailing order-history-dates query
    let stepsDone = 0
    const step = <T,>(p: Promise<T>): Promise<T> => p.then((r) => { onProgress?.(++stepsDone, FETCH_STEPS); return r })

    const [configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, openPurchaseOrders, poItems, locRows, schedRows, calRows, history] = await Promise.all([
      step(fetchAll<OrderConfigRow>('inventory', 'location_order_config', 'location_id, product_id, vendor_id, capacity, order_limit, metadata', companyId,
        vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined)),
      step(fetchAll<ProductRule & { id: string }>('inventory', 'ov2_product_rules', '*', companyId)),
      // By far the largest table this fetches (every product at every shop,
      // not just oil) — usually the long pole in the whole generation run.
      step(fetchAll<UsageRow>('inventory', 'product_usage', 'location_id, product_id, on_hands, daily_usage', companyId)),
      step(fetchAll<any>('inventory', 'product_id_mappings', 'old_product_id, new_product_id', companyId)),
      // Cost + package size come from here, not from ov2_product_rules (that
      // table has no editing UI and is empty in practice) — see
      // resolveVendorPart below.
      step(fetchAll<VendorPartRow>('inventory', 'vendor_parts', 'vendor_id, our_part_number, unit_of_measure, metadata, description, part_number', companyId)),
      step(fetchAll<UomMappingRow>('inventory', 'uom_mappings', 'vendor_id, from_unit, to_unit, factor, order_type', companyId)),
      // Most products report on-hand/usage in quarts already; a product
      // whose global_products.unit_of_measure says otherwise (e.g. HM0806
      // in ounces) gets converted before it reaches the engine — see
      // quartsFromSourceUnit below.
      step(fetchAll<GlobalProductRow>('inventory', 'global_products', 'product_id, unit_of_measure', companyId)),
      // Keep-fill/VMI products use the tank monitor's own on-hand reading
      // instead of Droptop's product_usage — see buildGenerationInputs.
      step(fetchAll<TankOnHandRow>('inventory', 'tank_monitors', 'location_id, product_id, on_hand', companyId)),
      // Still-open POs (not closed/cancelled) — filtered server-side since
      // most POs in practice ARE closed and there's no reason to pull them
      // just to discard them. Flags a line as covered_by_open_po rather than
      // silently adjusting anything; see buildGenerationInputs.
      step(fetchAll<PurchaseOrderRow>('inventory', 'droptop_purchase_orders', 'id, location_id, po_status', companyId,
        (q: any) => q.in('po_status', ['draft', 'sent', 'accepted']))),
      step(fetchAll<PoItemRow>('inventory', 'droptop_purchase_order_items', 'purchase_order_id, product_id, quantity, received_quantity, remaining_quantity, purchase_uom', companyId)),
      step(fetchAll<any>('core', 'locations', 'id, reladyne_delivery_day', companyId)),
      step(fetchAll<any>('inventory', 'ov2_location_schedules', '*', companyId, vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined)),
      step(fetchAll<any>('inventory', 'ov2_delivery_calendar', 'week_start, week_label', companyId, vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined)),
      step(fetchAll<any>('inventory', 'ov2_order_history_lines', 'location_id, product_id, qty, dos_before, dos_after, order_id', companyId)),
    ])

    // History lines carry no date of their own; join the header dates in.
    const { data: heads } = await sb().schema('inventory').from('ov2_order_history')
      .select('id, order_date').eq('company_id', companyId).gte('order_date', sinceStr)
    onProgress?.(++stepsDone, FETCH_STEPS)
    const dateById = new Map<string, string>(((heads ?? []) as any[]).map((h) => [h.id, h.order_date]))
    const historyFacts = history
      .filter((h) => dateById.has(h.order_id))
      .map((h) => ({
        location_id: h.location_id, product_id: h.product_id,
        order_date: dateById.get(h.order_id)!,
        dos_before: h.dos_before,
        // How many days of supply that order added — dos_after minus dos_before.
        dos_ordered: h.dos_after != null && h.dos_before != null ? Number(h.dos_after) - Number(h.dos_before) : null,
        qty: Number(h.qty),
      }))

    // Order day = RelaDyne delivery day − 3 business days (lib/orderDay).
    const days: VendorDayRow[] = (locRows ?? []).map((l: any) => {
      const deliv = parseWeekday(l.reladyne_delivery_day)
      return {
        location_id: l.id,
        delivery_dow: deliv,
        order_dow: deliv == null ? null : parseWeekday(orderDayFromDelivery(l.reladyne_delivery_day)),
      }
    }).filter((d: VendorDayRow) => d.order_dow != null)

    // Per-shop delivery schedules (Valvoline and anything else that isn't a
    // single company-wide weekday), plus the uploaded A/B week calendar.
    const schedules = new Map<string, DeliverySchedule>()
    for (const r of (schedRows ?? [])) {
      schedules.set(r.location_id, {
        type: r.schedule_type, delivery_dow: r.delivery_dow,
        week_a_dow: r.week_a_dow, week_b_dow: r.week_b_dow,
        lead_business_days: Number(r.lead_business_days ?? 4),
      })
    }
    const calendar: WeekCalendar = new Map(
      (calRows ?? []).map((c: any) => [String(c.week_start).slice(0, 10), c.week_label as 'A' | 'B']),
    )

    return { configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, openPurchaseOrders, poItems, days, schedules, calendar, history: historyFacts }
  }, [companyId])

  return { fetchInputs }
}

/** Merge config + rules + usage into engine inputs (config is the gate). */
export function buildGenerationInputs(
  configs: OrderConfigRow[], rules: (ProductRule & { id?: string })[], usage: UsageRow[],
  productMappings: { old_product_id: string | null; new_product_id: string | null }[] = [],
  vendorParts: VendorPartRow[] = [], uomMappings: UomMappingRow[] = [],
  globalProducts: GlobalProductRow[] = [],
  tankOnHand: TankOnHandRow[] = [],
  openPurchaseOrders: PurchaseOrderRow[] = [],
  poItems: PoItemRow[] = [],
  // Manual raw-tank-name -> our_part_number overrides (platform.app_settings
  // key 'tank_product_map', edited from Tank Monitors' Product Mapping tab)
  // — same resolution LocationLookupPage.tsx already applies to its own
  // on-hand display. Without this, a keep-fill product's tank reading never
  // matches its order-config product_id at all (tank_monitors.product_id is
  // whatever raw name the telemetry provider uses — e.g. "DMX SYN 0W20" —
  // not the shop's canonical "SYN-0W20"), so every VMI product with a real
  // tank installed still showed "no data" here.
  tankProductMap: Record<string, string> = {},
) {
  const ruleKey = (l: string, p: string) => `${l}|${String(p).toLowerCase().trim()}`
  const ruleMap = new Map(rules.map((r) => [ruleKey(r.location_id, r.product_id), r]))

  // Product Usage is often still keyed by retired product ids while the order
  // config already uses the new ones, so a straight join finds no on-hand at
  // all. Resolve each usage row through product_id_mappings first and sum
  // anything landing on the same product — same treatment Location Lookup's
  // order-config table gets.
  const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()
  // Same convention as RecountLogicTab.tsx's "equivalent case types" on-hand
  // lookup: a trailing run of letters marks the case-type suffix (e.g. "D"
  // for drum, "BB" for bulk/tote) — stripping it gives the product family
  // both belong to, so 5W30D and 5W30BB both resolve to "5W30".
  const baseProductId = (id: string): string => id.replace(/[A-Z]+$/i, '') || id
  const oldToNew = new Map<string, string>()
  for (const m of productMappings) {
    if (m.old_product_id && m.new_product_id) oldToNew.set(pkey(m.old_product_id), String(m.new_product_id))
  }
  const usageMap = new Map<string, UsageRow>()
  for (const u of usage) {
    const resolved = oldToNew.get(pkey(u.product_id)) ?? u.product_id
    const k = ruleKey(u.location_id, resolved)
    const cur = usageMap.get(k)
    const add = (a: number | null | undefined, b: number | null | undefined) =>
      (b == null ? (a ?? null) : (a ?? 0) + Number(b))
    usageMap.set(k, {
      location_id: u.location_id, product_id: resolved,
      on_hands: add(cur?.on_hands, u.on_hands),
      daily_usage: add(cur?.daily_usage, u.daily_usage),
    })
  }

  // Tank monitor telemetry names its own products however the provider
  // does ("DMX SYN 0W20"), never the shop's canonical product_id — so a
  // plain product_id join here would never match anything. Resolve through
  // the SAME two-step lookup LocationLookupPage.tsx already uses for its
  // own on-hand display: the manual tankProductMap override first, then an
  // automatic match against vendor_parts' description/part_number.
  const vendorPartByDescOrPart = new Map<string, string>()
  for (const vp of vendorParts) {
    const our = vp.our_part_number; if (!our) continue
    const desc = vp.description ? pkey(vp.description) : ''
    if (desc) vendorPartByDescOrPart.set(desc, our)
    const pn = vp.part_number ? pkey(vp.part_number) : ''
    if (pn && !vendorPartByDescOrPart.has(pn)) vendorPartByDescOrPart.set(pn, our)
  }
  const resolveTankProductId = (rawProductId: string): string => {
    const k = pkey(rawProductId)
    if (!k) return rawProductId
    return tankProductMap[k] || vendorPartByDescOrPart.get(k) || rawProductId
  }

  // Keep-fill/VMI products read on-hand from the tank monitor instead —
  // summed across every monitor matched to that location+product (a shop
  // can have more than one tank of the same product), resolved through the
  // tank-name match above and then the same retired-id mapping as usage.
  const tankOnHandMap = new Map<string, number>()
  for (const t of tankOnHand) {
    if (!t.location_id || !t.product_id || t.on_hand == null) continue
    const tankResolved = resolveTankProductId(t.product_id)
    const resolved = oldToNew.get(pkey(tankResolved)) ?? tankResolved
    const k = ruleKey(t.location_id, resolved)
    tankOnHandMap.set(k, (tankOnHandMap.get(k) ?? 0) + Number(t.on_hand))
  }

  // Outstanding quantity on still-open POs — summed per location+product, in
  // quarts. fetchInputs already filters to draft/sent/accepted server-side,
  // but this also checks status here rather than trusting that unconditionally
  // — cheap insurance against a caller passing an unfiltered list. A PO
  // item's purchase_uom ("GA", "QT", ...) is the vendor's own purchase
  // unit, not necessarily quarts; only real volume units convert cleanly,
  // so a case/each-counted item (no reliable quarts equivalent without
  // knowing package size) is left out of the sum rather than guessed —
  // same "don't silently fabricate a number" stance as the keep-fill
  // on-hand handling above.
  const OPEN_PO_STATUSES = new Set(['draft', 'sent', 'accepted'])
  const poQuartsPerUnit = (raw: string | null): number | null => {
    const u = pkey(raw).replace(/\./g, '')
    if (['qt', 'qts', 'quart', 'quarts'].includes(u)) return 1
    if (['pt', 'pts', 'pint', 'pints'].includes(u)) return 0.5
    if (['ga', 'gal', 'gals', 'gallon', 'gallons'].includes(u)) return 4
    return null
  }
  const openPoLocationById = new Map(
    openPurchaseOrders.filter((po) => OPEN_PO_STATUSES.has(po.po_status ?? '')).map((po) => [po.id, po.location_id]),
  )
  const pendingPoMap = new Map<string, number>()
  for (const it of poItems) {
    const locationId = openPoLocationById.get(it.purchase_order_id)
    if (!locationId || !it.product_id) continue
    const outstanding = it.remaining_quantity != null
      ? Number(it.remaining_quantity)
      : Math.max(0, Number(it.quantity ?? 0) - Number(it.received_quantity ?? 0))
    if (outstanding <= 0) continue
    const perUnit = poQuartsPerUnit(it.purchase_uom)
    if (perUnit == null) continue
    const resolved = oldToNew.get(pkey(it.product_id)) ?? it.product_id
    const k = ruleKey(locationId, resolved)
    pendingPoMap.set(k, (pendingPoMap.get(k) ?? 0) + outstanding * perUnit)
  }

  // Package size + cost come from vendor_parts (matched vendor + our part
  // number, resolved through the same product_id_mappings as usage above —
  // both can lag behind the config's canonical id), not from
  // ov2_product_rules: that table has no editing UI and is empty in
  // practice. "Quarts per package" prefers the vendor-scoped UOM
  // Conversions table; when a UOM has no mapping yet, package_qty_gallons
  // × 4 is used as a fallback so a product isn't left fully unresolved
  // just because nobody's filled in the UOM table for it yet.
  const vendorPartMap = new Map<string, VendorPartRow>()
  for (const vp of vendorParts) {
    if (!vp.our_part_number) continue
    vendorPartMap.set(`${vp.vendor_id ?? ''}|${pkey(vp.our_part_number)}`, vp)
  }
  const QUART_NAMES = new Set(['quart', 'quarts', 'qt', 'qts'])
  const uomQuartsMap = new Map<string, number>()
  for (const m of uomMappings) {
    if (!QUART_NAMES.has(pkey(m.to_unit)) || !(Number(m.factor) > 0)) continue
    uomQuartsMap.set(`${m.vendor_id ?? ''}|${pkey(m.from_unit)}`, Number(m.factor))
  }
  const quartsForUom = (vendorId: string | null, uomName: string | null | undefined) => {
    const u = pkey(uomName)
    if (!u) return undefined
    return uomQuartsMap.get(`${vendorId ?? ''}|${u}`) ?? uomQuartsMap.get(`|${u}`)
  }
  // Package-vs-bulk override, keyed the same way but independent of the
  // to_unit filter above — order_type can be set on a row regardless of
  // whether it also carries a quarts conversion.
  const uomOrderTypeMap = new Map<string, OrderType>()
  for (const m of uomMappings) {
    if (m.order_type) uomOrderTypeMap.set(`${m.vendor_id ?? ''}|${pkey(m.from_unit)}`, m.order_type)
  }
  const orderTypeForUom = (vendorId: string | null, uomName: string | null | undefined): OrderType | null => {
    const u = pkey(uomName)
    if (!u) return null
    return uomOrderTypeMap.get(`${vendorId ?? ''}|${u}`) ?? uomOrderTypeMap.get(`|${u}`) ?? null
  }
  const resolveVendorPart = (vendorId: string | null, productId: string) => {
    const resolved = oldToNew.get(pkey(productId)) ?? productId
    return vendorPartMap.get(`${vendorId ?? ''}|${pkey(resolved)}`)
  }

  // Almost every product's on-hand/usage is already recorded in quarts —
  // but a product tracked in a different unit (e.g. HM0806 in ounces) would
  // silently overstate its order need by that same factor, since the
  // deficit math downstream assumes quarts throughout. global_products'
  // "on-hand UOM" declares the real source unit per product; anything not
  // listed here, or already quarts, passes through unchanged.
  //
  // Ounces get a substring match (any spelling containing "oz" or "ounce" —
  // "oz", "Oz.", "fl oz", "fluid ounces", ...) rather than requiring one
  // exact string, since how it got typed into Global Products varies and a
  // near-miss here means the conversion silently never applies. Quart/pint/
  // gallon stay exact-match: those abbreviations are short enough that a
  // substring match risks false positives.
  const quartsPerSourceUnit = (raw: string): number => {
    const u = pkey(raw).replace(/\./g, '')
    if (['quart', 'quarts', 'qt', 'qts'].includes(u)) return 1
    if (['pint', 'pints', 'pt'].includes(u)) return 0.5
    if (['gallon', 'gallons', 'gal'].includes(u)) return 4
    if (u.includes('oz') || u.includes('ounce')) return 1 / 32
    return 1
  }
  // Resolved the same direction as usage above: global_products may still
  // carry a retired id, so each row is forward-mapped to its canonical id
  // before indexing — the config's own product_id is already canonical, so
  // no resolution is needed at lookup time.
  const sourceUnitMap = new Map<string, string>()
  for (const g of globalProducts) {
    if (!g.unit_of_measure) continue
    const resolved = oldToNew.get(pkey(g.product_id)) ?? g.product_id
    sourceUnitMap.set(pkey(resolved), g.unit_of_measure)
  }
  const quartsFromSourceUnit = (productId: string): number => {
    const unit = sourceUnitMap.get(pkey(productId))
    return unit ? quartsPerSourceUnit(unit) : 1
  }

  // "Order Limit" of exactly 0 is the config screen's own documented
  // convention for "inactive — don't order this product at this shop"
  // (OrderConfigTab.tsx: "set Order Limit to 0 to make a product
  // inactive"). Orders v2 never selected the column before now, so this
  // was silently ignored; excluded here so an inactive product never
  // becomes a candidate at all, not just capped.
  //
  // Pass 1: each config row's own rule/on-hand/usage, exactly as before —
  // "own" on-hand, not yet combined with any other case type of the same
  // product family.
  const base = configs.filter((c) => c.order_limit !== 0).map((c) => {
    const k = ruleKey(c.location_id, c.product_id)
    const r = ruleMap.get(k)
    const u = usageMap.get(k)
    const meta = (c.metadata ?? {}) as Record<string, unknown>
    const rule: ProductRule = r ?? {
      location_id: c.location_id, product_id: c.product_id,
      // Fall back to the order config's own UOM/VMI metadata when no v2 rule
      // has been set up yet, so a shop is usable before it's fully configured.
      uom: String(meta.uom ?? '').toLowerCase().replace(/\s+/g, '_') || null,
      units_per_uom_gallons: null, unit_cost: null,
      max_capacity_gallons: null,
      vmi_keepfill_enabled: String(meta.vmi ?? '').trim().toLowerCase() === 'yes',
      can_ignore_minimum: false, ignore_minimum_if_ordered_alone: true,
      default_order_amount_if_alone: 2, include_in_total_shop_order: true,
      order_type_override: null,
    }

    // Fill in whatever an explicit ov2_product_rules override (if any)
    // left unset — vendor_parts for package size/cost, the config's own
    // capacity (converted gallons -> quarts, the one place that
    // conversion happens) for the cap.
    const vp = resolveVendorPart(c.vendor_id, c.product_id)
    if (rule.units_per_uom_gallons == null && vp) {
      const uomFactor = quartsForUom(vp.vendor_id ?? c.vendor_id, vp.unit_of_measure)
      const galQty = Number((vp.metadata as any)?.package_qty_gallons)
      rule.units_per_uom_gallons = uomFactor ?? (galQty > 0 ? galQty * 4 : null)
    }
    if (rule.unit_cost == null && vp) {
      const galQty = Number((vp.metadata as any)?.package_qty_gallons)
      const perGal = Number((vp.metadata as any)?.price_per_gallon)
      rule.unit_cost = galQty > 0 && perGal > 0 ? galQty * perGal : null
    }
    if (rule.max_capacity_gallons == null && c.capacity != null) {
      rule.max_capacity_gallons = Number(c.capacity) * 4
    }
    if (rule.order_type_override == null && vp) {
      rule.order_type_override = orderTypeForUom(vp.vendor_id ?? c.vendor_id, vp.unit_of_measure)
    }

    const srcFactor = quartsFromSourceUnit(c.product_id)
    // Keep-fill/VMI: on-hand comes from the tank monitor (gallons, so ×4 to
    // match this module's quarts-denominated fields — same conversion as
    // max_capacity_gallons above), not Droptop's product_usage. A monitor
    // reading of exactly 0 is real data (tank confirmed empty) and stays 0;
    // no matching monitor at all stays null — the engine treats that as
    // "needs review", not "empty" (see generateOrder's vmi_no_tank_data
    // check), so a shop that was never fitted with a monitor can't
    // silently generate a bogus catch-up order.
    const tankSum = tankOnHandMap.get(k)
    const on_hand = rule.vmi_keepfill_enabled
      ? (tankSum != null ? tankSum * 4 : null)
      : (u?.on_hands != null ? u.on_hands * srcFactor : null)
    return {
      location_id: c.location_id, product_id: c.product_id, rule,
      on_hand, daily_usage: u?.daily_usage != null ? u.daily_usage * srcFactor : null,
    }
  })

  // Pass 2: group non-VMI rows by shop + product family for the "equivalent
  // case types" combine below. Built from EVERY product with a usage/on-hand
  // record (usageMap — the full product_usage universe for this location),
  // not just products actually configured for order here — a sibling case
  // type can carry real on-hand at a shop without ever being an order-config
  // row itself (e.g. EURO-SYN-0W20D sitting on the shelf at a shop that only
  // orders EURO-SYN-0W20C), and that quantity still belongs to the family.
  // Restricting this to `base` (configured products only) silently dropped
  // exactly that case. Keep-fill/VMI is excluded — its on-hand is already
  // the tank monitor's own reading, not something another case type's
  // on-hand should be blended into; `vmiKeys` covers this from the actual
  // order configs since a bare usage row has no VMI flag of its own.
  const vmiKeys = new Set(base.filter((b) => b.rule.vmi_keepfill_enabled).map((b) => ruleKey(b.location_id, b.product_id)))
  const familyMembers = new Map<string, { product_id: string; on_hand: number }[]>()
  for (const u of usageMap.values()) {
    if (u.on_hands == null || vmiKeys.has(ruleKey(u.location_id, u.product_id))) continue
    const onHand = Number(u.on_hands) * quartsFromSourceUnit(u.product_id)
    const fam = `${u.location_id}|${pkey(baseProductId(u.product_id))}`
    if (!familyMembers.has(fam)) familyMembers.set(fam, [])
    familyMembers.get(fam)!.push({ product_id: u.product_id, on_hand: onHand })
  }

  // Pass 3: combine each row's own on-hand with its family's other case
  // types — e.g. 5W30D and 5W30BB both resolve to family "5W30", so
  // ordering 5W30BB accounts for on-hand sitting under the 5W30D id too.
  // A sibling reading that's implausibly large next to this product's own
  // usage (more than a 12-gallon drum's worth, or more than a day's usage,
  // whichever is smaller) is excluded from the combined total — probably a
  // stale reading rather than product actually on the shelf at this shop —
  // but still shown, tagged "not used", never silently dropped.
  const CASE_CARRYOVER_MAX_QUARTS = 48 // 12 gallons, in this module's quarts convention
  return base.map((b) => {
    // Never applies to VMI/keep-fill — its on-hand already comes from the
    // tank monitor and any "order" is really a vendor-notify recommendation,
    // not a normal PO decision.
    const pendingPoQty = b.rule.vmi_keepfill_enabled
      ? null
      : pendingPoMap.get(ruleKey(b.location_id, b.product_id)) ?? null

    if (b.rule.vmi_keepfill_enabled || b.on_hand == null) {
      return { location_id: b.location_id, product_id: b.product_id, rule: b.rule, on_hand: b.on_hand, daily_usage: b.daily_usage, pendingPoQty }
    }
    const fam = `${b.location_id}|${pkey(baseProductId(b.product_id))}`
    const siblings = (familyMembers.get(fam) ?? []).filter((s) => s.product_id !== b.product_id)
    if (siblings.length === 0) {
      return { location_id: b.location_id, product_id: b.product_id, rule: b.rule, on_hand: b.on_hand, daily_usage: b.daily_usage, pendingPoQty }
    }
    const threshold = Math.min(CASE_CARRYOVER_MAX_QUARTS, Number(b.daily_usage ?? 0))
    const equivalent_products = siblings.map((s) => ({ ...s, used: s.on_hand <= threshold }))
    const combined = b.on_hand + equivalent_products.filter((e) => e.used).reduce((sum, e) => sum + e.on_hand, 0)
    return {
      location_id: b.location_id, product_id: b.product_id, rule: b.rule,
      on_hand: combined, daily_usage: b.daily_usage,
      own_on_hand: b.on_hand, equivalent_products, pendingPoQty,
    }
  })
}

/**
 * Shops whose order day falls on this date. Only RelaDyne restricts by day —
 * for any other vendor this returns null, meaning "no restriction".
 */
export function eligibleLocations(
  days: VendorDayRow[], usesOrderDays: boolean, orderDate: string, overrideDow?: number | null,
): Set<string> | null {
  if (!usesOrderDays) return null
  const withDays = days.filter((d) => d.order_dow != null)
  if (!withDays.length) return null
  // Order days are a weekday, not a date. The order date supplies the default
  // weekday, but a run can be pointed at a different one (ordering Thursday's
  // shops on a Wednesday, say) without moving the order date itself.
  const dow = overrideDow ?? new Date(orderDate + 'T00:00:00').getDay()
  return new Set(withDays.filter((d) => d.order_dow === dow).map((d) => d.location_id))
}

/** How many shops sit on each order weekday — powers the picker and the empty state. */
export function shopsPerOrderDay(days: VendorDayRow[]): number[] {
  const counts = [0, 0, 0, 0, 0, 0, 0]
  for (const d of days) if (d.order_dow != null) counts[d.order_dow]++
  return counts
}

/** The weekday a draft is ordering for: an explicit choice, else the date's own. */
export function draftOrderDow(draft: { order_date: string; settings_snapshot?: Record<string, unknown> | null }): number {
  const stored = (draft.settings_snapshot as any)?.__order_dow
  if (typeof stored === 'number' && stored >= 0 && stored <= 6) return stored
  return new Date(draft.order_date + 'T00:00:00').getDay()
}

/**
 * Order-day coverage for a vendor: how many shops sit on each weekday, so the
 * "start order" dialog can say up front that Wednesday has 12 shops and
 * Saturday has none — rather than generating an empty order and leaving the
 * user to work out why.
 */
export function useOrderDayCoverage(vendorName: string | null | undefined) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [counts, setCounts] = useState<number[]>([0, 0, 0, 0, 0, 0, 0])
  const [applies, setApplies] = useState(false)

  useEffect(() => {
    if (!companyId) return
    const uses = isReladyne(vendorName)
    setApplies(uses)
    if (!uses) { setCounts([0, 0, 0, 0, 0, 0, 0]); return }
    let cancelled = false
    void (async () => {
      const rows = await fetchAll<any>('core', 'locations', 'id, reladyne_delivery_day, active', companyId)
      if (cancelled) return
      const days: VendorDayRow[] = rows
        .filter((l) => l.active !== false)
        .map((l) => {
          const deliv = parseWeekday(l.reladyne_delivery_day)
          return {
            location_id: l.id, delivery_dow: deliv,
            order_dow: deliv == null ? null : parseWeekday(orderDayFromDelivery(l.reladyne_delivery_day)),
          }
        })
      setCounts(shopsPerOrderDay(days))
    })()
    return () => { cancelled = true }
  }, [companyId, vendorName])

  return { counts, applies, total: counts.reduce((a, b) => a + b, 0) }
}

export const groupKeyOf = (l: { location_id: string; order_type: OrderType }) => `${l.location_id}|${l.order_type}`
export const lineOrderType = orderTypeOf
