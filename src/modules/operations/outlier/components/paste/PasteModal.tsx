import { useState, useRef, useEffect } from 'react'
import { X, Upload, ClipboardPaste, FileSpreadsheet } from 'lucide-react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'
import { Report, ParsedRow, Week } from '../../types'
import { detectPivot } from './pivotDetector'
import PastePreview from './PastePreview'
import XlsxMapper from './XlsxMapper'
import { toDateString, getThisWeekFriday } from '../../lib/weekUtils'

interface Props {
  report: Report
  currentWeek: Week | null
  existingEntries: { row_key: string }[]
  onClose: () => void
  onCommit: (rows: ParsedRow[], weekId: string, submittedByOverride?: string | null) => Promise<void>
}

export default function PasteModal({ report, currentWeek, existingEntries, onClose, onCommit }: Props) {
  const { profile } = useAuthStore()
  const [rawText, setRawText] = useState('')
  const [parsedRows, setParsedRows] = useState<ParsedRow[] | null>(null)
  const [xlsxData, setXlsxData] = useState<{ headers: string[]; rows: string[][] } | null>(null)
  const [pivotInfo, setPivotInfo] = useState<{ isPivot: boolean; shopCount: number; employeeCount: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [committing, setCommitting] = useState(false)
  const [submittedByOverride, setSubmittedByOverride] = useState<string>('')
  const [orgUsers, setOrgUsers] = useState<{ id: string; full_name: string | null; email: string }[]>([])
  const csvRef = useRef<HTMLInputElement>(null)
  const xlsxRef = useRef<HTMLInputElement>(null)

  const canOverride = isAdminOrDeveloper(profile?.role)

  useEffect(() => {
    if (!canOverride) return
    ;(supabase as any).schema('platform').from('user_profiles')
      .select('id, full_name, email')
      .is('deleted_at', null)
      .order('full_name')
      .then(({ data }: { data: any[] }) => { if (data) setOrgUsers(data) })
  }, [canOverride])

  const dataColumns = report.columns.filter(c => c.type !== 'location' && c.type !== 'employee')
  const defaultDueDate = toDateString(getThisWeekFriday())

  void dataColumns

  function parseText(text: string) {
    setError(null)
    const result = Papa.parse<string[]>(text.trim(), { delimiter: '\t', skipEmptyLines: true })

    if (!result.data || result.data.length < 2) {
      setError('Could not parse pasted data. Make sure you paste tab-separated rows (copy directly from Excel/Sheets).')
      return
    }

    const pivot = detectPivot(result.data)
    setPivotInfo(pivot)

    // Route through the column mapper so headers can be remapped
    const headers = result.data[0].map(h => String(h ?? '').trim())
    const dataRows = result.data.slice(1).map(row => row.map(v => String(v ?? '').trim()))
    setXlsxData({ headers, rows: dataRows })
  }

  function handlePaste() {
    if (!rawText.trim()) { setError('Please paste some data first.'); return }
    parseText(rawText)
  }

  function handleCsvFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target?.result as string
      setRawText(text)
      parseText(text)
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleXlsxFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const data = new Uint8Array(ev.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const all = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '' }) as string[][]

        if (all.length < 2) { setError('Excel file appears to be empty.'); return }

        // Find first row with 2+ non-empty cells (skips title rows)
        let headerIdx = 0
        for (let i = 0; i < Math.min(all.length, 10); i++) {
          if (all[i].filter(v => v && String(v).trim()).length >= 2) { headerIdx = i; break }
        }

        const headers = all[headerIdx].map(h => String(h ?? '').trim()).filter(Boolean)
        const dataRows = all.slice(headerIdx + 1)
          .filter(row => row.some(v => v && String(v).trim()))
          .map(row => row.map(v => String(v ?? '').trim()))

        if (headers.length === 0) { setError('Could not detect column headers in the Excel file.'); return }
        setXlsxData({ headers, rows: dataRows })
      } catch {
        setError('Failed to read the Excel file. Make sure it is a valid .xlsx file.')
      }
    }
    reader.readAsArrayBuffer(file)
    e.target.value = ''
  }

  async function handleCommit() {
    if (!parsedRows || !currentWeek) return
    setCommitting(true)
    try {
      await onCommit(parsedRows, currentWeek.id, submittedByOverride || null)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to save data: ${msg}`)
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-sb-onyx/60 z-50 flex items-center justify-center p-4">
      <div className="bg-sb-navy border border-sb-inky/50 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-sb-inky/30">
          <div>
            <h2 className="font-brand font-bold text-sb-sky tracking-widest text-[14px] uppercase">Import Report Data</h2>
            <p className="font-mono text-sb-cream/50 text-[11px] mt-0.5">{report.name}</p>
          </div>
          <button onClick={onClose} className="text-sb-cream/50 hover:text-sb-cream transition-colors">
            <X size={18} />
          </button>
        </div>

        {/* Step: Excel column mapper */}
        {xlsxData && !parsedRows ? (
          <XlsxMapper
            sourceHeaders={xlsxData.headers}
            sourceRows={xlsxData.rows}
            report={report}
            onBack={() => setXlsxData(null)}
            onMapped={rows => { setParsedRows(rows); setPivotInfo(null) }}
          />
        ) : parsedRows ? (
          /* Step: preview & commit */
          <PastePreview
            rows={parsedRows}
            columns={report.columns}
            existingKeys={new Set(existingEntries.map(e => e.row_key))}
            pivotInfo={pivotInfo}
            onBack={() => { setParsedRows(null); setXlsxData(null) }}
            onCommit={handleCommit}
            committing={committing}
          />
        ) : (
          /* Step: input */
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            <div>
              <label className="font-brand font-bold text-[11px] text-sb-inky tracking-widest uppercase mb-2 block">
                Paste Data (Tab-Separated from Excel / Sheets)
              </label>
              <textarea
                value={rawText}
                onChange={e => setRawText(e.target.value)}
                placeholder="Paste your copied data here…"
                className="w-full h-48 bg-sb-inky/20 text-sb-cream font-mono text-[12px] p-3 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky resize-none placeholder:text-sb-cream/25"
              />
            </div>

            {error && (
              <p className="font-mono text-sb-red text-[12px] bg-sb-red/10 border border-sb-red/30 rounded px-3 py-2">{error}</p>
            )}

            {canOverride && (
              <div>
                <label className="font-brand font-bold text-[11px] text-sb-inky tracking-widest uppercase mb-1.5 block">
                  Submitted By (Override)
                </label>
                <select
                  value={submittedByOverride}
                  onChange={e => setSubmittedByOverride(e.target.value)}
                  className="bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-3 py-1.5 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky"
                >
                  <option value="">— use my account —</option>
                  {orgUsers.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name ?? u.email}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handlePaste}
                className="flex items-center gap-2 bg-sb-sky text-sb-navy font-brand font-bold text-[12px] tracking-wider px-4 py-2 rounded hover:brightness-105 transition"
              >
                <ClipboardPaste size={14} />
                PARSE PASTED DATA
              </button>

              <span className="font-mono text-[11px] text-sb-inky">or upload</span>

              <button
                onClick={() => xlsxRef.current?.click()}
                className="flex items-center gap-2 bg-sb-inky/40 text-sb-cream font-brand font-bold text-[12px] tracking-wider px-4 py-2 rounded border border-sb-inky hover:bg-sb-inky/60 transition"
              >
                <FileSpreadsheet size={14} />
                UPLOAD EXCEL (.XLSX)
              </button>

              <button
                onClick={() => csvRef.current?.click()}
                className="flex items-center gap-2 bg-sb-inky/20 text-sb-cream/70 font-brand font-bold text-[12px] tracking-wider px-4 py-2 rounded border border-sb-inky/50 hover:bg-sb-inky/40 transition"
              >
                <Upload size={14} />
                UPLOAD CSV
              </button>

              <input ref={xlsxRef} type="file" accept=".xlsx,.xls" onChange={handleXlsxFile} className="hidden" />
              <input ref={csvRef} type="file" accept=".csv,.tsv,.txt" onChange={handleCsvFile} className="hidden" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
