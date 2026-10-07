// GRNI (Goods Received Not Invoiced) — the month-end calculation, pure (no React / Supabase) so it can be tested.
//
// The question: at month end, how much product has been DELIVERED to shops but not yet BILLED by RelaDyne? Finance adds that to expected
// on hand so it ties out to Droptop. Inputs are the Open Sales Order report (ordered, not yet invoiced), the Open Invoice report, the
// receipts shops recorded in Droptop, and each shop's receiving compliance:
//
//   • An open order placed in the period (PO date between the 1st and the order cut-off — later orders aren't expected to have arrived):
//       - already invoiced with a ship date in the month   -> counted from the invoice report instead (see below)
//       - shop has BAD receiving compliance                -> ignore its receipts; assume a share was delivered: 90% of bulk, 64% of package
//       - shop has GOOD compliance                         -> use what it actually received in Droptop (received units x price)
//       - good compliance but nothing received             -> not delivered, not counted
//   • Invoiced after month end, shipped in the month        -> the invoice report's own cost (gallons shipped x price per gallon)
//   • Open orders from earlier months                       -> assumed delivered at the prior-months percentage, shown separately
//
// Everything is priced from the effective-dated RelaDyne price list: the price in effect on the order's date.

export interface GrniParams {
  /** First day of the month being closed, YYYY-MM-DD. */
  periodStart: string
  /** Orders with a PO date after this are not expected to have been delivered by month end. */
  cutoff: string
  bulkPct: number
  packagePct: number
  priorPct: number
  /** A shop whose received / invoiced is below this is not trusted to receive. */
  threshold: number
}

export interface GrniOrder { id: string; orderDate: string | null; po: string; shipTo: string; shop: number | null; code: string; desc: string; qty: number }
export interface GrniInvoice {
  id: string; invoiceNo: string; po: string; orderDate: string | null; shipDate: string | null; invoiceDate: string | null
  shop: number | null; code: string; desc: string; gallonsShipped: number
}
export interface GrniPrice { itemCode: string; itemId: string | null; uom: string | null; pkgQtyGal: number; priceGal: number; effectiveFrom: string }
export interface GrniCompliance { shop: number; pct: number | null; override: 'standard' | 'receipts' | null }

export type LineKind =
  | 'received'      // compliant shop — valued at what it received
  | 'assumed'       // low-compliance shop — valued at the standard percentage
  | 'not_received'  // compliant shop, nothing received yet — not counted
  | 'billed'        // already invoiced for this period — counted from the invoice report
  | 'prior'         // from an earlier month — valued at the prior-months percentage
  | 'later'         // placed after the cut-off (or after month end) — not expected delivered yet
  | 'unpriced'      // no price for this product code (deposits, fees, unmapped products) — not counted

export interface GrniLine {
  order: GrniOrder
  poDate: string | null
  type: 'Bulk' | 'Package'
  itemId: string | null
  account: 12005 | 12006
  /** Price of one ordered unit (a gallon for bulk, a package otherwise). */
  unitPrice: number | null
  /** Ordered qty x unit price. */
  listCost: number
  kind: LineKind
  receivedUnits: number | null
  /** What this line contributes to GRNI. */
  counted: number
  /** The compliance rule applied: 'standard' | 'receipts' (only meaningful for current-period lines). */
  mode: 'standard' | 'receipts' | null
}

export interface GrniInvoiceCounted { invoice: GrniInvoice; shop: number | null; cost: number; account: 12005 | 12006 }

export interface GrniShopRow {
  shop: number
  received: number
  assumed: number
  invoicedAfter: number
  prior: number
  total: number
  compliancePct: number | null
  mode: 'standard' | 'receipts'
  override: 'standard' | 'receipts' | null
}

