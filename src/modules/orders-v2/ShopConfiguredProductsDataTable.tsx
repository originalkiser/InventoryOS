// New (2026-09-30), opt-in DataTable/Manage-Columns rebuild of
// ShopConfiguredProductsTable (OrdersV2Review.tsx) — same "shop's full
// configured product list" sub-table, rebuilt onto this app's standard
// useTable/DataTable/useColumnPrefs/ColumnManagerModal stack so it matches
// the main lines table whenever "New Table (Beta)" is on. Direct ask
// 2026-09-30: "If the user is using the new table (beta), this modal table
// should be the new table as well ... whole thing, not this different
// style" — covers the old table's own row-expand, the "Shops With No
// Orders" panel, the "Popup" modal, and the beta table's own row-expand.
//
// Deliberately a DROP-IN replacement — same exact prop interface as
// ShopConfiguredProductsTable, so every call site just swaps the component
// based on `useNewTable` with no other wiring changes. All per-row math
// (on-hand/DOS-now/DOS-after/why) is copied verbatim from SmoothingRow
// (OrdersV2Review.tsx) rather than reimplemented, so the two tables can
// never quietly disagree on a number.
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { DataTable } from '@/components/shared/DataTable'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { daysOfSupply, gallonsPerUnit } from './engine'
import { DOS_COLOR_LEGEND, dos, money, num, dShort } from './shared'
import { QtyStepper, ZeroReasonButtons, isZeroAdjusted, type ZeroReason } from './lineControls'
import type { LastInfoFor } from './OrdersV2Review'
import { uomDisplayLabel } from './types'
import type { DraftLineRow } from './useOrdersV2'
import type { useProductExceptions } from './useProductExceptions'
import type { GenerationInput } from './types'

const TABLE_KEY = 'orders-v2.shop-products-datatable'

type ShopProductRow = { input?: GenerationInput; line?: DraftLineRow }

// Same per-row math as SmoothingRow (OrdersV2Review.tsx) — copied verbatim,
// not reimplemented, so this table can never drift from the old one's
// numbers. See that component's own comments for the reasoning behind each
// of these (combined on-hand, delivery-projected On Hand/DOS After, etc.).
function deriveRow(r: ShopProductRow, leadDays: number) {
  const { input, line } = r
  const productId = line?.product_id ?? input?.product_id ?? ''
  const locationId = line?.location_id ?? input?.location_id ?? ''
  const unitCost = Number(line?.unit_cost ?? input?.rule.unit_cost ?? 0)
  const uom = line?.uom ?? input?.rule.uom ?? null
  const capacity = line?.max_capacity_gallons ?? input?.rule.max_capacity_gallons ?? null
  const onHand = line?.on_hand ?? input?.on_hand ?? null
  const dailyUsage = line?.daily_usage ?? input?.daily_usage ?? null
  const dosNow = line?.dos_before ?? daysOfSupply(onHand, dailyUsage)
  const why = line?.triggered_smoothing ? 'triggered smoothing'
    : line?.added_by_smoothing ? 'added to reach minimum'
    : 'not on order'
  const whyClass = line?.triggered_smoothing ? 'text-[#C0392B]'
    : line?.added_by_smoothing ? 'text-sky'
    : 'text-inky/40'
  const quartsPerUnit = line?.quarts_per_unit ?? (input ? gallonsPerUnit(input.rule) : null)
  const qty = line ? Number(line.qty) : 0
  const remainingAtDelivery = Math.max(0, Number(onHand ?? 0) - Number(dailyUsage ?? 0) * leadDays)
  const onHandAfter = remainingAtDelivery + qty * Number(quartsPerUnit ?? 1)
  const dosAfter = Number(dailyUsage ?? 0) > 0 ? onHandAfter / Number(dailyUsage) : null
  return { productId, locationId, unitCost, uom, capacity, onHand, dailyUsage, dosNow, why, whyClass, quartsPerUnit, qty, onHandAfter, dosAfter }
}

