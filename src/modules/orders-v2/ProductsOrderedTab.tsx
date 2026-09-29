import { useCallback, useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useLocations } from '@/hooks/useLocations'
import { useAllOrderHistoryLines, type OrderHistoryLineRow } from './useOrderHistory'
import { useVendors } from './useLookups'
import { dShort, money, num } from './shared'

const col = createColumnHelper<OrderHistoryLineRow>()

/**
 * "Products Ordered" — every completed order line across every vendor, by
 * date and shop (direct ask 2026-09-29: "similar to the Valvoline order
 * database" but not vendor-specific). Sourced from ov2_order_history_lines,
 * which markDraftComplete (useOrderHistory.ts) keeps refreshed to match the
 * draft's current state on every export, so this never goes stale the way a
 * one-shot finalize snapshot would.
 */
export function ProductsOrderedTab() {
  const loc = useLocations()
  const vendors = useVendors()
  const { rows, loading, reload } = useAllOrderHistoryLines()

  const shopLabel = useCallback(
    (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : null),
    [loc],
  )

  const columns = useMemo(() => [
    col.accessor('location_id', { header: 'Shop', cell: (i) => shopLabel(i.getValue()) ?? '—' }),
    col.accessor('order_date', { header: 'Order Date', cell: (i) => dShort(i.getValue()) }),
    col.accessor('vendor_id', { header: 'Vendor', cell: (i) => vendors.byId(i.getValue())?.name ?? '—' }),
    col.accessor('po_number', { header: 'PO Number', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('product_id', { header: 'Product', cell: (i) => i.getValue() }),
    col.accessor('order_type', { header: 'Order Type', cell: (i) => i.getValue() }),
    col.accessor('uom', { header: 'UOM', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('qty', { header: 'Qty', cell: (i) => <span className="text-right block">{num(i.getValue())}</span> }),
    col.accessor('unit_cost', { header: 'Unit Cost', cell: (i) => <span className="text-right block">{money(i.getValue())}</span> }),
    col.accessor('line_total', { header: 'Line Total', cell: (i) => <span className="text-right block">{money(i.getValue())}</span> }),
  ], [shopLabel, vendors])

  const table = useTable(rows, columns, {
    persistKey: 'orders-v2:products-ordered',
    initialSorting: [{ id: 'order_date', desc: true }],
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-mono text-inky/60 max-w-3xl">
          Every completed order line across every vendor, by date and shop — refreshed each time an order is
          exported (see Orders v2's own status table), so this always matches what was actually ordered.
        </p>
        <Button size="sm" variant="secondary" loading={loading} onClick={reload}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      <DataTable
        table={table.table}
        globalFilter={table.globalFilter}
        onGlobalFilterChange={table.setGlobalFilter}
        exportFilename="Products Ordered"
        loading={loading}
      />
    </div>
  )
}
