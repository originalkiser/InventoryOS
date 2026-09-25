// Purchase Order status — reads inventory.droptop_purchase_orders /
// droptop_purchase_order_items (see supabase/functions/droptop-sync-
// purchase-orders). Deliberately its own page, not folded into Orders v2's
// own routes — "on PO" is operational information people need to check
// regardless of whether they're mid-way through building a new order.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Card, CardBody, Combobox, Modal, Select, SbLoader, Toggle, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { useTable } from '@/hooks/useTable'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { usePageRevisit } from '@/hooks/usePageActive'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface PoItemRow {
  id: string
  purchase_order_item_type: string | null
  inventory_id: string | null
  product_id: string | null
  name: string | null
  quantity: number | null
  unit_cost: number | null
  received_quantity: number | null
  back_ordered_quantity: number | null
  remaining_quantity: number | null
  total_cost: number | null
  purchase_uom: string | null
  sell_uom: string | null
}
interface PoRow {
  id: string
  location_id: string | null
  po_id: string
  custom_po_id: string | null
  supplier_name: string | null
  po_status: string | null
  approved_status: string | null
  delivery_status: string | null
  delivery_status_updated_timestamp: string | null
  pay_status: string | null
  total_cost: number | null
  note: string | null
  last_updated_user_name: string | null
  created_timestamp: string | null
  closed_timestamp: string | null
  last_updated_timestamp: string | null
  to_receive_timestamp: string | null
}
// Row shape actually fed into the DataTable — adds an item count for the
// "Items" column and a synthesized, hidden search-index column so the
// table's own search box can match on line-item content (product id/name),
// not just this PO's own fields.
interface PoTableRow extends PoRow {
  _itemCount: number
  _searchText: string
}
interface OnOrderRow {
  locId: string
  product_id: string
  qty: number
  poIds: string[]
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const dShort = (iso: string | null) => { if (!iso) return '—'; try { return format(new Date(iso), 'MMM d, yyyy') } catch { return '—' } }
const dTime = (iso: string | null) => { if (!iso) return '—'; try { return format(new Date(iso), 'MMM d · h:mm a') } catch { return '—' } }
const money = (v: number | null) => (v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }))
const num = (v: number | null) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))

