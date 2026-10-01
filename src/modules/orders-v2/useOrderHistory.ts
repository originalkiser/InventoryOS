// Orders v2 — finalized order history. Separate from the draft tables so a
// past order is a permanent record, and so the flag rules in the engine have
// a stable place to read prior orders from.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'
import type { DraftLineRow, DraftRow } from './useOrdersV2'
import { poNumber } from './engine'
import { isValvoline } from './useOrdersV2'
import { insertValvolineOrderFromFinalize } from './useValvolineOrderDatabase'
import type { OrderType } from './types'

const sb = () => supabase as any
const PAGE = 1000

export interface HistoryOrder {
  id: string
  draft_id: string | null
  vendor_id: string | null
  order_date: string
  order_type: OrderType | null
  location_count: number
  line_count: number
  total_dollars: number
  // New column (migration 20260828e_order_history_gallons.sql) — may be
  // missing on rows finalized before it was added, or in a production
  // database that hasn't run the migration yet. Saved best-effort below.
  total_gallons?: number | null
  export_status: string
  export_count: number
  last_exported_at: string | null
  settings_snapshot: Record<string, unknown>
  finalized_by: string | null
  finalized_at: string
  edited_after_finalize: boolean
}

export interface HistoryLine {
  id: string
  order_id: string
  location_id: string | null
  product_id: string
  order_type: OrderType
  uom: string | null
  po_number: string | null
  system_qty: number
  qty: number
  is_override: boolean
  unit_cost: number | null
  line_total: number | null
  on_hand: number | null
  daily_usage: number | null
  dos_before: number | null
  dos_after: number | null
  dos_after_delivery: number | null
  quarts_per_unit: number | null
  flags: string[]
  note: string | null
  edited_after_finalize: boolean
  edited_by: string | null
  edited_at: string | null
}

/**
 * draft_id -> ov2_order_history.id, for every completed draft in the given
 * list — the landing page's unified table (2026-09-29 rework) reads drafts
 * directly for its rows now (see statusRoute, which already reopens an
 * 'exported' draft on the same editable Export step), so it no longer needs
 * the full history list. This is just enough to link a completed row to its
 * read-only Order Summary recap.
 */
export function useHistoryIdsByDraft(draftIds: string[]) {
  const [ids, setIds] = useState<Record<string, string>>({})
  const key = draftIds.slice().sort().join(',')
  useEffect(() => {
    let cancelled = false
    if (!key) { setIds({}); return }
    sb().schema('inventory').from('ov2_order_history').select('id, draft_id').in('draft_id', key.split(','))
      .then(({ data }: any) => {
        if (cancelled) return
        const out: Record<string, string> = {}
        for (const r of (data ?? []) as { id: string; draft_id: string }[]) out[r.draft_id] = r.id
        setIds(out)
      })
    return () => { cancelled = true }
  }, [key])
  return ids
}

export function useHistoryOrder(orderId: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [order, setOrder] = useState<HistoryOrder | null>(null)
  const [lines, setLines] = useState<HistoryLine[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId || !orderId) { setLoading(false); return }
    setLoading(true)
    const [{ data: o }, all] = await Promise.all([
      sb().schema('inventory').from('ov2_order_history').select('*').eq('id', orderId).maybeSingle(),
      (async () => {
        const out: HistoryLine[] = []
        let from = 0
        for (;;) {
          const { data, error } = await sb().schema('inventory').from('ov2_order_history_lines')
            .select('*').eq('order_id', orderId).order('id', { ascending: true }).range(from, from + PAGE - 1)
          if (error) break
          const batch = (data ?? []) as HistoryLine[]
          out.push(...batch)
          // Exit only on a genuinely empty page — the project's API "Max
          // Rows" setting silently caps every response at 1000 regardless
          // of the requested range, so a full page doesn't mean "last page."
          if (batch.length === 0) break
          from += batch.length
        }
        return out
      })(),
    ])
    setOrder((o ?? null) as HistoryOrder | null)
    setLines(all)
    setLoading(false)
  }, [companyId, orderId])
  useEffect(() => { load() }, [load])

  async function noteReExport() {
    if (!orderId || !order) return
    const now = new Date().toISOString()
    await sb().schema('inventory').from('ov2_order_history')
      .update({ export_count: (order.export_count ?? 1) + 1, last_exported_at: now, updated_at: now })
      .eq('id', orderId)
    await load()
  }

  return { order, lines, loading, reload: load, noteReExport }
}

