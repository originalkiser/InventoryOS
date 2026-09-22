import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useLocations } from '@/hooks/useLocations'
import { useRdReports, type RdOpenOrderRow, type RdOpenInvoiceRow } from './useRdReports'
import { dShort } from './shared'

const oCol = createColumnHelper<RdOpenOrderRow>()
const iCol = createColumnHelper<RdOpenInvoiceRow>()

/**
 * Browse-only view of what's currently sitting in the two uploaded RD
 * report snapshot tables (rd_open_orders/rd_open_invoices) — added
 * 2026-09-22 per request: before this there was no way to see the data
 * after uploading it, only the upload buttons themselves. Each upload
 * fully replaces its own table (see useRdReports.ts's replaceSnapshot),
 * so what's shown here is always "as of the last upload," not history —
 * for that, see the accumulating rd_order_ledger/rd_delivery_ledger
 * tables (fetchRdProductHistory) instead.
 */
export function RdReportsTab() {
  const loc = useLocations()
  const { lastOpenOrdersAt, lastOpenInvoicesAt, fetchOpenOrders, fetchOpenInvoices } = useRdReports()
  const [orders, setOrders] = useState<RdOpenOrderRow[]>([])
  const [invoices, setInvoices] = useState<RdOpenInvoiceRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, i] = await Promise.all([fetchOpenOrders(), fetchOpenInvoices()])
    setOrders(o)
    setInvoices(i)
    setLoading(false)
  }, [fetchOpenOrders, fetchOpenInvoices])
  useEffect(() => { load() }, [load])

  const shopLabel = useCallback(
    (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : '—'),
    [loc],
  )

  const orderColumns = useMemo(() => [
    oCol.accessor('location_id', { header: 'Shop', cell: (i) => shopLabel(i.getValue()) }),
    oCol.accessor('sales_order_no', { header: 'Sales Order #', cell: (i) => i.getValue() }),
    oCol.accessor('customer_po_no', { header: 'Customer PO #', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('order_date', { header: 'Order Date', cell: (i) => dShort(i.getValue()) }),
    oCol.accessor('order_type', { header: 'Order Type', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('warehouse_code', { header: 'Warehouse', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('ship_to_code', { header: 'Ship To Code', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('ship_to_name', { header: 'Ship To Name', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('product_code', { header: 'Product Code', cell: (i) => i.getValue() }),
    oCol.accessor('product_desc', { header: 'Product Desc', cell: (i) => i.getValue() || '—' }),
    oCol.accessor('qty_ordered', { header: 'Qty Ordered', cell: (i) => i.getValue() ?? '—' }),
    oCol.accessor('uploaded_at', { header: 'Uploaded At', cell: (i) => dShort(i.getValue()) }),
  ], [shopLabel])

  const invoiceColumns = useMemo(() => [
    iCol.accessor('location_id', { header: 'Shop', cell: (i) => shopLabel(i.getValue()) }),
    iCol.accessor('sales_order_no', { header: 'Sales Order #', cell: (i) => i.getValue() }),
    iCol.accessor('customer_po_no', { header: 'Customer PO #', cell: (i) => i.getValue() || '—' }),
    iCol.accessor('invoice_no', { header: 'Invoice #', cell: (i) => i.getValue() || '—' }),
    iCol.accessor('order_date', { header: 'Order Date', cell: (i) => dShort(i.getValue()) }),
    iCol.accessor('ship_date', { header: 'Ship Date', cell: (i) => dShort(i.getValue()) }),
    iCol.accessor('invoice_date', { header: 'Invoice Date', cell: (i) => dShort(i.getValue()) }),
    iCol.accessor('invoice_due_date', { header: 'Invoice Due Date', cell: (i) => dShort(i.getValue()) }),
    iCol.accessor('ship_to_name', { header: 'Ship To Name', cell: (i) => i.getValue() || '—' }),
    iCol.accessor('product_code', { header: 'Product Code', cell: (i) => i.getValue() }),
    iCol.accessor('product_desc', { header: 'Product Desc', cell: (i) => i.getValue() || '—' }),
    iCol.accessor('qty_ordered', { header: 'Qty Ordered', cell: (i) => i.getValue() ?? '—' }),
    iCol.accessor('qty_shipped', { header: 'Qty Shipped', cell: (i) => i.getValue() ?? '—' }),
    iCol.accessor('gallons_ordered', { header: 'Gallons Ordered', cell: (i) => i.getValue() ?? '—' }),
    iCol.accessor('gallons_shipped', { header: 'Gallons Shipped', cell: (i) => i.getValue() ?? '—' }),
    iCol.accessor('uploaded_at', { header: 'Uploaded At', cell: (i) => dShort(i.getValue()) }),
  ], [shopLabel])

  const ordersTable = useTable(orders, orderColumns, {
    persistKey: 'orders-v2:rd-open-orders',
    initialVisibility: { warehouse_code: false, ship_to_code: false },
  })
  const invoicesTable = useTable(invoices, invoiceColumns, {
    persistKey: 'orders-v2:rd-open-invoices',
    initialVisibility: { ship_date: false, invoice_due_date: false },
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-mono text-inky/60">
          Each upload fully replaces its own table — this shows what's currently on file, not a history.
          For last-ordered/last-delivered by shop and product, see the ledger built from these uploads.
        </p>
        <Button size="sm" variant="secondary" loading={loading} onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      <Tabs defaultValue="orders">
        <TabsList>
          <TabsTrigger value="orders">Open Sales Orders ({orders.length})</TabsTrigger>
          <TabsTrigger value="invoices">Open Invoices ({invoices.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="orders">
          <p className="text-[10px] font-mono text-inky/50 mb-2">
            Last uploaded: {lastOpenOrdersAt ? dShort(lastOpenOrdersAt) : 'never'}
          </p>
          <DataTable
            table={ordersTable.table}
            globalFilter={ordersTable.globalFilter}
            onGlobalFilterChange={ordersTable.setGlobalFilter}
            exportFilename="RD Open Sales Orders"
            loading={loading}
          />
        </TabsContent>

        <TabsContent value="invoices">
          <p className="text-[10px] font-mono text-inky/50 mb-2">
            Last uploaded: {lastOpenInvoicesAt ? dShort(lastOpenInvoicesAt) : 'never'}
          </p>
          <DataTable
            table={invoicesTable.table}
            globalFilter={invoicesTable.globalFilter}
            onGlobalFilterChange={invoicesTable.setGlobalFilter}
            exportFilename="RD Open Invoices"
            loading={loading}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
