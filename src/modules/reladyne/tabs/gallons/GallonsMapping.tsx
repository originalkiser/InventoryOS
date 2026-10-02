// Product -> Bulk / Package / Drum mapping sheet (direct ask 2026-10-02, this
// MMR only). The source file only says BULK or PACKAGE; Drum is split out
// here — by default from a trailing " DR" in the description (see
// defaultGroupFor), and any product can be overridden explicitly. An
// override is a row in inventory.reladyne_product_group_map; "Auto" means no
// row (the default applies).
import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { GROUP_KEYS, GROUP_LABELS, num0, type GroupKey } from '../../mmrShared'

export interface MappingProduct {
  productDesc: string
  packageGroup: string | null
  defaultGroup: GroupKey
  billedAllTime: number
}

interface Row extends MappingProduct {
  id: string
  override: GroupKey | null
  effective: GroupKey
}

const TABLE_KEY = 'reladyne.gallons_product_mapping'

export function GallonsMapping({ products, overrides, setGroup }: {
  products: MappingProduct[]
  overrides: Map<string, GroupKey>
  setGroup: (productDesc: string, group: GroupKey | null) => Promise<void>
}) {
  const [saving, setSaving] = useState<string | null>(null)

  const rows = useMemo((): Row[] => products.map((p) => {
    const override = overrides.get(p.productDesc) ?? null
    return { ...p, id: p.productDesc, override, effective: override ?? p.defaultGroup }
  }), [products, overrides])

  async function change(productDesc: string, value: string) {
    setSaving(productDesc)
    try {
      await setGroup(productDesc, value === 'auto' ? null : (value as GroupKey))
    } catch (e) {
      toast.error(`Unable to save mapping: ${(e as Error).message}`)
    } finally {
      setSaving(null)
    }
  }

  const col = useMemo(() => createColumnHelper<Row>(), [])
  const columns = useMemo(() => [
    col.accessor('productDesc', { id: 'product', header: 'Product' }),
    col.accessor('packageGroup', { id: 'source', header: 'Source Group', cell: (i) => i.getValue() ?? '—' }),
    col.accessor((r) => GROUP_LABELS[r.defaultGroup], { id: 'default', header: 'Auto Type' }),
    col.accessor((r) => GROUP_LABELS[r.effective], {
      id: 'effective', header: 'Package Type',
      cell: (i) => {
        const r = i.row.original
        return (
          <select value={r.override ?? 'auto'} disabled={saving === r.productDesc}
            onChange={(e) => change(r.productDesc, e.target.value)}
            className={`bg-cream border rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-2 focus:ring-sky ${r.override ? 'border-[#E67E22]' : 'border-navy/40'}`}>
            <option value="auto">Auto ({GROUP_LABELS[r.defaultGroup]})</option>
            {GROUP_KEYS.map((g) => <option key={g} value={g}>{GROUP_LABELS[g]}</option>)}
          </select>
        )
      },
    }),
    col.accessor((r) => (r.override ? 'Override' : ''), {
      id: 'override', header: 'Override',
      cell: (i) => (i.getValue() ? <span className="text-[#E67E22] font-bold">Override</span> : <span className="text-inky/30">—</span>),
    }),
    col.accessor('billedAllTime', { id: 'billed', header: 'Gallons Billed (All Time)', cell: (i) => <span className="block text-right">{num0(i.getValue())}</span> }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [col, saving])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(rows, columns, {
    persistKey: TABLE_KEY, initialSorting: [{ id: 'billed', desc: true }], initialPageSize: 50,
  })
  useColumnPrefs(TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-inky">
        Assign each product to Bulk, Package, or Drum. "Auto" uses the source file's BULK/PACKAGE grouping, with PACKAGE
        products whose description ends in "DR" treated as Drum. This split applies to the MMR Product Gallons views only.
        Overrides are shared company-wide and show in orange.
      </p>
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="RelaDyne Product Mapping" />
    </div>
  )
}