/**
 * Mark a draft complete — direct ask 2026-09-29: "kill the finalize step,"
 * a draft is just considered complete the moment it's exported, and it
 * never locks. No separate confirmation, no navigating away from the
 * draft's own Review/Final Review/Export pages, and no distinct
 * lock/unlock edit mode — the draft stays exactly as editable as it always
 * was (see statusRoute in shared.ts, which already reopens an 'exported'
 * draft on the Export step like any other status).
 *
 * ov2_order_history/_lines still get written — RD reconciliation
 * (rdReconciliation.ts) reads ov2_order_history_lines.po_number/qty for its
 * own matching, and this is also the one place Valvoline's order-database
 * auto-feed hooks in — but as an UPSERT keyed on draft_id rather than an
 * always-insert: calling this again after further edits (a re-download)
 * refreshes the existing history header + fully replaces its lines with
 * the draft's current state, instead of the old behavior of either
 * silently going stale or (if re-finalized) creating a second, duplicate
 * "completed" order for the same draft. finalized_by/finalized_at are only
 * ever set on the FIRST call — they mean "when this was first completed,"
 * not "when it was last re-exported" (last_exported_at covers that). The
 * Valvoline auto-feed likewise only ever fires on that first call.
 */
export async function markDraftComplete(
  companyId: string, userId: string | null, draft: DraftRow, lines: DraftLineRow[],
  shopNumberOf: (locationId: string | null) => string, vendorName?: string | null,
): Promise<string | null> {
  const included = lines.filter((l) => l.included && Number(l.qty) > 0)
  const total = included.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0)
  const totalGallons = included.reduce((s, l) => s + (l.quarts_per_unit ? Number(l.qty) * Number(l.quarts_per_unit) : 0), 0) / 4
  const shops = new Set(included.map((l) => l.location_id))
  const types = new Set(included.map((l) => l.order_type))
  const now = new Date().toISOString()

  const { data: existing } = await sb().schema('inventory').from('ov2_order_history')
    .select('id, export_count').eq('draft_id', draft.id).maybeSingle()

  let orderId: string
  if (existing) {
    orderId = existing.id
    const { error } = await sb().schema('inventory').from('ov2_order_history').update({
      vendor_id: draft.vendor_id, order_date: draft.order_date,
      order_type: types.size === 1 ? [...types][0] : null,
      location_count: shops.size, line_count: included.length, total_dollars: total,
      export_status: 'exported', export_count: (existing.export_count ?? 1) + 1, last_exported_at: now,
      settings_snapshot: draft.settings_snapshot, updated_at: now,
    }).eq('id', orderId)
    if (error) { toast.error(error.message); return null }
    sb().schema('inventory').from('ov2_order_history').update({ total_gallons: totalGallons }).eq('id', orderId).then(() => {})
    // Fully replace the line snapshot with the draft's current state — the
    // draft is the live source of truth, this is just its latest mirror.
    await sb().schema('inventory').from('ov2_order_history_lines').delete().eq('order_id', orderId)
  } else {
    const { data: head, error } = await sb().schema('inventory').from('ov2_order_history').insert({
      company_id: companyId, draft_id: draft.id, vendor_id: draft.vendor_id, order_date: draft.order_date,
      order_type: types.size === 1 ? [...types][0] : null,
      location_count: shops.size, line_count: included.length, total_dollars: total,
      export_status: 'exported', export_count: 1, last_exported_at: now,
      settings_snapshot: draft.settings_snapshot, finalized_by: userId, finalized_at: now,
    }).select('id').single()
    if (error) { toast.error(error.message); return null }
    orderId = head.id as string
    // Best-effort: total_gallons is a new column that may not exist in
    // production yet. Never let it block the core insert above, which is
    // what actually marks the order complete.
    sb().schema('inventory').from('ov2_order_history').update({ total_gallons: totalGallons }).eq('id', orderId).then(() => {})
  }

  const payload = included.map((l) => ({
    company_id: companyId, order_id: orderId, location_id: l.location_id, product_id: l.product_id,
    order_type: l.order_type, uom: l.uom,
    po_number: poNumber(shopNumberOf(l.location_id), draft.order_date, l.order_type),
    system_qty: l.system_qty, qty: l.qty, is_override: l.is_override, unit_cost: l.unit_cost,
    line_total: Number(l.qty) * Number(l.unit_cost ?? 0),
    on_hand: l.on_hand, daily_usage: l.daily_usage, dos_before: l.dos_before, dos_after: l.dos_after,
    dos_after_delivery: l.dos_after_delivery, quarts_per_unit: l.quarts_per_unit, flags: l.flags, note: l.note ?? null,
  }))
  const CHUNK = 500
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error: e } = await sb().schema('inventory').from('ov2_order_history_lines').insert(payload.slice(i, i + CHUNK))
    if (e) { toast.error(e.message); return null }
  }

  await sb().schema('inventory').from('ov2_order_drafts')
    .update({ status: 'exported', last_edited_by: userId, updated_at: now }).eq('id', draft.id)

  // Valvoline Order Database auto-feed (2026-09-24) — every order this app
  // completes for Valvoline also lands in inventory.valvoline_order_lines
  // (source: 'sbnet'), so it shows up alongside uploaded/manual Valvoline
  // history without a separate step. Same shop-grouped, per-shop-reset line
  // numbering as Orders v2 Export's own "line_number" export field, and the
  // exact same po_number already computed above — a shop's own SB Net order
  // and any Valvoline-side export of the same PO land on the same rows.
  // Only on first completion (existing == null) — a re-export shouldn't
  // feed a second, duplicate copy of the same order into that database.
  // Best-effort: never lets a database-feed failure undo an already-
  // successful completion.
  if (!existing && isValvoline(vendorName)) {
    const sorted = [...included].sort((a, b) =>
      shopNumberOf(a.location_id).localeCompare(shopNumberOf(b.location_id), undefined, { numeric: true })
      || a.product_id.localeCompare(b.product_id))
    const lineNumberByShop = new Map<string, number>()
    const feedLines = sorted.map((l) => {
      const n = (lineNumberByShop.get(l.location_id) ?? 0) + 1
      lineNumberByShop.set(l.location_id, n)
      return {
        location_id: l.location_id, product_id: l.product_id, qty: Number(l.qty), uom: l.uom,
        po_number: poNumber(shopNumberOf(l.location_id), draft.order_date, l.order_type), line_number: n,
      }
    })
    insertValvolineOrderFromFinalize(companyId, feedLines).catch((e) => console.warn('[ValvolineOrderDatabase] auto-feed failed:', e))
  }

  return orderId
}

