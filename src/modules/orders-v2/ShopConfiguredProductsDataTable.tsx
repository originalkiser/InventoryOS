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
import { useMemo, useState, useEffect, useRef } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Pencil, Plus } from 'lucide-react'
import { DataTable } from '@/components/shared/DataTable'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { daysOfSupply, gallonsPerUnit } from './engine'
import { DOS_COLOR_LEGEND, dos, money, num } from './shared'
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

// Same focus-preserving controlled-input pattern as OrdersV2ReviewTable's
// own QtyInput (see that file's own comment on the re-render-clobbers-typing
// bug this avoids) — for an existing line. A configured-but-not-yet-ordered
// candidate keeps SmoothingRow's original uncontrolled blur-to-add input,
// since there's no live value for it to clobber.
function ShopProductQtyInput({ line, onPatch }: { line: DraftLineRow; onPatch: (l: DraftLineRow, qty: number) => void }) {
  const [text, setText] = useState(() => String(line.qty))
  const lastCommittedRef = useRef<number>(Number(line.qty))
  useEffect(() => {
    if (Number(line.qty) !== lastCommittedRef.current) {
      setText(String(line.qty))
      lastCommittedRef.current = Number(line.qty)
    }
  }, [line.qty])
  return (
    <input type="number" min={0} step={line.uom === 'bulk' ? 0.1 : 1} value={text}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value) || 0
        lastCommittedRef.current = n
        onPatch(line, n)
      }}
      className="w-16 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
  )
}

export function ShopConfiguredProductsDataTable({ rows, onPatch, onAdd, showVmi, ozProductIds, exceptionFor, onOpenException, leadDays, dosAfterColorClass }: {
  rows: ShopProductRow[]
  onPatch: (line: DraftLineRow, qty: number) => void
  onAdd: (input: GenerationInput, qty: number) => void
  dosAfterColorClass?: (v: number | null) => string
  showVmi: boolean
  ozProductIds: Set<string>
  exceptionFor: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>['rows'][number] | null
  onOpenException: (locationId: string, productId: string) => void
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
    col.display({
      id: 'qty', header: 'Qty', meta: { noClip: true }, enableSorting: false,
      cell: (i) => {
        const r = i.row.original
        const d = deriveRow(r, leadDays)
        const isOz = ozProductIds.has(d.productId)
        return (
          <div className="flex items-start justify-end gap-1">
            <div>
              {r.line ? (
                <ShopProductQtyInput line={r.line} onPatch={onPatch} />
              ) : r.input ? (
                <input type="number" min={0} step={d.uom === 'bulk' ? 0.1 : 1} defaultValue="" placeholder="0"
                  onBlur={(e) => { const v = Number(e.target.value) || 0; if (v > 0) onAdd(r.input!, v) }}
                  title="Add this product to the order"
                  className="w-16 bg-transparent border border-navy/20 rounded px-1 py-0.5 text-right text-inky/60 focus:outline-none focus:ring-1 focus:ring-sky" />
              ) : null}
              {isOz && r.line && d.quartsPerUnit != null && (
                <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(r.line.qty) * d.quartsPerUnit * 32, 0)}oz</div>
              )}
            </div>
            {d.locationId && d.productId && (
              <button
                onClick={() => onOpenException(d.locationId, d.productId)}
                title={exceptionFor(d.locationId, d.productId) ? 'Edit product exception' : 'Add product exception'}
                className="text-inky/40 hover:text-navy flex-shrink-0 mt-0.5">
                {exceptionFor(d.locationId, d.productId) ? <Pencil className="w-3 h-3" /> : <Plus className="w-3.5 h-3.5" />}
              </button>
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
      id: 'why', header: 'Why', enableSorting: false, enableColumnFilter: false,
      cell: (i) => {
        const d = deriveRow(i.row.original, leadDays)
        return <span className={d.whyClass}>{d.why}</span>
      },
    }),
  ], [col, leadDays, ozProductIds, onPatch, onAdd, exceptionFor, onOpenException, dosAfterColorClass])

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