export function ShopConfiguredProductsDataTable({ rows, onPatch, onAdd, showVmi, ozProductIds, leadDays, dosAfterColorClass, lastInfoFor, onZeroReason, tall }: {
  rows: ShopProductRow[]
  // Optional Last Ordered / Last Delivered columns (see useLastOrderedInfo().infoFor).
  lastInfoFor?: LastInfoFor
  // Optional "why zero?" buttons on a line adjusted to 0.
  onZeroReason?: (line: DraftLineRow, reason: ZeroReason | null, note: string | null) => void
  // Taller body for the shop popup — about 18 products without scrolling.
  tall?: boolean
  onPatch: (line: DraftLineRow, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
  dosAfterColorClass?: (v: number | null) => string
  showVmi: boolean
  ozProductIds: Set<string>
  exceptionFor?: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>["rows"][number] | null
  onOpenException?: (locationId: string, productId: string) => void
  leadDays: number
}) {
  const [columnManagerOpen, setColumnManagerOpen] = useState(false)

  const visible = showVmi ? rows : rows.filter((r) =>
    !(r.input?.rule.vmi_keepfill_enabled || r.line?.flags?.includes('vmi_keepfill')))

  const col = useMemo(() => createColumnHelper<ShopProductRow>(), [])
  const columns = useMemo(() => [
    col.accessor((r) => deriveRow(r, leadDays).productId, {
      id: 'product', header: 'Product',
    }),
    col.accessor((r) => uomDisplayLabel(deriveRow(r, leadDays).uom), {
      id: 'uom', header: 'UOM', enableSorting: false,
    }),
    col.accessor((r) => {
      const d = deriveRow(r, leadDays)
      const isOz = ozProductIds.has(d.productId)
      return isOz ? (d.capacity ?? 0) * 32 : d.capacity
    }, {
      id: 'capacity', header: 'Capacity', cell: (i) => <span className="block text-right">{num(i.getValue(), 0)}</span>,
    }),
    col.display({
      id: 'on_hand', header: 'On Hand', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const r = i.row.original
        const d = deriveRow(r, leadDays)
        const isOz = ozProductIds.has(d.productId)
        const toOz = (v: number | null | undefined) => (v == null ? v : v * 32)
        return (
          <div className="text-right">
            {num(isOz ? toOz(d.onHand) : d.onHand)}
            {r.input?.equivalent_products && r.input.equivalent_products.length > 0 && (
              <div className="text-[9px] text-inky/50 leading-tight font-normal text-left">
                <div className="text-sky font-bold uppercase tracking-wide">Combining On Hands</div>
                <div>{d.productId}: {num(r.input.own_on_hand)}</div>
                {r.input.equivalent_products.map((e) => (
                  <div key={e.product_id}>{e.product_id}: {num(e.on_hand)}</div>
                ))}
              </div>
            )}
          </div>
        )
      },
    }),
    col.accessor((r) => {
      const d = deriveRow(r, leadDays)
      const isOz = ozProductIds.has(d.productId)
      return isOz ? (d.dailyUsage == null ? null : d.dailyUsage * 32) : d.dailyUsage
    }, {
      id: 'usage_day', header: 'Usage/day', enableSorting: false, cell: (i) => <span className="block text-right">{num(i.getValue())}</span>,
    }),
    col.accessor((r) => deriveRow(r, leadDays).dosNow, {
      id: 'dos_now', header: 'DOS Now', enableSorting: false, cell: (i) => <span className="block text-right">{dos(i.getValue())}</span>,
    }),
    ...(lastInfoFor ? [
      col.display({
        id: 'last_ordered', header: 'Last Ordered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
        cell: (i) => {
          const d = deriveRow(i.row.original, leadDays)
          const info = lastInfoFor(d.locationId, d.productId, d.onHand, d.dailyUsage)
          return info.lastOrderDate ? (
            <div className="whitespace-nowrap">
              <div>{dShort(info.lastOrderDate)} · {num(info.lastOrderQty, 1)}{info.lastOrderUom ? ` ${info.lastOrderUom}` : ''}</div>
              {info.eta && <div className="text-[9px] text-inky/50">ETA {dShort(info.eta)}</div>}
            </div>
          ) : '—'
        },
      }),
      col.display({
        id: 'last_delivered', header: 'Last Delivered', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
        cell: (i) => {
          const d = deriveRow(i.row.original, leadDays)
          const info = lastInfoFor(d.locationId, d.productId, d.onHand, d.dailyUsage)
          return <span className="whitespace-nowrap">{info.lastDeliveredDate
            ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)}${info.lastDeliveredUnit === 'gal' ? ' gal' : ''}`
            : '—'}</span>
        },
      }),
    ] : []),
    col.display({
      id: 'qty', header: 'Qty', meta: { noClip: true }, enableSorting: false,
      cell: (i) => {
        const r = i.row.original
        const d = deriveRow(r, leadDays)
        const isOz = ozProductIds.has(d.productId)
        return (
          <div className="flex flex-col items-end">
            {r.line ? (
              <QtyStepper value={Number(r.line.qty)} bulk={d.uom === 'bulk'} align="text-right" onChange={(n) => onPatch(r.line!, n)} />
            ) : r.input ? (
              <QtyStepper value={0} bulk={d.uom === 'bulk'} align="text-right" commitOn="blur" muted onChange={(n) => { if (n > 0) onAdd(r.input!, n) }} />
            ) : null}
            {isOz && r.line && d.quartsPerUnit != null && (
              <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(r.line.qty) * d.quartsPerUnit * 32, 0)}oz</div>
            )}
          </div>
        )
      },
    }),
    col.accessor((r) => {
      const d = deriveRow(r, leadDays)
      const isOz = ozProductIds.has(d.productId)
      return isOz ? d.onHandAfter * 32 : d.onHandAfter
    }, {
      id: 'on_hand_after', header: 'On Hand After', enableSorting: false, cell: (i) => <span className="block text-right">{num(i.getValue())}</span>,
    }),
    col.accessor((r) => deriveRow(r, leadDays).dosAfter, {
      id: 'dos_after', header: 'DOS After', enableSorting: false,
      cell: (i) => (
        <span title={dosAfterColorClass ? DOS_COLOR_LEGEND : undefined}
          className={`block text-right ${dosAfterColorClass ? `font-bold ${dosAfterColorClass(i.getValue())}` : ''}`}>
          {dos(i.getValue())}
        </span>
      ),
    }),
    col.accessor((r) => {
      const d = deriveRow(r, leadDays)
      return d.qty * d.unitCost
    }, {
      id: 'dollars', header: '$', enableSorting: false, cell: (i) => <span className="block text-right">{money(i.getValue())}</span>,
    }),
    col.display({
      id: 'why', header: 'Why', enableSorting: false, enableColumnFilter: false, meta: { noClip: true },
      cell: (i) => {
        const r = i.row.original
        const d = deriveRow(r, leadDays)
        return (
          <>
            <span className={d.whyClass}>{d.why}</span>
            {r.line && onZeroReason && isZeroAdjusted(r.line) && <ZeroReasonButtons line={r.line} onChange={(rs, n) => onZeroReason(r.line!, rs, n)} />}
          </>
        )
      },
    }),
  ], [col, leadDays, ozProductIds, onPatch, onAdd, dosAfterColorClass, lastInfoFor, onZeroReason])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(visible, columns, {
    persistKey: TABLE_KEY,
    initialPageSize: 50,
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
    setColumnPinning({ left: [], right: [] })
  }

  if (!visible.length) return <p className="text-[11px] font-mono text-inky/50 py-2">Nothing configured for this shop.</p>

  return (
    <>
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        hideColumnControl
        hideExport
        bodyMaxHeightClass={tall ? 'max-h-[calc(90vh-13rem)]' : undefined}
        actions={
          <button onClick={() => setColumnManagerOpen(true)} className="text-xs font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">Manage Columns</button>
        }
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
