// COGS Price Check (Finance). A vendor back-dates a price change; whatever Droptop booked at the old price has to be re-costed so the expected
// ending balance is right. Replaces the "COGS Check (Rebate Pricing Check)" workbook. The rules are in cogsCalc.ts and spelled out on the Check tab.
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Copy, Pencil, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Modal, SbLoader, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { dShort, money } from '@/modules/orders-v2/shared'
import type { CheckLine, CheckResult, DateSource, LineStatus, ShopTotals } from './cogsCalc'
import { useCogs, type CogsCheck, type CoverageDay, type PriceRow } from './useCogs'

type C = ReturnType<typeof useCogs>

const STATUS_LABEL: Record<LineStatus, string> = {
  correct: 'At the correct price',
  old_price: 'Booked at an old price — re-costed',
  recosted_other: 'Re-costed (matched no listed price)',
  unmatched: 'Matches no listed price — not re-costed',
  start_stock: 'Covered by starting on hand',
  no_price: 'No price in effect',
  left_as_booked: 'Negative adjustment — left as booked',
}
const STATUS_TONE: Record<LineStatus, string> = {
  correct: 'text-inky', old_price: 'text-[#E67E22] font-bold', recosted_other: 'text-[#E67E22] font-bold', unmatched: 'text-[#C0392B]',
  start_stock: 'text-[#27A860]', no_price: 'text-[#C0392B]', left_as_booked: 'text-inky',
}
const DATE_SOURCE_LABEL: Record<DateSource, string> = { transaction: '', po_name: 'order date from PO #', po_record: "order date from Droptop's PO", receipt_date: 'no PO date — used receipt date' }
const TYPE_LABEL = { sale: 'Sale', receipt: 'Receipt', adjustment: 'Adjustment' } as const
const ppq = (v: number | null | undefined) => (v == null ? '—' : `$${v.toFixed(4)}`)
const FIELD = 'w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy'
const LABEL = 'flex flex-col gap-1 text-xs font-heading uppercase tracking-wide text-inky'

