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

// Raw uploaded-report row shapes, as actually stored (confirmed against
// information_schema.columns) — used by RdReportsTab.tsx to browse what's
// currently in each snapshot table, separate from the reconciliation logic
// above that also reads them.
export interface RdOpenOrderRow {
  id: string; location_id: string | null; sales_order_no: string; customer_po_no: string | null
  order_date: string | null; order_type: string | null; warehouse_code: string | null
  ship_to_code: string | null; ship_to_name: string | null; product_code: string; product_desc: string | null
  qty_ordered: number | null; uploaded_at: string
}
export interface RdOpenInvoiceRow {
  id: string; location_id: string | null; sales_order_no: string; customer_po_no: string | null
  invoice_no: string | null; order_date: string | null; ship_date: string | null; invoice_date: string | null
  invoice_due_date: string | null; ship_to_code: string | null; ship_to_name: string | null
  product_code: string; product_desc: string | null
  qty_ordered: number | null; qty_shipped: number | null; gallons_ordered: number | null; gallons_shipped: number | null
  uploaded_at: string
}

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

// Accumulating history ledgers, separate from the two snapshot tables above
// (see migration 20260930au_rd_order_delivery_ledgers.sql's own header
// comment for why they can't be repurposed for this). Order ledger allows
// updates (a still-open sales order's qty/dates can genuinely change);
// delivery ledger is insert-only (ignoreDuplicates) since a shipped
// quantity should never be overwritten once invoiced.
async function upsertOrderLedger(companyId: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb().schema('inventory').from('rd_order_ledger')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'company_id,sales_order_no,product_code' })
    if (error) throw error
  }
}

