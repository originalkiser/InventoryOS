import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { useAppSetting } from '@/hooks/useAppSetting'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Modal, Toggle, Card, CardBody } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ColumnMapping } from '@/types'
import { format } from 'date-fns'

// Company-level tuning knobs for the expectations engine (platform.app_settings).
export const TANK_VARIANCE_KEY = 'monthend.tankVarianceQts'
export const UNLISTED_LIMIT_KEY = 'monthend.unlistedCategoryLimit'
export const DEFAULT_TANK_VARIANCE = 100 // quarts

interface CategoryExpectation {
  id: string
  company_id: string
  category: string
  cpd_0_30_limit: number | null
  cpd_30plus_limit: number | null
  is_engine_oil: boolean
  oil_bulk_limit: number | null
  oil_package_limit: number | null
  oil_drum_limit: number | null
  metadata: Record<string, unknown> | null
  updated_at: string
  last_change_source: string | null
}

function num(v: string): number | null {
  const t = v.trim(); if (!t) return null
  const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n
}
const show = (v: number | null) => (v == null ? '—' : v.toLocaleString())

const col = createColumnHelper<CategoryExpectation>()

const EMPTY_FORM = {
  category: '', cpd_0_30_limit: '', cpd_30plus_limit: '',
  is_engine_oil: false, oil_bulk_limit: '', oil_package_limit: '', oil_drum_limit: '',
}

