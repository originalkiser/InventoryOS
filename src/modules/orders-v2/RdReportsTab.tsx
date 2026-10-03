import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw } from 'lucide-react'
import { RdOrderCheckCard } from './RdOrderCheckCard'
import { OverduePoPanel } from './OverduePoPanel'
import { groupOverdueByPo } from './rdPoCheck'
import { Button, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { supabase } from '@/lib/supabase'
import { parseWeekday } from '@/lib/orderDay'
import { useRdReports, type RdOpenOrderRow, type RdOpenInvoiceRow, type RdOrderLedgerRow } from './useRdReports'
import { useVendors } from './useLookups'
import { isReladyne } from './useOrdersV2'
import { resolveDeliveryDate, nextDeliveryDate } from './engine'
import { dShort } from './shared'
import type { DeliverySchedule, WeekCalendar } from './types'

const sb = () => supabase as any
const oCol = createColumnHelper<RdOpenOrderRow>()
const iCol = createColumnHelper<RdOpenInvoiceRow>()
const lCol = createColumnHelper<RdOrderLedgerRow>()

const LEDGER_STATUS_LABEL: Record<string, string> = {
  open: 'Open', closed_delivered: 'Delivered', closed_no_invoice: 'Closed — No Invoice Found',
}
const LEDGER_STATUS_COLOR: Record<string, string> = {
  open: 'bg-sky/25 text-navy', closed_delivered: 'bg-[#2ECC71]/20 text-[#2ECC71]', closed_no_invoice: 'bg-[#C0392B]/15 text-[#C0392B]',
}

/**
 * Browse-only view of what's currently sitting in the two uploaded RD
 * report snapshot tables (rd_open_orders/rd_open_invoices) — added
 * 2026-09-22 per request. Each upload fully replaces its own table (see
 * useRdReports.ts's replaceSnapshot), so those two tabs are always "as of
 * the last upload," not history — the Order Ledger tab below is the real
 * history (direct ask 2026-09-30): every PO/product line ever seen, closed
 * out with what actually shipped once it drops off an Open Sales Order
 * upload, plus an Overdue callout for anything still open past when the
 * shop should have received it.
 */
export function RdReportsTab({ refreshKey = 0 }: { refreshKey?: number }) {
  const loc = useLocations()
  const vendors = useVendors()
  const { lastOpenOrdersAt, lastOpenInvoicesAt, fetchOpenOrders, fetchOpenInvoices, fetchOrderLedger } = useRdReports()
  const [orders, setOrders] = useState<RdOpenOrderRow[]>([])
  const [invoices, setInvoices] = useState<RdOpenInvoiceRow[]>([])
  const [ledger, setLedger] = useState<RdOrderLedgerRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const [o, i, l] = await Promise.all([fetchOpenOrders(), fetchOpenInvoices(), fetchOrderLedger()])
    setOrders(o)
    setInvoices(i)
    setLedger(l)
    setLoading(false)
  }, [fetchOpenOrders, fetchOpenInvoices, fetchOrderLedger])
  useEffect(() => { load() }, [load, refreshKey])

  // RelaDyne's own delivery-schedule lookup — same shape as OrdersV2Review/
  // OrdersV2FinalReview's own scheduleLookup, scoped here to whichever
  // vendor these reports actually belong to (RelaDyne, per this whole
  // feature's own name and the vendor filter runReconciliation already
  // applies) so "should have delivered by" can be computed per shop.
  const rdVendorId = useMemo(() => vendors.vendors.find((v) => isReladyne(v.name))?.id ?? null, [vendors.vendors])
  const [scheduleLookup, setScheduleLookup] = useState<{ schedules: Map<string, DeliverySchedule>; calendar: WeekCalendar }>({ schedules: new Map(), calendar: new Map() })
  useEffect(() => {
    if (!rdVendorId) { setScheduleLookup({ schedules: new Map(), calendar: new Map() }); return }
    let cancelled = false
    Promise.all([
      sb().schema('inventory').from('ov2_location_schedules').select('*').eq('vendor_id', rdVendorId),
      sb().schema('inventory').from('ov2_delivery_calendar').select('week_start, week_label').eq('vendor_id', rdVendorId),
    ]).then(([{ data: schedRows }, { data: calRows }]: any[]) => {
      if (cancelled) return
      const schedules = new Map<string, DeliverySchedule>()
      for (const r of (schedRows ?? [])) {
        schedules.set(r.location_id, {
          type: r.schedule_type, delivery_dow: r.delivery_dow,
          week_a_dow: r.week_a_dow, week_b_dow: r.week_b_dow,
          biweekly_anchor_date: r.biweekly_anchor_date ?? null,
          lead_business_days: Number(r.lead_business_days ?? 4),
        })
      }
      const calendar: WeekCalendar = new Map((calRows ?? []).map((c: any) => [String(c.week_start).slice(0, 10), c.week_label as 'A' | 'B']))
      setScheduleLookup({ schedules, calendar })
    })
    return () => { cancelled = true }
  }, [rdVendorId])
  const deliveryDowOf = useCallback((id: string | null) => parseWeekday(loc.byId(id ?? '')?.reladyne_delivery_day as string | undefined), [loc])
  const expectedDeliveryFor = useCallback((locationId: string | null, orderDate: string | null): string | null => {
    if (!orderDate) return null
    const sched = scheduleLookup.schedules.get(locationId ?? '')
    return sched
      ? resolveDeliveryDate(orderDate, sched, scheduleLookup.calendar)
      : nextDeliveryDate(orderDate, deliveryDowOf(locationId))
  }, [scheduleLookup, deliveryDowOf])

  const today = new Date().toISOString().slice(0, 10)
  // Direct ask 2026-09-30: still open on the vendor's own report, but past
  // when the shop's own schedule says it should have already arrived —
  // grouped to the side so it's obvious which POs are actually worth
  // calling the vendor about, versus just normally still in transit.
  const overdueGroups = useMemo(() => groupOverdueByPo(ledger, expectedDeliveryFor, today), [ledger, expectedDeliveryFor, today])

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

  const ledgerColumns = useMemo(() => [
    lCol.accessor('status', {
      header: 'Status',
      cell: (i) => <span className={`rounded-full px-2 py-0.5 text-[10px] font-heading uppercase tracking-wide whitespace-nowrap ${LEDGER_STATUS_COLOR[i.getValue()]}`}>{LEDGER_STATUS_LABEL[i.getValue()] ?? i.getValue()}</span>,
    }),
    lCol.accessor('location_id', { header: 'Shop', cell: (i) => shopLabel(i.getValue()) }),
    lCol.accessor('sales_order_no', { header: 'Sales Order #', cell: (i) => i.getValue() }),
    lCol.accessor('customer_po_no', { header: 'Customer PO #', cell: (i) => i.getValue() || '—' }),
    lCol.accessor('order_date', { header: 'Order Date', cell: (i) => dShort(i.getValue()) }),
    lCol.display({
      id: 'expected_delivery', header: 'Expected Delivery',
      cell: (i) => { const d = expectedDeliveryFor(i.row.original.location_id, i.row.original.order_date); return d ? dShort(d) : '—' },
    }),
    lCol.accessor('product_code', { header: 'Product Code', cell: (i) => i.getValue() }),
    lCol.accessor('product_desc', { header: 'Product Desc', cell: (i) => i.getValue() || '—' }),
    lCol.accessor('qty_ordered', { header: 'Qty Ordered', cell: (i) => i.getValue() ?? '—' }),
    lCol.accessor('delivered_qty', { header: 'Delivered Qty', cell: (i) => i.getValue() ?? '—' }),
    lCol.accessor('delivered_at', { header: 'Delivered Date', cell: (i) => (i.getValue() ? dShort(i.getValue()) : '—') }),
    lCol.accessor('closed_at', { header: 'Closed At', cell: (i) => (i.getValue() ? dShort(i.getValue()) : '—') }),
    lCol.accessor('last_updated_at', { header: 'Last Updated', cell: (i) => dShort(i.getValue()) }),
  ], [shopLabel, expectedDeliveryFor])

  const ordersTable = useTable(orders, orderColumns, {
    persistKey: 'orders-v2:rd-open-orders',
    initialVisibility: { warehouse_code: false, ship_to_code: false },
  })
  useColumnPrefs('orders-v2:rd-open-orders', ordersTable.table, ordersTable.columnVisibility, ordersTable.columnOrder, ordersTable.setColumnOrder)
  const invoicesTable = useTable(invoices, invoiceColumns, {
    persistKey: 'orders-v2:rd-open-invoices',
    initialVisibility: { ship_date: false, invoice_due_date: false },
  })
  useColumnPrefs('orders-v2:rd-open-invoices', invoicesTable.table, invoicesTable.columnVisibility, invoicesTable.columnOrder, invoicesTable.setColumnOrder)
  const ledgerTable = useTable(ledger, ledgerColumns, {
    persistKey: 'orders-v2:rd-order-ledger',
    initialSorting: [{ id: 'last_updated_at', desc: true }],
  })
  useColumnPrefs('orders-v2:rd-order-ledger', ledgerTable.table, ledgerTable.columnVisibility, ledgerTable.columnOrder, ledgerTable.setColumnOrder)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-mono text-inky/60">
          Open Sales Orders/Open Invoices show what's currently on file as of the last upload. The Order Ledger tab
          is the real history — every line ever seen, closed out with what actually shipped once it drops off an
          upload.
        </p>
        <Button size="sm" variant="secondary" loading={loading} onClick={load}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
        </Button>
      </div>

      <RdOrderCheckCard refreshKey={refreshKey} />

      <OverduePoPanel groups={overdueGroups} shopLabel={shopLabel} />

      <Tabs defaultValue="ledger">
        <TabsList>
          <TabsTrigger value="ledger">Order Ledger ({ledger.length})</TabsTrigger>
          <TabsTrigger value="orders">Open Sales Orders ({orders.length})</TabsTrigger>
          <TabsTrigger value="invoices">Open Invoices ({invoices.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="ledger">
          <DataTable
            table={ledgerTable.table}
            globalFilter={ledgerTable.globalFilter}
            onGlobalFilterChange={ledgerTable.setGlobalFilter}
            exportFilename="RD Order Ledger"
            loading={loading}
          />
        </TabsContent>

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
