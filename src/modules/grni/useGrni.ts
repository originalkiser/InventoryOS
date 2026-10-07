// Data layer for the GRNI module: runs, their snapshotted RelaDyne reports, the price list, shop compliance, and Droptop receipts.
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { parseOpenInvoicesXlsx, parseOpenOrdersXlsx } from '@/modules/orders-v2/rdReconciliation'
import {
  calcGrni, computeCompliance, monthEnd, parsePo, receiptKey,
  type GrniCompliance, type GrniInvoice, type GrniOrder, type GrniParams, type GrniPrice,
} from './grniCalc'

const sb = () => supabase as any

export interface GrniRun {
  id: string; period_month: string; cutoff_date: string
  bulk_pct: number; package_pct: number; prior_pct: number; compliance_threshold: number
  orders_uploaded_at: string | null; invoices_uploaded_at: string | null; notes: string | null; created_at: string
}
export interface ComplianceRow { shop: number; shop_label: string | null; invoiced_gal: number | null; received_gal: number | null; pct: number | null; source: string; override: 'standard' | 'receipts' | null }

async function pageAll<T>(build: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length < pageSize) break
  }
  return out
}

async function inChunks<T>(table: string, select: string, column: string, values: string[], chunk = 150): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += chunk) {
    const slice = values.slice(i, i + chunk)
    out.push(...await pageAll<T>(() => sb().schema('inventory').from(table).select(select).in(column, slice).order('id', { ascending: true })))
  }
  return out
}

/** Units Droptop shows as received per PO + our product id (gallons for bulk POs, packages otherwise). */
async function fetchReceipts(pos: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  const unique = [...new Set(pos.filter(Boolean))]
  if (!unique.length) return map
  const pOs = await inChunks<{ id: string; custom_po_id: string }>('droptop_purchase_orders', 'id, custom_po_id', 'custom_po_id', unique)
  const poById = new Map(pOs.map((p) => [p.id, p.custom_po_id]))
  const items = await inChunks<{ purchase_order_id: string; product_id: string; received_quantity: number | null }>(
    'droptop_purchase_order_items', 'id, purchase_order_id, product_id, received_quantity', 'purchase_order_id', [...poById.keys()], 100)
  for (const it of items) {
    const po = poById.get(it.purchase_order_id)
    if (!po || !it.product_id) continue
    const k = receiptKey(po, it.product_id)
    map.set(k, (map.get(k) ?? 0) + (Number(it.received_quantity) || 0))
  }
  return map
}