// Known values from Droptop; anything else still renders (title-cased, not
// swallowed) rather than falling back to a raw/blank value.
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  fully_received: 'Fully Received',
  partially_received: 'Partially Received',
  backordered: 'Backordered',
}
function deliveryStatusLabel(v: string | null): string {
  if (!v) return 'None'
  const key = v.toLowerCase().trim().replace(/[\s-]+/g, '_')
  return DELIVERY_STATUS_LABELS[key] ?? v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Still outstanding on this line. Droptop's own remaining_quantity is
// unreliable in practice — confirmed against production data (2026-09-23):
// 311,171 line items company-wide, only 2,500 (0.8%) ever report a positive
// remaining_quantity, and it's never null — meaning it's routinely a literal
// 0 even for a line that's plainly still outstanding (quantity=1,
// received_quantity=0, remaining_quantity=0, on a PO whose own header
// delivery_status is null or "back_ordered"). This single field being
// trusted at face value is what made "Products currently on order" show
// almost nothing (25 of 7,925 open-PO line items) when the real number,
// recomputed the way below, is 5,351 across 226 shops.
// Only trust remaining_quantity when it's actually positive — Droptop
// occasionally reports something MORE precise than quantity-received alone
// (e.g. a partial shipment already dispatched) — otherwise fall back to the
// reliable quantity-minus-received computation.
function outstandingQty(it: PoItemRow): number {
  if (it.remaining_quantity != null && it.remaining_quantity > 0) return Number(it.remaining_quantity)
  return Math.max(0, Number(it.quantity ?? 0) - Number(it.received_quantity ?? 0))
}

const OPEN_STATUSES = new Set(['draft', 'sent', 'accepted'])

// Module-level cache (2026-09-25 direct feedback: "the data has to reload"
// after just switching browser tabs for 30 seconds) — same stale-while-
// revalidate shape useConfigTab.ts/useLocations.ts already use elsewhere in
// this app. usePageRevisit (below) calls load() on every tab
// revisit/refocus; without this, that meant re-running the full ~20k-row
// PO + line-item fetch from scratch every single time, even a few seconds
// after the last one. A revisit within the TTL now returns instantly with
// no network call at all; past the TTL it still shows the cached data
// immediately (no blanked table, no progress bar) while quietly
// refreshing in the background.
interface PoStatusCacheEntry { pos: PoRow[]; itemsByPo: Record<string, PoItemRow[]>; ts: number }
const poStatusCache = new Map<string, PoStatusCacheEntry>()
const PO_STATUS_CACHE_TTL_MS = 5 * 60 * 1000

export function PoStatusPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()

  const [pos, setPos] = useState<PoRow[]>([])
  const [itemsByPo, setItemsByPo] = useState<Record<string, PoItemRow[]>>({})
  const [loading, setLoading] = useState(true)
  // Real loading progress instead of an indeterminate spinner — a cheap
  // count-only (head:true) request seeds `total` for each phase, then the
  // paginated fetch below reports cumulative rows loaded so far. Two
  // sequential phases (POs, then their line items), not one — same overall
  // technique Droptop Orders/Customer Heatmap already use.
  const [loadProgress, setLoadProgress] = useState<{ phase: 'pos' | 'items'; loaded: number; total: number | null }>({ phase: 'pos', loaded: 0, total: null })
  const [viewingPo, setViewingPo] = useState<PoRow | null>(null)

  const [fLocation, setFLocation] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [hideClosed, setHideClosed] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    const cached = poStatusCache.get(companyId)
    if (cached) {
      // Instant, no network — a stale entry still shows immediately (never
      // blanks the table back to a loading state) and falls through to a
      // silent background refresh below.
      setPos(cached.pos)
      setItemsByPo(cached.itemsByPo)
      setLoading(false)
      if (Date.now() - cached.ts < PO_STATUS_CACHE_TTL_MS) return
    } else {
      setLoading(true)
      setLoadProgress({ phase: 'pos', loaded: 0, total: null })
    }
    const sb = supabase as any

    // PostgREST caps an un-ranged select at 1000 rows by default — silently,
    // no error. Applied to both queries here: the PO count alone might fit
    // under that, but ~16 items/PO puts the item rows well past it, so most
    // POs' items were getting silently dropped (the exact same bug already
    // root-caused once this session, in LocationLookupPage.tsx — same fix).
    const fetchAllRows = async <T,>(table: string, apply: (q: any) => any, onPage?: (loadedSoFar: number) => void, select = '*'): Promise<T[]> => {
      const out: T[] = []
      // 8,000 (2026-09-23) — this project's other large fetches use this
      // size successfully. The exit condition below only trusts a
      // genuinely empty page.
      const PAGE = 8000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await apply(sb.schema('inventory').from(table).select(select)).range(from, from + PAGE - 1)
        if (error) throw error
        const batch = (data ?? []) as T[]
        out.push(...batch)
        onPage?.(out.length)
        // Exit only on a genuinely empty page — the project's API "Max
        // Rows" setting silently caps every response at 1000 regardless of
        // the requested range, so a full page here doesn't mean "last page."
        if (batch.length === 0) break
      }
      return out
    }

    // Explicit column list — droptop_purchase_orders also carries a
    // raw_data jsonb column (Droptop's full raw API response per PO, never
    // read by this page). Confirmed via EXPLAIN ANALYZE (2026-09-23): with
    // select('*') this query took 2,430ms for 10,000 rows (width 1,206
    // bytes/row, forcing a heap fetch per row despite the covering index);
    // with just these columns it's 25ms (width 190 bytes) — a ~98x
    // difference using the exact same index. This, not row count, was the
    // real cause of the reported "hangs after loading the first page."
    const PO_COLUMNS = 'id, location_id, po_id, custom_po_id, supplier_name, po_status, approved_status, delivery_status, delivery_status_updated_timestamp, pay_status, total_cost, note, last_updated_user_name, created_timestamp, closed_timestamp, last_updated_timestamp, to_receive_timestamp'

    let poRows: PoRow[]
    try {
      const { count } = await sb.schema('inventory').from('droptop_purchase_orders')
        .select('id', { count: 'exact', head: true }).eq('company_id', companyId)
      setLoadProgress({ phase: 'pos', loaded: 0, total: count ?? null })
      poRows = await fetchAllRows<PoRow>(
        'droptop_purchase_orders',
        (q) => q.eq('company_id', companyId).order('created_timestamp', { ascending: false }),
        (loaded) => setLoadProgress((p) => ({ ...p, loaded })),
        PO_COLUMNS,
      )
    } catch (error: any) {
      toast.error(error.message?.includes('does not exist') ? 'Purchase order tables not found — apply migration 20260829_droptop_purchase_orders.sql' : error.message)
      setLoading(false)
      return
    }
    setPos(poRows)
    if (poRows.length) {
      // Filtered by company_id directly (a single value, not an .in() list
      // of every PO id) — avoids also risking a URL-length limit once the
      // PO count grows past a couple hundred.
      const { count: itemCount } = await sb.schema('inventory').from('droptop_purchase_order_items')
        .select('id', { count: 'exact', head: true }).eq('company_id', companyId)
      setLoadProgress({ phase: 'items', loaded: 0, total: itemCount ?? null })
      const itemRows = await fetchAllRows<PoItemRow & { purchase_order_id: string }>(
        'droptop_purchase_order_items', (q) => q.eq('company_id', companyId),
        (loaded) => setLoadProgress((p) => ({ ...p, loaded })),
      )
      const grouped: Record<string, PoItemRow[]> = {}
      for (const it of itemRows) (grouped[it.purchase_order_id] ??= []).push(it)
      setItemsByPo(grouped)
      poStatusCache.set(companyId, { pos: poRows, itemsByPo: grouped, ts: Date.now() })
    } else {
      setItemsByPo({})
      poStatusCache.set(companyId, { pos: poRows, itemsByPo: {}, ts: Date.now() })
    }
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])
  // Direct feedback 2026-09-25: removed the page's own Inspect/Sync Now
  // buttons — Droptop — Purchase Orders is already a registered connection
  // in useDataConnectionRunner.ts (CONNECTION_ORDER), so Data Connections'
  // own card already has a Run Now for this, and Inspect was a pure debug
  // tool. With no local "Sync Now" left to double as this page's own
  // refresh path (its previous reasoning for skipping usePageRevisit), this
  // page now catches up automatically when revisited — after triggering a
  // sync from Data Connections and coming back, or just returning to this
  // browser tab — same pattern as Comms/Alerts/Exceptions.
  usePageRevisit(load)

  const shopLabel = useCallback((id: string | null) => (id ? (loc.codeOf(id) || loc.labelOf(id)) : '—') || '—', [loc])

  // Structural pre-filters (shop/status/hide-closed) — go before useTable(),
  // per this app's own Template 1 convention (TABLE_TEMPLATES.md). Free-text
  // search is handled by the DataTable's own search box below instead (see
  // _searchText), not a bespoke input here.
  const visible = useMemo(() => {
    return pos.filter((p) => {
      if (fLocation && p.location_id !== fLocation) return false
      if (fStatus) { if (p.po_status !== fStatus) return false }
      else if (hideClosed && (p.po_status === 'closed' || p.po_status === 'cancelled')) return false
      return true
    })
  }, [pos, fLocation, fStatus, hideClosed])

  // Every product still outstanding on an open PO, grouped by shop — the
  // "what's already on order" view, independent of which specific PO it
  // came from.
  const onOrderByShop = useMemo(() => {
    const m = new Map<string, { product_id: string; qty: number; poIds: Set<string> }[]>()
    for (const p of pos) {
      if (!OPEN_STATUSES.has(p.po_status ?? '')) continue
      const items = itemsByPo[p.id] ?? []
      for (const it of items) {
        if (!it.product_id) continue
        const qty = outstandingQty(it)
        if (qty <= 0) continue
        const key = p.location_id ?? ''
        const list = m.get(key) ?? []
        const existing = list.find((r) => r.product_id === it.product_id)
        if (existing) { existing.qty += qty; existing.poIds.add(p.po_id) }
        else list.push({ product_id: it.product_id, qty, poIds: new Set([p.po_id]) })
        m.set(key, list)
      }
    }
    return m
  }, [pos, itemsByPo])

  const locationOptions = [{ value: '', label: 'All shops' }, ...loc.options]

  // ── Products currently on order, by shop — Template 1 (DataTable) ─────────
  const onOrderRows: OnOrderRow[] = useMemo(() => {
    const out: OnOrderRow[] = []
    for (const [locId, rows] of onOrderByShop.entries()) {
      for (const r of rows) out.push({ locId, product_id: r.product_id, qty: r.qty, poIds: [...r.poIds] })
    }
    return out
  }, [onOrderByShop])

  // po_id is only unique per (location, po_id) — see project_droptop_
  // purchase_orders.md's own cross-shop collision history — so this is
  // keyed by both, not bare po_id, before it's used to resolve a click in
  // the Products On Order table back to the exact right PO for that shop.
  const posByLocAndId = useMemo(() => {
    const m = new Map<string, PoRow>()
    for (const p of pos) m.set(`${p.location_id ?? ''}|${p.po_id}`, p)
    return m
  }, [pos])

  const onOrderCol = useMemo(() => createColumnHelper<OnOrderRow>(), [])
  const onOrderColumns = useMemo(() => [
    onOrderCol.accessor((r) => shopLabel(r.locId || null), { id: 'shop', header: 'Shop', size: 70 }),
    onOrderCol.accessor('product_id', { header: 'Product', size: 150 }),
    onOrderCol.accessor('qty', { header: 'Outstanding Qty', size: 130, cell: (i) => <div className="text-right">{num(i.getValue())}</div> }),
    // Fill column — a comma-joined PO list can run long, and this is the
    // last column, so it's the one that should absorb any extra width
    // instead of every column defaulting to an equal 150px each (which is
    // what left this table looking half-empty until manually resized).
    // Direct feedback 2026-09-25: each PO # is now its own clickable button
    // opening the same PO Details modal the main table's row click already
    // uses, instead of a plain comma-joined string.
    onOrderCol.accessor('poIds', {
      header: 'PO #', meta: { fill: true },
      cell: (i) => (
        <div className="flex flex-wrap gap-x-1.5 gap-y-0.5">
          {i.getValue().map((poId, idx) => {
            const po = posByLocAndId.get(`${i.row.original.locId}|${poId}`)
            return (
              <span key={poId}>
                {po ? (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setViewingPo(po) }}
                    className="text-navy underline decoration-dotted hover:text-sky">
                    {po.custom_po_id || po.po_id}
                  </button>
                ) : poId}
                {idx < i.getValue().length - 1 ? ',' : ''}
              </span>
            )
          })}
        </div>
      ),
    }),
  ], [onOrderCol, shopLabel, posByLocAndId])

  const { table: onOrderTable, globalFilter: onOrderSearch, setGlobalFilter: setOnOrderSearch } = useTable(onOrderRows, onOrderColumns, {
    persistKey: 'po-status:on-order',
    initialSorting: [{ id: 'qty', desc: true }],
  })

  // ── Main PO list — Template 1 (DataTable) ─────────────────────────────────
  const tableRows: PoTableRow[] = useMemo(() => visible.map((p) => {
    const items = itemsByPo[p.id] ?? []
    return {
      ...p,
      _itemCount: items.length,
      _searchText: `${p.po_id} ${p.custom_po_id ?? ''} ${p.supplier_name ?? ''} ${shopLabel(p.location_id)} ${items.map((i) => `${i.product_id ?? ''} ${i.name ?? ''}`).join(' ')}`.toLowerCase(),
    }
  }), [visible, itemsByPo, shopLabel])

  const poCol = useMemo(() => createColumnHelper<PoTableRow>(), [])
  const poColumns = useMemo(() => [
    poCol.accessor((r) => r.custom_po_id || r.po_id, { id: 'po_number', header: 'PO #' }),
    poCol.accessor((r) => shopLabel(r.location_id), { id: 'shop', header: 'Shop' }),
    poCol.accessor('supplier_name', { header: 'Supplier', cell: (i) => i.getValue() ?? '—' }),
    poCol.accessor('po_status', {
      header: 'Status',
      cell: (i) => <span className="rounded-full bg-sky/25 text-navy px-2 py-0.5 capitalize">{i.getValue() ?? '—'}</span>,
    }),
    poCol.accessor((r) => deliveryStatusLabel(r.delivery_status), { id: 'delivery_status', header: 'Delivery Status' }),
    poCol.accessor('delivery_status_updated_timestamp', { header: 'Delivery Updated', cell: (i) => dShort(i.getValue()) }),
    poCol.accessor('closed_timestamp', { header: 'Closed', cell: (i) => dShort(i.getValue()) }),
    poCol.accessor('created_timestamp', { header: 'Created', cell: (i) => dShort(i.getValue()) }),
    poCol.accessor('last_updated_timestamp', {
      header: 'Last Updated',
      cell: (i) => `${dTime(i.getValue())}${i.row.original.last_updated_user_name ? ` · ${i.row.original.last_updated_user_name}` : ''}`,
    }),
    poCol.accessor('total_cost', { header: 'Total', cell: (i) => <div className="text-right">{money(i.getValue())}</div> }),
    // Read-only count — the whole row opens the details modal (onRowClick
    // below), so this is informational, not a click target.
    poCol.accessor('_itemCount', {
      header: 'Items',
      cell: (i) => <span className="text-inky/70 whitespace-nowrap">{i.getValue()} item{i.getValue() !== 1 ? 's' : ''}</span>,
    }),
    // Hidden search index — lets the table's own search box match on line
    // item product id/name too, not just this PO's own visible columns.
    poCol.accessor('_searchText', { header: '', cell: () => null, enableSorting: false }),
  ], [poCol, shopLabel])

  const { table: poTable, globalFilter: poSearch, setGlobalFilter: setPoSearch } = useTable(tableRows, poColumns, {
    persistKey: 'po-status:pos',
    initialSorting: [{ id: 'created_timestamp', desc: true }],
    initialVisibility: { _searchText: false },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Purchase Orders</h1>
          <p className="text-xs text-inky mt-0.5">
            Purchase orders pulled from Droptop — status, line items, and what's still outstanding by shop.
          </p>
        </div>
      </div>

      <Tabs defaultValue="on-order">
        <TabsList>
          <TabsTrigger value="on-order">Products On Order</TabsTrigger>
          <TabsTrigger value="all-pos">All Purchase Orders</TabsTrigger>
        </TabsList>

        <TabsContent value="on-order">
          {/* Product-level rollup — what's on order per shop, regardless of
              which PO it's spread across. */}
          <Card><CardBody className="flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Products currently on order, by shop</span>
            {loading ? (
              <div className="py-8 flex justify-center"><SbLoader size={28} /></div>
            ) : onOrderRows.length === 0 ? (
              <p className="text-xs font-mono text-inky/50 italic py-4">Nothing currently outstanding.</p>
            ) : (
              <DataTable table={onOrderTable} globalFilter={onOrderSearch} onGlobalFilterChange={setOnOrderSearch} exportFilename="Products On Order" />
            )}
          </CardBody></Card>
        </TabsContent>

        <TabsContent value="all-pos">
          <div className="flex flex-col gap-4">
            <Card><CardBody className="flex items-end gap-3 flex-wrap py-3">
              <div className="w-56"><Combobox label="Shop" options={locationOptions} value={fLocation} onChange={setFLocation} /></div>
              <div className="w-44">
                <Select label="Status" value={fStatus} onChange={(e) => setFStatus(e.target.value)} options={STATUS_OPTIONS} />
              </div>
              {!fStatus && (
                <label className="flex items-center gap-2 text-xs font-mono text-inky pb-2">
                  <Toggle checked={hideClosed} onChange={setHideClosed} size="sm" color="cyan" />
                  Hide closed/cancelled
                </label>
              )}
              <span className="text-[11px] font-mono text-inky/50 pb-2 ml-auto">{pos.length.toLocaleString()} PO{pos.length !== 1 ? 's' : ''} total</span>
            </CardBody></Card>

            {loading ? (
              <LoadingProgress
                fraction={loadProgress.total ? loadProgress.loaded / loadProgress.total : null}
                countText={
                  loadProgress.total
                    ? `Loading ${loadProgress.phase === 'pos' ? 'purchase orders' : 'line items'} — ${loadProgress.loaded.toLocaleString()} of ${loadProgress.total.toLocaleString()} (${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%)`
                    : loadProgress.loaded > 0
                      ? `Loading ${loadProgress.phase === 'pos' ? 'purchase orders' : 'line items'} — ${loadProgress.loaded.toLocaleString()} loaded so far…`
                      : 'Loading purchase orders…'
                }
                messages={[
                  'Pulling purchase orders from Droptop…',
                  'Matching line items to their orders…',
                  'Tallying what’s still outstanding…',
                ]}
              />
            ) : (
              <DataTable table={poTable} globalFilter={poSearch} onGlobalFilterChange={setPoSearch} exportFilename="Purchase Orders" onRowClick={setViewingPo} />
            )}
          </div>
        </TabsContent>
      </Tabs>

      <Modal open={!!viewingPo} onClose={() => setViewingPo(null)} title={`PO Details — ${viewingPo ? (viewingPo.custom_po_id || viewingPo.po_id) : ''}`} size="lg">
        {viewingPo && (
          <div className="flex flex-col gap-3">
            {/* Header details — the row itself already opens this, so it
                doubles as "PO details" and "line items" in one modal. */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-[11px] font-mono">
              <div><span className="text-inky/50 uppercase tracking-wide block">Shop</span><span className="text-navy">{shopLabel(viewingPo.location_id)}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Supplier</span><span className="text-navy">{viewingPo.supplier_name ?? '—'}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Status</span><span className="text-navy capitalize">{viewingPo.po_status ?? '—'}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Delivery Status</span><span className="text-navy">{deliveryStatusLabel(viewingPo.delivery_status)}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Created</span><span className="text-navy">{dShort(viewingPo.created_timestamp)}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Closed</span><span className="text-navy">{dShort(viewingPo.closed_timestamp)}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Last Updated</span><span className="text-navy">{dTime(viewingPo.last_updated_timestamp)}{viewingPo.last_updated_user_name ? ` · ${viewingPo.last_updated_user_name}` : ''}</span></div>
              <div><span className="text-inky/50 uppercase tracking-wide block">Total</span><span className="text-navy">{money(viewingPo.total_cost)}</span></div>
            </div>
            {viewingPo.note && <p className="text-[11px] font-mono text-inky/60">Note: {viewingPo.note}</p>}
            <div className="overflow-auto max-h-96 rounded border border-navy/20">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-cream"><tr className="text-inky/60 uppercase border-b border-navy/20">
                  <th className="text-left px-2 py-1">Product</th><th className="text-left px-2 py-1">UOM</th>
                  <th className="text-right px-2 py-1">Qty</th><th className="text-right px-2 py-1">Received</th>
                  <th className="text-right px-2 py-1">Outstanding</th><th className="text-right px-2 py-1">Unit Cost</th><th className="text-right px-2 py-1">Total</th>
                </tr></thead>
                <tbody>
                  {(itemsByPo[viewingPo.id] ?? []).map((it) => (
                    <tr key={it.id} className="border-t border-navy/10">
                      <td className="px-2 py-1 text-navy">{it.product_id ?? it.name ?? '—'}</td>
                      <td className="px-2 py-1 text-inky/70">{it.purchase_uom ?? '—'}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{num(it.quantity)}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{num(it.received_quantity)}</td>
                      <td className="px-2 py-1 text-right text-navy">{num(outstandingQty(it))}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{money(it.unit_cost)}</td>
                      <td className="px-2 py-1 text-right text-navy">{money(it.total_cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