function Tile({ label, value, sub, strong = false }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded border p-3 flex flex-col gap-0.5 ${strong ? 'border-navy bg-navy/5' : 'border-navy/25'}`}>
      <span className="text-[10px] font-mono uppercase tracking-wide text-inky">{label}</span>
      <span className={`font-heading font-bold text-navy ${strong ? 'text-2xl' : 'text-lg'}`}>{value}</span>
      {sub && <span className="text-[11px] font-mono text-inky leading-snug">{sub}</span>}
    </div>
  )
}

export function CogsPriceCheckPage() {
  const c = useCogs()
  if (c.loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  return (
    <div className="flex flex-col gap-4 max-w-[1400px]">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">COGS Price Check</h1>
        <p className="text-xs text-inky mt-0.5 max-w-3xl">
          When a vendor back-dates a price change, anything Droptop booked at the old price has to be re-costed. This totals the difference for
          receipts, adjustments and sales so finance can correct the expected ending balance.
        </p>
      </div>
      <Tabs defaultValue="check">
        <TabsList>
          <TabsTrigger value="check">Check</TabsTrigger>
          <TabsTrigger value="prices">Prices</TabsTrigger>
          <TabsTrigger value="data">Data</TabsTrigger>
        </TabsList>
        <TabsContent value="check"><CheckTab c={c} /></TabsContent>
        <TabsContent value="prices"><PricesTab c={c} /></TabsContent>
        <TabsContent value="data"><DataTab c={c} /></TabsContent>
      </Tabs>
    </div>
  )
}

// ── Check ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function CheckTab({ c }: { c: C }) {
  const [modal, setModal] = useState<'new' | 'edit' | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const chk = c.check
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-2 flex-wrap">
        {c.checks.length > 0 && (
          <div className="w-72">
            <Select label="Check" value={c.checkId ?? ''} onChange={(e) => c.setCheckId(e.target.value)}
              options={c.checks.map((k) => ({ value: k.id, label: `${k.name} · ${k.vendor} · ${dShort(k.start_date)}–${dShort(k.end_date)}` }))} />
          </div>
        )}
        {chk && <Button size="sm" variant="secondary" onClick={() => setModal('edit')}><Pencil className="w-3 h-3 mr-1" />Edit</Button>}
        {chk && <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 className="w-3 h-3 mr-1" />Delete</Button>}
        <Button size="sm" onClick={() => setModal('new')}>New check</Button>
      </div>

      {!chk ? (
        <Card><CardBody className="text-sm font-mono text-inky py-10 text-center">
          No checks yet. Add the corrected prices on the Prices tab and upload Droptop's cost detail on the Data tab, then create a check for a vendor and date range.
        </CardBody></Card>
      ) : c.loadingData || !c.result ? (
        <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
      ) : (
        <CheckResults c={c} chk={chk} result={c.result} />
      )}

      <CheckModal key={`${modal}-${chk?.id ?? 'new'}`} open={modal != null} c={c} existing={modal === 'edit' ? chk : null} onClose={() => setModal(null)} />
      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this check?" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-body text-navy">Only the saved check goes — the prices and uploaded Droptop data stay.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button size="sm" onClick={() => { if (chk) void c.deleteCheck(chk.id); setConfirmDelete(false) }}>Delete</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CheckResults({ c, chk, result }: { c: C; chk: CogsCheck; result: CheckResult }) {
  const t = result.totals
  const label = (id: string) => c.locations.labelOf(id) || id
  const receiptFallbacks = result.lines.filter((l) => l.row.change_type === 'receipt' && l.dateSource === 'receipt_date').length
  const copy = async () => {
    const text = [
      `${chk.vendor} COGS price check — ${dShort(chk.start_date)} to ${dShort(chk.end_date)}`,
      `Sales: ${money(t.sales)}`, `Receipts: ${money(t.receipts)}`, `Adjustments: ${money(t.adjustments)}`, `Total impact: ${money(t.total)}`,
    ].join('\n')
    try { await navigator.clipboard.writeText(text); toast.success('Summary copied') } catch { toast.error("Couldn't copy") }
  }
  return (
    <div className="flex flex-col gap-4">
      {c.ledger.length === 0 && (
        <p className="text-xs font-mono text-[#E67E22] border border-[#E67E22]/40 bg-[#E67E22]/10 rounded px-3 py-2">
          No Droptop cost detail is loaded for {dShort(chk.start_date)}–{dShort(chk.end_date)} — upload it on the Data tab.
        </p>
      )}
      {chk.sell_through && c.startBalances.length === 0 && (
        <p className="text-xs font-mono text-[#E67E22] border border-[#E67E22]/40 bg-[#E67E22]/10 rounded px-3 py-2">
          This check sells through the starting on hand first, but no starting balances are loaded{chk.start_balance_date ? ` for ${dShort(chk.start_balance_date)}` : ''} — every sale is being re-costed.
        </p>
      )}
      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">{chk.vendor} · {dShort(chk.start_date)} – {dShort(chk.end_date)}</h2>
          <Button size="sm" variant="secondary" onClick={() => void copy()}><Copy className="w-3 h-3 mr-1" />Copy summary</Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <Tile label="Sales" value={money(t.sales)} sub={t.sales < 0 ? 'Increases COGS, decreases inventory' : 'Decreases COGS, increases inventory'} />
          <Tile label="Receipts" value={money(t.receipts)} sub="Cost booked below (or above) the price at order time" />
          <Tile label="Adjustments" value={money(t.adjustments)} sub="Net of positive and negative adjustments" />
          <Tile strong label="Total impact" value={money(t.total)} sub="Add to the expected ending balance" />
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">How this is calculated</h3>
        <ul className="list-disc pl-5 text-xs font-body text-navy/90 flex flex-col gap-1 marker:text-inky">
          <li>Each sale, receipt and adjustment is compared to the price in effect for it: <strong>receipts use the date the PO was ordered</strong> (read from the PO number, then Droptop's PO record), sales and adjustments use the day they happened.</li>
          <li>It is re-costed only if Droptop booked it at an <strong>old price</strong> — a booked cost per quart that matches another price on the list for that product (within ${chk.tolerance} per quart){chk.adjust_unmatched ? '. This check also re-costs any cost that matches no listed price' : ''}.</li>
          <li>Impact = quantity × (correct price − booked price), signed like the quantity — so a sale booked too cheaply is negative (more COGS, less inventory).</li>
          {chk.sell_through && <li><strong>Sell-through:</strong> sales use up each shop's starting on hand{chk.start_balance_date ? ` (as of ${dShort(chk.start_balance_date)})` : ''} first — it was costed at the old price on purpose — and only the quantity sold past it is re-costed. Negative adjustments are left as booked.</li>}
        </ul>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Data checks</h3>
        <ul className="list-disc pl-5 text-xs font-mono text-navy/90 flex flex-col gap-1 marker:text-inky">
          <li>{result.lines.length.toLocaleString()} transactions checked: {result.counts.old_price + result.counts.recosted_other} re-costed, {result.counts.correct.toLocaleString()} already at the right price{result.counts.start_stock ? `, ${result.counts.start_stock} covered by starting on hand` : ''}.</li>
          {result.counts.unmatched > 0 && <li className="text-[#C0392B]">{result.counts.unmatched} transaction{result.counts.unmatched === 1 ? '' : 's'} booked at a cost that matches no listed price — not re-costed. Review them under "Needs review" (a missing old price on the Prices tab is the usual cause).</li>}
          {result.counts.no_price > 0 && <li className="text-[#C0392B]">{result.counts.no_price} transaction{result.counts.no_price === 1 ? '' : 's'} had no price in effect on their pricing date — add or extend a price on the Prices tab.</li>}
          {receiptFallbacks > 0 && <li className="text-[#E67E22]">{receiptFallbacks} receipt{receiptFallbacks === 1 ? '' : 's'} had no readable PO order date, so the receipt date set the price.</li>}
          {result.outsideVendor > 0 && <li>{result.outsideVendor.toLocaleString()} ledger rows in this window are for products not on {chk.vendor}'s price list (ignored).</li>}
          {chk.sell_through && result.remainingStart.length > 0 && <li>{result.remainingStart.length.toLocaleString()} shop/product starting balances weren't fully sold through in this window.</li>}
        </ul>
      </CardBody></Card>

      <ResultTables c={c} chk={chk} result={result} label={label} />
    </div>
  )
}

function ResultTables({ c, chk, result, label }: { c: C; chk: CogsCheck; result: CheckResult; label: (id: string) => string }) {
  const [view, setView] = useState<'shops' | 'lines' | 'review'>('shops')
  const [filter, setFilter] = useState<'recosted' | 'start' | 'all'>('recosted')
  const needsReview = useMemo(() => result.lines.filter((l) => l.status === 'unmatched' || l.status === 'no_price' || (l.row.change_type === 'receipt' && l.dateSource === 'receipt_date')), [result.lines])
  const lineRows = useMemo(() => {
    if (view === 'review') return needsReview
    if (filter === 'recosted') return result.lines.filter((l) => l.status === 'old_price' || l.status === 'recosted_other')
    if (filter === 'start') return result.lines.filter((l) => l.status === 'start_stock' || l.fromStartQty > 0)
    return result.lines
  }, [view, filter, result.lines, needsReview])

  const shopCol = useMemo(() => createColumnHelper<ShopTotals>(), [])
  const shopColumns = useMemo(() => [
    shopCol.accessor((r) => label(r.location_id), { id: 'shop', header: 'Shop' }),
    shopCol.accessor('sales', { header: 'Sales', cell: (i) => money(i.getValue()) }),
    shopCol.accessor('receipts', { header: 'Receipts', cell: (i) => money(i.getValue()) }),
    shopCol.accessor('adjustments', { header: 'Adjustments', cell: (i) => money(i.getValue()) }),
    shopCol.accessor('total', { header: 'Total impact', cell: (i) => <strong>{money(i.getValue())}</strong> }),
    shopCol.accessor('lines', { header: 'Lines' }),
  ], [shopCol, label])
  const shopTable = useTable(result.byShop, shopColumns, { persistKey: 'cogs-by-shop' })
  useColumnPrefs('cogs-by-shop', shopTable.table, shopTable.columnVisibility, shopTable.columnOrder, shopTable.setColumnOrder)

  const lineCol = useMemo(() => createColumnHelper<CheckLine>(), [])
  const lineColumns = useMemo(() => [
    lineCol.accessor((l) => l.row.change_date, { id: 'date', header: 'Date', cell: (i) => dShort(i.getValue() as string) }),
    lineCol.accessor((l) => label(l.row.location_id), { id: 'shop', header: 'Shop' }),
    lineCol.accessor((l) => TYPE_LABEL[l.row.change_type], { id: 'type', header: 'Type' }),
    lineCol.accessor((l) => l.row.product_id, { id: 'product', header: 'Product' }),
    lineCol.accessor((l) => l.row.po_custom_id, { id: 'po', header: 'PO #' }),
    lineCol.accessor((l) => l.row.qty_change, { id: 'qty', header: 'Qty', cell: (i) => (i.getValue() as number).toLocaleString(undefined, { maximumFractionDigits: 2 }) }),
    lineCol.accessor((l) => l.bookedPpq ?? '', { id: 'booked', header: 'Booked $/qt', cell: (i) => ppq(i.row.original.bookedPpq) }),
    lineCol.accessor((l) => l.expectedPpq ?? '', { id: 'expected', header: 'Correct $/qt', cell: (i) => ppq(i.row.original.expectedPpq) }),
    lineCol.accessor((l) => l.pricingDate, {
      id: 'pricing', header: 'Priced on',
      cell: (i) => { const l = i.row.original; return <span title={DATE_SOURCE_LABEL[l.dateSource]} className={l.dateSource === 'receipt_date' ? 'text-[#E67E22]' : ''}>{dShort(l.pricingDate)}{l.dateSource !== 'transaction' && l.dateSource !== 'receipt_date' ? ' (PO)' : ''}</span> },
    }),
    lineCol.accessor((l) => l.fromStartQty, { id: 'fromStart', header: 'From starting on hand', cell: (i) => ((i.getValue() as number) ? (i.getValue() as number).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '') }),
    lineCol.accessor((l) => l.adjustedQty, { id: 'adjQty', header: 'Re-costed qty', cell: (i) => ((i.getValue() as number) ? (i.getValue() as number).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '') }),
    lineCol.accessor((l) => l.impact, { id: 'impact', header: 'Impact', cell: (i) => ((i.getValue() as number) ? <strong>{money(i.getValue() as number)}</strong> : '') }),
    lineCol.accessor((l) => STATUS_LABEL[l.status], { id: 'status', header: 'Result', cell: (i) => <span className={STATUS_TONE[i.row.original.status]}>{i.getValue()}</span> }),
  ], [lineCol, label])
  const lineTable = useTable(lineRows, lineColumns, { persistKey: 'cogs-lines' })
  useColumnPrefs('cogs-lines', lineTable.table, lineTable.columnVisibility, lineTable.columnOrder, lineTable.setColumnOrder)

  const pill = (active: boolean) => `text-[11px] font-mono rounded border px-2 py-0.5 ${active ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`
  const slug = `${chk.vendor}-${chk.start_date}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5 items-center">
        <button type="button" className={pill(view === 'shops')} onClick={() => setView('shops')}>By shop {result.byShop.length}</button>
        <button type="button" className={pill(view === 'lines')} onClick={() => setView('lines')}>Transactions {result.lines.length.toLocaleString()}</button>
        <button type="button" className={pill(view === 'review')} onClick={() => setView('review')}>Needs review {needsReview.length}</button>
        {view === 'lines' && (
          <span className="ml-3 flex gap-1.5">
            <button type="button" className={pill(filter === 'recosted')} onClick={() => setFilter('recosted')}>Re-costed</button>
            <button type="button" className={pill(filter === 'start')} onClick={() => setFilter('start')}>Starting on hand</button>
            <button type="button" className={pill(filter === 'all')} onClick={() => setFilter('all')}>All</button>
          </span>
        )}
      </div>
      {view === 'shops'
        ? <DataTable table={shopTable.table} globalFilter={shopTable.globalFilter} onGlobalFilterChange={shopTable.setGlobalFilter} exportFilename={`cogs-by-shop-${slug}`} />
        : <DataTable table={lineTable.table} globalFilter={lineTable.globalFilter} onGlobalFilterChange={lineTable.setGlobalFilter} exportFilename={`cogs-transactions-${slug}`} />}
      {c.ledger.length > 0 && view === 'shops' && result.byShop.length === 0 && <p className="text-xs font-mono text-inky">Nothing needed re-costing in this window.</p>}
    </div>
  )
}

