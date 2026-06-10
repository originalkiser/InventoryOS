import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { ColumnMapper } from '@/components/upload/ColumnMapper'
import { DataSourceLinker } from '@/components/upload/DataSourceLinker'
import { Button, Modal, Card, CardHeader, CardBody } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { ParsedUpload, ColumnMapping } from '@/types'
import { useState } from 'react'
import toast from 'react-hot-toast'

const REQUIRED_FIELDS = [
  { name: 'location_code', label: 'Location Code', required: true },
  { name: 'count_date', label: 'Count Date', required: true },
  { name: 'count_type', label: 'Count Type' },
  { name: 'total_adjustments', label: 'Total Adjustments' },
  { name: 'adjustment_value', label: 'Adjustment Value' },
  { name: 'abs_adjustment_value', label: 'Abs Adjustment Value' },
  { name: 'ending_inventory_cost', label: 'Ending Inventory Cost' },
]

export function WeeklyCountsPage() {
  const { profile } = useAuthStore()
  const [parsed, setParsed] = useState<ParsedUpload | null>(null)
  const [mappings, setMappings] = useState<ColumnMapping[] | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [importing, setImporting] = useState(false)

  async function confirmImport() {
    if (!parsed || !mappings || !profile?.company_id) return
    setImporting(true)
    const NUM = ['total_adjustments', 'adjustment_value', 'abs_adjustment_value', 'ending_inventory_cost']
    const rows = parsed.rows.map((row) => {
      const out: Record<string, unknown> = { company_id: profile.company_id }
      for (const m of mappings) {
        const v = row[m.sourceColumn] ?? ''
        if (NUM.includes(m.fieldName)) {
          const num = parseFloat(v.replace(/[$,]/g, ''))
          out[m.fieldName] = isNaN(num) ? null : (m.invert ? -num : num)
        } else out[m.fieldName] = v || null
      }
      return out
    })
    const { error } = await supabase.from('weekly_counts').insert(rows as any)
    if (error) toast.error(error.message)
    else toast.success(`Imported ${rows.length} weekly count rows`)
    setImporting(false); setParsed(null); setMappings(null); setConfirmOpen(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-lg font-bold text-white tracking-wide uppercase">Weekly Counts</h1>
        <p className="text-xs text-gray-500 mt-0.5">Upload weekly inventory count data</p>
      </div>
      <div className="grid grid-cols-2 gap-6">
        <Card>
          <CardHeader><span className="text-xs font-mono text-gray-400 uppercase tracking-wide">Upload Count File</span></CardHeader>
          <CardBody className="flex flex-col gap-4">
            {!parsed ? <FileUploadZone onParsed={(r) => setParsed(r)} />
              : !mappings ? (
                <ColumnMapper headers={parsed.headers} requiredFields={REQUIRED_FIELDS}
                  onConfirm={(m) => { setMappings(m); setConfirmOpen(true) }} onCancel={() => setParsed(null)} />
              ) : <div className="text-xs text-[#39ff14] font-mono">✓ {parsed.totalRowsParsed} rows ready</div>}
          </CardBody>
        </Card>
        <DataSourceLinker configType="weekly_counts" />
      </div>
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Confirm Import">
        <p className="text-sm text-gray-300 mb-4 font-mono">Import {parsed?.totalRowsParsed} weekly count records?</p>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => { setConfirmOpen(false); setMappings(null) }}>Back</Button>
          <Button size="sm" loading={importing} onClick={confirmImport}>Import</Button>
        </div>
      </Modal>
    </div>
  )
}
