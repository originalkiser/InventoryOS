import { useState } from 'react'
import { ArrowLeft, Check, Plus } from 'lucide-react'
import { Report, ColumnDef, ParsedRow, ColumnType } from '../../types'
import { parseLocation, parseEmployeeRow } from './locationParser'
import { toDateString, getThisWeekFriday } from '../../lib/weekUtils'

interface Props {
  sourceHeaders: string[]
  sourceRows: string[][]
  report: Report
  onBack: () => void
  onMapped: (rows: ParsedRow[]) => void
  onAddColumns?: (newCols: ColumnDef[]) => Promise<void>
}

function labelToKey(label: string) {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function guessColType(header: string, rows: string[][], headerIdx: number): ColumnType {
  const vals = rows.map(r => String(r[headerIdx] ?? '').trim()).filter(Boolean)
  if (!vals.length) return 'text'
  const numericCount = vals.filter(v => !isNaN(parseFloat(v.replace(/[$,%]/g, '')))).length
  if (numericCount / vals.length >= 0.8) return 'number'
  return 'text'
}

function autoMatch(col: ColumnDef, headers: string[]): string {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const label = normalize(col.label)
  const key = normalize(col.key)
  for (const h of headers) {
    const n = normalize(h)
    if (n === label || n === key || n.includes(label) || label.includes(n)) return h
  }
  return ''
}

export default function XlsxMapper({ sourceHeaders, sourceRows, report, onBack, onMapped, onAddColumns }: Props) {
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const col of report.columns) m[col.key] = autoMatch(col, sourceHeaders)
    return m
  })
  const [addingCols, setAddingCols] = useState(false)
  const [selectedNew, setSelectedNew] = useState<Set<string>>(new Set())

  const primaryCol = report.columns.find(c => c.type === 'location' || c.type === 'employee')
  const hasPrimary = !!(primaryCol && mapping[primaryCol.key])

  const existingKeys = new Set(report.columns.map(c => c.key))
  const usedSourceCols = new Set(Object.values(mapping).filter(Boolean))
  // Source headers not yet mapped to any report column and not key-conflicting
  const addableHeaders = sourceHeaders.filter(h => {
    const key = labelToKey(h)
    return key && !usedSourceCols.has(h) && !existingKeys.has(key)
  })

  async function handleAddAndMap() {
    if (!onAddColumns || !selectedNew.size) return
    setAddingCols(true)
    const newCols: ColumnDef[] = Array.from(selectedNew).map(header => {
      const key = labelToKey(header)
      const headerIdx = sourceHeaders.indexOf(header)
      const type = guessColType(header, sourceRows, headerIdx)
      return { key, label: header, type }
    })
    await onAddColumns(newCols)
    // Auto-map each new col to its source header
    setMapping(prev => {
      const next = { ...prev }
      for (const col of newCols) {
        next[col.key] = col.label
      }
      return next
    })
    setAddingCols(false)
    setSelectedNew(new Set())
  }

  function generate() {
    const defaultDueDate = toDateString(getThisWeekFriday())
    const locationCol = report.columns.find(c => c.type === 'location')
    const employeeCol = report.columns.find(c => c.type === 'employee')

    const rows: ParsedRow[] = []
    for (let i = 0; i < sourceRows.length; i++) {
      const row = sourceRows[i]

      const getVal = (key: string) => {
        const src = mapping[key]
        if (!src) return ''
        const idx = sourceHeaders.indexOf(src)
        return idx >= 0 ? String(row[idx] ?? '').trim() : ''
      }

      const primaryKey = (locationCol ?? employeeCol)?.key ?? ''
      const primaryVal = getVal(primaryKey)
      if (!primaryVal) continue

      const isTotal = /^(grand\s+)?total$/i.test(primaryVal)
      let parsed: ParsedRow

      if (report.is_employee_report && employeeCol) {
        const locVal = locationCol ? getVal(locationCol.key) : ''
        const empVal = getVal(employeeCol.key)
        const emp = parseEmployeeRow(locVal || primaryVal, empVal || primaryVal)
        parsed = {
          row_key: emp.rowKey,
          row_label: emp.rowLabel,
          row_type: isTotal ? 'total' : 'data',
          data: {},
          matched: emp.matched,
          originalText: row.join('\t'),
        }
      } else {
        const locVal = locationCol ? getVal(locationCol.key) : primaryVal
        const loc = parseLocation(locVal)
        parsed = {
          row_key: isTotal ? `total-${i}` : loc.rowKey,
          row_label: isTotal ? primaryVal : loc.rowLabel,
          row_type: isTotal ? 'total' : 'data',
          data: {},
          matched: isTotal || loc.matched,
          originalText: row.join('\t'),
        }
      }

      for (const col of report.columns) {
        if (col.type === 'location' || col.type === 'employee') continue
        parsed.data[col.key] = getVal(col.key)
      }
      parsed.data['due_date'] = defaultDueDate
      rows.push(parsed)
    }

    onMapped(rows)
  }

  const mappedCols = report.columns.filter(c => mapping[c.key])

  return (
    <div className="flex-1 overflow-y-auto p-5 space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="text-sb-inky hover:text-sb-cream transition-colors">
          <ArrowLeft size={16} />
        </button>
        <div>
          <h3 className="font-brand font-bold text-sb-sky tracking-widest text-[13px] uppercase">Map Columns</h3>
          <p className="font-mono text-sb-cream/50 text-[11px]">{sourceRows.length} rows · {sourceHeaders.length} source columns detected</p>
        </div>
      </div>

      {/* Mapping table */}
      <div className="space-y-2">
        <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase">
          Report Column → Excel Column
        </p>
        {report.columns.map(col => (
          <div key={col.key} className="flex items-center gap-3">
            <div className="w-44 shrink-0">
              <span className="font-brand font-bold text-[11px] text-sb-cream tracking-wide uppercase">{col.label}</span>
              {col.required && <span className="text-sb-red text-[10px] ml-1">*</span>}
            </div>
            <select
              value={mapping[col.key] ?? ''}
              onChange={e => setMapping(prev => ({ ...prev, [col.key]: e.target.value }))}
              className="flex-1 bg-sb-inky/30 text-sb-cream font-mono text-[12px] px-3 py-1.5 rounded border border-sb-inky/50 focus:outline-none focus:border-sb-sky"
            >
              <option value="">— skip —</option>
              {sourceHeaders.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
            {mapping[col.key] && <Check size={13} className="text-sb-sky shrink-0" />}
          </div>
        ))}
      </div>

      {/* Preview */}
      {mappedCols.length > 0 && (
        <div>
          <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase mb-2">Preview (first 3 rows)</p>
          <div className="overflow-x-auto rounded border border-sb-inky/30">
            <table className="text-[11px] font-mono w-full">
              <thead>
                <tr className="border-b border-sb-inky/30 bg-sb-inky/10">
                  {mappedCols.map(c => (
                    <th key={c.key} className="text-left text-sb-inky px-3 py-1.5 whitespace-nowrap font-normal tracking-wide">
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sourceRows.slice(0, 3).map((row, i) => (
                  <tr key={i} className="border-b border-sb-inky/10">
                    {mappedCols.map(c => {
                      const idx = sourceHeaders.indexOf(mapping[c.key])
                      return (
                        <td key={c.key} className="text-sb-cream/70 px-3 py-1.5 whitespace-nowrap max-w-[160px] truncate">
                          {idx >= 0 ? String(row[idx] ?? '') : ''}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Add unmapped source columns to report */}
      {onAddColumns && addableHeaders.length > 0 && (
        <div className="border border-sb-inky/30 rounded p-3 space-y-2">
          <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase">
            Add source columns to report
          </p>
          <p className="font-mono text-[11px] text-sb-cream/40">
            These source columns aren't in the report yet. Check any you'd like to add as new data columns.
          </p>
          <div className="flex flex-wrap gap-2">
            {addableHeaders.map(h => (
              <label key={h} className="flex items-center gap-1.5 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={selectedNew.has(h)}
                  onChange={e => setSelectedNew(prev => {
                    const next = new Set(prev)
                    if (e.target.checked) next.add(h)
                    else next.delete(h)
                    return next
                  })}
                  className="accent-sb-sky"
                />
                <span className="font-mono text-[11px] text-sb-cream/70 group-hover:text-sb-cream transition-colors">{h}</span>
              </label>
            ))}
          </div>
          {selectedNew.size > 0 && (
            <button
              onClick={handleAddAndMap}
              disabled={addingCols}
              className="flex items-center gap-1.5 font-brand font-bold text-[11px] tracking-wider bg-sb-inky/40 border border-sb-inky text-sb-cream px-3 py-1.5 rounded hover:bg-sb-inky/60 transition disabled:opacity-40"
            >
              <Plus size={12} />
              {addingCols ? 'Adding…' : `Add ${selectedNew.size} column${selectedNew.size !== 1 ? 's' : ''} to report`}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={generate}
          disabled={!hasPrimary}
          className="flex items-center gap-2 bg-sb-sky text-sb-navy font-brand font-bold text-[12px] tracking-wider px-4 py-2 rounded hover:brightness-105 transition disabled:opacity-40"
        >
          APPLY MAPPING
        </button>
        {!hasPrimary && (
          <p className="font-mono text-sb-orange text-[11px]">
            Map the {report.is_employee_report ? 'employee' : 'location'} column to continue.
          </p>
        )}
      </div>
    </div>
  )
}
