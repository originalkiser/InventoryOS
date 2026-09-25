// New (2026-09-25), opt-in rebuild of OrdersV2Review's main lines table onto
// this app's standard useTable/DataTable/useColumnPrefs/ColumnManagerModal
// stack — same pattern as ExceptionTable.tsx and OrdersV2FinalReview.tsx's
// own rebuilds. Gated behind a "New table (beta)" toggle in
// OrdersV2Review.tsx (localStorage, default OFF) rather than replacing the
// existing hand-rolled table outright — direct ask: keep the proven table
// live for real orders while this one gets tested alongside it.
//
// Deliberately a "dumb", fully prop-driven presentational component: every
// piece of business logic (live DOS/on-hand-after recompute, minimum
// checks, PO-decision handling, shop-expand candidate lists) stays owned by
// OrdersV2Review.tsx exactly as it already is — this component only
// renders whatever it's handed. That's what makes "live calculations and
// conditional formatting keep working" true by construction: the values
// and classNames it renders are computed by the exact same functions the
// old table already calls, not a reimplementation.
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { ChevronDown, ChevronRight, Pencil, Plus } from 'lucide-react'
import { DataTable } from '@/components/shared/DataTable'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import type { useLastOrderedInfo } from './useLastOrderedInfo'
import type { useProductExceptions } from './useProductExceptions'
import type { DraftLineRow, DraftRow } from './useOrdersV2'
import { ShopConfiguredProductsTable, PoDecisionButtons, Flags } from './OrdersV2Review'
import { OVERRIDE_CELL, dos, money, num, dShort } from './shared'
import type { GenerationInput, LineFlag } from './types'

const TABLE_KEY = 'orders-v2.review-lines'
const DEFAULT_PINNED = ['shop']

