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
    if (batch.length < PAGE) break
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
    const payload = generated.map((l) => ({
      company_id: companyId, draft_id: draftId,
      location_id: l.location_id, product_id: l.product_id, order_type: l.order_type, uom: l.uom,
      system_qty: l.system_qty, qty: l.qty, is_override: false, included: l.included,
      unit_cost: l.unit_cost, on_hand: l.on_hand, daily_usage: l.daily_usage,
      dos_before: l.dos_before, dos_after: l.dos_after, dos_after_delivery: l.dos_after_delivery ?? null,
      max_capacity_gallons: l.max_capacity_gallons, flags: l.flags,
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
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch, ...(markOverride ? { is_override: true } : {}) } : l)))
    const body: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() }
    if (markOverride) body.is_override = true
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

export interface OrderConfigRow { location_id: string; product_id: string; vendor_id: string | null; capacity: number | null; metadata: Record<string, unknown> | null }
export interface UsageRow { location_id: string; product_id: string; on_hands: number | null; daily_usage: number | null }
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

  const fetchInputs = useCallback(async (vendorId: string | null, lookbackDays: number) => {
    if (!companyId) return { configs: [], rules: [], usage: [], days: [], schedules: new Map(), calendar: new Map(), history: [] as any[] }
    const since = new Date(); since.setDate(since.getDate() - Math.max(1, lookbackDays))
    const sinceStr = since.toISOString().slice(0, 10)

    const [configs, rules, usage, locRows, schedRows, calRows, history] = await Promise.all([
      fetchAll<OrderConfigRow>('inventory', 'location_order_config', 'location_id, product_id, vendor_id, capacity, metadata', companyId,
        vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined),
      fetchAll<ProductRule & { id: string }>('inventory', 'ov2_product_rules', '*', companyId),
      fetchAll<UsageRow>('inventory', 'product_usage', 'location_id, product_id, on_hands, daily_usage', companyId),
      fetchAll<any>('core', 'locations', 'id, reladyne_delivery_day', companyId),
      fetchAll<any>('inventory', 'ov2_location_schedules', '*', companyId, vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined),
      fetchAll<any>('inventory', 'ov2_delivery_calendar', 'week_start, week_label', companyId, vendorId ? (q: any) => q.eq('vendor_id', vendorId) : undefined),
      fetchAll<any>('inventory', 'ov2_order_history_lines', 'location_id, product_id, qty, dos_before, dos_after, order_id', companyId),
    ])

    // History lines carry no date of their own; join the header dates in.
    const { data: heads } = await sb().schema('inventory').from('ov2_order_history')
      .select('id, order_date').eq('company_id', companyId).gte('order_date', sinceStr)
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

    return { configs, rules, usage, days, schedules, calendar, history: historyFacts }
  }, [companyId])

  return { fetchInputs }
}

/** Merge config + rules + usage into engine inputs (config is the gate). */
export function buildGenerationInputs(
  configs: OrderConfigRow[], rules: (ProductRule & { id?: string })[], usage: UsageRow[],
) {
  const ruleKey = (l: string, p: string) => `${l}|${String(p).toLowerCase().trim()}`
  const ruleMap = new Map(rules.map((r) => [ruleKey(r.location_id, r.product_id), r]))
  const usageMap = new Map(usage.map((u) => [ruleKey(u.location_id, u.product_id), u]))

  return configs.map((c) => {
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
      max_capacity_gallons: c.capacity ?? null,
      vmi_keepfill_enabled: String(meta.vmi ?? '').trim().toLowerCase() === 'yes',
      can_ignore_minimum: false, ignore_minimum_if_ordered_alone: true,
      default_order_amount_if_alone: 2, include_in_total_shop_order: true,
    }
    return {
      location_id: c.location_id, product_id: c.product_id, rule,
      on_hand: u?.on_hands ?? null, daily_usage: u?.daily_usage ?? null,
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
