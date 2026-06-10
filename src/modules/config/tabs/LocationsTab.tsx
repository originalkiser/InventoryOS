import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { Location, ColumnMapping, ParsedUpload } from '@/types'
import toast from 'react-hot-toast'
import { useForm } from 'react-hook-form'

const REQUIRED_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'name', label: 'Name', required: true },
  { name: 'region', label: 'Region' },
  { name: 'active', label: 'Active (bool)' },
]

const col = createColumnHelper<Location>()
const COLUMNS = [
  col.accessor('location_code', { header: 'Code' }),
  col.accessor('name', { header: 'Name' }),
  col.accessor('region', { header: 'Region', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('active', { header: 'Active', cell: (i) => i.getValue() ? '✓' : '✗' }),
  col.accessor('created_at', { header: 'Added', cell: (i) => new Date(i.getValue()).toLocaleDateString() }),
]

export function LocationsTab() {
  const { data, loading, insert, upsertBatch } = useConfigTab<Location>('locations')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)

  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const { register, handleSubmit, reset } = useForm<{ location_code: string; name: string; region: string }>()

  function applyMappings(rows: Record<string, string>[], maps: ColumnMapping[]) {
    return rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of maps) {
        const raw = row[m.sourceColumn] ?? ''
        if (m.fieldName === 'active') {
          out[m.fieldName] = ['true', '1', 'yes'].includes(raw.toLowerCase())
        } else {
          out[m.fieldName] = raw
        }
      }
      return out
    })
  }

  async function confirmImport() {
    if (!parsed || !mappings) return
    const rows = applyMappings(parsed.rows, mappings)
    await upsertBatch(rows as Partial<Location>[])
    setParsed(null)
    setMappings(null)
    setConfirmOpen(false)
  }

  async function onAddSubmit(form: { location_code: string; name: string; region: string }) {
    await insert(form)
    reset()
    setAddOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="locations.csv"
        exportData={data}
        loading={loading}
        actions={<Button size="sm" onClick={() => setAddOpen(true)}>+ Add Location</Button>}
      />

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          {!parsed ? (
            <FileUploadZone
              onParsed={(result) => { setParsed(result) }}
            />
          ) : !mappings ? (
            <div className="border border-[#2a2d3e] rounded-lg p-4 bg-[#0f1117]">
              <h4 className="text-xs font-mono text-gray-400 uppercase mb-3">Map Columns</h4>
              <ColumnMapper
                headers={parsed.headers}
                requiredFields={REQUIRED_FIELDS}
                onConfirm={(maps) => { setMappings(maps); setConfirmOpen(true) }}
                onCancel={() => setParsed(null)}
              />
            </div>
          ) : null}

          {confirmOpen && parsed && mappings && (
            <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import" size="md">
              <p className="text-sm text-gray-300 mb-4 font-mono">
                Import {parsed.totalRowsParsed.toLocaleString()} locations?
                {parsed.skippedRows > 0 && ` (${parsed.skippedRows} header rows skipped)`}
              </p>
              <div className="flex justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>
                  Back
                </Button>
                <Button size="sm" onClick={confirmImport}>
                  Import
                </Button>
              </div>
            </Modal>
          )}
        </div>

        <DataSourceLinker configType="locations" />
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Location">
        <form onSubmit={handleSubmit(onAddSubmit)} className="flex flex-col gap-3">
          <Input label="Location Code *" {...register('location_code', { required: true })} />
          <Input label="Name *" {...register('name', { required: true })} />
          <Input label="Region" {...register('region')} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit">Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
