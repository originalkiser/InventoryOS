// Data layer for the COGS Price Check: the dated price list, saved checks, the uploaded Droptop cost ledger, starting on hands and
// the coverage check that finds shop-days with sales in SB Net but no cost rows yet.
import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { excelSerialToIso } from '@/modules/orders-v2/rdReconciliation'
import { poOrderDateFromName, runCheck, type CheckParams, type LedgerRow, type PriceEntry, type StartBalance, type TxType } from './cogsCalc'

const sb = () => supabase as any

export interface PriceRow { id: string; vendor: string; product_id: string; price_per_qt: number; start_date: string | null; end_date: string | null; note: string | null }
export interface CogsCheck {
  id: string; name: string; vendor: string; start_date: string; end_date: string
  sell_through: boolean; start_balance_date: string | null; adjust_unmatched: boolean; tolerance: number; notes: string | null
}
export interface CoverageDay { date: string; selling: number; withCosts: number; missing: { location_id: string; products: string[] }[] }

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
const chunked = <T,>(rows: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out }
const pk = (s: string) => s.trim().toLowerCase()
const plusDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

/** Finds a column by loose header match; returns the cell text (or ''). */
function headerFinder(rows: Record<string, string>[]) {
  const keys = Object.keys(rows[0] ?? {})
  return (...patterns: RegExp[]) => {
    for (const p of patterns) { const k = keys.find((h) => p.test(h.trim())); if (k) return k }
    return null
  }
}
const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : NaN }
const shopNumber = (v: unknown) => { const m = /^\s*0*(\d+)/.exec(String(v ?? '')); return m ? m[1] : null }

