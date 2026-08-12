import { useMemo, useState } from 'react'
import { useConfigTab, type ImportMode } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { DataTable } from '@/components/shared/DataTable'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { Button } from '@/components/ui'
import { useTable } from '@/hooks/useTable'
import { mappedValue } from '@/lib/columnTransform'
import { applyTransforms } from '@/lib/transforms'
import type { ColumnMapping } from '@/types'
import { EXCEPTION_STATUSES, parseContacted, type ExceptionReport } from './exceptions'
import { ExceptionReportModal } from './ExceptionReportModal'
import { format } from 'date-fns'

const toDate = (v: string) => applyTransforms(v, [{ kind: 'date' }]) || null
const stripHtml = (s: string | null) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '')
const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

const UPLOAD_FIELDS = [
  { name: 'shop', label: 'Shop', required: true },
  { name: 'date_of_finding', label: 'Date of Finding' },
  { name: 'date_of_shop_action', label: 'Date of Shop Action' },
  { name: 'area_manager', label: 'Area Manager' },
  { name: 'report_type', label: 'Exception Report (Type)' },
  { name: 'issue', label: 'Issue' },
  { name: 'details', label: 'Details' },
  { name: 'contacted', label: 'Contacted?' },
  { name: 'response', label: 'Response?' },
  { name: 'rd_if_no', label: 'RD if No' },
  { name: 'response_notes', label: 'Response Notes' },
]

export function ExceptionReportingPage() {
  const { data, loading, insert, update, remove, importRows, clearAll } = useConfigTab<ExceptionReport>('exception_reports', 'inventory')
  const loc = useLocations()
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<ExceptionReport> | null>(null)
  const [importing, setImporting] = useState(false)

  function openAdd() { setEditing(null); setModalOpen(true) }
  function openEdit(r: ExceptionReport) { setEditing(r); setModalOpen(true) }

  const columns = useMemo(() => [
    { id: 'date_of_finding', header: 'Finding', accessorFn: (r: ExceptionReport) => r.date_of_finding ?? '', cell: (i: any) => dShort((i.row.original as ExceptionReport).date_of_finding) },
    { id: 'location', header: 'Shop', accessorFn: (r: ExceptionReport) => loc.labelOf(r.location_id), cell: (i: any) => loc.labelOf((i.row.original as ExceptionReport).location_id) },
    { id: 'area_manager', header: 'Area Manager', accessorFn: (r: ExceptionReport) => r.area_manager ?? '', cell: (i: any) => (i.getValue() || '—') },
    { id: 'report_type', header: 'Type', accessorFn: (r: ExceptionReport) => r.report_type ?? '', cell: (i: any) => (i.getValue() || '—') },
    { id: 'issue', header: 'Issue', accessorFn: (r: ExceptionReport) => r.issue ?? '', cell: (i: any) => (i.getValue() || '—') },
    { id: 'details', header: 'Details', accessorFn: (r: ExceptionReport) => stripHtml(r.details), cell: (i: any) => <span className="block max-w-[22rem] truncate" title={i.getValue()}>{i.getValue() || '—'}</span> },
    { id: 'contacted', header: 'Contacted', accessorFn: (r: ExceptionReport) => (r.contacted ? 1 : 0), cell: (i: any) => { const r = i.row.original as ExceptionReport; return r.contacted ? `✓ ${r.contacted_date ? dShort(r.contacted_date) : ''}`.trim() : '—' } },
    {
      id: 'status', header: 'Status', enableColumnFilter: true,
      accessorFn: (r: ExceptionReport) => r.status ?? '',
      cell: (i: any) => {
        const r = i.row.original as ExceptionReport
        return (
          <select value={r.status ?? ''} onChange={(e) => update(r.id, { status: e.target.value || null } as Partial<ExceptionReport>)}
            className="bg-cream border border-navy/30 rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky">
            <option value="">—</option>
            {EXCEPTION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )
      },
    },
    { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => <button onClick={() => openEdit(i.row.original as ExceptionReport)} className="text-xs font-mono text-inky hover:underline">Edit</button> },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [loc, update])

  const { table, globalFilter, setGlobalFilter } = useTable(data, columns)

  async function handleImport(rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = rows.map((row) => {
      let location_id: string | null = null, area_manager: string | null = null
      let date_of_finding: string | null = null, date_of_shop_action: string | null = null
      let report_type: string | null = null, issue: string | null = null, details: string | null = null
      let contactedRaw = '', response: string | null = null, rd_if_no: string | null = null, response_notes: string | null = null
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        switch (m.fieldName) {
          case 'shop': location_id = loc.resolveId(v); break
          case 'area_manager': area_manager = v.trim() || null; break
          case 'date_of_finding': date_of_finding = toDate(v); break
          case 'date_of_shop_action': date_of_shop_action = toDate(v); break
          case 'report_type': report_type = v.trim() || null; break
          case 'issue': issue = v.trim() || null; break
          case 'details': details = v.trim() || null; break
          case 'contacted': contactedRaw = v; break
          case 'response': response = v.trim() || null; break
          case 'rd_if_no': rd_if_no = v.trim() || null; break
          case 'response_notes': response_notes = v.trim() || null; break
        }
      }
      const yr = date_of_finding ? Number(date_of_finding.slice(0, 4)) : new Date().getFullYear()
      const { contacted, contacted_date } = parseContacted(contactedRaw, yr)
      return { location_id, area_manager, date_of_finding, date_of_shop_action, report_type, issue, details, contacted, contacted_date, response, rd_if_no, response_notes } as Partial<ExceptionReport>
    }).filter((r) => r.location_id)
    // Dedup a re-upload by shop + finding date + type + issue + details.
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.date_of_finding ?? ''}|${r.report_type ?? ''}|${r.issue ?? ''}|${r.details ?? ''}` })
    setImporting(false)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Exception Reporting</h1>
          <p className="text-xs text-inky mt-0.5">Inventory findings (PO match, activity, on-hand). Edit status inline; use Edit or + Add for full detail.</p>
        </div>
      </div>

      <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter}
        exportFilename="exception_reports.csv" exportData={data} loading={loading}
        actions={<>
          <ClearTableButton clearAll={clearAll} />
          <Button size="sm" onClick={openAdd}>+ Add</Button>
        </>}
      />

      <div className="flex flex-col gap-3 max-w-2xl">
        <h3 className="text-xs font-mono text-inky uppercase tracking-wide">Upload Exception Report File</h3>
        <p className="text-[11px] font-mono text-inky/60">Columns: Shop, Date of Finding, Exception Report (type), Issue, Details, Contacted?, Response?, RD if No, Response Notes.</p>
        <ConfigUpload requiredFields={UPLOAD_FIELDS} onImport={handleImport} importing={importing} />
      </div>

      <ExceptionReportModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSubmit={async (fields, id) => { if (id) await update(id, fields); else await insert(fields) }}
        onDelete={(id) => remove(id)} />
    </div>
  )
}