async function insertDeliveryLedger(companyId: string, rows: Record<string, unknown>[]) {
  for (let i = 0; i < rows.length; i += 1000) {
    const { error } = await sb().schema('inventory').from('rd_delivery_ledger')
      .upsert(rows.slice(i, i + 1000), { onConflict: 'company_id,sales_order_no,product_code', ignoreDuplicates: true })
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

  // Browse what's currently in each snapshot table — backs RdReportsTab.tsx.
  // Both are small (a few thousand rows) relative to fetchAllRows' own
  // 5,000-row page, but paginated anyway rather than a bare .select('*') so
  // this keeps working correctly as either report grows.
  const fetchOpenOrders = useCallback(async (): Promise<RdOpenOrderRow[]> => {
    if (!companyId) return []
    return fetchAllRows<RdOpenOrderRow>('inventory', 'rd_open_orders', (q) => q.eq('company_id', companyId))
  }, [companyId])
  const fetchOpenInvoices = useCallback(async (): Promise<RdOpenInvoiceRow[]> => {
    if (!companyId) return []
    return fetchAllRows<RdOpenInvoiceRow>('inventory', 'rd_open_invoices', (q) => q.eq('company_id', companyId))
  }, [companyId])

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
      // rd_order_ledger's own unique key is (company_id, sales_order_no,
      // product_code) — one row per PO+product. The raw report can list the
      // same PO+product on more than one line (e.g. a split/backordered
      // quantity), which parsed 1:1 used to hand upsertOrderLedger two rows
      // targeting the same conflict key in one batch — Postgres refuses
      // that outright ("ON CONFLICT DO UPDATE command cannot affect row a
      // second time"), found live 2026-09-23 blocking every Open Sales
      // Order upload that happened to include a split line. Aggregated here
      // first (summing qty_ordered, since each line is a real slice of the
      // same still-open order) so the ledger always gets exactly one row
      // per key regardless of how many lines the report split it across.
      const ledgerByKey = new Map<string, { company_id: string; location_id: string | null; sales_order_no: string; product_code: string; customer_po_no: string | null; order_date: string | null; order_type: string | null; ship_to_name: string | null; product_desc: string | null; qty_ordered: number | null; last_updated_at: string }>()
      for (const r of parsed) {
        const key = `${r.sales_order_no}|${r.product_code}`
        const existing = ledgerByKey.get(key)
        if (existing) { existing.qty_ordered = Number(existing.qty_ordered ?? 0) + Number(r.qty_ordered ?? 0); continue }
        ledgerByKey.set(key, {
          company_id: companyId, location_id: r.shop_number ? locationIdByShop.get(r.shop_number) ?? null : null,
          sales_order_no: r.sales_order_no, product_code: r.product_code, customer_po_no: r.customer_po_no,
          order_date: r.order_date, order_type: r.order_type, ship_to_name: r.ship_to_name,
          product_desc: r.product_desc, qty_ordered: r.qty_ordered, last_updated_at: uploadedAt,
        })
      }
      await upsertOrderLedger(companyId, [...ledgerByKey.values()])
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
      // Same (company_id, sales_order_no, product_code) conflict key as the
      // order ledger above, and the same risk if a PO+product is split
      // across more than one invoice line within this same report — this
      // path uses ignoreDuplicates (Postgres's ON CONFLICT DO NOTHING)
      // rather than DO UPDATE, so it never actually THROWS the way
      // uploadOpenOrders did, but it would have silently kept only the
      // FIRST such line and dropped the rest of that split shipment's real
      // qty_shipped/gallons_shipped. Aggregated here first for the same
      // reason, before ignoreDuplicates does its real job of protecting an
      // already-recorded shipment from being overwritten by a LATER
      // re-upload of the same PO+product.
      const invLedgerByKey = new Map<string, { company_id: string; location_id: string | null; sales_order_no: string; product_code: string; customer_po_no: string | null; invoice_no: string | null; order_date: string | null; invoice_date: string | null; ship_to_name: string | null; product_desc: string | null; qty_ordered: number | null; qty_shipped: number | null; gallons_ordered: number | null; gallons_shipped: number | null }>()
      for (const r of parsed) {
        const key = `${r.sales_order_no}|${r.product_code}`
        const existing = invLedgerByKey.get(key)
        if (existing) {
          existing.qty_ordered = Number(existing.qty_ordered ?? 0) + Number(r.qty_ordered ?? 0)
          existing.qty_shipped = Number(existing.qty_shipped ?? 0) + Number(r.qty_shipped ?? 0)
          existing.gallons_ordered = Number(existing.gallons_ordered ?? 0) + Number(r.gallons_ordered ?? 0)
          existing.gallons_shipped = Number(existing.gallons_shipped ?? 0) + Number(r.gallons_shipped ?? 0)
          continue
        }
        invLedgerByKey.set(key, {
          company_id: companyId, location_id: r.shop_number ? locationIdByShop.get(r.shop_number) ?? null : null,
          sales_order_no: r.sales_order_no, product_code: r.product_code, customer_po_no: r.customer_po_no,
          invoice_no: r.invoice_no, order_date: r.order_date, invoice_date: r.invoice_date,
          ship_to_name: r.ship_to_name, product_desc: r.product_desc, qty_ordered: r.qty_ordered,
          qty_shipped: r.qty_shipped, gallons_ordered: r.gallons_ordered, gallons_shipped: r.gallons_shipped,
        })
      }
      await insertDeliveryLedger(companyId, [...invLedgerByKey.values()])
      setLastOpenInvoicesAt(uploadedAt)
      toast.success(`Open Invoice report uploaded — ${payload.length} lines`)
      await runReconciliation()
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to upload Open Invoice report')
    } finally {
      setUploading(null)
    }
  }, [companyId, locationIdByShop, profile?.id, runReconciliation])

  // Read access to the two accumulating ledgers, by shop+product — backs
  // "we should be able to access these two tables after we upload the
  // data." Not wired into a dedicated page yet (no specific display was
  // requested); callers can key off location_id/product_code to show this
  // wherever it's actually needed (e.g. a shop's Order Config or Product
  // Sales History).
  const fetchRdProductHistory = useCallback(async (): Promise<RdProductHistoryRow[]> => {
    const [{ data: ordered, error: orderedErr }, { data: delivered, error: deliveredErr }] = await Promise.all([
      sb().rpc('get_rd_last_ordered_by_shop_product'),
      sb().rpc('get_rd_last_delivered_by_shop_product'),
    ])
    if (orderedErr) throw orderedErr
    if (deliveredErr) throw deliveredErr
    const byKey = new Map<string, RdProductHistoryRow>()
    const keyOf = (locationId: string | null, productCode: string) => `${locationId ?? ''}|${productCode}`
    for (const o of (ordered ?? []) as any[]) {
      byKey.set(keyOf(o.location_id, o.product_code), {
        location_id: o.location_id, product_code: o.product_code,
        last_order_date: o.last_order_date, last_qty_ordered: o.last_qty_ordered, last_order_sales_order_no: o.sales_order_no,
        last_invoice_date: null, last_qty_shipped: null, last_delivery_sales_order_no: null,
      })
    }
    for (const d of (delivered ?? []) as any[]) {
      const key = keyOf(d.location_id, d.product_code)
      const existing = byKey.get(key)
      if (existing) {
        existing.last_invoice_date = d.last_invoice_date
        existing.last_qty_shipped = d.last_qty_shipped
        existing.last_delivery_sales_order_no = d.sales_order_no
      } else {
        byKey.set(key, {
          location_id: d.location_id, product_code: d.product_code,
          last_order_date: null, last_qty_ordered: null, last_order_sales_order_no: null,
          last_invoice_date: d.last_invoice_date, last_qty_shipped: d.last_qty_shipped, last_delivery_sales_order_no: d.sales_order_no,
        })
      }
    }
    return Array.from(byKey.values())
  }, [])

  return {
    lastOpenOrdersAt, lastOpenInvoicesAt, uploading, reconciling, uploadOpenOrders, uploadOpenInvoices, runReconciliation,
    fetchRdProductHistory, fetchOpenOrders, fetchOpenInvoices,
  }
}

export interface RdProductHistoryRow {
  location_id: string | null
  product_code: string
  last_order_date: string | null
  last_qty_ordered: number | null
  last_order_sales_order_no: string | null
  last_invoice_date: string | null
  last_qty_shipped: number | null
  last_delivery_sales_order_no: string | null
}
