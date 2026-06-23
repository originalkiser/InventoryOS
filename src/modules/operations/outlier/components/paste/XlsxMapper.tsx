import { useState } from 'react'
import { ArrowLeft, Check } from 'lucide-react'
import { Report, ColumnDef, ParsedRow } from '../../types'
import { parseLocation, parseEmployeeRow } from './locationParser'
import { toDateString, getThisWeekFriday } from '../../lib/weekUtils'

interface Props {
  sourceHeaders: string[]
  sourceRows: string[][]
  report: Report
  onBack: () => void
  onMapped: (rows: ParsedRow[]) => void
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

export default function XlsxMapper({ sourceHeaders, sourceRows, report, onBack, onMapped }: Props) {
  const [mapping, setMapping] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const col of report.columns) m[col.key] = autoMatch(col, sourceHeaders)
    return m
  })

  const primaryCol = report.columns.find(c => c.type === 'location' || c.type === 'employee')
  const hasPrimary = !!(primaryCol && mapping[primaryCol.key])

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
