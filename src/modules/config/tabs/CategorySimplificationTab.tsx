import { useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab, type ImportMode } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button, Input, Modal, Select } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import type { ColumnMapping } from '@/types'
import { format } from 'date-fns'

// The three simplified rollup buckets. Blank = excluded from rollups.
const SIMPLE_CATS = ['Parts', 'Oil', 'Additives'] as const
type SimpleCat = (typeof SIMPLE_CATS)[number]

// Normalize a free-text "Simple Cat" value to one of the three buckets (or null).
function normalizeSimple(raw: string | null | undefined): SimpleCat | null {
  const t = (raw ?? '').trim().toLowerCase()
  if (!t) return null
  const hit = SIMPLE_CATS.find((c) => c.toLowerCase() === t)
  return hit ?? null
}

interface CategorySimplification {
  id: string
  company_id: string
  category: string
  simple_category: string | null
  metadata: Record<string, unknown> | null
  updated_at: string
  last_change_source: string | null
}

const col = createColumnHelper<CategorySimplification>()

export function CategorySimplificationTab() {
  const { data, loading, insert, update, remove, removeMany, importRows, clearAll } =
    useConfigTab<CategorySimplification>('category_simplification', 'inventory')

  const [addOpen, setAddOpen] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [form, setForm] = useState({ category: '', simple_category: '' })

  // Rollup counts for the header summary
  const summary = useMemo(() => {
    const counts: Record<string, number> = { Parts: 0, Oil: 0, Additives: 0, Excluded: 0 }
    for (const r of data) {
      const s = normalizeSimple(r.simple_category)
      counts[s ?? 'Excluded']++
    }
    return counts
  }, [data])

  const columns = useMemo(() => {
    return [
      col.accessor('category', { header: 'Category', cell: (i) => i.getValue() }),
      {
        id: 'simple_category',
        header: 'Simple Cat',
        accessorFn: (r: CategorySimplification) => r.simple_category ?? '',
        cell: (i: any) => {
          const r = i.row.original as CategorySimplification
          return (
            <Select
              options={[{ value: '', label: '— Excluded —' }, ...SIMPLE_CATS.map((c) => ({ value: c, label: c }))]}
              value={normalizeSimple(r.simple_category) ?? ''}
              onChange={(e) => update(r.id, { simple_category: e.target.value || null })}
              className="min-w-[8rem]"
            />
          )
        },
      },
      col.accessor('updated_at', {
        header: 'Last Updated',
        cell: (i) => {
          const r = i.row.original as CategorySimplification
          const s = r.last_change_source ? ` (${r.last_change_source})` : ''
          return i.getValue() ? `${format(new Date(i.getValue()), 'MMM d, yyyy')}${s}` : '—'
        },
      }),
      {
        id: 'edit',
        header: '',
        enableColumnFilter: false,
        enableSorting: false,
        cell: (i: any) => (
          <button onClick={() => openEdit(i.row.original as CategorySimplification)} className="text-xs font-mono text-inky hover:underline">
            Edit
          </button>
        ),
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  const uploadFields = [
    { name: 'category', label: 'Category', required: true },
    { name: 'simple_category', label: 'Simple Cat (Parts / Oil / Additives)' },
  ]

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let category = ''
      let simple_category: string | null = null
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'category') category = raw.trim()
        else if (m.fieldName === 'simple_category') simple_category = normalizeSimple(raw)
      }
      return { category, simple_category } as Partial<CategorySimplification>
    }).filter((r) => r.category)
    // Merge on category so re-uploading updates the mapping in place.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => (r.category ?? '').trim().toLowerCase() })
    setImporting(false)
  }

  function resetForm() { setForm({ category: '', simple_category: '' }) }
  function openAdd() { setEditId(null); resetForm(); setAddOpen(true) }
  function openEdit(r: CategorySimplification) {
    setEditId(r.id)
    setForm({ category: r.category ?? '', simple_category: normalizeSimple(r.simple_category) ?? '' })
    setAddOpen(true)
  }

  async function onSubmit() {
    if (!form.category.trim()) return
    const payload = { category: form.category.trim(), simple_category: form.simple_category || null } as Partial<CategorySimplification>
    if (editId) await update(editId, payload)
    else await insert(payload)
    resetForm(); setAddOpen(false); setEditId(null)
  }

  async function onDelete() {
    if (!editId) return
    if (!confirm('Delete this category mapping?')) return
    await remove(editId); resetForm(); setAddOpen(false); setEditId(null)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-sm font-bold text-navy uppercase tracking-wide">Category Simplification</h2>
        <p className="text-xs text-inky mt-0.5">
          Roll detailed categories up into <strong>Parts</strong>, <strong>Oil</strong>, and <strong>Additives</strong> for ending-balance
          tracking. Leave the bucket blank to exclude a category from rollups.
        </p>
        <div className="flex flex-wrap gap-3 mt-2 text-[11px] font-mono text-inky">
          <span>Parts: <span className="text-navy font-bold">{summary.Parts}</span></span>
          <span>Oil: <span className="text-navy font-bold">{summary.Oil}</span></span>
          <span>Additives: <span className="text-navy font-bold">{summary.Additives}</span></span>
          <span>Excluded: <span className="text-inky/60 font-bold">{summary.Excluded}</span></span>
        </div>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="category_simplification.csv" exportData={data} loading={loading}
        onBulkDelete={removeMany}
        dangerZone={<ClearTableButton clearAll={clearAll} />}
        actions={<>
          <Button size="sm" onClick={openAdd}>+ Add Category</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload Mapping File</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Columns: <strong>Category</strong> and <strong>Simple Cat</strong>. Unrecognized Simple Cat values import as Excluded.
        </p>
        <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} />
      </div>

      <Modal open={addOpen} onClose={() => { setAddOpen(false); setEditId(null) }} title={editId ? 'Edit Category Mapping' : 'Add Category Mapping'} size="md">
        <div className="flex flex-col gap-3">
          <Input label="Category *" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          <Select
            label="Simple Cat"
            options={[{ value: '', label: '— Excluded —' }, ...SIMPLE_CATS.map((c) => ({ value: c, label: c }))]}
            value={form.simple_category}
            onChange={(e) => setForm({ ...form, simple_category: e.target.value })}
          />
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