function CheckModal({ open, c, existing, onClose }: { open: boolean; c: C; existing: CogsCheck | null; onClose: () => void }) {
  const today = new Date()
  const firstOfLast = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const lastOfLast = new Date(today.getFullYear(), today.getMonth(), 0)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const [d, setD] = useState({
    name: existing?.name ?? '', vendor: existing?.vendor ?? c.vendors[0] ?? '', start: existing?.start_date ?? iso(firstOfLast), end: existing?.end_date ?? iso(lastOfLast),
    sellThrough: existing?.sell_through ?? false, balanceDate: existing?.start_balance_date ?? c.balanceDates[0] ?? '', adjustUnmatched: existing?.adjust_unmatched ?? false,
    tolerance: String(existing?.tolerance ?? 0.0005), notes: existing?.notes ?? '',
  })
  const tol = Number(d.tolerance)
  const valid = d.name.trim() && d.vendor.trim() && d.start && d.end && d.end >= d.start && Number.isFinite(tol) && tol >= 0
  return (
    <Modal open={open} onClose={onClose} title={existing ? 'Edit check' : 'New check'} size="md">
      <div className="flex flex-col gap-3">
        <label className={LABEL}>Name
          <input className={FIELD} value={d.name} placeholder="e.g. September RelaDyne price change" onChange={(e) => setD({ ...d, name: e.target.value })} />
        </label>
        <label className={LABEL}>Vendor
          <input className={FIELD} list="cogs-vendors" value={d.vendor} onChange={(e) => setD({ ...d, vendor: e.target.value })} />
          <datalist id="cogs-vendors">{c.vendors.map((v) => <option key={v} value={v} />)}</datalist>
          <span className="normal-case tracking-normal font-mono text-[11px] text-inky">Uses that vendor's products and dated prices from the Prices tab.</span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Start date<input type="date" className={FIELD} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} /></label>
          <label className={LABEL}>End date<input type="date" className={FIELD} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /></label>
        </div>
        <label className="flex items-start gap-2 text-xs font-body text-navy cursor-pointer">
          <input type="checkbox" checked={d.sellThrough} onChange={(e) => setD({ ...d, sellThrough: e.target.checked })} className="accent-sky mt-0.5" />
          <span><strong>Sell through the starting on hand first</strong> (Valvoline) — sales use up each shop's starting balance, which was costed at the old price on purpose, and only what's sold past it is re-costed.</span>
        </label>
        {d.sellThrough && (
          <label className={LABEL}>Starting on hand as of
            {c.balanceDates.length > 0
              ? <select className={FIELD} value={d.balanceDate} onChange={(e) => setD({ ...d, balanceDate: e.target.value })}>{c.balanceDates.map((b) => <option key={b} value={b}>{dShort(b)}</option>)}</select>
              : <span className="normal-case tracking-normal font-mono text-[11px] text-[#E67E22]">No starting balances uploaded yet — add them on the Data tab, then edit this check.</span>}
          </label>
        )}
        <label className="flex items-start gap-2 text-xs font-body text-navy cursor-pointer">
          <input type="checkbox" checked={d.adjustUnmatched} onChange={(e) => setD({ ...d, adjustUnmatched: e.target.checked })} className="accent-sky mt-0.5" />
          <span><strong>Also re-cost costs that match no listed price</strong> — Valvoline's workbook did (Droptop's average cost rarely equals a list price). Off: only costs booked at a listed old price are re-costed, the rest wait under "Needs review".</span>
        </label>
        <label className={LABEL}>Price match tolerance ($ per quart)
          <input className={FIELD} value={d.tolerance} onChange={(e) => setD({ ...d, tolerance: e.target.value })} />
          <span className="normal-case tracking-normal font-mono text-[11px] text-inky">Two costs closer than this count as the same price.</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!valid} onClick={async () => {
            const ok = await c.saveCheck({ id: existing?.id, name: d.name.trim(), vendor: d.vendor.trim(), start_date: d.start, end_date: d.end, sell_through: d.sellThrough, start_balance_date: d.sellThrough ? d.balanceDate || null : null, adjust_unmatched: d.adjustUnmatched, tolerance: tol, notes: d.notes || null })
            if (ok) onClose()
          }}>{existing ? 'Save' : 'Create check'}</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Prices ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function PricesTab({ c }: { c: C }) {
  const [vendor, setVendor] = useState<string>('all')
  const [edit, setEdit] = useState<Partial<PriceRow> | null>(null)
  const [up, setUp] = useState({ vendor: '', effective: new Date().toISOString().slice(0, 10), endCurrent: true, mode: 'new' as 'new' | 'old' })
  const rows = useMemo(() => (vendor === 'all' ? c.prices : c.prices.filter((p) => p.vendor === vendor)), [c.prices, vendor])
  const col = useMemo(() => createColumnHelper<PriceRow>(), [])
  const columns = useMemo(() => [
    col.accessor('vendor', { header: 'Vendor' }),
    col.accessor('product_id', { header: 'Product' }),
    col.accessor('price_per_qt', { header: 'Price per quart', cell: (i) => ppq(i.getValue()) }),
    col.accessor((p) => p.start_date ?? '', { id: 'start', header: 'Starts', cell: (i) => (i.getValue() ? dShort(i.getValue() as string) : 'from the beginning') }),
    col.accessor((p) => p.end_date ?? '', { id: 'end', header: 'Ends', cell: (i) => (i.getValue() ? dShort(i.getValue() as string) : 'still in effect') }),
    col.accessor((p) => p.note ?? '', { id: 'note', header: 'Note' }),
    col.display({
      id: 'actions', header: '',
      cell: (i) => (
        <div className="flex gap-1">
          <button type="button" title="Edit" onClick={() => setEdit(i.row.original)} className="p-1 rounded text-navy/70 hover:text-navy hover:bg-navy/10"><Pencil className="w-3.5 h-3.5" /></button>
          <button type="button" title="Delete" onClick={() => { if (window.confirm(`Delete ${i.row.original.product_id} ${ppq(i.row.original.price_per_qt)}?`)) void c.deletePrice(i.row.original.id) }} className="p-1 rounded text-navy/70 hover:text-[#C0392B] hover:bg-[#C0392B]/10"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      ),
    }),
  ], [col, c])
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(rows, columns, { persistKey: 'cogs-prices' })
  useColumnPrefs('cogs-prices', table, columnVisibility, columnOrder, setColumnOrder)
  return (
    <div className="flex flex-col gap-4">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Add a price change</h3>
        <p className="text-[11px] font-mono text-inky max-w-3xl">
          Upload a vendor price list (product + price per quart, or price per gallon). A <strong>new</strong> list takes effect on the date and each product's current
          price is ended the day before, so several price periods can roll at once; a <strong>previous</strong> list stays in effect through the date. If the file has Start / End date columns they're used as given.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 max-w-4xl">
          <label className={LABEL}>Vendor<input className={FIELD} list="cogs-vendors-up" value={up.vendor} placeholder="RelaDyne, Valvoline…" onChange={(e) => setUp({ ...up, vendor: e.target.value })} /><datalist id="cogs-vendors-up">{c.vendors.map((v) => <option key={v} value={v} />)}</datalist></label>
          <label className={LABEL}>This list is
            <select className={FIELD} value={up.mode} onChange={(e) => setUp({ ...up, mode: e.target.value as 'new' | 'old' })}><option value="new">New prices</option><option value="old">Previous prices</option></select></label>
          <label className={LABEL}>{up.mode === 'new' ? 'Effective from' : 'In effect through'}<input type="date" className={FIELD} value={up.effective} onChange={(e) => setUp({ ...up, effective: e.target.value })} /></label>
          {up.mode === 'new' && <label className="flex items-end gap-2 text-xs font-body text-navy cursor-pointer pb-2"><input type="checkbox" checked={up.endCurrent} onChange={(e) => setUp({ ...up, endCurrent: e.target.checked })} className="accent-sky" />End each current price the day before</label>}
        </div>
        {c.busy === 'prices'
          ? <div className="flex items-center gap-2 text-xs font-mono text-inky"><SbLoader size={16} /> Working…</div>
          : up.vendor.trim()
            ? <FileUploadZone onParsed={(r) => void c.uploadPrices(r.rows, { vendor: up.vendor, effectiveFrom: up.effective, endCurrent: up.endCurrent, mode: up.mode })} label="Drop the price list (Excel / CSV), or click to browse" />
            : <p className="text-xs font-mono text-inky">Enter the vendor to enable the upload.</p>}
      </CardBody></Card>

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex flex-wrap gap-1.5">
            {['all', ...c.vendors].map((v) => (
              <button key={v} type="button" onClick={() => setVendor(v)} className={`text-[11px] font-mono rounded border px-2 py-0.5 ${vendor === v ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`}>{v === 'all' ? 'All vendors' : v}</button>
            ))}
          </div>
          <Button size="sm" onClick={() => setEdit({ vendor: vendor === 'all' ? c.vendors[0] ?? '' : vendor, start_date: null, end_date: null })}>Add a price</Button>
        </div>
        {c.prices.length === 0 && <p className="text-xs font-mono text-inky">No prices yet — upload a price list above or add them one at a time.</p>}
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="cogs-prices" />
      </div>
      <PriceModal key={edit?.id ?? (edit ? 'new' : 'closed')} edit={edit} c={c} onClose={() => setEdit(null)} />
    </div>
  )
}