// Advances by the ACTUAL rows returned, not a fixed page size — the
// project's API "Max Rows" setting can silently cap a response below PAGE
// regardless of the requested range, which has bitten this exact
// fetch-every-page shape more than once elsewhere in this module (see
// useValvolineOrderDatabase.ts's own header comment on the same bug).
async function fetchAllHistoryRows<T>(table: string, companyId: string, select: string, orderCol: string): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb().schema('inventory').from(table).select(select).eq('company_id', companyId)
      .order(orderCol, { ascending: false }).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length === 0) break
    from += batch.length
  }
  return out
}

export interface OrderHistoryLineRow {
  id: string
  order_id: string
  location_id: string | null
  vendor_id: string | null
  order_date: string
  po_number: string | null
  product_id: string
  order_type: OrderType
  uom: string | null
  qty: number
  unit_cost: number | null
  line_total: number | null
  quarts_per_unit: number | null
}

/**
 * Every completed order line across every vendor, flattened — "products
 * ordered by date and shop" (direct ask 2026-09-29), the general-purpose
 * counterpart to the Valvoline-only order database. ov2_order_history_lines
 * itself doesn't carry vendor_id/order_date (those live on the header row),
 * so this joins them client-side, same convention as useDraftAggregates'
 * own draft_id -> aggregate map.
 */
export function useAllOrderHistoryLines() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<OrderHistoryLineRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [headers, lines] = await Promise.all([
      fetchAllHistoryRows<{ id: string; vendor_id: string | null; order_date: string }>(
        'ov2_order_history', companyId, 'id, vendor_id, order_date', 'order_date'),
      fetchAllHistoryRows<Omit<OrderHistoryLineRow, 'vendor_id' | 'order_date'>>(
        'ov2_order_history_lines', companyId,
        'id, order_id, location_id, po_number, product_id, order_type, uom, qty, unit_cost, line_total, quarts_per_unit', 'id'),
    ])
    const headerById = new Map(headers.map((h) => [h.id, h]))
    setRows(lines.map((l) => {
      const h = headerById.get(l.order_id)
      return { ...l, vendor_id: h?.vendor_id ?? null, order_date: h?.order_date ?? '' }
    }))
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  return { rows, loading, reload: load }
}