export interface GrniResult {
  lines: GrniLine[]
  invoices: GrniInvoiceCounted[]
  shops: GrniShopRow[]
  totals: { received: number; assumed: number; invoicedAfter: number; current: number; prior: number; total: number; accounts: Record<12005 | 12006, number> }
  issues: { unpricedCodes: { code: string; desc: string; qty: number }[]; noDatePos: string[]; shopsOnStandard: number }
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────────────────────

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const monthEnd = (periodStart: string): string => { const [y, m] = periodStart.split('-').map(Number); return iso(new Date(y, m, 0)) }
export const addDays = (s: string, n: number): string => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return iso(d) }

/** "146-05202026B" -> date 2026-05-20, type Bulk. The date is MMDDYYYY after the shop number; B means bulk, anything else package. */
export function parsePo(po: string): { date: string | null; shop: number | null; type: 'Bulk' | 'Package' } {
  const m = String(po ?? '').trim().match(/^(\d+)-(\d{2})(\d{2})(\d{4})/)
  let date: string | null = null
  if (m) {
    const mm = Number(m[2]), dd = Number(m[3]), yy = Number(m[4])
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) date = `${yy}-${m[2]}-${m[3]}`
  }
  const type = /b/i.test(String(po ?? '')) ? 'Bulk' : 'Package'
  return { date, shop: m ? Number(m[1]) : null, type }
}

const isHm = (code: string, itemId: string | null) => /HM0806$/i.test(code) || itemId === 'HM0806'

export function buildPriceIndex(prices: GrniPrice[]): (code: string, date: string | null) => GrniPrice | null {
  const byCode = new Map<string, GrniPrice[]>()
  for (const p of prices) {
    if (!Number.isFinite(p.priceGal) || !Number.isFinite(p.pkgQtyGal)) continue // a row with no usable price never prices anything
    const a = byCode.get(p.itemCode); if (a) a.push(p); else byCode.set(p.itemCode, [p])
  }
  for (const a of byCode.values()) a.sort((x, y) => x.effectiveFrom.localeCompare(y.effectiveFrom))
  return (code, date) => {
    const a = byCode.get(code)
    if (!a) return null
    if (!date) return a[a.length - 1]
    let hit: GrniPrice | null = null
    for (const p of a) if (p.effectiveFrom <= date) hit = p
    return hit ?? a[0]
  }
}

/** Which rule applies to a shop: its receipts, or the standard percentages. */
export function shopMode(c: GrniCompliance | undefined, threshold: number): 'standard' | 'receipts' {
  if (c?.override) return c.override
  if (c && c.pct != null && c.pct < threshold) return 'standard'
  return 'receipts'
}

export const receiptKey = (po: string, itemId: string | null) => `${String(po).trim().toLowerCase()}|${String(itemId ?? '').trim().toLowerCase()}`

// ── the calculation ─────────────────────────────────────────────────────────────────────────────────────────────────

