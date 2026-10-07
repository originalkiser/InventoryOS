// GRNI — Goods Received Not Invoiced. Month-end run that values what has been delivered to shops but not yet billed by RelaDyne, so
// finance can raise expected on hand to tie out to Droptop. See grniCalc.ts for the rules (also written out on the Summary tab).
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Input, Modal, SbLoader, Select, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { dShort, money } from '@/modules/orders-v2/shared'
import { defaultCutoff, useGrni } from './useGrni'
import type { GrniLine, GrniShopRow, LineKind } from './grniCalc'
import { monthEnd } from './grniCalc'

const monthName = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
const pct = (v: number | null | undefined, dp = 0) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)

const KIND_LABEL: Record<LineKind, string> = {
  received: 'Received in Droptop', assumed: 'Assumed delivered', not_received: 'Not received yet', billed: 'Billed (on invoice report)',
  prior: 'Prior month (assumed)', later: 'After cut-off', unpriced: 'No price (not counted)',
}
const KIND_TONE: Record<LineKind, string> = {
  received: 'text-[#27A860]', assumed: 'text-[#E67E22]', not_received: 'text-inky', billed: 'text-inky', prior: 'text-[#E67E22]', later: 'text-inky/60', unpriced: 'text-[#C0392B]',
}

function Tile({ label, value, sub, strong = false }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return (
    <div className={`rounded border p-3 flex flex-col gap-0.5 ${strong ? 'border-navy bg-navy/5' : 'border-navy/25'}`}>
      <span className="text-[10px] font-mono uppercase tracking-wide text-inky">{label}</span>
      <span className={`font-heading font-bold text-navy ${strong ? 'text-2xl' : 'text-lg'}`}>{value}</span>
      {sub && <span className="text-[11px] font-mono text-inky leading-snug">{sub}</span>}
    </div>
  )
}

export function GrniPage() {
  const g = useGrni()
  const [newOpen, setNewOpen] = useState(false)

  if (g.loadingRuns) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  return (
    <div className="flex flex-col gap-4 max-w-[1400px]">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">GRNI — Goods Received Not Invoiced</h1>
          <p className="text-xs text-inky mt-0.5 max-w-3xl">
            What has been delivered to shops but not yet billed by RelaDyne at month end. Finance adds it to expected on hand so the
            books tie out to Droptop.
          </p>
        </div>
        <div className="flex items-end gap-2">
          {g.runs.length > 0 && (
            <div className="w-56">
              <Select label="Run" value={g.runId ?? ''} onChange={(e) => g.setRunId(e.target.value)}
                options={g.runs.map((r) => ({ value: r.id, label: `${monthName(r.period_month)} · cut-off ${dShort(r.cutoff_date)}` }))} />
            </div>
          )}
          <Button size="sm" onClick={() => setNewOpen(true)}>New month-end run</Button>
        </div>
      </div>

      {!g.run ? (
        <Card><CardBody className="text-sm font-mono text-inky py-10 text-center">
          No GRNI runs yet. Start one for the month you're closing, then upload the RelaDyne Open Sales Order and Open Invoice reports.
        </CardBody></Card>
      ) : g.loadingRun || !g.result || !g.params ? (
        <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
      ) : (
        <Tabs defaultValue={g.orders.length === 0 ? 'inputs' : 'summary'}>
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="shops">By Shop</TabsTrigger>
            <TabsTrigger value="lines">Order Lines</TabsTrigger>
            <TabsTrigger value="inputs">Inputs &amp; Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="summary"><SummaryTab g={g} /></TabsContent>
          <TabsContent value="shops"><ShopsTab g={g} /></TabsContent>
          <TabsContent value="lines"><LinesTab g={g} /></TabsContent>
          <TabsContent value="inputs"><InputsTab g={g} /></TabsContent>
        </Tabs>
      )}
      <NewRunModal open={newOpen} onClose={() => setNewOpen(false)} onCreate={async (m, c) => { if (await g.createRun(m, c)) setNewOpen(false) }} />
    </div>
  )
}

type G = ReturnType<typeof useGrni>