export function useCogs() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const loc = useLocations()

  const [prices, setPrices] = useState<PriceRow[]>([])
  const [checks, setChecks] = useState<CogsCheck[]>([])
  const [loading, setLoading] = useState(true)
  const [checkId, setCheckId] = useState<string | null>(null)
  const [ledger, setLedger] = useState<LedgerRow[]>([])
  const [poDates, setPoDates] = useState<Map<string, string>>(new Map())
  const [startBalances, setStartBalances] = useState<StartBalance[]>([])
  const [balanceDates, setBalanceDates] = useState<string[]>([])
  const [loadingData, setLoadingData] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [coverage, setCoverage] = useState<CoverageDay[] | null>(null)
  const [loadingCoverage, setLoadingCoverage] = useState(false)

  const check = useMemo(() => checks.find((c) => c.id === checkId) ?? null, [checks, checkId])
  const vendors = useMemo(() => [...new Set(prices.map((p) => p.vendor))].sort(), [prices])

  const loadPrices = useCallback(async () => {
    if (!companyId) return
    const rows = await pageAll<PriceRow>(() => sb().schema('inventory').from('cogs_price_entries').select('id, vendor, product_id, price_per_qt, start_date, end_date, note').eq('company_id', companyId).order('vendor').order('product_id').order('start_date', { ascending: true, nullsFirst: true }))
    setPrices(rows.map((r) => ({ ...r, price_per_qt: Number(r.price_per_qt) })))
  }, [companyId])

  const loadChecks = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await sb().schema('inventory').from('cogs_checks').select('*').eq('company_id', companyId).order('created_at', { ascending: false })
    if (error) { toast.error(error.message); return }
    const rows = ((data ?? []) as any[]).map((r) => ({ ...r, tolerance: Number(r.tolerance) })) as CogsCheck[]
    setChecks(rows)
    setCheckId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? null))
  }, [companyId])

  const loadBalanceDates = useCallback(async () => {
    if (!companyId) return
    const { data } = await sb().schema('inventory').from('cogs_start_balances').select('as_of_date').eq('company_id', companyId).order('as_of_date', { ascending: false }).limit(2000)
    setBalanceDates([...new Set(((data ?? []) as { as_of_date: string }[]).map((r) => r.as_of_date))])
  }, [companyId])

  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    Promise.all([loadPrices(), loadChecks(), loadBalanceDates()]).catch((e) => toast.error(e?.message ?? 'Could not load')).finally(() => setLoading(false))
  }, [companyId, loadPrices, loadChecks, loadBalanceDates])

  /** Ledger rows, PO order dates and starting balances for the selected check. */
  const loadCheckData = useCallback(async () => {
    if (!companyId || !check) { setLedger([]); setStartBalances([]); return }
    setLoadingData(true)
    try {
      const rows = await pageAll<any>(() => sb().schema('inventory').from('cogs_ledger')
        .select('id, location_id, change_date, change_type, product_id, po_custom_id, qty_change, total_cost')
        .eq('company_id', companyId).gte('change_date', check.start_date).lte('change_date', check.end_date).order('id', { ascending: true }))
      const mapped: LedgerRow[] = rows.map((r) => ({ ...r, qty_change: Number(r.qty_change), total_cost: Number(r.total_cost) }))
      setLedger(mapped)

      // Receipts whose PO number doesn't carry our order date fall back to Droptop's own PO record.
      const need = [...new Set(mapped.filter((r) => r.change_type === 'receipt' && r.po_custom_id && !poOrderDateFromName(r.po_custom_id)).map((r) => r.po_custom_id))]
      const dates = new Map<string, string>()
      for (const c of chunked(need, 150)) {
        const { data } = await sb().schema('inventory').from('droptop_purchase_orders').select('custom_po_id, created_timestamp').eq('company_id', companyId).in('custom_po_id', c)
        for (const p of (data ?? []) as { custom_po_id: string; created_timestamp: string | null }[]) {
          if (p.custom_po_id && p.created_timestamp && !dates.has(p.custom_po_id)) dates.set(p.custom_po_id, p.created_timestamp.slice(0, 10))
        }
      }
      setPoDates(dates)

      if (check.sell_through && check.start_balance_date) {
        const bal = await pageAll<any>(() => sb().schema('inventory').from('cogs_start_balances').select('location_id, product_id, on_hand_qty').eq('company_id', companyId).eq('as_of_date', check.start_balance_date).order('id', { ascending: true }))
        setStartBalances(bal.map((b) => ({ ...b, on_hand_qty: Number(b.on_hand_qty) })))
      } else setStartBalances([])
    } catch (e: any) { toast.error(e?.message ?? 'Could not load the check data') }
    setLoadingData(false)
  }, [companyId, check])

  useEffect(() => { void loadCheckData() }, [loadCheckData])
  useEffect(() => { setCoverage(null) }, [checkId])

  const vendorEntries = useMemo<PriceEntry[]>(() => (check ? prices.filter((p) => pk(p.vendor) === pk(check.vendor)) : []), [prices, check])

  const result = useMemo(() => {
    if (!check) return null
    const params: CheckParams = { start: check.start_date, end: check.end_date, sellThrough: check.sell_through, adjustUnmatched: check.adjust_unmatched, tolerance: check.tolerance }
    return runCheck({ params, ledger, prices: vendorEntries, poDates, startBalances })
  }, [check, ledger, vendorEntries, poDates, startBalances])

  // ── checks ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async function saveCheck(draft: Omit<CogsCheck, 'id'> & { id?: string }): Promise<boolean> {
    if (!companyId) return false
    const payload = { company_id: companyId, name: draft.name, vendor: draft.vendor, start_date: draft.start_date, end_date: draft.end_date, sell_through: draft.sell_through, start_balance_date: draft.sell_through ? draft.start_balance_date : null, adjust_unmatched: draft.adjust_unmatched, tolerance: draft.tolerance, notes: draft.notes, updated_at: new Date().toISOString() }
    const q = draft.id
      ? sb().schema('inventory').from('cogs_checks').update(payload).eq('id', draft.id).select('id').single()
      : sb().schema('inventory').from('cogs_checks').insert({ ...payload, created_by: userId }).select('id').single()
    const { data, error } = await q
    if (error) { toast.error(error.message); return false }
    await loadChecks()
    setCheckId(data.id)
    return true
  }
  async function deleteCheck(id: string) {
    const { error } = await sb().schema('inventory').from('cogs_checks').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setCheckId(null)
    await loadChecks()
  }

  // ── prices ──────────────────────────────────────────────────────────────────────────────────────────────────────
  async function savePrice(p: Omit<PriceRow, 'id'> & { id?: string }): Promise<boolean> {
    if (!companyId) return false
    if (p.start_date && p.end_date && p.end_date < p.start_date) { toast.error('The end date is before the start date'); return false }
    const payload = { company_id: companyId, vendor: p.vendor.trim(), product_id: p.product_id.trim(), price_per_qt: p.price_per_qt, start_date: p.start_date || null, end_date: p.end_date || null, note: p.note || null, updated_at: new Date().toISOString() }
    const { error } = p.id
      ? await sb().schema('inventory').from('cogs_price_entries').update(payload).eq('id', p.id)
      : await sb().schema('inventory').from('cogs_price_entries').insert({ ...payload, created_by: userId })
    if (error) { toast.error(error.message); return false }
    await loadPrices()
    return true
  }
  async function deletePrice(id: string) {
    const { error } = await sb().schema('inventory').from('cogs_price_entries').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    await loadPrices()
  }

  /** A price file: product + price per quart (or per gallon) with optional start/end dates and vendor. With no dates in the file,
   *  `effectiveFrom` applies and each product's current open-ended price is ended the day before (the usual back-dated change). */
  async function uploadPrices(rows: Record<string, string>[], opts: { vendor: string; effectiveFrom: string; endCurrent: boolean; mode: 'new' | 'old' }) {
    if (!companyId || !rows.length) return
    const find = headerFinder(rows)
    const kProduct = find(/^item\s*_?id$/i, /^product\s*_?id$/i, /^product$/i, /^item$/i)
    const kPpq = find(/^ppq(t)?$/i, /price\s*per\s*q(ua)?r?t/i, /^price_per_qt$/i, /\$\s*\/\s*qt/i)
    const kGal = find(/^price_gal$/i, /price\s*per\s*gal/i)
    const kStart = find(/^(start|effective)/i)
    const kEnd = find(/^end/i)
    const kVendor = find(/^vendor$/i)
    // The workbook's price sheets tag Valvoline rows by writing 'Valvoline' where RelaDyne's item code goes.
    const kCode = find(/^reladyne_item_code$/i)
    if (!kProduct || (!kPpq && !kGal)) { toast.error('Expected a product id column (itemId / Product ID) and a price per quart (PPQ) or price per gallon column'); return }
    const hasDates = !!kStart || !!kEnd
    const parsed = rows.map((r) => {
      const ppq = kPpq ? num(r[kPpq]) : num(r[kGal!]) / 4
      const start = kStart ? (r[kStart] ? excelSerialToIso(r[kStart]) : null) : hasDates ? null : opts.mode === 'new' ? opts.effectiveFrom : null
      const end = kEnd ? (r[kEnd] ? excelSerialToIso(r[kEnd]) : null) : hasDates ? null : opts.mode === 'old' ? opts.effectiveFrom : null
      return { product_id: String(r[kProduct] ?? '').trim(), vendor: ((kVendor && r[kVendor]) || (kCode && /^valvoline$/i.test(String(r[kCode] ?? '').trim()) ? 'Valvoline' : '') || opts.vendor).trim(), price_per_qt: ppq, start_date: start, end_date: end }
    }).filter((r) => r.product_id && r.vendor && Number.isFinite(r.price_per_qt) && r.price_per_qt > 0)
    if (!parsed.length) { toast.error('No usable price rows found'); return }
    setBusy('prices')
    try {
      if (opts.mode === 'new' && opts.endCurrent && !hasDates) {
        const eff = opts.effectiveFrom
        const ids = prices.filter((p) => parsed.some((n) => pk(n.vendor) === pk(p.vendor) && pk(n.product_id) === pk(p.product_id)) && !p.end_date && (!p.start_date || p.start_date < eff)).map((p) => p.id)
        for (const c of chunked(ids, 100)) {
          const { error } = await sb().schema('inventory').from('cogs_price_entries').update({ end_date: plusDays(eff, -1), updated_at: new Date().toISOString() }).in('id', c)
          if (error) throw error
        }
      }
      for (const c of chunked(parsed.map((p) => ({ ...p, company_id: companyId, created_by: userId })), 500)) {
        const { error } = await sb().schema('inventory').from('cogs_price_entries').insert(c)
        if (error) throw error
      }
      toast.success(`Added ${parsed.length} price${parsed.length === 1 ? '' : 's'}`)
      await loadPrices()
    } catch (e: any) { toast.error(e?.message ?? 'Price upload failed') }
    setBusy(null)
  }

  // ── ledger (Droptop inventory change detail) ───────────────────────────────────────────────────────────────────
  /** The Power BI inventory-change export: Shop # - City, Date, Change Type, Product Id, PO Custom Id, UOM, Qty Change, Total Cost. */
  async function uploadLedger(rows: Record<string, string>[], keepEveryProduct: boolean) {
    if (!companyId || !rows.length) return
    const find = headerFinder(rows)
    const kShop = find(/^shop/i, /^operation/i, /^location/i)
    const kDate = find(/^date/i)
    const kType = find(/change\s*type/i, /^type$/i)
    const kProduct = find(/^product\s*id/i, /^itemid$/i)
    const kPo = find(/po\s*custom/i, /^po/i)
    const kUom = find(/^uom$/i)
    const kQty = find(/^qty/i, /quantity\s*change/i)
    const kCost = find(/^total\s*cost/i)
    if (!kShop || !kDate || !kType || !kProduct || !kQty || !kCost) { toast.error('Expected columns: Shop # - City, Date, Change Type, Product Id, Qty Change and Total Cost'); return }
    setBusy('ledger')
    try {
      const listed = new Set(prices.map((p) => pk(p.product_id)))
      const agg = new Map<string, { company_id: string; location_id: string; change_date: string; change_type: TxType; product_id: string; po_custom_id: string; uom: string | null; qty_change: number; total_cost: number }>()
      let notListed = 0, unknownShop = 0, badRow = 0, otherType = 0
      const unknownShops = new Set<string>()
      for (const r of rows) {
        const t = String(r[kType] ?? '').toLowerCase()
        const type: TxType | null = t.includes('sale') ? 'sale' : t.includes('receiv') ? 'receipt' : t.includes('adjust') ? 'adjustment' : null
        if (!type) { otherType++; continue }
        const product = String(r[kProduct] ?? '').trim()
        if (!product) { badRow++; continue }
        if (!keepEveryProduct && !listed.has(pk(product))) { notListed++; continue }
        const date = excelSerialToIso(r[kDate]); const qty = num(r[kQty]); const cost = num(r[kCost])
        if (!date || !Number.isFinite(qty) || !Number.isFinite(cost)) { badRow++; continue }
        const n = shopNumber(r[kShop]); const locationId = n ? loc.resolveId(n) : null
        if (!locationId) { unknownShop++; unknownShops.add(String(r[kShop] ?? '').trim()); continue }
        const po = kPo ? String(r[kPo] ?? '').trim() : ''
        const key = `${locationId}|${date}|${type}|${pk(product)}|${po}`
        const cur = agg.get(key)
        if (cur) { cur.qty_change += qty; cur.total_cost += cost } else agg.set(key, { company_id: companyId, location_id: locationId, change_date: date, change_type: type, product_id: product, po_custom_id: po, uom: kUom ? String(r[kUom] ?? '') || null : null, qty_change: qty, total_cost: cost })
      }
      const payload = [...agg.values()]
      if (!payload.length) { toast.error(`Nothing to save — ${notListed.toLocaleString()} rows were products not on a price list, ${unknownShop.toLocaleString()} had an unknown shop`); setBusy(null); return }
      for (const c of chunked(payload, 500)) {
        const { error } = await sb().schema('inventory').from('cogs_ledger').upsert(c, { onConflict: 'company_id,location_id,change_date,change_type,product_id,po_custom_id' })
        if (error) throw error
      }
      const days = new Set(payload.map((p) => p.change_date)).size
      const extra = [notListed && `${notListed.toLocaleString()} not on a price list`, unknownShop && `${unknownShop.toLocaleString()} for unknown shops (${[...unknownShops].slice(0, 3).join(', ')}${unknownShops.size > 3 ? '…' : ''})`, otherType && `${otherType.toLocaleString()} other change types`, badRow && `${badRow.toLocaleString()} unreadable`].filter(Boolean)
      toast.success(`Saved ${payload.length.toLocaleString()} cost rows across ${days} day${days === 1 ? '' : 's'}${extra.length ? ` — skipped ${extra.join(', ')}` : ''}`, { duration: 7000 })
      await loadCheckData()
      setCoverage(null)
    } catch (e: any) { toast.error(e?.message ?? 'Upload failed') }
    setBusy(null)
  }

  /** Starting on hand per shop + product as of a date (the Power BI on-hand report: Operation, Product ID, Final On Hand Quantity). */
  async function uploadStartBalances(rows: Record<string, string>[], asOf: string) {
    if (!companyId || !rows.length) return
    const find = headerFinder(rows)
    const kShop = find(/^operation/i, /^shop/i, /^location/i)
    const kProduct = find(/^product\s*id/i, /^itemid$/i)
    const kQty = find(/final\s*on\s*hand/i, /^on\s*hand/i, /^qty/i)
    if (!kShop || !kProduct || !kQty) { toast.error('Expected Operation, Product ID and Final On Hand Quantity columns'); return }
    setBusy('balances')
    try {
      const listed = new Set(prices.map((p) => pk(p.product_id)))
      const agg = new Map<string, { company_id: string; location_id: string; as_of_date: string; product_id: string; on_hand_qty: number }>()
      let unknownShop = 0, notListed = 0
      for (const r of rows) {
        const product = String(r[kProduct] ?? '').trim(); const qty = num(r[kQty])
        if (!product || !Number.isFinite(qty)) continue
        if (!listed.has(pk(product))) { notListed++; continue }
        const n = shopNumber(r[kShop]); const locationId = n ? loc.resolveId(n) : null
        if (!locationId) { unknownShop++; continue }
        const key = `${locationId}|${pk(product)}`
        const cur = agg.get(key)
        if (cur) cur.on_hand_qty += qty; else agg.set(key, { company_id: companyId, location_id: locationId, as_of_date: asOf, product_id: product, on_hand_qty: qty })
      }
      const payload = [...agg.values()]
      if (!payload.length) { toast.error('No usable rows — are these products on a price list?'); setBusy(null); return }
      for (const c of chunked(payload, 500)) {
        const { error } = await sb().schema('inventory').from('cogs_start_balances').upsert(c, { onConflict: 'company_id,as_of_date,location_id,product_id' })
        if (error) throw error
      }
      toast.success(`Saved ${payload.length.toLocaleString()} starting balances as of ${asOf}${unknownShop ? ` — ${unknownShop} rows had an unknown shop` : ''}${notListed ? `, ${notListed.toLocaleString()} not on a price list` : ''}`, { duration: 6000 })
      await loadBalanceDates()
      await loadCheckData()
    } catch (e: any) { toast.error(e?.message ?? 'Upload failed') }
    setBusy(null)
  }

  async function clearLedger(start: string, end: string) {
    if (!companyId) return
    setBusy('ledger')
    const { error } = await sb().schema('inventory').from('cogs_ledger').delete().eq('company_id', companyId).gte('change_date', start).lte('change_date', end)
    setBusy(null)
    if (error) { toast.error(error.message); return }
    toast.success('Cleared')
    await loadCheckData(); setCoverage(null)
  }

  /** Shop-days where SB Net's own sales ledger shows this vendor's products selling but the cost ledger has no sale rows. */
  async function loadCoverage() {
    if (!companyId || !check) return
    setLoadingCoverage(true)
    try {
      const ids = [...new Set(vendorEntries.map((e) => e.product_id))]
      if (!ids.length) { setCoverage([]); setLoadingCoverage(false); return }
      const selling = new Map<string, Map<string, Set<string>>>() // date -> location -> products
      for (const c of chunked(ids, 60)) {
        const rows = await pageAll<{ location_id: string; activity_date: string; product_id: string }>(() => sb().schema('inventory').from('daily_product_activity')
          .select('location_id, activity_date, product_id').eq('company_id', companyId).gt('sold_qty', 0).in('product_id', c).gte('activity_date', check.start_date).lte('activity_date', check.end_date).order('id', { ascending: true }))
        for (const r of rows) {
          if (!selling.has(r.activity_date)) selling.set(r.activity_date, new Map())
          const byLoc = selling.get(r.activity_date)!
          if (!byLoc.has(r.location_id)) byLoc.set(r.location_id, new Set())
          byLoc.get(r.location_id)!.add(r.product_id)
        }
      }
      const have = new Map<string, Set<string>>()
      const idSet = new Set(ids.map(pk))
      for (const l of ledger) {
        if (l.change_type !== 'sale' || !idSet.has(pk(l.product_id))) continue
        if (!have.has(l.change_date)) have.set(l.change_date, new Set())
        have.get(l.change_date)!.add(l.location_id)
      }
      const days: CoverageDay[] = []
      for (let d = check.start_date; d <= check.end_date; d = plusDays(d, 1)) {
        const byLoc = selling.get(d) ?? new Map<string, Set<string>>()
        const got = have.get(d) ?? new Set<string>()
        days.push({
          date: d, selling: byLoc.size, withCosts: [...byLoc.keys()].filter((k) => got.has(k)).length,
          missing: [...byLoc.entries()].filter(([k]) => !got.has(k)).map(([location_id, p]) => ({ location_id, products: [...p].sort() })),
        })
      }
      setCoverage(days)
    } catch (e: any) { toast.error(e?.message ?? 'Could not check coverage') }
    setLoadingCoverage(false)
  }

  return {
    loading, loadingData, busy, prices, checks, check, checkId, setCheckId, vendors, vendorEntries, ledger, poDates, startBalances, balanceDates, result,
    coverage, loadingCoverage, loadCoverage, saveCheck, deleteCheck, savePrice, deletePrice, uploadPrices, uploadLedger, uploadStartBalances, clearLedger, locations: loc,
  }
}
