// Opens from a KPI card click on Month End Overview (2026-09-28 ask) — every
// shop's dollar figure for the one category clicked, sorted descending by
// default. No fetch of its own: the data is already in memory
// (shopBalanceRows, built from the same currentCategoryBalances the KPI
// tiles themselves read), so this opens instantly. Clicking a shop row
// drills one level further into ShopBalanceModal, pre-filtered to that same
// category (see its own categoryFilter prop).
import { useMemo } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Modal } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { usd } from './OverviewTab'

interface CategoryBreakdownRow { location_id: string; shop: string; value: number }
const TABLE_KEY = 'monthend:category-breakdown'

export function CategoryBreakdownModal({ open, onClose, title, rows, onSelectShop }: {
  open: boolean
  onClose: () => void
  title: string
  rows: CategoryBreakdownRow[]
  onSelectShop: (locationId: string, shopLabel: string) => void
}) {
  const col = useMemo(() => createColumnHelper<CategoryBreakdownRow>(), [])
  const columns = useMemo(() => [
    col.accessor('shop', { header: 'Shop', meta: { fill: true } }),
    col.accessor('value', { header: 'Amount', cell: (i) => <div className="text-right font-bold">{usd(i.getValue())}</div> }),
  ], [col])

  const {
    table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder,
  } = useTable(rows, columns, {
    persistKey: TABLE_KEY,
    initialPageSize: 50,
    initialSorting: [{ id: 'value', desc: true }],
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  return (
    <Modal open={open} onClose={onClose} title={title} size="xl">
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={title}
        onRowClick={(r) => onSelectShop(r.location_id, r.shop)}
      />
    </Modal>
  )
}