// ── new run ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function NewRunModal({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (periodMonth: string, cutoff: string) => void }) {
  const prev = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })()
  const [month, setMonth] = useState(prev)
  const [cutoff, setCutoff] = useState('')
  const period = `${month}-01`
  const effectiveCutoff = cutoff || defaultCutoff(period)
  return (
    <Modal open={open} onClose={onClose} title="New GRNI run" size="md">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-xs font-heading uppercase tracking-wide text-inky">Month being closed
          <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); setCutoff('') }} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy" />
        </label>
        <label className="flex flex-col gap-1 text-xs font-heading uppercase tracking-wide text-inky">Order cut-off date
          <input type="date" value={effectiveCutoff} onChange={(e) => setCutoff(e.target.value)} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy" />
          <span className="normal-case tracking-normal font-mono text-[11px] text-inky">Orders placed after this aren't expected to have arrived by {dShort(monthEnd(period))} (default: four days before month end).</span>
        </label>
        <div className="flex justify-end gap-2"><Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button><Button size="sm" onClick={() => onCreate(period, effectiveCutoff)}>Create run</Button></div>
      </div>
    </Modal>
  )
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function SummaryTab({ g }: { g: G }) {
  const r = g.result!, p = g.params!
  const t = r.totals
  const monthN = new Date(`${p.periodStart}T00:00:00`).toLocaleDateString('en-US', { month: 'long' })
  const notReceived = r.lines.filter((l) => l.kind === 'not_received').length
  const copy = async () => {
    const text = [
      `GRNI — ${monthName(p.periodStart)} (orders through ${dShort(p.cutoff)})`,
      `Received in Droptop (shops with good receiving): ${money(t.received)}`,
      `Assumed delivered (shops with low receiving): ${money(t.assumed)}`,
      `Invoiced after month end, delivered in ${monthN}: ${money(t.invoicedAfter)}`,
      `Current-month GRNI: ${money(t.current)}`,
      `Prior months delivered, not invoiced (assumed): ${money(t.prior)}`,
      `Total GRNI: ${money(t.total)}`,
      `Account 12005 (oil): ${money(t.accounts[12005])} · Account 12006 (additive): ${money(t.accounts[12006])}`,
    ].join('\n')
    try { await navigator.clipboard.writeText(text); toast.success('Summary copied') } catch { toast.error("Couldn't copy") }
  }
  return (
    <div className="flex flex-col gap-4">
      {g.orders.length === 0 && (
        <p className="text-xs font-mono text-[#E67E22] border border-[#E67E22]/40 bg-[#E67E22]/10 rounded px-3 py-2">
          No Open Sales Order report loaded for this run yet — upload it (and the Open Invoice report) on the Inputs &amp; Settings tab.
        </p>
      )}
      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">{monthName(p.periodStart)}</h2>
          <Button size="sm" variant="secondary" onClick={() => void copy()}><Copy className="w-3 h-3 mr-1" />Copy summary</Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Tile label="Received in Droptop" value={money(t.received)} sub="Shops with good receiving — valued at what they received" />
          <Tile label="Assumed delivered" value={money(t.assumed)} sub={`${r.issues.shopsOnStandard} shop${r.issues.shopsOnStandard === 1 ? '' : 's'} on standard % (bulk ${pct(p.bulkPct)}, package ${pct(p.packagePct)})`} />
          <Tile label={`Invoiced after month end, delivered in ${monthN}`} value={money(t.invoicedAfter)} sub="Open Invoice report: shipped in the month, invoice dated after" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Tile strong label="Current-month GRNI" value={money(t.current)} sub="Received + assumed + invoiced after month end" />
          <Tile label="Prior months, not invoiced" value={money(t.prior)} sub={`Older open orders assumed ${pct(p.priorPct)} delivered`} />
          <Tile strong label="Total GRNI" value={money(t.total)} sub={`12005 oil ${money(t.accounts[12005])} · 12006 additive ${money(t.accounts[12006])}`} />
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">How this is calculated</h3>
        <ul className="list-disc pl-5 text-xs font-body text-navy/90 flex flex-col gap-1 marker:text-inky">
          <li><strong>Open orders placed in {monthN}</strong> (through the {dShort(p.cutoff)} cut-off — later orders aren't expected to have arrived):</li>
          <ul className="list-[circle] pl-5 flex flex-col gap-1">
            <li>Already invoiced with a ship date in the month → counted from the invoice report instead, never twice.</li>
            <li>Shop with <strong>low receiving compliance</strong> (receipts under {pct(p.threshold)} of what was invoiced) → its Droptop receipts are ignored; assume <strong>{pct(p.bulkPct)} of bulk</strong> and <strong>{pct(p.packagePct)} of package</strong> orders were delivered.</li>
            <li>Shop with <strong>good compliance</strong> → what it actually received in Droptop, at price. Nothing received → not delivered, not counted.</li>
          </ul>
          <li><strong>Invoiced after month end:</strong> invoice lines shipped during {monthN} but dated after it — gallons shipped × price per gallon.</li>
          <li><strong>Prior months:</strong> orders from earlier months still open on the report, assumed {pct(p.priorPct)} delivered, shown separately.</li>
          <li>Priced from the RelaDyne price list in effect on each order's date. HM0806 posts to 12006; everything else to 12005.</li>
        </ul>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Data checks</h3>
        <ul className="list-disc pl-5 text-xs font-mono text-navy/90 flex flex-col gap-1 marker:text-inky">
          <li>{g.compliance.length === 0
            ? 'No shop compliance yet — every shop is treated as having good receiving. Calculate it on the Inputs tab.'
            : `${r.issues.shopsOnStandard} shop${r.issues.shopsOnStandard === 1 ? '' : 's'} on the standard percentages; the rest use their Droptop receipts.`}</li>
          <li>{notReceived.toLocaleString()} order line{notReceived === 1 ? '' : 's'} from good-compliance shops have no Droptop receipt yet (not counted).</li>
          {g.receiptsLoading && <li>Loading Droptop receipts…</li>}
          {r.issues.unpricedCodes.length > 0 && (
            <li>
              Products with no price (not counted): {r.issues.unpricedCodes.slice(0, 8).map((u) => `${u.code}${u.desc ? ` (${u.desc})` : ''}`).join(', ')}
              {r.issues.unpricedCodes.length > 8 ? '…' : ''} — deposits and returns are expected; add real products to the price list on the Inputs tab.
            </li>
          )}
          {r.issues.noDatePos.length > 0 && <li>{r.issues.noDatePos.length} PO number{r.issues.noDatePos.length === 1 ? '' : 's'} had no readable date and weren't placed in a month.</li>}
        </ul>
      </CardBody></Card>
    </div>
  )
}

// ── by shop ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function ShopsTab({ g }: { g: G }) {
  const loc = useLocations()
  const label = useMemo(() => {
    const m = new Map<number, string>()
    for (const l of loc.locations) { const n = Number(l.name); if (Number.isFinite(n)) m.set(n, String((l as any).shop_city || l.name)) }
    return m
  }, [loc.locations])
  const rows = g.result!.shops
  const col = useMemo(() => createColumnHelper<GrniShopRow>(), [])
  const columns = useMemo(() => [
    col.accessor((r) => label.get(r.shop) ?? String(r.shop), { id: 'shop', header: 'Shop' }),
    col.accessor((r) => r.compliancePct, { id: 'compliance', header: 'Receiving compliance', cell: (i) => <span className={i.row.original.mode === 'standard' ? 'text-[#E67E22] font-bold' : ''}>{pct(i.getValue() as number | null)}</span> }),
    col.display({
      id: 'rule', header: 'Rule used',
      cell: (i) => {
        const r = i.row.original
        return (
          <select value={r.override ?? ''} onChange={(e) => void g.setOverride(r.shop, (e.target.value || null) as 'standard' | 'receipts' | null)}
            className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-[11px] font-mono text-navy">
            <option value="">Auto — {r.mode === 'standard' ? 'standard %' : 'receipts'}</option>
            <option value="standard">Always standard %</option>
            <option value="receipts">Always receipts</option>
          </select>
        )
      },
    }),
    col.accessor('received', { header: 'Received', cell: (i) => money(i.getValue()) }),
    col.accessor('assumed', { header: 'Assumed', cell: (i) => money(i.getValue()) }),
    col.accessor('invoicedAfter', { header: 'Invoiced after month end', cell: (i) => money(i.getValue()) }),
    col.accessor('prior', { header: 'Prior months', cell: (i) => money(i.getValue()) }),
    col.accessor('total', { header: 'Total GRNI', cell: (i) => <strong>{money(i.getValue())}</strong> }),
  ], [col, label, g])
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(rows, columns, { persistKey: 'grni-by-shop' })
  useColumnPrefs('grni-by-shop', table, columnVisibility, columnOrder, setColumnOrder)
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] font-mono text-inky">
        Receiving compliance = gallons received in Droptop ÷ gallons RelaDyne invoiced. Under {pct(g.params!.threshold)} the shop's receipts are ignored
        and the standard percentages apply — override a shop's rule here if you know better.
      </p>
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename={`grni-by-shop-${g.params!.periodStart.slice(0, 7)}`} />
    </div>
  )
}