export function CategoryExpectationsTab() {
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } =
    useConfigTab<CategoryExpectation>('category_expectations', 'inventory')

  const [tankVariance, saveTankVariance] = useAppSetting<number>(TANK_VARIANCE_KEY, DEFAULT_TANK_VARIANCE)
  const [unlistedLimit, saveUnlistedLimit] = useAppSetting<number | null>(UNLISTED_LIMIT_KEY, null)

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ ...EMPTY_FORM })

  const columns = useMemo(() => [
    col.accessor('category', { header: 'Category', cell: (i) => i.getValue() }),
    col.accessor('cpd_0_30_limit', { header: '0–30 CPD', cell: (i) => show(i.getValue()) }),
    col.accessor('cpd_30plus_limit', { header: '30+ CPD', cell: (i) => show(i.getValue()) }),
    col.accessor('oil_bulk_limit', { header: 'Bulk', cell: (i) => show(i.getValue()) }),
    col.accessor('oil_package_limit', { header: 'Package', cell: (i) => show(i.getValue()) }),
    col.accessor('oil_drum_limit', { header: 'Drum', cell: (i) => show(i.getValue()) }),
    col.accessor('is_engine_oil', { header: 'Oil?', cell: (i) => (i.getValue() ? 'Yes' : '') }),
    col.accessor('updated_at', {
      header: 'Last Updated',
      cell: (i) => {
        const r = i.row.original as CategoryExpectation
        const s = r.last_change_source ? ` (${r.last_change_source})` : ''
        return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—'
      },
    }),
    {
      id: 'edit', header: '', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => <button onClick={() => openEdit(i.row.original as CategoryExpectation)} className="text-xs font-mono text-inky hover:underline">Edit</button>,
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns, { persistKey: 'config:category-expectations' })

  const uploadFields = [
    { name: 'category', label: 'Category', required: true },
    { name: 'cpd_0_30_limit', label: '0-30 CPD' },
    { name: 'cpd_30plus_limit', label: '30+ CPD' },
    { name: 'oil_bulk_limit', label: 'Bulk' },
    { name: 'oil_package_limit', label: 'Package' },
    { name: 'oil_drum_limit', label: 'Drum' },
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      const r: Record<string, unknown> = {}
      let category = ''
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'category') category = raw.trim()
        else r[m.fieldName] = num(raw)
      }
      const bulk = r.oil_bulk_limit as number | null
      const pkg = r.oil_package_limit as number | null
      const drum = r.oil_drum_limit as number | null
      // A row is engine-oil style when it carries any case-type limit.
      const is_engine_oil = bulk != null || pkg != null || drum != null
      return {
        category,
        cpd_0_30_limit: (r.cpd_0_30_limit ?? null) as number | null,
        cpd_30plus_limit: (r.cpd_30plus_limit ?? null) as number | null,
        oil_bulk_limit: bulk ?? null,
        oil_package_limit: pkg ?? null,
        oil_drum_limit: drum ?? null,
        is_engine_oil,
      } as Partial<CategoryExpectation>
    }).filter((r) => r.category)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => (r.category ?? '').trim().toLowerCase() })
    setImporting(false)
  }

  function resetForm() { setForm({ ...EMPTY_FORM }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: CategoryExpectation) {
    setEditId(r.id)
    setForm({
      category: r.category ?? '',
      cpd_0_30_limit: r.cpd_0_30_limit?.toString() ?? '',
      cpd_30plus_limit: r.cpd_30plus_limit?.toString() ?? '',
      is_engine_oil: !!r.is_engine_oil,
      oil_bulk_limit: r.oil_bulk_limit?.toString() ?? '',
      oil_package_limit: r.oil_package_limit?.toString() ?? '',
      oil_drum_limit: r.oil_drum_limit?.toString() ?? '',
    })
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.category.trim()) return
    const payload = {
      category: form.category.trim(),
      cpd_0_30_limit: num(form.cpd_0_30_limit),
      cpd_30plus_limit: num(form.cpd_30plus_limit),
      is_engine_oil: form.is_engine_oil,
      oil_bulk_limit: num(form.oil_bulk_limit),
      oil_package_limit: num(form.oil_package_limit),
      oil_drum_limit: num(form.oil_drum_limit),
    } as Partial<CategoryExpectation>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this category expectation?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Expected On Hand — Category Limits</h2>
        <p className="text-xs text-inky mt-0.5">
          Upper on-hand limits per category. Non-oil categories use the CPD tier for the shop (0–30 vs 30+ cars/day).
          Engine oil uses case-type limits (Bulk / Package / Drum) instead. Exceeding a limit flags the product for recount.
        </p>
      </div>

      {/* Engine tuning knobs */}
      <Card>
        <CardBody className="flex flex-wrap items-end gap-6">
          <div className="w-48">
            <Input
              label="Tank Monitor Variance (qts)"
              type="number"
              value={String(tankVariance)}
              onChange={(e) => saveTankVariance(Number(e.target.value) || 0)}
              hint="Bulk oil within this of the tank reading won't flag"
            />
          </div>
          <div className="w-56">
            <Input
              label="Unlisted Category Limit"
              type="number"
              value={unlistedLimit == null ? '' : String(unlistedLimit)}
              onChange={(e) => { const t = e.target.value.trim(); saveUnlistedLimit(t === '' ? null : Number(t)) }}
              placeholder="blank = unlimited"
              hint="Limit for categories not listed below (blank = never flag)"
            />
          </div>
        </CardBody>
      </Card>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="category_expectations.csv" exportData={data} loading={loading}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<>
          <Button size="sm" onClick={openAdd}>+ Add Category</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-3xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload Expectations File</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Columns: <strong>Category</strong>, <strong>0-30 CPD</strong>, <strong>30+ CPD</strong>, <strong>Bulk</strong>, <strong>Package</strong>, <strong>Drum</strong>.
          Rows with any Bulk/Package/Drum value are treated as engine-oil (case-type) limits.
        </p>
        <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Category Expectation' : 'Add Category Expectation'} size="lg">
        <div className="flex flex-col gap-3">
          <Input label="Category *" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <div className="flex items-center gap-3">
            <Toggle checked={form.is_engine_oil} onChange={(v) => setForm({ ...form, is_engine_oil: v })} color="green" size="sm" label="Engine oil (use case-type limits)" />
          </div>
          {!form.is_engine_oil ? (
            <div className="grid grid-cols-2 gap-3">
              <Input label="0–30 CPD limit" type="number" value={form.cpd_0_30_limit} onChange={(e) => setForm({ ...form, cpd_0_30_limit: e.target.value })} />
              <Input label="30+ CPD limit" type="number" value={form.cpd_30plus_limit} onChange={(e) => setForm({ ...form, cpd_30plus_limit: e.target.value })} />
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Input label="Bulk limit" type="number" value={form.oil_bulk_limit} onChange={(e) => setForm({ ...form, oil_bulk_limit: e.target.value })} />
              <Input label="Package limit" type="number" value={form.oil_package_limit} onChange={(e) => setForm({ ...form, oil_package_limit: e.target.value })} />
              <Input label="Drum limit" type="number" value={form.oil_drum_limit} onChange={(e) => setForm({ ...form, oil_drum_limit: e.target.value })} />
            </div>
          )}
          <div className="flex justify-between gap-2 pt-2">
            <div>{editId && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setAddOpen(false); setEditId(null) }}>Discard</Button>
              <Button size="sm" onClick={onSubmit} disabled={!form.category.trim()}>{editId ? 'Save Changes' : 'Save'}</Button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