export function OrdersV2ReviewTable({
  lines, draft, shopLabel, ozProductIds, lastOrderedInfo, deliveryFor, describeSchedule,
  liveFlags, dosAfterColorClass, groupMinimumStatus, patchQty, exceptionFor, onOpenException,
  decidePoOverride, decidePoExclude, decidePoCombine, includeToggle, onRemoveLine,
  expanded, onToggleExpand, shopRows, onAddConfiguredProduct, showConfigVmi, leadDaysFor,
  inputByLineKey,
}: {
  lines: DraftLineRow[]
  draft: DraftRow
  shopLabel: (id: string | null) => string
  ozProductIds: Set<string>
  lastOrderedInfo: ReturnType<typeof useLastOrderedInfo>
  deliveryFor: (locationId: string | null, fromDate: string) => string | null
  describeSchedule: (locationId: string | null) => string | null
  liveFlags: (l: DraftLineRow) => LineFlag[]
  dosAfterColorClass: (v: number | null) => string
  groupMinimumStatus: Map<string, boolean>
  patchQty: (l: DraftLineRow, qty: number) => void
  exceptionFor: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>['rows'][number] | null
  onOpenException: (locationId: string, productId: string) => void
  decidePoOverride: (l: DraftLineRow) => void
  decidePoExclude: (l: DraftLineRow) => void
  decidePoCombine: (l: DraftLineRow) => void
  includeToggle: (l: DraftLineRow) => void
  onRemoveLine: (id: string) => void
  expanded: Set<string>
  onToggleExpand: (locId: string) => void
  shopRows: (locId: string) => { input?: GenerationInput; line?: DraftLineRow }[]
  onAddConfiguredProduct: (input: GenerationInput, qty: number) => void
  showConfigVmi: boolean
  leadDaysFor: (locId: string) => number
  inputByLineKey: Map<string, GenerationInput>
}) {
  const [columnManagerOpen, setColumnManagerOpen] = useState(false)

  // Stable per-shop "anchor" row for the expand content — the FIRST line
  // for that location in the CURRENT (pre-sort) data, not "last of shop in
  // sorted order" like the old table used. Deliberately sort-independent:
  // the old table's own anchor already moved around under a re-sort (it
  // was always whichever row was LAST for that shop in whatever order was
  // on screen); picking a fixed anchor from the underlying data instead
  // means the expand toggle and its content always live on the same
  // physical row regardless of which column is currently sorted, at the
  // cost of that row not always being the visually-last one for its shop.
  const anchorLineId = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of lines) { const k = l.location_id ?? ''; if (!m.has(k)) m.set(k, l.id) }
    return m
  }, [lines])

  const col = useMemo(() => createColumnHelper<DraftLineRow>(), [])
  const columns = useMemo(() => [
    col.accessor((l) => shopLabel(l.location_id), {
      id: 'shop', header: 'Shop',
      cell: (i) => {
        const l = i.row.original
        const locId = l.location_id ?? ''
        const open = expanded.has(locId)
        return (
          <button onClick={() => onToggleExpand(locId)} title="Show every product configured for this shop"
            className="inline-flex items-center gap-1 hover:underline hover:text-sky">
            {open ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
            {i.getValue()}
          </button>
        )
      },
    }),
    col.accessor('product_id', { id: 'product', header: 'Product' }),
    col.accessor((l) => l.uom ?? '—', { id: 'uom', header: 'UOM', enableSorting: false }),
    col.accessor((l) => (ozProductIds.has(l.product_id) ? (l.max_capacity_gallons ?? 0) * 32 : l.max_capacity_gallons), {
      id: 'capacity', header: 'Capacity', cell: (i) => <span className="block text-right">{num(i.getValue(), 0)}</span>,
    }),
    col.display({
      id: 'on_hand', header: 'On Hand', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const isOz = ozProductIds.has(l.product_id)
        const toOz = (v: number | null | undefined) => (v == null ? v : v * 32)
        const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
        const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
        return (
          <div className="text-right">
            {num(isOz ? toOz(input?.own_on_hand ?? l.on_hand) : (input?.own_on_hand ?? l.on_hand))}
            {input?.equivalent_products && input.equivalent_products.length > 0 && (
              <div className="text-[9px] text-inky/50 leading-tight font-normal text-left">
                <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
                {input.equivalent_products.map((e) => <div key={e.product_id}>{e.product_id}: {num(e.on_hand)}</div>)}
              </div>
            )}
            {info.onHandCheck && !info.onHandCheck.withinRange && (
              <div className="text-[9px] text-[#C0392B] font-bold mt-0.5 normal-case"
                title={`Based on the last delivery, on hand was expected to be roughly ${num(info.onHandCheck.expected)} (${num(info.onHandCheck.low)}–${num(info.onHandCheck.high)})`}>
                ⚠ On hand may be off
              </div>
            )}
          </div>
        )
      },
    }),
    col.accessor((l) => (ozProductIds.has(l.product_id) ? (l.daily_usage ?? 0) * 32 : l.daily_usage), {
      id: 'usage_day', header: 'Usage/day', enableSorting: false, cell: (i) => <span className="block text-right">{num(i.getValue())}</span>,
    }),
    col.accessor('dos_before', { id: 'dos_now', header: 'DOS Now', enableSorting: false, cell: (i) => <span className="block text-right">{dos(i.getValue())}</span> }),
    col.display({
      id: 'last_ordered', header: 'Last Ordered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
        return info.lastOrderDate ? (
          <>
            <div>{dShort(info.lastOrderDate)} · {num(info.lastOrderQty, 1)}{info.lastOrderUom ? ` ${info.lastOrderUom}` : ''}</div>
            {info.eta && <div className="text-[9px] text-inky/50">ETA {dShort(info.eta)}</div>}
          </>
        ) : '—'
      },
    }),
    col.display({
      id: 'last_delivered', header: 'Last Delivered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const info = lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
        return info.lastDeliveredDate
          ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)}${info.lastDeliveredUnit === 'gal' ? ' gal' : ''}`
          : '—'
      },
    }),
    col.display({
      id: 'delivery_date', header: 'Delivery', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const dd = deliveryFor(l.location_id, draft.order_date)
        const sd = describeSchedule(l.location_id)
        return (
          <>
            <div>{dd ? dShort(dd) : '—'}</div>
            {sd && <div className="text-[9px] text-inky/50">{sd}</div>}
          </>
        )
      },
    }),
    col.accessor('qty', {
      id: 'qty', header: 'Qty', meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        const isOz = ozProductIds.has(l.product_id)
        return (
          <div className={l.is_override ? OVERRIDE_CELL : ''}>
            <div className="flex items-start justify-end gap-1">
              <div>
                <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                  onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
                  className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                {l.quarts_per_unit != null && (
                  <div className="text-[10px] text-inky/50 mt-0.5">
                    {isOz ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)}oz` : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`}
                  </div>
                )}
              </div>
              <button onClick={() => onOpenException(l.location_id ?? '', l.product_id)}
                title={exceptionFor(l.location_id ?? '', l.product_id) ? 'Edit product exception' : 'Add product exception'}
                className="text-inky/40 hover:text-navy flex-shrink-0 mt-1.5">
                {exceptionFor(l.location_id ?? '', l.product_id) ? <Pencil className="w-3 h-3" /> : <Plus className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        )
      },
    }),
    col.accessor((l) => {
      const isOz = ozProductIds.has(l.product_id)
      const v = Number(l.on_hand ?? 0) + Number(l.qty) * Number(l.quarts_per_unit ?? 1)
      return isOz ? v * 32 : v
    }, { id: 'on_hand_after', header: 'On Hand After', enableSorting: false, cell: (i) => <span className="block text-right">{num(i.getValue())}</span> }),
    col.accessor('dos_after', {
      id: 'dos_after', header: 'DOS After',
      cell: (i) => <span className={`block text-right font-bold ${dosAfterColorClass(i.getValue())}`}>{dos(i.getValue())}</span>,
    }),
    col.accessor('dos_after_delivery', { id: 'dos_at_delivery', header: 'DOS @ Delivery', enableSorting: false, cell: (i) => <span className="block text-right">{dos(i.getValue())}</span> }),
    col.accessor((l) => Number(l.qty) * Number(l.unit_cost ?? 0), { id: 'dollars', header: '$', cell: (i) => <span className="block text-right">{money(i.getValue())}</span> }),
    col.display({
      id: 'flags', header: 'Flags', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const l = i.row.original
        return (
          <>
            <Flags flags={liveFlags(l)} />
            {l.note && <div className="text-[10px] font-mono text-inky/60 italic mt-0.5">{l.note}</div>}
            {(l.flags ?? []).includes('covered_by_open_po') && (
              <PoDecisionButtons line={l} onOverride={decidePoOverride} onExclude={decidePoExclude} onCombine={decidePoCombine} />
            )}
          </>
        )
      },
    }),
    col.display({
      id: 'actions', header: '', enableSorting: false, enableColumnFilter: false,
      cell: (i) => {
        const l = i.row.original
        return (
          <div className="flex items-center gap-1">
            <button title={l.included ? 'Exclude from order' : 'Include in order'} onClick={() => includeToggle(l)}
              className="text-[10px] border border-navy/30 rounded px-1 py-0.5 text-inky hover:border-navy">
              {l.included ? 'Exclude' : 'Include'}
            </button>
            <button title="Remove line" onClick={() => onRemoveLine(l.id)} className="text-inky/40 hover:text-[#C0392B]">✕</button>
          </div>
        )
      },
    }),
  ], [col, shopLabel, ozProductIds, inputByLineKey, lastOrderedInfo, deliveryFor, describeSchedule, draft.order_date,
      patchQty, exceptionFor, onOpenException, dosAfterColorClass, liveFlags, decidePoOverride, decidePoExclude,
      decidePoCombine, includeToggle, onRemoveLine, expanded, onToggleExpand])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(lines, columns, {
    persistKey: TABLE_KEY,
    initialPageSize: 50,
    initialSorting: [{ id: 'shop', desc: false }],
    initialColumnPinning: { left: DEFAULT_PINNED, right: [] },
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  const allColItems: ColItem[] = useMemo(
    () => table.getAllLeafColumns().map((c) => ({ id: c.id, label: String(c.columnDef.header ?? c.id) })),
    [table],
  )
  const shownOrder = useMemo(() => {
    const ids = table.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return ids
    const known = columnOrder.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !known.includes(id))]
  }, [table, columnOrder])
  function applyShownColumns(shown: string[]) {
    setColumnOrder(shown)
    const vis: Record<string, boolean> = {}
    for (const c of allColItems) vis[c.id] = shown.includes(c.id)
    table.setColumnVisibility(vis)
  }
  function resetColumns() {
    setColumnOrder([])
    table.setColumnVisibility({})
    table.setColumnSizing({})
    setColumnPinning({ left: DEFAULT_PINNED, right: [] })
  }

  // Same-band-per-shop grouping as the old table — computed off the live
  // sorted/filtered row order DataTable is about to render, same trade-off
  // already accepted on Final Review's own rebuild (re-sorting by another
  // column still alternates on shop changes, just won't read as a clean
  // per-shop grouping once the shop column itself isn't the active sort).
  const pageRows = table.getRowModel().rows
  const bandOf = new Map<string, boolean>()
  {
    let prevShop: string | null = null
    let band = false
    for (const r of pageRows) {
      const shopId = r.original.location_id
      if (shopId !== prevShop) { band = !band; prevShop = shopId }
      bandOf.set(r.original.id, band)
    }
  }

  if (!lines.length) return <p className="text-xs font-mono text-inky/50 py-8">Nothing to show for this filter.</p>

  return (
    <>
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={`Order Review - ${draft.order_date}`}
        hideColumnControl
        // belowMin can only ever be true for an included line (see
        // groupMinimumStatus's own gating in OrdersV2Review.tsx), so this
        // never has to arbitrate between "dim" and "below minimum" for the
        // same row — they're mutually exclusive by construction.
        getRowClassName={(l) => {
          if (!l.included) return 'bg-[#E4E4DC] dark:bg-[#16222E]'
          const belowMin = groupMinimumStatus.get(`${l.location_id}|${l.order_type}`) === false
          if (belowMin) return 'bg-[#F4DBD4] dark:bg-[#3A1F1C]'
          return bandOf.get(l.id) ? 'bg-[#EAEBDF] dark:bg-[#15283C]' : ''
        }}
        expandedRowRender={(l) => {
          const locId = l.location_id ?? ''
          if (!expanded.has(locId) || anchorLineId.get(locId) !== l.id) return null
          return (
            <div className="px-3 py-2">
              <p className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-1">
                Every product configured for {shopLabel(l.location_id)}
                {(() => {
                  const dd = deliveryFor(l.location_id, draft.order_date)
                  const sd = describeSchedule(l.location_id)
                  return dd ? <span className="normal-case text-inky/50"> · Delivers {dShort(dd)}{sd ? ` (${sd})` : ''}</span> : null
                })()}
              </p>
              <ShopConfiguredProductsTable
                rows={shopRows(locId)}
                onPatch={patchQty}
                onAdd={onAddConfiguredProduct}
                showVmi={showConfigVmi}
                ozProductIds={ozProductIds}
                exceptionFor={exceptionFor}
                onOpenException={onOpenException}
                leadDays={leadDaysFor(locId)}
              />
            </div>
          )
        }}
        actions={<button onClick={() => setColumnManagerOpen(true)} className="text-xs font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">Manage Columns</button>}
      />
      <ColumnManagerModal
        open={columnManagerOpen}
        onClose={() => setColumnManagerOpen(false)}
        all={allColItems.filter((c) => c.id !== 'select')}
        shown={shownOrder.filter((id) => id !== 'select')}
        onChange={applyShownColumns}
        onReset={resetColumns}
        pinned={columnPinning.left ?? []}
        onPinChange={(left) => setColumnPinning({ left, right: [] })}
      />
    </>
  )
}
