// RelaDyne Open Sales Order / Open Invoice report upload + reconciliation
// (2026-09-16 request) — see rdReconciliation.ts for the pure parsing/
// matching logic and migration 20260930v_rd_reconciliation.sql for the
// snapshot tables this reads/writes. This hook is the Supabase-facing
// half: uploads (snapshot-replace), and running the reconciliation check
// against our own RelaDyne order history + Droptop's purchase-order data,
// writing findings into inventory.exception_reports (report_type
// 'PO Match', metadata.source 'po_reconciliation_test' — the placeholder
// "Test - AutoExceptions" tab on the Exception Reporting page reads that
// tag) so they can be tested before this feeds the real exception flow.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import toast from 'react-hot-toast'
import { isReladyne } from './useOrdersV2'
import {
  parseOpenOrdersXlsx, parseOpenInvoicesXlsx, reconcilePoActivity,
  type ParsedOpenInvoiceRow, type HistoryLineForRecon, type DroptopPoForRecon,
} from './rdReconciliation'

const sb = () => supabase as any
const PAGE = 5000

// PostgREST caps an un-ranged select at 1000 rows regardless of a Max Rows
// setting past 1000 — same fix already applied at PoStatusPage.tsx/
// LocationLookupPage.tsx for the same reason. Only trust a genuinely empty
// page as the end.
async function fetchAllRows<T>(schema: string, table: string, apply: (q: any) => any): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await apply(sb().schema(schema).from(table).select('*')).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length === 0) break
  }
  return out
}

async function replaceSnapshot(table: string, companyId: string, rows: Record<string, unknown>[]) {
  const { error: delErr } = await sb().schema('inventory').from(table).delete().eq('company_id', companyId)
  if (delErr) throw delErr
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb().schema('inventory').from(table).insert(rows.slice(i, i + 1000))
    if (error) throw error
  }
}