// ── order lines ─────────────────────────────────────────────────────────────────────────────────────────────────────

function LinesTab({ g }: { g: G }) {
  const [kind, setKind] = useState<LineKind | 'all'>('all')
  const all = g.result!.lines
  const counts = useMemo(() => { const m = new Map<LineKind, number>(); for (const l of all) m.set(l.kind, (m.get(l.kind) ?? 0) + 1); return m }, [all])
  const rows = useMemo(() => (kind === 'all' ? all : all.filter((l) => l.kind === kind)), [all, kind])
  const col = useMemo(() => createColumnHelper<GrniLine>(), [])
  const columns = useMemo(() => [
    col.accessor((l) => l.order.shop ?? '', { id: 'shop', header: 'Shop' }),
    col.accessor((l) => l.order.po, { id: 'po', header: 'PO #' }),
    col.accessor((l) => l.order.desc || l.order.code, { id: 'product', header: 'Product' }),
    col.accessor('type', { header: 'Type' }),
    col.accessor((l) => l.poDate ?? '', { id: 'date', header: 'PO date', cell: (i) => dShort(i.getValue() as string) }),
    col.accessor((l) => l.order.qty, { id: 'qty', header: 'Qty ordered' }),
    col.accessor((l) => l.receivedUnits ?? '', { id: 'received', header: 'Received (Droptop)' }),
    col.accessor((l) => l.listCost, { id: 'list', header: 'Order value', cell: (i) => money(i.getValue()) }),
    col.accessor((l) => KIND_LABEL[l.kind], { id: 'status', header: 'Treatment', cell: (i) => <span className={KIND_TONE[i.row.original.kind]}>{i.getValue()}</span> }),
    col.accessor('counted', { header: 'GRNI', cell: (i) => <strong>{money(i.getValue())}</strong> }),
    col.accessor('account', { header: 'Acct' }),
  ], [col])
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(rows, columns, { persistKey: 'grni-lines' })
  useColumnPrefs('grni-lines', table, columnVisibility, columnOrder, setColumnOrder)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {(['all', ...Object.keys(KIND_LABEL)] as (LineKind | 'all')[]).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)}
            className={`text-[11px] font-mono rounded border px-2 py-0.5 ${kind === k ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`}>
            {k === 'all' ? 'All' : KIND_LABEL[k]} {k === 'all' ? all.length : counts.get(k) ?? 0}
          </button>
        ))}
      </div>
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename={`grni-lines-${g.params!.periodStart.slice(0, 7)}`} />
    </div>
  )
}