export function calcGrni(args: {
  params: GrniParams
  orders: GrniOrder[]
  invoices: GrniInvoice[]
  prices: GrniPrice[]
  /** Droptop receipts: key = receiptKey(po, our product id), value = units received (gallons for bulk, packages otherwise). */
  receipts: Map<string, number>
  compliance: GrniCompliance[]
}): GrniResult {
  const { params, orders, invoices, receipts } = args
  const start = params.periodStart
  const end = monthEnd(start)
  const priceFor = buildPriceIndex(args.prices)
  const comp = new Map(args.compliance.map((c) => [c.shop, c]))

  // Invoice lines by PO + product code, for the "already billed" test.
  const invByKey = new Map<string, GrniInvoice[]>()
  for (const i of invoices) { const k = `${i.po.toLowerCase()}|${i.code}`; const a = invByKey.get(k); if (a) a.push(i); else invByKey.set(k, [i]) }

  const unpriced = new Map<string, { code: string; desc: string; qty: number }>()
  const noDatePos = new Set<string>()
  const lines: GrniLine[] = []

  for (const o of orders) {
    const parsed = parsePo(o.po)
    const poDate = parsed.date ?? o.orderDate
    if (!poDate) noDatePos.add(o.po)
    const shop = o.shop ?? parsed.shop
    const price = priceFor(o.code, o.orderDate ?? poDate)
    const itemId = price?.itemId ?? null
    const unitPrice = price ? (parsed.type === 'Bulk' ? price.priceGal : price.pkgQtyGal * price.priceGal) : null
    // A bulk line's price is per gallon whichever way the price list describes the product; a package line's is per package.
    const listCost = unitPrice != null ? unitPrice * o.qty : 0
    const account: 12005 | 12006 = isHm(o.code, itemId) ? 12006 : 12005
    const base = { order: { ...o, shop }, poDate, type: parsed.type, itemId, account, unitPrice, listCost, receivedUnits: null as number | null }

    let kind: LineKind
    let counted = 0
    let mode: GrniLine['mode'] = null
    let receivedUnits: number | null = null

    if (unitPrice == null) {
      kind = 'unpriced'
      const u = unpriced.get(o.code) ?? { code: o.code, desc: o.desc, qty: 0 }
      u.qty += o.qty; unpriced.set(o.code, u)
    } else if (!poDate || poDate > end || poDate > params.cutoff || (o.orderDate != null && o.orderDate > params.cutoff)) {
      kind = 'later'
    } else if (poDate < start) {
      kind = 'prior'
      counted = listCost * params.priorPct
    } else {
      const billed = (invByKey.get(`${o.po.toLowerCase()}|${o.code}`) ?? []).some((i) => i.shipDate != null && i.shipDate >= start && i.shipDate <= end)
      if (billed) {
        kind = 'billed'
      } else {
        mode = shopMode(shop != null ? comp.get(shop) : undefined, params.threshold)
        if (mode === 'standard') {
          kind = 'assumed'
          counted = listCost * (parsed.type === 'Bulk' ? params.bulkPct : params.packagePct)
        } else {
          const got = itemId ? receipts.get(receiptKey(o.po, itemId)) ?? 0 : 0
          receivedUnits = got
          if (got > 0) { kind = 'received'; counted = Math.min(got, o.qty) * unitPrice } else kind = 'not_received'
        }
      }
    }
    lines.push({ ...base, kind, counted, mode, receivedUnits })
  }

  // Invoiced after month end, shipped during the month.
  const counted: GrniInvoiceCounted[] = []
  for (const i of invoices) {
    if (!i.shipDate || i.shipDate < start || i.shipDate > end) continue
    if (!i.invoiceDate || i.invoiceDate <= end) continue
    const price = priceFor(i.code, i.orderDate ?? i.shipDate)
    if (!price) continue
    counted.push({ invoice: i, shop: i.shop ?? parsePo(i.po).shop, cost: price.priceGal * i.gallonsShipped, account: isHm(i.code, price.itemId) ? 12006 : 12005 })
  }

  // Roll up.
  const shops = new Map<number, GrniShopRow>()
  const rowFor = (shop: number): GrniShopRow => {
    let r = shops.get(shop)
    if (!r) {
      const c = comp.get(shop)
      r = { shop, received: 0, assumed: 0, invoicedAfter: 0, prior: 0, total: 0, compliancePct: c?.pct ?? null, mode: shopMode(c, params.threshold), override: c?.override ?? null }
      shops.set(shop, r)
    }
    return r
  }
  const totals = { received: 0, assumed: 0, invoicedAfter: 0, current: 0, prior: 0, total: 0, accounts: { 12005: 0, 12006: 0 } as Record<12005 | 12006, number> }
  // Totals always include every counted line; the per-shop table can only list lines whose shop is known.
  for (const l of lines) {
    if (l.counted === 0) continue
    const r = l.order.shop != null ? rowFor(l.order.shop) : null
    if (l.kind === 'received') { if (r) r.received += l.counted; totals.received += l.counted }
    else if (l.kind === 'assumed') { if (r) r.assumed += l.counted; totals.assumed += l.counted }
    else if (l.kind === 'prior') { if (r) r.prior += l.counted; totals.prior += l.counted }
    totals.accounts[l.account] += l.counted
  }
  for (const c of counted) {
    if (c.shop != null) rowFor(c.shop).invoicedAfter += c.cost
    totals.invoicedAfter += c.cost
    totals.accounts[c.account] += c.cost
  }
  // Shops with compliance data but no GRNI still list (so the user can see and override them).
  for (const c of args.compliance) rowFor(c.shop)
  for (const r of shops.values()) r.total = r.received + r.assumed + r.invoicedAfter + r.prior
  totals.current = totals.received + totals.assumed + totals.invoicedAfter
  totals.total = totals.current + totals.prior

  return {
    lines, invoices: counted,
    shops: [...shops.values()].sort((a, b) => a.shop - b.shop),
    totals,
    issues: {
      unpricedCodes: [...unpriced.values()].sort((a, b) => b.qty - a.qty),
      noDatePos: [...noDatePos],
      shopsOnStandard: [...shops.values()].filter((s) => s.mode === 'standard').length,
    },
  }
}

