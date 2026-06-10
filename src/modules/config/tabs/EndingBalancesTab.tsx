import { useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { useConfigTab } from '../useConfigTab'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Input, Modal } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import type { MonthlyEndingBalance, ColumnMapping, ParsedUpload } from '@/types'
import { useForm } from 'react-hook-form'
import { format } from 'date-fns'

const REQUIRED_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'month', label: 'Month (date)', required: true },
  { name: 'ending_balance', label: 'Ending Balance', required: true },
]

const col = createColumnHelper<MonthlyEndingBalance>()
const fmt = (v: number | null) =>
  v != null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v) : '—'

const COLUMNS = [
  col.accessor('month', { header: 'Month', cell: (i) => {
    try { return format(new Date(i.getValue() + 'T00:00:00'), 'MMM yyyy') } catch { return i.getValue() }
  }}),
  col.accessor('ending_balance', { header: 'Ending Balance', cell: (i) => fmt(i.getValue()) }),
  col.accessor('uploaded_at', { header: 'Uploaded', cell: (i) => new Date(i.getValue()).toLocaleDateString() }),
]

export function EndingBalancesTab() {
  const { data, loading, insert, upsertBatch } = useConfigTab<MonthlyEndingBalance>('monthly_ending_balances')
  const { table, globalFilter, setGlobalFilter } = useTable(data, COLUMNS)
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const { register, handleSubmit, reset } = useForm<{ month: string; ending_balance: string }>()

  async function confirmImport() {
    if (!parsed || !mappings) return
    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = {}
      for (const m of mappings) {
        const v = row[m.sourceColumn] ?? ''
        if (m.fieldName === 'ending_balance') out[m.fieldName] = v ? parseFloat(v.replace(/[$,]/g, '')) : 0
        else out[m.fieldName] = v || null
      }
      return out
    })
    await upsertBatch(rows as Partial<MonthlyEndingBalance>[])
    setParsed(null); setMappings(null); setConfirmOpen(false)
  }

  async function onAdd(form: { month: string; ending_balance: string }) {
    await insert({ month: form.month, ending_balance: parseFloat(form.ending_balance) })
    reset(); setAddOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="ending_balances.csv" exportData={data} loading={loading}
        actions={<Button size="sm" onClick={() => setAddOpen(true)}>+ Add Balance</Button>}
      />
      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-3">
          <h3 className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload File</h3>
          {!parsed ? <FileUploadZone onParsed={(r) => setParsed(r)} />
            : !mappings ? (
              <div className="border border-[#2a2d3e] rounded-lg p-4 bg-[#0f1117]">
                <ColumnMapper headers={parsed.headers} requiredFields={REQUIRED_FIELDS}
                  onConfirm={(m) => { setMappings(m); setConfirmOpen(true) }} onCancel={() => setParsed(null)} />
              </div>
            ) : null}
          <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import">
            <p className="text-sm text-gray-300 mb-4 font-mono">Import {parsed?.totalRowsParsed} balance rows?</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>Back</Button>
              <Button size="sm" onClick={confirmImport}>Import</Button>
            </div>
          </Modal>
        </div>
        <DataSourceLinker configType="monthly_ending_balances" />
      </div>
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Ending Balance">
        <form onSubmit={handleSubmit(onAdd)} className="flex flex-col gap-3">
          <Input label="Month *" type="month" {...register('month', { required: true })} />
          <Input label="Ending Balance *" type="number" step="0.01" {...register('ending_balance', { required: true })} />
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button size="sm" type="submit">Save</Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
