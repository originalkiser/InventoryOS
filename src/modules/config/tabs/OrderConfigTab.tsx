import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { LocationOrderConfig, ColumnMapping, ParsedUpload } from '@/types'

const REQUIRED_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'product_id', label: 'Product ID', required: true },
  { name: 'capacity', label: 'Capacity' },
  { name: 'order_trigger', label: 'Order Trigger' },
  { name: 'order_limit', label: 'Order Limit' },
  { name: 'active', label: 'Active' },
]

const col = createColumnHelper<LocationOrderConfig>()
const COLUMNS = [
  col.accessor('product_id', { header: 'Product ID' }),
  col.accessor('capacity', { header: 'Capacity', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('order_trigger', { header: 'Trigger', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('order_limit', { header: 'Limit', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('active', { header: 'Active', cell: (i) => i.getValue() ? '✓' : '✗' }),
]

const NUM_FIELDS = ['capacity', 'order_trigger', 'order_limit']

export function OrderConfigTab() {
  const { data, loading, upsertBatch } = useConfigTab<LocationOrderConfig>('location_order_configs')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function confirmImport() {
    if (!parsed || !mappings) return
    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of mappings) {
        const v = row[m.sourceColumn] ?? ''
        if (m.fieldName === 'active') out[m.fieldName] = ['true', '1', 'yes'].includes(v.toLowerCase())
        else if (NUM_FIELDS.includes(m.fieldName)) out[m.fieldName] = v ? parseFloat(v) : null
        else out[m.fieldName] = v || null
      }
      return out
    })
    await upsertBatch(rows as Partial<LocationOrderConfig>[])
    setParsed(null); setMappings(null); setConfirmOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="order_config.csv" exportData={data} loading={loading} />
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          {!parsed ? (
            <FileUploadZone onParsed={(r) => setParsed(r)} />
          ) : !mappings ? (
            <div className="border border-[#2a2d3e] rounded-lg p-4 bg-[#0f1117]">
              <ColumnMapper headers={parsed.headers} requiredFields={REQUIRED_FIELDS}
                onConfirm={(m) => { setMappings(m); setConfirmOpen(true) }} onCancel={() => setParsed(null)} />
            </div>
          ) : null}
          <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import">
            <p className="text-sm text-gray-300 mb-4 font-mono">Import {parsed?.totalRowsParsed} order configs?</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>Back</Button>
              <Button size="sm" onClick={confirmImport}>Import</Button>
            </div>
          </Modal>
        </div>
        <DataSourceLinker configType="location_order_configs" />
      </div>
    </div>
  )
}