function PriceModal({ edit, c, onClose }: { edit: Partial<PriceRow> | null; c: C; onClose: () => void }) {
  const [d, setD] = useState({
    vendor: edit?.vendor ?? '', product: edit?.product_id ?? '', price: edit?.price_per_qt != null ? String(edit.price_per_qt) : '', start: edit?.start_date ?? '', end: edit?.end_date ?? '', note: edit?.note ?? '',
  })
  const price = Number(d.price)
  const valid = d.vendor.trim() && d.product.trim() && Number.isFinite(price) && price > 0
  return (
    <Modal open={edit != null} onClose={onClose} title={edit?.id ? 'Edit price' : 'Add a price'} size="md">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Vendor<input className={FIELD} list="cogs-vendors-edit" value={d.vendor} onChange={(e) => setD({ ...d, vendor: e.target.value })} /><datalist id="cogs-vendors-edit">{c.vendors.map((v) => <option key={v} value={v} />)}</datalist></label>
          <label className={LABEL}>Product id<input className={FIELD} value={d.product} placeholder="e.g. VRP020BB" onChange={(e) => setD({ ...d, product: e.target.value })} /></label>
        </div>
        <label className={LABEL}>Price per quart ($)<input className={FIELD} value={d.price} onChange={(e) => setD({ ...d, price: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>Starts<input type="date" className={FIELD} value={d.start} onChange={(e) => setD({ ...d, start: e.target.value })} /><span className="normal-case tracking-normal font-mono text-[11px] text-inky">Blank = from the beginning</span></label>
          <label className={LABEL}>Ends<input type="date" className={FIELD} value={d.end} onChange={(e) => setD({ ...d, end: e.target.value })} /><span className="normal-case tracking-normal font-mono text-[11px] text-inky">Blank = still in effect</span></label>
        </div>
        <label className={LABEL}>Note<input className={FIELD} value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} /></label>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" disabled={!valid} onClick={async () => { if (await c.savePrice({ id: edit?.id, vendor: d.vendor, product_id: d.product, price_per_qt: price, start_date: d.start || null, end_date: d.end || null, note: d.note || null })) onClose() }}>Save</Button>
        </div>
      </div>
    </Modal>
  )
}

// ── Data ────────────────────────────────────────────────────────────────────────────────────────────────────────────

function DataTab({ c }: { c: C }) {
  const chk = c.check
  const [keepAll, setKeepAll] = useState(false)
  const [asOf, setAsOf] = useState(() => { const d = new Date(); d.setDate(0); return d.toISOString().slice(0, 10) })
  const stats = useMemo(() => {
    const days = new Set(c.ledger.map((l) => l.change_date)), shops = new Set(c.ledger.map((l) => l.location_id))
    return { rows: c.ledger.length, days: days.size, shops: shops.size, sale: c.ledger.filter((l) => l.change_type === 'sale').length, receipt: c.ledger.filter((l) => l.change_type === 'receipt').length, adjustment: c.ledger.filter((l) => l.change_type === 'adjustment').length }
  }, [c.ledger])
  return (
    <div className="flex flex-col gap-4">
      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Droptop cost detail (sales, receipts, adjustments)</h3>
          {chk && <span className="text-[11px] font-mono text-inky">{chk.name}: {dShort(chk.start_date)}–{dShort(chk.end_date)} — {stats.rows.toLocaleString()} rows over {stats.days} days, {stats.shops} shops ({stats.sale.toLocaleString()} sales, {stats.receipt.toLocaleString()} receipts, {stats.adjustment.toLocaleString()} adjustments)</span>}
        </div>
        <p className="text-[11px] font-mono text-inky max-w-3xl">
          The Power BI inventory-change export: Shop # - City, Date, Change Type, Product Id, PO Custom Id, UOM, Qty Change, Total Cost. Droptop's own sync doesn't carry the cost it booked
          on each change, so this is where those costs come from. Re-uploading a day replaces that shop/product's rows for it, so uploading just the missing days is safe.
        </p>
        <label className="flex items-center gap-2 text-xs font-body text-navy cursor-pointer">
          <input type="checkbox" checked={keepAll} onChange={(e) => setKeepAll(e.target.checked)} className="accent-sky" />
          Keep every product (default: only products on a price list, which keeps the table small)
        </label>
        {c.busy === 'ledger' ? <div className="flex items-center gap-2 text-xs font-mono text-inky"><SbLoader size={16} /> Working…</div>
          : <FileUploadZone onParsed={(r) => void c.uploadLedger(r.rows, keepAll)} label="Drop the inventory change detail (Excel / CSV), or click to browse" />}
        {chk && stats.rows > 0 && (
          <div><Button size="sm" variant="ghost" onClick={() => { if (window.confirm(`Delete the ${stats.rows.toLocaleString()} cost rows for ${dShort(chk.start_date)}–${dShort(chk.end_date)}?`)) void c.clearLedger(chk.start_date, chk.end_date) }}><Trash2 className="w-3 h-3 mr-1" />Clear this check's window</Button></div>
        )}
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Starting on hand (sell-through checks)</h3>
          <span className="text-[11px] font-mono text-inky">{c.balanceDates.length ? `Uploaded: ${c.balanceDates.map(dShort).join(', ')}` : 'None uploaded'}</span>
        </div>
        <p className="text-[11px] font-mono text-inky max-w-3xl">
          Each shop's on hand at the start of the window (the Power BI on-hand report: Operation, Product ID, Final On Hand Quantity for the day before the window starts).
          Sales use this up before any COGS re-costing begins.
        </p>
        <label className={`${LABEL} max-w-xs`}>On hand as of
          <input type="date" className={FIELD} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        {c.busy === 'balances' ? <div className="flex items-center gap-2 text-xs font-mono text-inky"><SbLoader size={16} /> Working…</div>
          : <FileUploadZone onParsed={(r) => void c.uploadStartBalances(r.rows, asOf)} label="Drop the on-hand report (Excel / CSV), or click to browse" />}
      </CardBody></Card>

      <Coverage c={c} />
    </div>
  )
}

function Coverage({ c }: { c: C }) {
  const chk = c.check
  const [open, setOpen] = useState<string | null>(null)
  const days = c.coverage
  const missingTotal = days?.reduce((s, d) => s + d.missing.length, 0) ?? 0
  const label = (id: string) => c.locations.labelOf(id) || id
  const copy = async (d: CoverageDay) => {
    try { await navigator.clipboard.writeText(d.missing.map((m) => label(m.location_id)).join('\n')); toast.success('Shop list copied') } catch { toast.error("Couldn't copy") }
  }
  return (
    <Card><CardBody className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Missing days</h3>
        <Button size="sm" variant="secondary" disabled={!chk || c.loadingCoverage} onClick={() => void c.loadCoverage()}>{c.loadingCoverage ? 'Checking…' : 'Check for missing days'}</Button>
      </div>
      <p className="text-[11px] font-mono text-inky max-w-3xl">
        Compares SB Net's own daily sales ledger with the cost rows above: a shop that sold {chk?.vendor ?? "this vendor's"} products on a day but has no cost rows for it needs that day uploaded.
        Dates can differ by a day for sales near midnight.
      </p>
      {!chk ? <p className="text-xs font-mono text-inky">Create a check first — it sets the window and vendor.</p> : days == null ? null : (
        <>
          <p className={`text-xs font-mono ${missingTotal ? 'text-[#E67E22]' : 'text-[#27A860]'}`}>
            {missingTotal ? `${missingTotal.toLocaleString()} shop-day${missingTotal === 1 ? '' : 's'} with sales in SB Net but no cost rows.` : 'Every shop-day with sales in SB Net has cost rows.'}
          </p>
          <div className="overflow-auto max-h-[28rem] rounded border border-navy/20">
            <table className="w-full text-xs font-mono">
              <thead className="bg-navy text-cream sticky top-0"><tr><th className="text-left px-2 py-1.5">Date</th><th className="text-right px-2 py-1.5">Shops selling</th><th className="text-right px-2 py-1.5">With cost rows</th><th className="text-right px-2 py-1.5">Missing</th><th /></tr></thead>
              <tbody>
                {days.map((d) => (
                  <>
                    <tr key={d.date} className={`border-t border-navy/10 ${d.missing.length ? 'bg-[#E67E22]/10' : ''}`}>
                      <td className="px-2 py-1">{dShort(d.date)}</td>
                      <td className="px-2 py-1 text-right">{d.selling}</td>
                      <td className="px-2 py-1 text-right">{d.withCosts}</td>
                      <td className={`px-2 py-1 text-right ${d.missing.length ? 'text-[#C0392B] font-bold' : ''}`}>{d.missing.length || ''}</td>
                      <td className="px-2 py-1 text-right">{d.missing.length > 0 && <button type="button" className="text-sky hover:underline" onClick={() => setOpen(open === d.date ? null : d.date)}>{open === d.date ? 'hide' : 'shops'}</button>}</td>
                    </tr>
                    {open === d.date && (
                      <tr key={`${d.date}-m`} className="bg-cream"><td colSpan={5} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2 mb-1"><span className="text-inky">Shops with {chk.vendor} sales but no cost rows on {dShort(d.date)}</span><button type="button" onClick={() => void copy(d)} className="text-sky hover:underline flex items-center gap-1"><Copy className="w-3 h-3" />copy</button></div>
                        <div className="flex flex-wrap gap-x-4 gap-y-0.5">{d.missing.map((m) => <span key={m.location_id} title={m.products.join(', ')}>{label(m.location_id)}</span>)}</div>
                      </td></tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </CardBody></Card>
  )
}