// ── inputs & settings ───────────────────────────────────────────────────────────────────────────────────────────────

function UploadBox({ title, status, busy, children }: { title: string; status: string; busy: boolean; children: React.ReactNode }) {
  return (
    <Card><CardBody className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">{title}</h3><span className="text-[11px] font-mono text-inky">{status}</span></div>
      {busy ? <div className="flex items-center gap-2 text-xs font-mono text-inky"><SbLoader size={16} /> Working…</div> : children}
    </CardBody></Card>
  )
}

function InputsTab({ g }: { g: G }) {
  const run = g.run!
  const [draft, setDraft] = useState({ bulk: String(run.bulk_pct * 100), pkg: String(run.package_pct * 100), prior: String(run.prior_pct * 100), thr: String(run.compliance_threshold * 100), cutoff: run.cutoff_date })
  const [effective, setEffective] = useState('2026-07-01')
  const num = (s: string) => Number(s) / 100
  const dirty = num(draft.bulk) !== Number(run.bulk_pct) || num(draft.pkg) !== Number(run.package_pct) || num(draft.prior) !== Number(run.prior_pct) || num(draft.thr) !== Number(run.compliance_threshold) || draft.cutoff !== run.cutoff_date
  const stamp = (iso: string | null) => (iso ? `uploaded ${new Date(iso).toLocaleString()}` : 'not uploaded')
  return (
    <div className="flex flex-col gap-4">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Assumptions for {monthName(run.period_month)}</h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Input label="Bulk delivered %" type="number" value={draft.bulk} onChange={(e) => setDraft({ ...draft, bulk: e.target.value })} />
          <Input label="Package delivered %" type="number" value={draft.pkg} onChange={(e) => setDraft({ ...draft, pkg: e.target.value })} />
          <Input label="Prior months %" type="number" value={draft.prior} onChange={(e) => setDraft({ ...draft, prior: e.target.value })} />
          <Input label="Low-compliance under %" type="number" value={draft.thr} onChange={(e) => setDraft({ ...draft, thr: e.target.value })} />
          <label className="flex flex-col gap-1 text-xs font-heading uppercase tracking-wide text-inky">Order cut-off
            <input type="date" value={draft.cutoff} onChange={(e) => setDraft({ ...draft, cutoff: e.target.value })} className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy" />
          </label>
        </div>
        <div className="flex justify-between items-center gap-2">
          <button type="button" onClick={() => { if (window.confirm('Delete this run and everything uploaded to it?')) void g.deleteRun() }} className="text-xs font-mono text-[#C0392B] hover:underline">Delete this run</button>
          <Button size="sm" disabled={!dirty} onClick={() => void g.updateRun({ bulk_pct: num(draft.bulk), package_pct: num(draft.pkg), prior_pct: num(draft.prior), compliance_threshold: num(draft.thr), cutoff_date: draft.cutoff })}>Save assumptions</Button>
        </div>
      </CardBody></Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <UploadBox title="RelaDyne Open Sales Order report" status={`${g.orders.length.toLocaleString()} lines · ${stamp(run.orders_uploaded_at)}`} busy={g.busy === 'orders'}>
          <FileUploadZone onParsed={(r) => void g.uploadOrders(r.rows)} label="Drop the Open SO report (Excel / CSV), or click to browse" />
        </UploadBox>
        <UploadBox title="RelaDyne Open Invoice report" status={`${g.invoices.length.toLocaleString()} lines · ${stamp(run.invoices_uploaded_at)}`} busy={g.busy === 'invoices'}>
          <FileUploadZone onParsed={(r) => void g.uploadInvoices(r.rows)} label="Drop the Open Invoice report (Excel / CSV), or click to browse" />
        </UploadBox>
      </div>

      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Receiving compliance by shop</h3>
          <span className="text-[11px] font-mono text-inky">{g.compliance.length} shops{g.compliance.some((c) => c.source === 'upload') ? ' (includes uploaded PO Match data)' : ''}</span>
        </div>
        <p className="text-[11px] font-mono text-inky max-w-3xl">
          Calculated from Droptop: gallons received on the period's POs ÷ gallons RelaDyne invoiced. Needs the Open Invoice report above.
          You can also load the Power BI "PO Match" export instead (one row per shop, PO Number = Total).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={g.busy === 'compliance'} disabled={g.invoices.length === 0} onClick={() => void g.recomputeCompliance()}>Calculate from Droptop receipts</Button>
          <Button size="sm" variant="secondary" loading={g.receiptsLoading} onClick={() => void g.refreshReceipts()}>Refresh Droptop receipts</Button>
        </div>
        <FileUploadZone onParsed={(r) => void g.uploadCompliance(r.rows)} label="…or drop the Power BI PO Match export" />
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">RelaDyne price list</h3>
          <span className="text-[11px] font-mono text-inky">{new Set(g.prices.map((p) => p.itemCode)).size} products · {[...new Set(g.prices.map((p) => p.effectiveFrom))].sort().join(', ') || 'none'}</span>
        </div>
        <p className="text-[11px] font-mono text-inky max-w-3xl">
          Each order is priced at the list in effect on its order date. When prices change, upload the new list with its effective date
          (columns: reladyne_item_code, itemId, item_description, uom, pkg_qty_gal, price_gal) — earlier dates keep their old prices.
        </p>
        <label className="flex items-center gap-2 text-xs font-mono text-navy">Effective from
          <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} className="bg-cream border border-navy/40 rounded px-2 py-1 text-sm font-body text-navy" />
        </label>
        {g.busy === 'prices' ? <SbLoader size={16} /> : <FileUploadZone onParsed={(r) => void g.uploadPrices(r.rows, effective)} label="Drop a price list (Excel / CSV)" />}
      </CardBody></Card>
    </div>
  )
}
