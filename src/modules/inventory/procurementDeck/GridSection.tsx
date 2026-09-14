import { useState } from 'react'
import { Upload, Trash2, Plus, ChevronDown, ChevronUp } from 'lucide-react'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { Button } from '@/components/ui'
import type { GridCell } from './types'
import { DeckChart } from './DeckChart'
import { formatValue, toInputValue, fromInputValue, type ValueFormat } from './formatting'

export interface GridSectionProps {
  title: string
  slideKey: string
  tableKey: string
  cells: GridCell[]
  format: ValueFormat
  // Per-row or per-column format overrides for grids that mix, e.g., counts
  // and a percent row/column in the same table (row wins if both match).
  rowFormats?: Record<string, ValueFormat>
  columnFormats?: Record<string, ValueFormat>
  chart?: { rows: string[]; stacked?: boolean; lineRows?: string[] }
  allowAddRow?: boolean
  onSaveCell: (rowLabel: string, rowSort: number, colKey: string, colLabel: string, colSort: number, value: number | null) => void
  onDeleteRow: (rowLabel: string) => void
  onUpload: (headers: string[], rows: Record<string, string>[]) => void
}

export function GridSection({ title, slideKey, tableKey, cells, format, rowFormats, columnFormats, chart, allowAddRow, onSaveCell, onDeleteRow, onUpload }: GridSectionProps) {
  const formatFor = (row: string, colKey: string): ValueFormat => rowFormats?.[row] ?? columnFormats?.[colKey] ?? format
  const [showUpload, setShowUpload] = useState(false)
  const [newRow, setNewRow] = useState('')

  const rowMap = new Map<string, number>()
  for (const c of cells) rowMap.set(c.row_label, c.row_sort)
  const rowLabels = [...rowMap.entries()].sort((a, b) => a[1] - b[1]).map(([r]) => r)
  const colMap = new Map<string, { label: string; sort: number }>()
  for (const c of cells) colMap.set(c.col_key, { label: c.col_label, sort: c.col_sort })
  const cols = [...colMap.entries()].sort((a, b) => a[1].sort - b[1].sort).map(([key, v]) => ({ key, ...v }))

  function cellFor(row: string, colKey: string) {
    return cells.find((c) => c.row_label === row && c.col_key === colKey) ?? null
  }

  function addRow() {
    const label = newRow.trim()
    if (!label) return
    const nextSort = Math.max(0, ...rowLabels.map((r) => rowMap.get(r) ?? 0)) + 1
    // Seed the row with its first column so it has something to key off of;
    // real values get filled in as the user edits cells.
    if (cols.length > 0) onSaveCell(label, nextSort, cols[0].key, cols[0].label, cols[0].sort, null)
    setNewRow('')
  }

  return (
    <div className="flex flex-col gap-3">
      {chart && chart.rows.length > 0 && (
        <DeckChart title={title} cells={cells} rows={chart.rows} stacked={chart.stacked} lineRows={chart.lineRows} format={format} />
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[11px] font-mono text-inky uppercase tracking-wide">{title} — Data</span>
        <button onClick={() => setShowUpload((s) => !s)} className="inline-flex items-center gap-1 text-[11px] font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">
          <Upload className="w-3 h-3" /> Upload to update {showUpload ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {showUpload && (
        <div className="border border-navy/20 rounded-lg p-3 bg-cream">
          <p className="text-[11px] font-mono text-inky/70 mb-2">
            First column = row label (must match an existing row name to update it, or a new name to add one); every other column header becomes a data column — a month header like "Jul-26" lines up with the matching existing column automatically.
          </p>
          <FileUploadZone onParsed={(r) => { onUpload(r.headers, r.rows); setShowUpload(false) }} label="Drop a CSV / Excel file, or click to browse" />
        </div>
      )}

      {cols.length === 0 || rowLabels.length === 0 ? (
        <p className="text-xs font-mono text-inky/50 py-4">No data yet — upload a file or add a row to get started.</p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30">
          <table className="text-xs font-mono border-collapse w-full">
            <thead>
              <tr>
                <th className="px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky left-0 z-10">Row</th>
                {cols.map((c) => <th key={c.key} className="px-2 py-2 text-right font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream">{c.label}</th>)}
                <th className="px-2 py-2 border-b border-navy/30 bg-cream" />
              </tr>
            </thead>
            <tbody>
              {rowLabels.map((row, idx) => {
                const band = idx % 2 ? 'bg-[#ECEBD8] dark:bg-[#0D2035]' : 'bg-cream'
                return (
                  <tr key={row} className={band}>
                    <td className={`px-2 py-1.5 border-b border-navy/15 whitespace-nowrap text-navy font-semibold sticky left-0 ${band}`}>{row}</td>
                    {cols.map((c) => {
                      const cell = cellFor(row, c.key)
                      const fmt = formatFor(row, c.key)
                      return (
                        <td key={c.key} className="px-2 py-1 border-b border-navy/15 text-right">
                          <input
                            type="number"
                            defaultValue={toInputValue(cell?.value_num, fmt)}
                            onBlur={(e) => {
                              const v = fromInputValue(e.target.value, fmt)
                              const prevInput = toInputValue(cell?.value_num, fmt)
                              if (e.target.value.trim() === prevInput.trim()) return
                              onSaveCell(row, rowMap.get(row) ?? 0, c.key, c.label, c.sort, v)
                            }}
                            title={formatValue(cell?.value_num, fmt)}
                            className="w-24 bg-transparent border border-transparent hover:border-navy/30 focus:border-sky focus:bg-white rounded px-1 py-0.5 text-right text-navy"
                          />
                        </td>
                      )
                    })}
                    <td className="px-2 py-1 border-b border-navy/15 text-center">
                      <button onClick={() => onDeleteRow(row)} title="Remove row" className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3 h-3" /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {allowAddRow !== false && (
        <div className="flex items-center gap-2">
          <input
            value={newRow}
            onChange={(e) => setNewRow(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRow() }}
            placeholder="New row label…"
            className="w-56 bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky"
          />
          <Button size="sm" variant="secondary" onClick={addRow} disabled={!newRow.trim() || cols.length === 0}><Plus className="w-3 h-3 mr-1" /> Add Row</Button>
        </div>
      )}
    </div>
  )
}
