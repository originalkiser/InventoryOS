// Morning cross-check (direct ask 2026-10-02): every RelaDyne order we sent
// yesterday should be on today's uploaded Open Sales Order report. This
// compares our own order lines for a given date against that report so a
// line that never made it (a missed export, or an edit made after the file
// went out) is caught while there's still time to send it.
//
// Matching mirrors rdReconciliation.ts: our po_number ({shop}-{MMDDYYYY}{B|P})
// is RelaDyne's CustomerPONo, and our product_id maps to RelaDyne's
// ProductCode through vendor_parts (part_number <-> our_part_number). A line
// not on the open report is only "missing" if it also isn't already on an
// invoice — RelaDyne can ship and bill an order before the next morning's
// report, and a shipped line legitimately drops off the OPEN list.
//
// "Our order lines" come from the draft when it still exists (it's the live,
// editable source of truth — an edit made after export is in the draft), and
// from ov2_order_history_lines otherwise (an older order whose draft is gone).
import { supabase } from '@/lib/supabase'
import { isReladyne } from './useOrdersV2'
import { poNumber } from './engine'
import type { OrderType } from './types'

const sb = () => supabase as any
const PAGE = 1000

export type OrderCheckStatus = 'found' | 'invoiced' | 'missing' | 'unmapped'

/** What's needed to rebuild a line on a re-send draft. */
export interface ResendLineSeed {
  location_id: string | null
  product_id: string
  order_type: OrderType
  uom: string | null
  qty: number
  unit_cost: number | null
  on_hand: number | null
  daily_usage: number | null
  dos_before: number | null
  dos_after: number | null
  dos_after_delivery: number | null
  max_capacity_gallons: number | null
  quarts_per_unit: number | null
}

export interface OrderCheckLine extends ResendLineSeed {
  key: string
  po_number: string
  shop: string
  /** RelaDyne's own ProductCode for product_id, or null when vendor_parts has no mapping. */
  product_code: string | null
  sourceOrderId: string
  status: OrderCheckStatus
}

export interface OrderCheckResult {
  date: string
  /** How many completed RelaDyne orders were dated `date`. */
  orderCount: number
  lines: OrderCheckLine[]
  /** When the Open Sales Order report was last uploaded (null = never). */
  openOrdersUploadedAt: string | null
  sourceOrderIds: string[]
  /** __order_dow of the first source order, carried onto a re-send draft so weekday export templates still resolve. */
  sourceOrderDow: number | null
}

/** Previous weekday before `todayIso` (YYYY-MM-DD) — Monday looks back to Friday. Holidays aren't considered. */
export function previousBusinessDay(todayIso: string): string {
  const d = new Date(todayIso + 'T00:00:00')
  do { d.setDate(d.getDate() - 1) } while (d.getDay() === 0 || d.getDay() === 6)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Pure classification of our order lines against the open-SO / invoiced PO+product keys. */
export function classifyOrderLines<T extends { po_number: string; product_id: string }>(
  lines: T[],
  openKeys: Set<string>,
  invoicedKeys: Set<string>,
  partNumberByProductId: Map<string, string>,
): (T & { product_code: string | null; status: OrderCheckStatus })[] {
  return lines.map((l) => {
    const code = partNumberByProductId.get(l.product_id) ?? null
    if (!code) return { ...l, product_code: null, status: 'unmapped' as const }
    const k = `${l.po_number}|${code}`
    const status: OrderCheckStatus = openKeys.has(k) ? 'found' : invoicedKeys.has(k) ? 'invoiced' : 'missing'
    return { ...l, product_code: code, status }
  })
}

async function fetchAll<T>(schema: string, table: string, select: string, apply: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await apply(sb().schema(schema).from(table).select(select)).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length === 0) break
    from += batch.length
  }
  return out
}