export function useRdReports() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [lastOpenOrdersAt, setLastOpenOrdersAt] = useState<string | null>(null)
  const [lastOpenInvoicesAt, setLastOpenInvoicesAt] = useState<string | null>(null)
  const [uploading, setUploading] = useState<'orders' | 'invoices' | null>(null)
  const [reconciling, setReconciling] = useState(false)

  const loadLastUploaded = useCallback(async () => {
    if (!companyId) return
    const [{ data: o }, { data: i }] = await Promise.all([
      sb().schema('inventory').from('rd_open_orders').select('uploaded_at').eq('company_id', companyId)
        .order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
      sb().schema('inventory').from('rd_open_invoices').select('uploaded_at').eq('company_id', companyId)
        .order('uploaded_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    setLastOpenOrdersAt(o?.uploaded_at ?? null)
    setLastOpenInvoicesAt(i?.uploaded_at ?? null)
  }, [companyId])
  useEffect(() => { loadLastUploaded() }, [loadLastUploaded])

  const locationIdByShop = useMemo(() => new Map(loc.locations.map((l) => [l.name, l.id])), [loc.locations])

  // Cross-checks our own recent RelaDyne order history against whatever's
  // currently in the two snapshot tables plus Droptop's own receiving data,
  // writing/updating inventory.exception_reports rows for genuine
  // mismatches. Upserts by a stable per-finding key rather than
  // delete-and-reinsert like the snapshot tables above: unlike a report
  // upload, these rows are real exception-workflow records a user may have
  // already contacted a shop about or closed out, so a re-run must never
  // silently wipe that progress. A finding that no longer reproduces is
  // just left as whatever status it's already in — nothing here auto-closes
  // it, since confirming a stale exception is actually resolved is a human
  // judgment call, not something this check alone can safely assume.
  const runReconciliation = useCallback(async () => {
    if (!companyId) return
    setReconciling(true)
    try {
      const vendors = await fetchAllRows<{ id: string; name: string | null }>(
        'inventory', 'vendors', (q) => q.eq('company_id', companyId))
      const rdVendorIds = vendors.filter((v) => isReladyne(v.name)).map((v) => v.id)
      if (!rdVendorIds.length) return

      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 45)
      const cutoffIso = cutoff.toISOString().slice(0, 10)
      const orders = await fetchAllRows<{ id: string; vendor_id: string | null; order_date: string }>(
        'inventory', 'ov2_order_history', (q) => q.eq('company_id', companyId).in('vendor_id', rdVendorIds).gte('order_date', cutoffIso))
      if (!orders.length) return
      const orderDateById = new Map(orders.map((o) => [o.id, o.order_date]))
      const orderIds = orders.map((o) => o.id)

      const lines = await fetchAllRows<{
        order_id: string; location_id: string | null; product_id: string
        order_type: 'package' | 'bulk'; qty: number; quarts_per_unit: number | null; po_number: string | null
      }>('inventory', 'ov2_order_history_lines', (q) => q.in('order_id', orderIds))
      const historyLines: HistoryLineForRecon[] = lines
        .filter((l) => l.po_number)
        .map((l) => ({
          po_number: l.po_number as string, order_id: l.order_id, location_id: l.location_id, product_id: l.product_id,
          order_type: l.order_type, qty: Number(l.qty), quarts_per_unit: l.quarts_per_unit,
          order_date: orderDateById.get(l.order_id) ?? cutoffIso,
        }))
      if (!historyLines.length) return

      const vendorParts = await fetchAllRows<{ our_part_number: string | null; part_number: string | null }>(
        'inventory', 'vendor_parts', (q) => q.eq('company_id', companyId).in('vendor_id', rdVendorIds))
      const partNumberByProductId = new Map<string, string>()
      for (const vp of vendorParts) if (vp.our_part_number && vp.part_number) partNumberByProductId.set(vp.our_part_number, vp.part_number)

      const openOrderRows = await fetchAllRows<{ customer_po_no: string | null }>(
        'inventory', 'rd_open_orders', (q) => q.eq('company_id', companyId))
      const openOrderPoNumbers = new Set(openOrderRows.map((r) => r.customer_po_no).filter((v): v is string => !!v))

      const openInvoiceRows = await fetchAllRows<ParsedOpenInvoiceRow>(
        'inventory', 'rd_open_invoices', (q) => q.eq('company_id', companyId))
      const openInvoicesByPo = new Map<string, ParsedOpenInvoiceRow[]>()
      for (const r of openInvoiceRows) {
        if (!r.customer_po_no) continue
        if (!openInvoicesByPo.has(r.customer_po_no)) openInvoicesByPo.set(r.customer_po_no, [])
        openInvoicesByPo.get(r.customer_po_no)!.push(r)
      }

      // Droptop's own po_number (our own, not RelaDyne's) rides along on
      // custom_po_id, or embedded in note as "SB PO #{po_number}" — not
      // every real PO has either (see CLAUDE.md's Droptop Purchase Orders
      // notes), so a miss here just means this cross-check can't confirm a
      // Droptop-side receipt for that PO, not that nothing was received.
      const poNumbers = new Set(historyLines.map((l) => l.po_number))
      const droptopPos = await fetchAllRows<{
        id: string; custom_po_id: string | null; note: string | null; po_status: string | null; delivery_status: string | null
      }>('inventory', 'droptop_purchase_orders', (q) => q.eq('company_id', companyId))
      const droptopPoIdByPoNumber = new Map<string, string>()
      for (const p of droptopPos) {
        for (const poNumber of poNumbers) {
          if (droptopPoIdByPoNumber.has(poNumber)) continue
          if (p.custom_po_id === poNumber || (p.note && p.note.includes(poNumber))) droptopPoIdByPoNumber.set(poNumber, p.id)
        }
      }
      const relevantDroptopIds = new Set(droptopPoIdByPoNumber.values())
      const droptopItems = relevantDroptopIds.size
        ? await fetchAllRows<{ purchase_order_id: string; product_id: string | null; quantity: number | null; received_quantity: number | null }>(
            'inventory', 'droptop_purchase_order_items', (q) => q.eq('company_id', companyId).in('purchase_order_id', Array.from(relevantDroptopIds)))
        : []
      const droptopById = new Map(droptopPos.map((p) => [p.id, p]))
      const droptopByPo = new Map<string, DroptopPoForRecon>()
      for (const [poNumber, droptopId] of droptopPoIdByPoNumber) {
        const header = droptopById.get(droptopId)
        if (!header) continue
        droptopByPo.set(poNumber, {
          po_status: header.po_status, delivery_status: header.delivery_status,
          items: droptopItems.filter((it) => it.purchase_order_id === droptopId)
            .map((it) => ({ product_code: it.product_id, quantity: it.quantity, received_quantity: it.received_quantity })),
        })
      }

      const findings = reconcilePoActivity({
        historyLines, openOrderPoNumbers, openInvoicesByPo, droptopByPo, partNumberByProductId,
        today: new Date().toISOString().slice(0, 10),
      })

      const { data: existingRows } = await sb().schema('inventory').from('exception_reports')
        .select('id, status, metadata').eq('company_id', companyId).eq('report_type', 'PO Match')
        .contains('metadata', { source: 'po_reconciliation_test' })
      const existingByKey = new Map<string, { id: string; status: string | null }>()
      for (const r of existingRows ?? []) {
        const key = (r.metadata as any)?.key
        if (key) existingByKey.set(key, { id: r.id, status: r.status })
      }

      for (const f of findings) {
        const key = `${f.po_number}:${f.status}`
        const existing = existingByKey.get(key)
        if (existing && (existing.status ?? '').toLowerCase().includes('closed')) continue // don't reopen a manually-closed finding
        const shop = f.location_id ? loc.locations.find((l) => l.id === f.location_id) : undefined
        const issue = f.status === 'not_received' ? 'Missing Receipt' : 'Receipt <> Invoice'
        const details = f.status === 'not_received'
          ? `PO ${f.po_number} (ordered ${f.order_date}) has not been received — no matching invoice line and no Droptop receipt found.`
          : `PO ${f.po_number} (ordered ${f.order_date}) received quantities don't match ${f.source === 'invoice' ? 'the invoice' : 'Droptop receiving'}: ` +
            f.variances.map((v) => `${v.product_code ?? v.product_id} ordered ${v.ordered.toFixed(1)}${v.unit === 'gal' ? ' gal' : ''}, received ${v.received.toFixed(1)}${v.unit === 'gal' ? ' gal' : ''}`).join('; ')
        const row = {
          company_id: companyId, location_id: f.location_id, area_manager: shop?.area_manager ?? null,
          date_of_finding: new Date().toISOString().slice(0, 10), report_type: 'PO Match', issue, details,
          status: 'Pending Shop/AM Response', metadata: { source: 'po_reconciliation_test', key, po_number: f.po_number },
        }
        if (existing) {
          await sb().schema('inventory').from('exception_reports').update(row).eq('id', existing.id)
        } else {
          await sb().schema('inventory').from('exception_reports').insert(row)
        }
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Reconciliation check failed')
    } finally {
      setReconciling(false)
    }
  }, [companyId, loc.locations])

  const uploadOpenOrders = useCallback(async (rows: Record<string, string>[]) => {
    if (!companyId) return
    setUploading('orders')
    try {
      const parsed = parseOpenOrdersXlsx(rows)
      const uploadedAt = new Date().toISOString()
      const payload = parsed.map((r) => ({
        company_id: companyId, location_id: r.shop_number ? locationIdByShop.get(r.shop_number) ?? null : null,
        sales_order_no: r.sales_order_no, customer_po_no: r.customer_po_no, order_date: r.order_date,
        order_type: r.order_type, warehouse_code: r.warehouse_code, ship_to_code: r.ship_to_code,
        ship_to_name: r.ship_to_name, product_code: r.product_code, product_desc: r.product_desc,
        qty_ordered: r.qty_ordered, uploaded_at: uploadedAt, uploaded_by: profile?.id ?? null,
      }))
      await replaceSnapshot('rd_open_orders', companyId, payload)
      setLastOpenOrdersAt(uploadedAt)
      toast.success(`Open Sales Order report uploaded — ${payload.length} lines`)
      await runReconciliation()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to upload Open Sales Order report')
    } finally {
      setUploading(null)
    }
  }, [companyId, locationIdByShop, profile?.id, runReconciliation])

  const uploadOpenInvoices = useCallback(async (rows: Record<string, string>[]) => {
    if (!companyId) return
    setUploading('invoices')
    try {
      const parsed = parseOpenInvoicesXlsx(rows)
      const uploadedAt = new Date().toISOString()
      const payload = parsed.map((r) => ({
        company_id: companyId, location_id: r.shop_number ? locationIdByShop.get(r.shop_number) ?? null : null,
        sales_order_no: r.sales_order_no, customer_po_no: r.customer_po_no, invoice_no: r.invoice_no,
        order_date: r.order_date, ship_date: r.ship_date, invoice_date: r.invoice_date, invoice_due_date: r.invoice_due_date,
        ship_to_code: r.ship_to_code, ship_to_name: r.ship_to_name, product_code: r.product_code, product_desc: r.product_desc,
        qty_ordered: r.qty_ordered, qty_shipped: r.qty_shipped, gallons_ordered: r.gallons_ordered, gallons_shipped: r.gallons_shipped,
        uploaded_at: uploadedAt, uploaded_by: profile?.id ?? null,
      }))
      await replaceSnapshot('rd_open_invoices', companyId, payload)
      setLastOpenInvoicesAt(uploadedAt)
      toast.success(`Open Invoice report uploaded — ${payload.length} lines`)
      await runReconciliation()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to upload Open Invoice report')
    } finally {
      setUploading(null)
    }
  }, [companyId, locationIdByShop, profile?.id, runReconciliation])

  return { lastOpenOrdersAt, lastOpenInvoicesAt, uploading, reconciling, uploadOpenOrders, uploadOpenInvoices, runReconciliation }
}