const chunked = <T,>(rows: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out }
const lastDayLag = (periodMonth: string, lag: number) => {
  const d = new Date(`${monthEnd(periodMonth)}T00:00:00`); d.setDate(d.getDate() - lag)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
export const defaultCutoff = (periodMonth: string) => lastDayLag(periodMonth, 4)

export function useGrni() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const [runs, setRuns] = useState<GrniRun[]>([])
  const [runId, setRunId] = useState<string | null>(null)
  const [loadingRuns, setLoadingRuns] = useState(true)
  const [loadingRun, setLoadingRun] = useState(false)
  const [orders, setOrders] = useState<GrniOrder[]>([])
  const [invoices, setInvoices] = useState<GrniInvoice[]>([])
  const [prices, setPrices] = useState<GrniPrice[]>([])
  const [compliance, setCompliance] = useState<ComplianceRow[]>([])
  const [receipts, setReceipts] = useState<Map<string, number>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)

  const run = useMemo(() => runs.find((r) => r.id === runId) ?? null, [runs, runId])

  const loadRuns = useCallback(async (select?: string) => {
    if (!companyId) return
    setLoadingRuns(true)
    const { data, error } = await sb().schema('inventory').from('grni_runs').select('*').eq('company_id', companyId).order('period_month', { ascending: false }).order('created_at', { ascending: false })
    if (error) toast.error(error.message)
    const list = (data ?? []) as GrniRun[]
    setRuns(list)
    setRunId((cur) => select ?? (cur && list.some((r) => r.id === cur) ? cur : list[0]?.id ?? null))
    setLoadingRuns(false)
  }, [companyId])
  useEffect(() => { void loadRuns() }, [loadRuns])

  const loadPrices = useCallback(async () => {
    if (!companyId) return
    try {
      const rows = await pageAll<any>(() => sb().schema('inventory').from('grni_product_prices').select('*').eq('company_id', companyId).order('id', { ascending: true }))
      setPrices(rows.map((r) => ({ itemCode: r.item_code, itemId: r.item_id, uom: r.uom, pkgQtyGal: Number(r.pkg_qty_gal), priceGal: Number(r.price_gal), effectiveFrom: r.effective_from })))
    } catch (e: any) { toast.error(e?.message ?? 'Could not load the price list') }
  }, [companyId])
  useEffect(() => { void loadPrices() }, [loadPrices])

  const loadRunData = useCallback(async (id: string) => {
    setLoadingRun(true)
    try {
      const [o, i, c] = await Promise.all([
        pageAll<any>(() => sb().schema('inventory').from('grni_open_orders').select('*').eq('run_id', id).order('id', { ascending: true })),
        pageAll<any>(() => sb().schema('inventory').from('grni_open_invoices').select('*').eq('run_id', id).order('id', { ascending: true })),
        pageAll<any>(() => sb().schema('inventory').from('grni_shop_compliance').select('*').eq('run_id', id).order('shop', { ascending: true })),
      ])
      const ords: GrniOrder[] = o.map((r) => ({ id: r.id, orderDate: r.order_date, po: r.customer_po_no ?? '', shipTo: r.ship_to_name ?? '', shop: r.shop, code: r.product_code, desc: r.product_desc ?? '', qty: Number(r.qty_ordered) || 0 }))
      const invs: GrniInvoice[] = i.map((r) => ({ id: r.id, invoiceNo: r.invoice_no ?? '', po: r.customer_po_no ?? '', orderDate: r.order_date, shipDate: r.ship_date, invoiceDate: r.invoice_date, shop: r.shop, code: r.product_code, desc: r.product_desc ?? '', gallonsShipped: Number(r.gallons_shipped) || 0 }))
      setOrders(ords); setInvoices(invs)
      setCompliance(c.map((r) => ({ shop: r.shop, shop_label: r.shop_label, invoiced_gal: r.invoiced_gal, received_gal: r.received_gal, pct: r.pct == null ? null : Number(r.pct), source: r.source, override: r.override })))
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not load the run')
    }
    setLoadingRun(false)
  }, [])
  useEffect(() => { if (runId) void loadRunData(runId); else { setOrders([]); setInvoices([]); setCompliance([]) } }, [runId, loadRunData])

  const params: GrniParams | null = useMemo(() => run ? {
    periodStart: run.period_month, cutoff: run.cutoff_date,
    bulkPct: Number(run.bulk_pct), packagePct: Number(run.package_pct), priorPct: Number(run.prior_pct), threshold: Number(run.compliance_threshold),
  } : null, [run])

  // Receipts from Droptop for the POs in the run's period (orders and invoices alike).
  const periodPos = useMemo(() => {
    if (!params) return []
    const end = monthEnd(params.periodStart)
    const set = new Set<string>()
    for (const x of [...orders.map((o) => ({ po: o.po, d: o.orderDate })), ...invoices.map((i) => ({ po: i.po, d: i.orderDate }))]) {
      const date = parsePo(x.po).date ?? x.d
      if (x.po && date && date >= params.periodStart && date <= end) set.add(x.po)
    }
    return [...set]
  }, [params, orders, invoices])
  const periodKey = periodPos.length + ':' + (periodPos[0] ?? '') + ':' + (periodPos[periodPos.length - 1] ?? '')
  const [receiptsLoading, setReceiptsLoading] = useState(false)
  const refreshReceipts = useCallback(async () => {
    setReceiptsLoading(true)
    try { setReceipts(await fetchReceipts(periodPos)) } catch (e: any) { toast.error(e?.message ?? 'Could not load Droptop receipts') }
    setReceiptsLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodKey])
  useEffect(() => { if (periodPos.length) void refreshReceipts(); else setReceipts(new Map()) }, [periodKey, refreshReceipts, periodPos.length])

  const result = useMemo(() => {
    if (!params) return null
    const comp: GrniCompliance[] = compliance.map((c) => ({ shop: c.shop, pct: c.pct, override: c.override }))
    return calcGrni({ params, orders, invoices, prices, receipts, compliance: comp })
  }, [params, orders, invoices, prices, receipts, compliance])

  // ── actions ───────────────────────────────────────────────────────────────────────────────────────────────────────

  async function createRun(periodMonth: string, cutoff: string): Promise<boolean> {
    if (!companyId) return false
    const prev = runs[0]
    const { data, error } = await sb().schema('inventory').from('grni_runs').insert({
      company_id: companyId, period_month: periodMonth, cutoff_date: cutoff, created_by: userId,
      ...(prev ? { bulk_pct: prev.bulk_pct, package_pct: prev.package_pct, prior_pct: prev.prior_pct, compliance_threshold: prev.compliance_threshold } : {}),
    }).select().single()
    if (error) { toast.error(error.message); return false }
    toast.success('Run created — upload the two RelaDyne reports next')
    await loadRuns((data as GrniRun).id)
    return true
  }

  async function updateRun(patch: Partial<Pick<GrniRun, 'cutoff_date' | 'bulk_pct' | 'package_pct' | 'prior_pct' | 'compliance_threshold' | 'notes'>>) {
    if (!runId) return
    const { error } = await sb().schema('inventory').from('grni_runs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', runId)
    if (error) { toast.error(error.message); return }
    setRuns((rs) => rs.map((r) => (r.id === runId ? { ...r, ...patch } : r)))
    toast.success('Saved')
  }

  async function deleteRun() {
    if (!runId) return
    setBusy('delete')
    for (const t of ['grni_open_orders', 'grni_open_invoices', 'grni_shop_compliance']) await sb().schema('inventory').from(t).delete().eq('run_id', runId)
    const { error } = await sb().schema('inventory').from('grni_runs').delete().eq('id', runId)
    setBusy(null)
    if (error) { toast.error(error.message); return }
    toast.success('Run deleted')
    await loadRuns()
  }

  async function uploadOrders(rows: Record<string, string>[]) {
    if (!companyId || !runId) return
    const parsed = parseOpenOrdersXlsx(rows)
    if (!parsed.length) { toast.error('No order lines found — is this the Open Sales Order report?'); return }
    setBusy('orders')
    const del = await sb().schema('inventory').from('grni_open_orders').delete().eq('run_id', runId)
    if (del.error) { setBusy(null); toast.error(del.error.message); return }
    const payload = parsed.map((r) => ({
      run_id: runId, company_id: companyId, order_date: r.order_date, sales_order_no: r.sales_order_no, customer_po_no: r.customer_po_no,
      ship_to_name: r.ship_to_name, shop: r.shop_number ? Number(r.shop_number) : (parsePo(r.customer_po_no).shop ?? null),
      product_code: r.product_code, product_desc: r.product_desc, qty_ordered: r.qty_ordered,
    }))
    for (const c of chunked(payload, 500)) {
      const { error } = await sb().schema('inventory').from('grni_open_orders').insert(c)
      if (error) { setBusy(null); toast.error(error.message); return }
    }
    await sb().schema('inventory').from('grni_runs').update({ orders_uploaded_at: new Date().toISOString() }).eq('id', runId)
    setBusy(null)
    toast.success(`Loaded ${payload.length.toLocaleString()} open order lines`)
    await loadRuns(runId); await loadRunData(runId)
  }

  async function uploadInvoices(rows: Record<string, string>[]) {
    if (!companyId || !runId) return
    const parsed = parseOpenInvoicesXlsx(rows)
    if (!parsed.length) { toast.error('No invoice lines found — is this the Open Invoice report?'); return }
    setBusy('invoices')
    const del = await sb().schema('inventory').from('grni_open_invoices').delete().eq('run_id', runId)
    if (del.error) { setBusy(null); toast.error(del.error.message); return }
    const payload = parsed.map((r) => ({
      run_id: runId, company_id: companyId, invoice_no: r.invoice_no, sales_order_no: r.sales_order_no, customer_po_no: r.customer_po_no,
      order_date: r.order_date, ship_date: r.ship_date, invoice_date: r.invoice_date, ship_to_name: r.ship_to_name,
      shop: r.shop_number ? Number(r.shop_number) : (parsePo(r.customer_po_no).shop ?? null),
      product_code: r.product_code, product_desc: r.product_desc, qty_ordered: r.qty_ordered, qty_shipped: r.qty_shipped,
      gallons_ordered: r.gallons_ordered, gallons_shipped: r.gallons_shipped,
    }))
    for (const c of chunked(payload, 500)) {
      const { error } = await sb().schema('inventory').from('grni_open_invoices').insert(c)
      if (error) { setBusy(null); toast.error(error.message); return }
    }
    await sb().schema('inventory').from('grni_runs').update({ invoices_uploaded_at: new Date().toISOString() }).eq('id', runId)
    setBusy(null)
    toast.success(`Loaded ${payload.length.toLocaleString()} invoice lines`)
    await loadRuns(runId); await loadRunData(runId)
  }

  /** The RelaDyne price list (same columns as the workbook's Products sheets), effective from a date. */
  async function uploadPrices(rows: Record<string, string>[], effectiveFrom: string) {
    if (!companyId) return
    const get = (r: Record<string, string>, ...names: string[]) => { for (const n of names) { const k = Object.keys(r).find((h) => h.trim().toLowerCase() === n); if (k && r[k] !== '') return r[k] } return '' }
    const payload = rows.map((r) => ({
      company_id: companyId, item_code: get(r, 'reladyne_item_code', 'item_code', 'productcode'), item_id: get(r, 'itemid', 'item_id') || null,
      description: get(r, 'item_description', 'description') || null, uom: get(r, 'uom') || null, category: get(r, 'item_category_code') || null,
      pkg_qty_gal: Number(get(r, 'pkg_qty_gal')), price_gal: Number(get(r, 'price_gal')), effective_from: effectiveFrom,
    })).filter((r) => r.item_code && Number.isFinite(r.pkg_qty_gal) && Number.isFinite(r.price_gal) && r.pkg_qty_gal > 0)
    const dedup = new Map(payload.map((p) => [p.item_code, p]))
    if (!dedup.size) { toast.error('No usable rows — expected reladyne_item_code, itemId, pkg_qty_gal and price_gal columns'); return }
    setBusy('prices')
    for (const c of chunked([...dedup.values()], 500)) {
      const { error } = await sb().schema('inventory').from('grni_product_prices').upsert(c, { onConflict: 'company_id,item_code,effective_from' })
      if (error) { setBusy(null); toast.error(error.message); return }
    }
    setBusy(null)
    toast.success(`Saved ${dedup.size} prices effective ${effectiveFrom}`)
    await loadPrices()
  }

  /** Shop compliance computed from Droptop receipts vs the invoice report (keeps any manual override). */
  async function recomputeCompliance() {
    if (!companyId || !runId || !params) return
    setBusy('compliance')
    try {
      const rec = await fetchReceipts(periodPos)
      setReceipts(rec)
      const rows = computeCompliance({ params, invoices, prices, receipts: rec })
      if (!rows.length) { toast('No invoices for this period to compare with yet'); setBusy(null); return }
      const payload = rows.map((r) => ({ run_id: runId, company_id: companyId, shop: r.shop, invoiced_gal: r.invoicedGal, received_gal: r.receivedGal, pct: r.pct, source: 'computed' }))
      for (const c of chunked(payload, 500)) {
        const { error } = await sb().schema('inventory').from('grni_shop_compliance').upsert(c, { onConflict: 'run_id,shop' })
        if (error) throw error
      }
      toast.success(`Compliance calculated for ${rows.length} shops`)
      await loadRunData(runId)
    } catch (e: any) { toast.error(e?.message ?? 'Could not calculate compliance') }
    setBusy(null)
  }

  /** The Power BI "PO Match" export: one row per shop with PO Number = Total and a % Receipt of Invoice. */
  async function uploadCompliance(rows: Record<string, string>[]) {
    if (!companyId || !runId) return
    const find = (r: Record<string, string>, re: RegExp) => Object.keys(r).find((k) => re.test(k.trim()))
    const out = new Map<number, { shop_label: string; pct: number }>()
    for (const r of rows) {
      const shopKey = find(r, /^shop/i), poKey = find(r, /po number/i), pctKey = find(r, /%\s*receipt/i)
      if (!shopKey || !pctKey) continue
      if (poKey && String(r[poKey]).trim().toLowerCase() !== 'total') continue
      const label = String(r[shopKey]).trim()
      const shop = Number(label.match(/^\d+/)?.[0])
      let pct = Number(String(r[pctKey]).replace('%', ''))
      if (!Number.isFinite(shop) || !Number.isFinite(pct)) continue
      if (String(r[pctKey]).includes('%') || pct > 5) pct = pct / 100
      out.set(shop, { shop_label: label, pct })
    }
    if (!out.size) { toast.error('No shop totals found — expected the PO Match export (Shop # - City, PO Number = Total, % Receipt of Invoice)'); return }
    setBusy('compliance')
    const payload = [...out.entries()].map(([shop, v]) => ({ run_id: runId, company_id: companyId, shop, shop_label: v.shop_label, pct: v.pct, source: 'upload' }))
    for (const c of chunked(payload, 500)) {
      const { error } = await sb().schema('inventory').from('grni_shop_compliance').upsert(c, { onConflict: 'run_id,shop' })
      if (error) { setBusy(null); toast.error(error.message); return }
    }
    setBusy(null)
    toast.success(`Loaded compliance for ${payload.length} shops`)
    await loadRunData(runId)
  }

  async function setOverride(shop: number, override: 'standard' | 'receipts' | null) {
    if (!companyId || !runId) return
    const { error } = await sb().schema('inventory').from('grni_shop_compliance')
      .upsert({ run_id: runId, company_id: companyId, shop, override }, { onConflict: 'run_id,shop' })
    if (error) { toast.error(error.message); return }
    setCompliance((cs) => (cs.some((c) => c.shop === shop)
      ? cs.map((c) => (c.shop === shop ? { ...c, override } : c))
      : [...cs, { shop, shop_label: null, invoiced_gal: null, received_gal: null, pct: null, source: 'computed', override }]))
  }

  return {
    runs, run, runId, setRunId, loadingRuns, loadingRun, busy, receiptsLoading,
    orders, invoices, prices, compliance, receipts, result, params,
    createRun, updateRun, deleteRun, uploadOrders, uploadInvoices, uploadPrices, recomputeCompliance, uploadCompliance, setOverride, refreshReceipts,
  }
}