const chunk = <T,>(arr: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/** Loads our RelaDyne orders for `date` and classifies each line against the current Open Sales Order report. */
export async function loadOrderCheck(
  companyId: string, date: string, shopNumberOf: (locationId: string | null) => string,
): Promise<OrderCheckResult> {
  const vendors = await fetchAll<{ id: string; name: string | null }>('inventory', 'vendors', 'id, name', (q) => q.eq('company_id', companyId))
  const rdVendorIds = vendors.filter((v) => isReladyne(v.name)).map((v) => v.id)
  const empty: OrderCheckResult = { date, orderCount: 0, lines: [], openOrdersUploadedAt: null, sourceOrderIds: [], sourceOrderDow: null }
  if (!rdVendorIds.length) return empty

  const orders = await fetchAll<{ id: string; draft_id: string | null; order_date: string; settings_snapshot: Record<string, unknown> | null }>(
    'inventory', 'ov2_order_history', 'id, draft_id, order_date, settings_snapshot',
    (q) => q.eq('company_id', companyId).in('vendor_id', rdVendorIds).eq('order_date', date))
  if (!orders.length) return empty

  // Prefer the live draft's lines when the draft still exists.
  const draftIds = orders.map((o) => o.draft_id).filter((v): v is string => !!v)
  const liveDraftIds = new Set<string>()
  if (draftIds.length) {
    const drafts = await fetchAll<{ id: string }>('inventory', 'ov2_order_drafts', 'id', (q) => q.in('id', draftIds))
    for (const d of drafts) liveDraftIds.add(d.id)
  }

  const SEED = 'location_id, product_id, order_type, uom, qty, unit_cost, on_hand, daily_usage, dos_before, dos_after, dos_after_delivery, quarts_per_unit'
  const seeds: { sourceOrderId: string; orderDate: string; seed: ResendLineSeed }[] = []
  const toSeed = (r: any): ResendLineSeed => ({
    location_id: r.location_id, product_id: r.product_id, order_type: r.order_type, uom: r.uom ?? null,
    qty: Number(r.qty), unit_cost: r.unit_cost != null ? Number(r.unit_cost) : null,
    on_hand: r.on_hand != null ? Number(r.on_hand) : null, daily_usage: r.daily_usage != null ? Number(r.daily_usage) : null,
    dos_before: r.dos_before != null ? Number(r.dos_before) : null, dos_after: r.dos_after != null ? Number(r.dos_after) : null,
    dos_after_delivery: r.dos_after_delivery != null ? Number(r.dos_after_delivery) : null,
    max_capacity_gallons: r.max_capacity_gallons != null ? Number(r.max_capacity_gallons) : null,
    quarts_per_unit: r.quarts_per_unit != null ? Number(r.quarts_per_unit) : null,
  })
  for (const o of orders) {
    if (o.draft_id && liveDraftIds.has(o.draft_id)) {
      const rows = await fetchAll<any>('inventory', 'ov2_order_draft_lines', `${SEED}, max_capacity_gallons, included`,
        (q) => q.eq('draft_id', o.draft_id))
      for (const r of rows) if (r.included && Number(r.qty) > 0) seeds.push({ sourceOrderId: o.id, orderDate: o.order_date, seed: toSeed(r) })
    } else {
      const rows = await fetchAll<any>('inventory', 'ov2_order_history_lines', SEED, (q) => q.eq('order_id', o.id))
      for (const r of rows) if (Number(r.qty) > 0) seeds.push({ sourceOrderId: o.id, orderDate: o.order_date, seed: toSeed(r) })
    }
  }

  const parts = await fetchAll<{ our_part_number: string | null; part_number: string | null }>(
    'inventory', 'vendor_parts', 'our_part_number, part_number', (q) => q.eq('company_id', companyId).in('vendor_id', rdVendorIds))
  const partNumberByProductId = new Map<string, string>()
  for (const vp of parts) if (vp.our_part_number && vp.part_number) partNumberByProductId.set(vp.our_part_number, vp.part_number)

  const withPo = seeds.map((s) => ({
    ...s.seed,
    sourceOrderId: s.sourceOrderId,
    po_number: poNumber(shopNumberOf(s.seed.location_id), s.orderDate, s.seed.order_type),
    shop: shopNumberOf(s.seed.location_id),
    key: `${s.sourceOrderId}|${s.seed.location_id}|${s.seed.product_id}|${s.seed.order_type}`,
  }))

  const openRows = await fetchAll<{ customer_po_no: string | null; product_code: string }>(
    'inventory', 'rd_open_orders', 'customer_po_no, product_code', (q) => q.eq('company_id', companyId))
  const openKeys = new Set(openRows.filter((r) => r.customer_po_no).map((r) => `${r.customer_po_no}|${r.product_code}`))
  const { data: up } = await sb().schema('inventory').from('rd_open_orders').select('uploaded_at')
    .eq('company_id', companyId).order('uploaded_at', { ascending: false }).limit(1).maybeSingle()

  // Already shipped/invoiced (so legitimately off the OPEN list): the
  // accumulating delivery ledger plus whatever's on the open-invoice report.
  const poNumbers = [...new Set(withPo.map((l) => l.po_number))]
  const invoicedKeys = new Set<string>()
  for (const group of chunk(poNumbers, 150)) {
    const [ledger, openInv] = await Promise.all([
      fetchAll<{ customer_po_no: string | null; product_code: string }>('inventory', 'rd_delivery_ledger', 'customer_po_no, product_code',
        (q) => q.eq('company_id', companyId).in('customer_po_no', group)),
      fetchAll<{ customer_po_no: string | null; product_code: string }>('inventory', 'rd_open_invoices', 'customer_po_no, product_code',
        (q) => q.eq('company_id', companyId).in('customer_po_no', group)),
    ])
    for (const r of [...ledger, ...openInv]) if (r.customer_po_no) invoicedKeys.add(`${r.customer_po_no}|${r.product_code}`)
  }

  const classified = classifyOrderLines(withPo, openKeys, invoicedKeys, partNumberByProductId)
  const dow = (orders[0].settings_snapshot as any)?.__order_dow
  return {
    date, orderCount: orders.length, lines: classified, openOrdersUploadedAt: up?.uploaded_at ?? null,
    sourceOrderIds: orders.map((o) => o.id), sourceOrderDow: typeof dow === 'number' ? dow : null,
  }
}

/**
 * Builds a new draft holding ONLY the given lines (the ones missing from
 * RelaDyne's open sales orders) and returns its id, ready for the normal
 * Export step. The draft keeps the ORIGINAL order date so each line's PO
 * number matches the order it belongs to. `__resend_for_date` marks it as a
 * re-send: markDraftComplete skips the order-history write for these (the
 * original order already recorded those lines — a second copy would double-
 * count them in reconciliation and "last ordered" figures).
 */
export async function createResendDraft(
  companyId: string, userId: string | null, vendorId: string | null, date: string,
  missing: OrderCheckLine[], sourceOrderDow: number | null,
): Promise<string | null> {
  if (!missing.length) return null
  const { data: draft, error } = await sb().schema('inventory').from('ov2_order_drafts').insert({
    company_id: companyId, vendor_id: vendorId, order_date: date, status: 'final_review',
    settings_snapshot: {
      __order_dow: sourceOrderDow, __resend_for_date: date, __resend_line_count: missing.length,
      __shop_count: new Set(missing.map((l) => l.location_id)).size,
    },
    created_by: userId, last_edited_by: userId,
  }).select('id').single()
  if (error) throw new Error(error.message)

  const note = 'Re-send: was missing from RelaDyne open sales orders'
  const payload = missing.map((l) => ({
    company_id: companyId, draft_id: draft.id,
    location_id: l.location_id, product_id: l.product_id, order_type: l.order_type, uom: l.uom,
    system_qty: l.qty, qty: l.qty, is_override: false, included: true,
    unit_cost: l.unit_cost, on_hand: l.on_hand, daily_usage: l.daily_usage,
    dos_before: l.dos_before, dos_after: l.dos_after, dos_after_delivery: l.dos_after_delivery,
    max_capacity_gallons: l.max_capacity_gallons, quarts_per_unit: l.quarts_per_unit, flags: [],
    added_by_smoothing: false, triggered_smoothing: false, note,
  }))
  for (const part of chunk(payload, 500)) {
    const { error: e } = await sb().schema('inventory').from('ov2_order_draft_lines').insert(part)
    if (e) throw new Error(e.message)
  }
  return draft.id as string
}
