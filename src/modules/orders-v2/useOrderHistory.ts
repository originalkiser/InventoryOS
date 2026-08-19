// Orders v2 — finalized order history. Separate from the draft tables so a
// past order is a permanent record, and so the flag rules in the engine have
// a stable place to read prior orders from.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'
import type { DraftLineRow, DraftRow } from './useOrdersV2'
import { poNumber } from './engine'
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
  edited_after_finalize: boolean
  edited_by: string | null
  edited_at: string | null
}

export function useOrderHistory() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [orders, setOrders] = useState<HistoryOrder[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('ov2_order_history')
      .select('*').eq('company_id', companyId).order('order_date', { ascending: false })
    setOrders((data ?? []) as HistoryOrder[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  return { orders, loading, reload: load }
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
          if (batch.length < PAGE) break
          from += PAGE
        }
        return out
      })(),
    ])
    setOrder((o ?? null) as HistoryOrder | null)
    setLines(all)
    setLoading(false)
  }, [companyId, orderId])
  useEffect(() => { load() }, [load])

  /**
   * Editing a finalized order is allowed but never silent: the line is
   * flagged, and the before/after is written to the audit table with who and
   * when. Callers gate this behind an explicit confirmation.
   */
  async function editLine(line: HistoryLine, patch: Partial<HistoryLine>) {
    if (!companyId || !orderId) return
    const now = new Date().toISOString()
    const body = { ...patch, edited_after_finalize: true, edited_by: profile?.id ?? null, edited_at: now }
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, ...body } as HistoryLine : l)))

    const { error } = await sb().schema('inventory').from('ov2_order_history_lines').update(body).eq('id', line.id)
    if (error) { toast.error(error.message); return }

    const audits = Object.entries(patch).map(([field, value]) => ({
      company_id: companyId, order_id: orderId, line_id: line.id, field,
      old_value: String((line as any)[field] ?? ''), new_value: String(value ?? ''),
      changed_by: profile?.id ?? null,
    }))
    if (audits.length) await sb().schema('inventory').from('ov2_order_history_audit').insert(audits)

    await sb().schema('inventory').from('ov2_order_history')
      .update({ edited_after_finalize: true, updated_at: now }).eq('id', orderId)
    await load()
  }

  async function noteReExport() {
    if (!orderId || !order) return
    const now = new Date().toISOString()
    await sb().schema('inventory').from('ov2_order_history')
      .update({ export_count: (order.export_count ?? 1) + 1, last_exported_at: now, updated_at: now })
      .eq('id', orderId)
    await load()
  }

  return { order, lines, loading, reload: load, editLine, noteReExport }
}

export function useAuditTrail(orderId: string | null) {
  const [rows, setRows] = useState<any[]>([])
  useEffect(() => {
    if (!orderId) return
    let cancelled = false
    sb().schema('inventory').from('ov2_order_history_audit')
      .select('*').eq('order_id', orderId).order('changed_at', { ascending: false })
      .then(({ data }: any) => { if (!cancelled) setRows((data ?? []) as any[]) })
    return () => { cancelled = true }
  }, [orderId])
  return rows
}

/**
 * Promote a draft into history. The draft keeps its rows (so it can still be
 * inspected) but flips to `exported`, moving it out of the in-progress list.
 */
export async function finalizeDraft(
  companyId: string, userId: string | null, draft: DraftRow, lines: DraftLineRow[],
  shopNumberOf: (locationId: string | null) => string,
): Promise<string | null> {
  const included = lines.filter((l) => l.included && Number(l.qty) > 0)
  const total = included.reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0)
  const shops = new Set(included.map((l) => l.location_id))
  const types = new Set(included.map((l) => l.order_type))
  const now = new Date().toISOString()

  const { data: head, error } = await sb().schema('inventory').from('ov2_order_history').insert({
    company_id: companyId, draft_id: draft.id, vendor_id: draft.vendor_id, order_date: draft.order_date,
    order_type: types.size === 1 ? [...types][0] : null,
    location_count: shops.size, line_count: included.length, total_dollars: total,
    export_status: 'exported', export_count: 1, last_exported_at: now,
    settings_snapshot: draft.settings_snapshot, finalized_by: userId, finalized_at: now,
  }).select('id').single()
  if (error) { toast.error(error.message); return null }

  const payload = included.map((l) => ({
    company_id: companyId, order_id: head.id, location_id: l.location_id, product_id: l.product_id,
    order_type: l.order_type, uom: l.uom,
    po_number: poNumber(shopNumberOf(l.location_id), draft.order_date, l.order_type),
    system_qty: l.system_qty, qty: l.qty, is_override: l.is_override, unit_cost: l.unit_cost,
    line_total: Number(l.qty) * Number(l.unit_cost ?? 0),
    on_hand: l.on_hand, daily_usage: l.daily_usage, dos_before: l.dos_before, dos_after: l.dos_after,
    dos_after_delivery: l.dos_after_delivery, quarts_per_unit: l.quarts_per_unit, flags: l.flags,
  }))
  const CHUNK = 500
  for (let i = 0; i < payload.length; i += CHUNK) {
    const { error: e } = await sb().schema('inventory').from('ov2_order_history_lines').insert(payload.slice(i, i + CHUNK))
    if (e) { toast.error(e.message); return null }
  }

  await sb().schema('inventory').from('ov2_order_drafts')
    .update({ status: 'exported', last_edited_by: userId, updated_at: now }).eq('id', draft.id)

  return head.id as string
}
