import { useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import { differenceInDays, format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { Modal, Button, Toggle } from '@/components/ui'
import { MultiSelectDropdown } from '@/components/ui/MultiSelectDropdown'
import type { Issue } from '@/types'
import toast from 'react-hot-toast'

interface IssueRow extends Issue {
  location_name?: string
  category_name?: string
  status_name?: string
}

interface Props {
  open: boolean
  onClose: () => void
  issues: IssueRow[]
  deptMap: Record<string, string>
  selectedIds: Set<string>
  companyId: string
}

// Strip RichText HTML down to readable plain text for a spreadsheet cell.
function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  const el = document.createElement('div')
  el.innerHTML = html
  return (el.textContent || '').replace(/ /g, ' ').replace(/\s+\n/g, '\n').trim()
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return isNaN(dt.getTime()) ? '' : format(dt, 'MMM d, yyyy')
}

interface ExportCol { header: string; get: (r: IssueRow) => string; max: number }

function exportName(): string {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `Issues Export- ${mm}.${dd}.${d.getFullYear()}`
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

type ExportFormat = 'xlsx' | 'csv'

export function IssueExportModal({ open, onClose, issues, deptMap, selectedIds, companyId }: Props) {
  const [vendorSel, setVendorSel] = useState<string[]>([])
  const [catSel, setCatSel] = useState<string[]>([])
  const [locSel, setLocSel] = useState<string[]>([])
  const [onlySelected, setOnlySelected] = useState(false)
  const [format_, setFormat] = useState<ExportFormat>('xlsx')
  const [withFiles, setWithFiles] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Distinct option lists (with counts) from the loaded issues.
  const countOpts = (pick: (r: IssueRow) => string) => {
    const m = new Map<string, number>()
    for (const r of issues) {
      const v = (pick(r) ?? '').trim()
      if (!v) continue
      m.set(v, (m.get(v) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }))
  }
  const vendorOpts = useMemo(() => countOpts((r) => r.vendor ?? ''), [issues])
  const catOpts = useMemo(() => countOpts((r) => r.category_name ?? ''), [issues])
  const locOpts = useMemo(() => countOpts((r) => r.location_name ?? ''), [issues])

  const filtered = useMemo(() => issues.filter((r) => {
    if (onlySelected && selectedIds.size > 0 && !selectedIds.has(r.id)) return false
    if (vendorSel.length && !vendorSel.includes((r.vendor ?? '').trim())) return false
    if (catSel.length && !catSel.includes((r.category_name ?? '').trim())) return false
    if (locSel.length && !locSel.includes((r.location_name ?? '').trim())) return false
    return true
  }), [issues, onlySelected, selectedIds, vendorSel, catSel, locSel])

  const cols: ExportCol[] = [
    { header: 'Title', get: (r) => r.title ?? '', max: 40 },
    { header: 'Department', get: (r) => (r.department_id ? (deptMap[r.department_id] ?? '') : 'Personal'), max: 18 },
    { header: 'Location', get: (r) => r.location_name ?? '', max: 20 },
    { header: 'Category', get: (r) => r.category_name ?? '', max: 18 },
    { header: 'Status', get: (r) => r.status_name ?? '', max: 16 },
    { header: 'Vendor', get: (r) => r.vendor ?? '', max: 20 },
    { header: 'Start Date', get: (r) => fmtDate(r.start_date), max: 14 },
    { header: 'Target Date', get: (r) => fmtDate(r.target_resolution_date), max: 14 },
    { header: 'Resolved Date', get: (r) => fmtDate(r.resolved_date), max: 14 },
    { header: 'Days Open', get: (r) => (r.start_date ? String(differenceInDays(new Date(), new Date(r.start_date))) : ''), max: 10 },
    { header: 'Issue Notes', get: (r) => stripHtml(r.issue_notes), max: 50 },
    { header: 'Resolution Notes', get: (r) => stripHtml(r.resolution_notes), max: 50 },
    { header: 'Helpful Links', get: (r) => (r.helpful_links ?? []).join('\n'), max: 40 },
  ]

  function buildAoa(): string[][] {
    const headers = cols.map((c) => c.header)
    const rows = filtered.map((r) => cols.map((c) => c.get(r)))
    return [headers, ...rows]
  }

  function buildXlsxBuffer(): ArrayBuffer {
    const aoa = buildAoa()
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    // Column widths tuned to content (capped), so it reads as a clean table.
    ws['!cols'] = cols.map((c) => {
      const bodyMax = filtered.reduce((m, r) => Math.max(m, c.get(r).split('\n')[0].length), c.header.length)
      return { wch: Math.min(c.max, Math.max(10, bodyMax + 2)) }
    })
    // Auto-filter across the header row → sortable/filterable table in Excel.
    ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: cols.length - 1 } }) }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Issues')
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  }

  function buildCsv(): string {
    const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    return buildAoa().map((row) => row.map(esc).join(',')).join('\n')
  }

  async function doExport() {
    if (filtered.length === 0) { toast.error('No issues match the selected filters'); return }
    setExporting(true)
    try {
      const name = exportName()

      if (withFiles) {
        // Bundle the spreadsheet + each issue's attachment files into a zip.
        const zip = new JSZip()
        if (format_ === 'csv') zip.file(`${name}.csv`, buildCsv())
        else zip.file(`${name}.xlsx`, buildXlsxBuffer())

        const ids = filtered.map((r) => r.id).filter(Boolean)
        let fetched = 0
        if (ids.length) {
          const { data: atts } = await (supabase as any)
            .schema('platform').from('attachments').select('*').in('entity_id', ids)
          if ((atts ?? []).length > 0) {
            const folder = zip.folder('Attachments')!
            for (const att of atts ?? []) {
              try {
                const { data } = await supabase.storage.from('attachments').download(att.storage_path)
                if (data) { folder.file(att.file_name, data); fetched++ }
              } catch { /* skip individual failures */ }
            }
          }
        }
        const blob = await zip.generateAsync({ type: 'blob' })
        triggerDownload(blob, `${name}.zip`)
        toast.success(`${name}.zip — ${filtered.length} issues + ${fetched} file${fetched !== 1 ? 's' : ''}`)
      } else if (format_ === 'csv') {
        triggerDownload(new Blob([buildCsv()], { type: 'text/csv;charset=utf-8;' }), `${name}.csv`)
        toast.success(`${name}.csv — ${filtered.length} issues`)
      } else {
        triggerDownload(
          new Blob([buildXlsxBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
          `${name}.xlsx`,
        )
        toast.success(`${name}.xlsx — ${filtered.length} issues`)
      }
      onClose()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Export Issues" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs font-mono text-inky/70">
          Filter the rows to export, then download a formatted table. Leave a filter on “All” to include everything.
        </p>

        {/* Filters */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Vendor</span>
            <MultiSelectDropdown options={vendorOpts} selected={vendorSel} onChange={setVendorSel} placeholder="All vendors" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Category</span>
            <MultiSelectDropdown options={catOpts} selected={catSel} onChange={setCatSel} placeholder="All categories" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide">Location</span>
            <MultiSelectDropdown options={locOpts} selected={locSel} onChange={setLocSel} placeholder="All locations" />
          </label>
        </div>

        {/* Options */}
        <div className="flex flex-col gap-2.5 rounded border border-navy/15 bg-navy/[0.02] px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-inky/70 uppercase tracking-wide w-16">Format</span>
            <div className="flex rounded border border-navy/30 overflow-hidden w-fit">
              {(['xlsx', 'csv'] as const).map((f) => (
                <button key={f} onClick={() => setFormat(f)}
                  className={['px-3 py-1 text-xs font-mono transition-colors', format_ === f ? 'bg-navy text-cream' : 'text-inky hover:text-navy'].join(' ')}>
                  {f === 'xlsx' ? 'Excel (formatted)' : 'CSV'}
                </button>
              ))}
            </div>
          </div>
          {selectedIds.size > 0 && (
            <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
              <Toggle checked={onlySelected} onChange={setOnlySelected} size="sm" />
              Only the {selectedIds.size} selected row{selectedIds.size !== 1 ? 's' : ''}
            </label>
          )}
          <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
            <Toggle checked={withFiles} onChange={setWithFiles} size="sm" />
            Include attachment files (.zip)
          </label>
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-xs font-mono text-inky">
            <span className="text-navy font-bold">{filtered.length}</span> of {issues.length} issue{issues.length !== 1 ? 's' : ''} will export
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={exporting} disabled={filtered.length === 0} onClick={doExport}>
              Export {filtered.length}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
