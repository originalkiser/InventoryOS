import { useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Modal } from '@/components/ui'
import type { Department } from '@/types'
import toast from 'react-hot-toast'

type Phase = 'input' | 'preview' | 'importing' | 'done'
type InputMode = 'paste' | 'file'

interface RawRow {
  title: string
  status_name: string
  location_code: string
  category_name: string
  start_date: string
  resolved_date: string
  resolution_notes: string
}

interface PreviewRow extends RawRow {
  location_found: boolean
}

// Column header aliases → canonical field key
const HEADER_MAP: Record<string, keyof RawRow> = {
  'start date': 'start_date',
  'status': 'status_name',
  'shop #': 'location_code',
  'shop#': 'location_code',
  'shop': 'location_code',
  'issue type': 'category_name',
  'category': 'category_name',
  'issue description': 'title',
  'description': 'title',
  'title': 'title',
  'date resolved': 'resolved_date',
  'resolved date': 'resolved_date',
  'resolution date': 'resolved_date',
  'resolution notes': 'resolution_notes',
  'notes': 'resolution_notes',
}

// Parse M/D/YYYY, M/D/YY, or YYYY-MM-DD → "YYYY-MM-DD". Returns null on failure.
function parseDate(val: string | null | undefined): string | null {
  if (!val) return null
  const s = String(val).trim()
  if (!s) return null
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (mdy) {
    const [, m, d, y] = mdy
    const year = y.length === 2 ? (parseInt(y, 10) >= 50 ? '19' : '20') + y : y
    return `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  return null
}

function mapRow(headerRow: string[], rawVals: Record<string, string>): RawRow {
  const r: RawRow = { title: '', status_name: '', location_code: '', category_name: '', start_date: '', resolved_date: '', resolution_notes: '' }
  for (const h of headerRow) {
    const key = HEADER_MAP[h.toLowerCase().trim()]
    if (!key) continue
    const val = String(rawVals[h] ?? '').trim()
    if (key === 'start_date' || key === 'resolved_date') {
      r[key] = parseDate(val) ?? ''
    } else {
      r[key] = val
    }
  }
  return r
}

function splitLine(line: string, delim: string): string[] {
  // Handles basic quoted CSV fields
  if (delim === ',') {
    const cols: string[] = []
    let cur = ''
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { inQ = !inQ }
      else if (ch === delim && !inQ) { cols.push(cur.trim()); cur = '' }
      else { cur += ch }
    }
    cols.push(cur.trim())
    return cols
  }
  return line.split(delim).map(c => c.trim())
}

function textToRawRows(text: string): { headers: string[]; rows: Record<string, string>[] } | null {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return null
  const delim = lines[0].includes('\t') ? '\t' : ','
  const headers = splitLine(lines[0], delim)
  const rows = lines.slice(1).map(line => {
    const cells = splitLine(line, delim)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = cells[i] ?? '' })
    return obj
  })
  return { headers, rows }
}

function xlsxToRawRows(wb: XLSX.WorkBook): { headers: string[]; rows: Record<string, string>[] } {
  const ws = wb.Sheets[wb.SheetNames[0]]
  // raw:false converts dates using dateNF format
  const raw = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' }) as any[][]
  if (raw.length < 2) return { headers: [], rows: [] }
  const headers = raw[0].map((h: any) => String(h ?? '').trim())
  const rows = raw.slice(1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = String(row[i] ?? '').trim() })
    return obj
  })
  return { headers, rows }
}

interface Props {
  open: boolean
  onClose: () => void
  onImported: () => void
  departments?: Department[]
  defaultDepartmentId?: string
}

export function IssueImportModal({ open, onClose, onImported, departments = [], defaultDepartmentId = '' }: Props) {
  const { profile } = useAuthStore()
  const sb = supabase as any

  const [phase, setPhase] = useState<Phase>('input')
  const [mode, setMode] = useState<InputMode>('paste')
  const [deptId, setDeptId] = useState(defaultDepartmentId)
  const [pasteText, setPasteText] = useState('')
  const [rawRows, setRawRows] = useState<RawRow[]>([])
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([])
  const [parseError, setParseError] = useState<string | null>(null)
  const [result, setResult] = useState<{ inserted: number; warnings: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  function reset() {
    setPhase('input')
    setMode('paste')
    setDeptId(defaultDepartmentId)
    setPasteText('')
    setRawRows([])
    setPreviewRows([])
    setParseError(null)
    setResult(null)
  }

  async function buildPreview(mapped: RawRow[]) {
    if (!profile?.company_id) return
    const { data: locs } = await sb.schema('core').from('locations')
      .select('name').eq('company_id', profile.company_id)
    // Index by exact code (lower) AND by stripped numeric value so "1" matches "0001" etc.
    const locSet = new Set<string>()
    for (const l of (locs ?? [])) {
      const code = String(l.name).trim()
      locSet.add(code.toLowerCase())
      const n = parseInt(code, 10)
      if (!isNaN(n)) locSet.add(String(n))
    }
    function locFound(code: string) {
      const t = code.trim()
      return locSet.has(t.toLowerCase()) || locSet.has(String(parseInt(t, 10)))
    }
    setRawRows(mapped)
    setPreviewRows(mapped.map(r => ({
      ...r,
      location_found: !r.location_code || locFound(r.location_code),
    })))
    setPhase('preview')
  }

  function handlePasteSubmit() {
    setParseError(null)
    const parsed = textToRawRows(pasteText)
    if (!parsed) {
      setParseError('Could not parse pasted data. Paste tab-separated or comma-separated rows with a header row.')
      return
    }
    const mapped = parsed.rows.map(row => mapRow(parsed.headers, row)).filter(r => r.title || r.location_code)
    if (mapped.length === 0) {
      setParseError('No data rows found. Ensure the data includes Issue Description or Shop # columns.')
      return
    }
    buildPreview(mapped)
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setParseError(null)
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        if (file.name.toLowerCase().endsWith('.csv')) {
          const text = typeof ev.target?.result === 'string' ? ev.target.result : new TextDecoder().decode(ev.target?.result as ArrayBuffer)
          const parsed = textToRawRows(text)
          if (!parsed) { setParseError('Could not parse CSV file.'); return }
          const mapped = parsed.rows.map(row => mapRow(parsed.headers, row)).filter(r => r.title || r.location_code)
          if (mapped.length === 0) { setParseError('No rows found in CSV.'); return }
          buildPreview(mapped)
        } else {
          const wb = XLSX.read(ev.target?.result, { type: 'binary' })
          const { headers, rows } = xlsxToRawRows(wb)
          const mapped = rows.map(row => mapRow(headers, row)).filter(r => r.title || r.location_code)
          if (mapped.length === 0) { setParseError('No rows found in spreadsheet.'); return }
          buildPreview(mapped)
        }
      } catch {
        setParseError('Error reading file. Ensure it is a valid Excel or CSV file.')
      }
    }
    if (file.name.toLowerCase().endsWith('.csv')) {
      reader.readAsText(file)
    } else {
      reader.readAsBinaryString(file)
    }
    e.target.value = ''
  }

  async function runImport() {
    if (!profile?.company_id) return
    setPhase('importing')

    const [locRes, statusRes, catRes] = await Promise.all([
      sb.schema('core').from('locations').select('id, name').eq('company_id', profile.company_id),
      sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', profile.company_id),
      sb.schema('inventory').from('issue_categories').select('id, name').eq('company_id', profile.company_id),
    ])

    // Index by exact code (lower) AND numeric-stripped so "1" resolves to "0001" etc.
    const locMap = new Map<string, string>()
    for (const l of (locRes.data ?? [])) {
      const code = String(l.name).trim()
      locMap.set(code.toLowerCase(), l.id)
      const n = parseInt(code, 10)
      if (!isNaN(n)) locMap.set(String(n), l.id)
    }
    const statusMap = new Map<string, string>((statusRes.data ?? []).map((s: any) => [s.name.trim().toLowerCase(), s.id]))
    const catMap = new Map<string, string>((catRes.data ?? []).map((c: any) => [c.name.trim().toLowerCase(), c.id]))

    async function resolveStatus(name: string): Promise<string | null> {
      if (!name.trim()) return null
      const key = name.trim().toLowerCase()
      if (statusMap.has(key)) return statusMap.get(key)!
      const { data } = await sb.schema('inventory').from('issue_statuses')
        .insert({ company_id: profile!.company_id, name: name.trim() }).select('id, name').single()
      if (!data) return null
      statusMap.set(key, data.id)
      return data.id as string
    }

    async function resolveCategory(name: string): Promise<string | null> {
      if (!name.trim()) return null
      const key = name.trim().toLowerCase()
      if (catMap.has(key)) return catMap.get(key)!
      const { data } = await sb.schema('inventory').from('issue_categories')
        .insert({ company_id: profile!.company_id, name: name.trim() }).select('id, name').single()
      if (!data) return null
      catMap.set(key, data.id)
      return data.id as string
    }

    const warnings: string[] = []
    const toInsert: object[] = []

    for (const row of rawRows) {
      const rawCode = row.location_code.trim()
      const location_id = rawCode
        ? (locMap.get(rawCode.toLowerCase()) ?? locMap.get(String(parseInt(rawCode, 10))) ?? null)
        : null
      if (row.location_code && !location_id) {
        warnings.push(`Shop "${row.location_code}" not found — imported without location`)
      }
      const [status_id, category_id] = await Promise.all([
        resolveStatus(row.status_name),
        resolveCategory(row.category_name),
      ])
      toInsert.push({
        company_id: profile.company_id,
        department_id: deptId,
        title: row.title || null,
        location_id,
        status_id,
        category_id,
        start_date: row.start_date || null,
        resolved_date: row.resolved_date || null,
        resolution_notes: row.resolution_notes || null,
        created_by: profile.id,
        helpful_links: [],
      })
    }

    let inserted = 0
    for (let i = 0; i < toInsert.length; i += 100) {
      const chunk = toInsert.slice(i, i + 100)
      const { data, error } = await sb.schema('platform').from('issues').insert(chunk).select('id')
      if (error) {
        toast.error(`Import failed: ${error.message}`)
        setPhase('preview')
        return
      }
      inserted += (data ?? []).length
    }

    setResult({ inserted, warnings: [...new Set(warnings)] })
    setPhase('done')
    onImported()
  }

  const unresolved = previewRows.filter(r => r.location_code && !r.location_found).length

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Import Issues" size="lg">
      <div className="flex flex-col gap-4">

        {/* ── Input phase ── */}
        {phase === 'input' && (
          <>
            {/* Department selector */}
            {departments.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className="text-xs font-mono text-inky uppercase tracking-wide">Department</label>
                <select
                  value={deptId}
                  onChange={(e) => setDeptId(e.target.value)}
                  className="rounded border border-navy/20 bg-cream text-xs font-mono text-navy px-2 py-1.5 focus:border-sky focus:outline-none"
                >
                  <option value="">Select a department…</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex gap-0 border-b border-navy/10">
              {(['paste', 'file'] as InputMode[]).map(m => (
                <button
                  key={m}
                  onClick={() => { setMode(m); setParseError(null) }}
                  className={[
                    'px-4 py-1.5 text-xs font-mono -mb-px border-b-2 transition-colors',
                    mode === m ? 'border-sky text-navy font-bold' : 'border-transparent text-inky hover:text-navy',
                  ].join(' ')}
                >
                  {m === 'paste' ? 'Paste Data' : 'Upload File'}
                </button>
              ))}
            </div>

            {mode === 'paste' && (
              <>
                <p className="text-xs font-mono text-inky leading-relaxed">
                  Copy rows from Excel or Google Sheets and paste below. Expected columns (order doesn't matter):<br />
                  <span className="text-navy/60">Start Date · Status · Shop # · Issue Type · Issue Description · Date Resolved · Resolution Notes</span>
                </p>
                <textarea
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  placeholder="Paste tab-separated or CSV data here..."
                  rows={10}
                  className="w-full rounded border border-navy/20 bg-cream px-3 py-2 text-xs font-mono text-navy placeholder-inky/40 focus:border-sky focus:outline-none resize-y"
                />
                {parseError && <p className="text-xs font-mono text-red-500">{parseError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="secondary" size="sm" onClick={() => { reset(); onClose() }}>Cancel</Button>
                  <Button size="sm" onClick={handlePasteSubmit} disabled={!pasteText.trim() || (departments.length > 0 && !deptId)}>Preview →</Button>
                </div>
              </>
            )}

            {mode === 'file' && (
              <>
                <p className="text-xs font-mono text-inky leading-relaxed">
                  Upload an Excel (.xls, .xlsx) or CSV file. The first row must be a header row with column names.
                </p>
                <div
                  className="flex flex-col items-center justify-center gap-2 rounded border-2 border-dashed border-navy/20 px-6 py-10 hover:border-sky/60 cursor-pointer transition-colors"
                  onClick={() => fileRef.current?.click()}
                >
                  <svg className="w-8 h-8 text-inky/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span className="text-xs font-mono text-inky">Click to select a file</span>
                  <span className="text-[10px] font-mono text-inky/50">.xls · .xlsx · .csv</span>
                </div>
                <input ref={fileRef} type="file" accept=".xls,.xlsx,.csv" onChange={handleFile} className="hidden" />
                {parseError && <p className="text-xs font-mono text-red-500">{parseError}</p>}
                <div className="flex justify-end">
                  <Button variant="secondary" size="sm" onClick={() => { reset(); onClose() }}>Cancel</Button>
                </div>
              </>
            )}
          </>
        )}

        {/* ── Preview phase ── */}
        {phase === 'preview' && (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <span className="text-xs font-mono font-bold text-navy">{previewRows.length} rows ready to import</span>
              {unresolved > 0 && (
                <span className="text-xs font-mono text-amber-600">
                  ⚠ {unresolved} shop code{unresolved !== 1 ? 's' : ''} not found — will import without location
                </span>
              )}
            </div>
            <div className="overflow-auto max-h-72 rounded border border-navy/15">
              <table className="w-full text-xs font-mono border-collapse">
                <thead>
                  <tr className="bg-navy text-cream">
                    <th className="px-2 py-1.5 text-left font-normal whitespace-nowrap">Shop #</th>
                    <th className="px-2 py-1.5 text-left font-normal whitespace-nowrap">Status</th>
                    <th className="px-2 py-1.5 text-left font-normal whitespace-nowrap">Type</th>
                    <th className="px-2 py-1.5 text-left font-normal max-w-[200px]">Description</th>
                    <th className="px-2 py-1.5 text-left font-normal whitespace-nowrap">Start</th>
                    <th className="px-2 py-1.5 text-left font-normal whitespace-nowrap">Resolved</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-navy/5">
                  {previewRows.map((r, i) => (
                    <tr key={i} className={!r.location_found && r.location_code ? 'bg-amber-50/60' : ''}>
                      <td className="px-2 py-1 whitespace-nowrap">
                        {r.location_code || '—'}
                        {r.location_code && !r.location_found && (
                          <span className="ml-1 text-amber-500" title="Location code not found">⚠</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-inky">{r.status_name || '—'}</td>
                      <td className="px-2 py-1 text-inky whitespace-nowrap">{r.category_name || '—'}</td>
                      <td className="px-2 py-1 max-w-[200px] truncate">{r.title || '—'}</td>
                      <td className="px-2 py-1 text-inky whitespace-nowrap">{r.start_date || '—'}</td>
                      <td className="px-2 py-1 text-inky whitespace-nowrap">{r.resolved_date || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {unresolved > 0 && (
              <p className="text-xs font-mono text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                ⚠ {unresolved} shop code{unresolved !== 1 ? 's' : ''} could not be matched to a location. Those issues will be imported <strong>without a location</strong>. Go back to fix the codes, or cancel to abort.
              </p>
            )}
            <div className="flex justify-between gap-2">
              <Button variant="danger" size="sm" onClick={() => { reset(); onClose() }}>Cancel Import</Button>
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={() => setPhase('input')}>← Back</Button>
                <Button size="sm" onClick={runImport}>
                  Import {previewRows.length} Issue{previewRows.length !== 1 ? 's' : ''}
                </Button>
              </div>
            </div>
          </>
        )}

        {/* ── Importing phase ── */}
        {phase === 'importing' && (
          <div className="flex flex-col items-center gap-3 py-10">
            <div className="w-6 h-6 border-2 border-sky border-t-transparent rounded-full animate-spin" />
            <span className="text-xs font-mono text-inky">Importing issues…</span>
          </div>
        )}

        {/* ── Done phase ── */}
        {phase === 'done' && result && (
          <>
            <p className="text-sm font-mono font-bold text-navy">
              ✓ Imported {result.inserted} issue{result.inserted !== 1 ? 's' : ''}
            </p>
            {result.warnings.length > 0 && (
              <div className="rounded border border-amber-200 bg-amber-50/50 px-3 py-2 flex flex-col gap-1">
                <p className="text-xs font-mono font-bold text-amber-700">Warnings:</p>
                {result.warnings.map((w, i) => (
                  <p key={i} className="text-xs font-mono text-amber-600">• {w}</p>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <Button size="sm" onClick={() => { reset(); onClose() }}>Done</Button>
            </div>
          </>
        )}

      </div>
    </Modal>
  )
}
