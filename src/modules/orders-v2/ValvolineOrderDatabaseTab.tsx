import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { RefreshCw, Upload } from 'lucide-react'
import { Button, Modal } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useLocations } from '@/hooks/useLocations'
import { useValvolineOrderDatabase, type ValvolineOrderLineRow } from './useValvolineOrderDatabase'
import { dShort } from './shared'

const col = createColumnHelper<ValvolineOrderLineRow>()

/**
 * "Valvoline Order Database" — a real, permanent record of Valvoline order
 * lines (2026-09-24 request): history uploaded from Valvoline's own
 * order-history export, orders placed directly with Valvoline outside SB
 * Net, and every order this app itself finalizes for Valvoline going
 * forward (see useValvolineOrderDatabase.ts's insertValvolineOrderFromFinalize).
 * Purpose is explicitly "what's already on order" — checked before
 * generating a new one — NOT delivery-schedule inference (that stays on
 * DeliverySchedulesCard.tsx / OrdersV2Settings.tsx, unchanged).
 *
 * Uploads are additive-only (see the hook's own header comment) — this tab
 * is a browse view over whatever has accumulated, not a per-upload snapshot.
 *
 * No "received"/pending status column yet — determining that needs the
 * shop's own expected delivery date cross-referenced against Droptop's
 * purchase-order data, planned as a follow-up on the daily Purchase Orders
 * data connection rather than something computable here. Until then, the
 * Delivery Date column is the best manual signal (a future date likely
 * still outstanding, a past one likely already received).
 */
export function ValvolineOrderDatabaseTab() {
  const loc = useLocations()
  const { uploading, fetchAll, uploadHistory } = useValvolineOrderDatabase()
  const [rows, setRows] = useState<ValvolineOrderLineRow[]>([])
  const [loading, setLoading] = useState(true)
  const [uploadOpen, setUploadOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setRows(await fetchAll())
    setLoading(false)
  }, [fetchAll])
  useEffect(() => { load() }, [load])

  const shopLabel = useCallback(
    (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : null),
    [loc],
  )

  const columns = useMemo(() => [
    col.accessor('location_id', { header: 'Shop', cell: (i) => shopLabel(i.getValue()) ?? i.row.original.shop_raw ?? '—' }),
    col.accessor('po_number', { header: 'PO Number', cell: (i) => i.getValue() }),
    col.accessor('line_number', { header: 'Line #', cell: (i) => i.getValue() }),
    col.accessor('product_id', { header: 'Product', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('material_code', { header: 'Material Code', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('description', { header: 'Description', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('quantity', { header: 'Qty', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('uom', { header: 'UOM', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('po_date', { header: 'PO Date', cell: (i) => dShort(i.getValue()) }),
    col.accessor('delivery_date', { header: 'Delivery Date', cell: (i) => dShort(i.getValue()) }),
    col.accessor('source', { header: 'Source', cell: (i) => (i.getValue() === 'sbnet' ? 'SB Net' : 'Uploaded') }),
    col.accessor('ship_to_account_number', { header: 'Account #', cell: (i) => i.getValue() ?? '—' }),
  ], [shopLabel])

  const table = useTable(rows, columns, {
    persistKey: 'orders-v2:valvoline-order-database',
    initialVisibility: { ship_to_account_number: false, material_code: false },
  })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-mono text-inky/60 max-w-3xl">
          Every Valvoline order line we know about — uploaded history, anything ordered directly with Valvoline
          outside SB Net, and every order this app finalizes for Valvoline. Check here before generating a new
          order to see what's already on order for a shop. Uploads only ever add new lines — re-uploading the same
          file (or an overlapping one) never overwrites or removes what's already here.
        </p>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button size="sm" variant="secondary" loading={loading} onClick={load}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Refresh
          </Button>
          <Button size="sm" onClick={() => setUploadOpen(true)}>
            <Upload className="w-3.5 h-3.5 mr-1" /> Upload Order History
          </Button>
        </div>
      </div>

      <DataTable
        table={table.table}
        globalFilter={table.globalFilter}
        onGlobalFilterChange={table.setGlobalFilter}
        exportFilename="Valvoline Order Database"
        loading={loading}
      />

      <Modal open={uploadOpen} onClose={() => setUploadOpen(false)} title="Upload Valvoline Order History" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            Expects Valvoline's own order-history export (or the same shape) — Customer Ship To Account Number,
            Customer PO Number, Customer PO Date, Request Delivery Date, Line Number, Valvoline Material Code,
            Quantity, Unit of Measure, Item Description, and sboc_shop_number, on the file's first sheet.
          </p>
          <FileUploadZone
            onParsed={async (parsed) => { await uploadHistory(parsed); setUploadOpen(false); load() }}
          />
          {uploading && <p className="text-xs font-mono text-inky/60">Processing…</p>}
        </div>
      </Modal>
    </div>
  )
}
