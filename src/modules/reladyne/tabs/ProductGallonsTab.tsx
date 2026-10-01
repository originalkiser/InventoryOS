// By-product gallons/revenue — derived live from reladyne_volume_data (the
// same role the Product Gallons workbook's own "Product Pivot" sheet
// plays, just computed here instead of re-stored — see migration
// 20260930by's header comment).
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Select, SbLoader } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useReladyneVolumeData } from '../useMmrData'
import { MONTHS_BACK_OPTIONS, trailingPeriods, num0, money } from '../mmrShared'

interface ProductRow {
  productDesc: string
  packageGroup: string | null
  gallonsOrdered: number
  gallonsBilled: number
  revenue: number
  revenuePerGallon: number | null
}

const TABLE_KEY = 'reladyne.product_gallons'

export function ProductGallonsTab() {
  const { rows, loading } = useReladyneVolumeData()
  const [monthsBack, setMonthsBack] = useState<number | 'all'>(3)
  const periods = useMemo(() => trailingPeriods(rows.map((r) => r.period), monthsBack), [rows, monthsBack])

  const products = useMemo((): ProductRow[] => {
    const m = new Map<string, { packageGroup: string | null; gallonsOrdered: number; gallonsBilled: number; revenue: number }>()
    for (const r of rows) {
      if (!periods.has(r.period)) continue
      const cur = m.get(r.product_desc) ?? { packageGroup: r.package_group, gallonsOrdered: 0, gallonsBilled: 0, revenue: 0 }
      cur.gallonsOrdered += Number(r.gallons_ordered ?? 0)
      cur.gallonsBilled += Number(r.gallons_billed ?? 0)
      cur.revenue += Number(r.revenue ?? 0)
      m.set(r.product_desc, cur)
    }
    return [...m.entries()].map(([productDesc, v]) => ({
      productDesc, ...v, revenuePerGallon: v.gallonsBilled > 0 ? v.revenue / v.gallonsBilled : null,
    }))
  }, [rows, periods])

  const col = useMemo(() => createColumnHelper<ProductRow>(), [])
  const columns = useMemo(() => [
    col.accessor('productDesc', { id: 'product', header: 'Product' }),
    col.accessor('packageGroup', { id: 'package_group', header: 'Package Group', cell: (i) => i.getValue() ?? '—' }),
    col.accessor('gallonsOrdered', { id: 'gallons_ordered', header: 'Gallons Ordered', cell: (i) => <span className="block text-right">{num0(i.getValue())}</span> }),
    col.accessor('gallonsBilled', { id: 'gallons_billed', header: 'Gallons Billed', cell: (i) => <span className="block text-right">{num0(i.getValue())}</span> }),
    col.accessor('revenue', { id: 'revenue', header: 'Revenue', cell: (i) => <span className="block text-right">{money(i.getValue())}</span> }),
    col.accessor('revenuePerGallon', { id: 'revenue_per_gallon', header: 'Revenue / Gal', cell: (i) => <span className="block text-right">{i.getValue() != null ? money(i.getValue()) : '—'}</span> }),
  ], [col])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(products, columns, {
    persistKey: TABLE_KEY, initialSorting: [{ id: 'gallons_billed', desc: true }], initialPageSize: 50,
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  if (loading) return <div className="py-10 flex justify-center"><SbLoader size={28} /></div>

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Show</span>
        <div className="w-36">
          <Select value={String(monthsBack)} onChange={(e) => setMonthsBack(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            options={MONTHS_BACK_OPTIONS} />
        </div>
      </div>
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename={`RelaDyne Product Gallons`} />
    </div>
  )
}