// ── receiving compliance ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per shop: gallons received in Droptop as a share of gallons RelaDyne invoiced, for POs dated in the period. Receipts are totalled per
 * PO across every product on it (no product matching — a receipt is a receipt), converted to gallons by the product's package size.
 * A shop with no invoices has nothing to compare — pct null.
 */
export function computeCompliance(args: {
  params: GrniParams
  invoices: GrniInvoice[]
  prices: GrniPrice[]
  receipts: Map<string, number>
}): { shop: number; invoicedGal: number; receivedGal: number; pct: number | null }[] {
  const start = args.params.periodStart
  const end = monthEnd(start)
  // Gallons in one received unit, by Droptop product id (our item id).
  const galPerUnit = new Map<string, number>()
  for (const p of args.prices) if (p.itemId && Number.isFinite(p.pkgQtyGal) && !galPerUnit.has(p.itemId.toLowerCase())) galPerUnit.set(p.itemId.toLowerCase(), p.pkgQtyGal)
  const receivedGalByPo = new Map<string, number>()
  for (const [key, units] of args.receipts) {
    const cut = key.lastIndexOf('|')
    const po = key.slice(0, cut), product = key.slice(cut + 1)
    // Droptop's received qty is in the PO's own unit: gallons on a bulk PO, packages otherwise.
    const gal = parsePo(po).type === 'Bulk' ? units : units * (galPerUnit.get(product) ?? 1)
    receivedGalByPo.set(po, (receivedGalByPo.get(po) ?? 0) + gal)
  }
  const byShop = new Map<number, { invoicedGal: number; receivedGal: number; pos: Set<string> }>()
  for (const i of args.invoices) {
    const parsed = parsePo(i.po)
    const poDate = parsed.date ?? i.orderDate
    if (!poDate || poDate < start || poDate > end) continue
    const shop = i.shop ?? parsed.shop
    if (shop == null || !(i.gallonsShipped > 0)) continue
    let r = byShop.get(shop)
    if (!r) { r = { invoicedGal: 0, receivedGal: 0, pos: new Set() }; byShop.set(shop, r) }
    r.invoicedGal += i.gallonsShipped
  }
  // Receipts: every PO the shop placed in the period (not only the ones already invoiced) — what Power BI's PO Match counts.
  for (const [po, gal] of receivedGalByPo) {
    const parsed = parsePo(po)
    if (!parsed.date || parsed.date < start || parsed.date > end || parsed.shop == null) continue
    const r = byShop.get(parsed.shop)
    if (r) r.receivedGal += gal
  }
  return [...byShop.entries()].map(([shop, r]) => ({ shop, invoicedGal: r.invoicedGal, receivedGal: r.receivedGal, pct: r.invoicedGal > 0 ? r.receivedGal / r.invoicedGal : null }))
}
