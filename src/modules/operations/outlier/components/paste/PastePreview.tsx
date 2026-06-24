import { Truck, User as UserIcon, CheckCircle, AlertTriangle, ChevronLeft } from 'lucide-react'
import { ParsedRow, ColumnDef } from '../../types'

interface Props {
  rows: ParsedRow[]
  columns: ColumnDef[]
  existingKeys: Set<string>
  pivotInfo: { isPivot: boolean; shopCount: number; employeeCount: number } | null
  onBack: () => void
  onCommit: () => void
  committing: boolean
  error?: string | null
}

export default function PastePreview({ rows, columns, existingKeys, pivotInfo, onBack, onCommit, committing, error }: Props) {
  const dataColumns = columns.filter(c => c.type !== 'location' && c.type !== 'employee' && c.key !== 'due_date')
  const newCount = rows.filter(r => !existingKeys.has(r.row_key)).length
  const updateCount = rows.filter(r => existingKeys.has(r.row_key)).length
  const unmatchedCount = rows.filter(r => !r.matched).length

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {/* Pivot banner */}
      {pivotInfo?.isPivot && (
        <div className="px-5 py-2 bg-sb-navy border-b border-sb-sky/40">
          <p className="font-brand font-bold text-sb-sky text-[12px] tracking-widest uppercase">
            Pivot Table Detected — {pivotInfo.shopCount} shops, {pivotInfo.employeeCount} employees
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="flex items-center gap-4 px-5 py-3 border-b border-sb-inky/20">
        <Stat label="Total Rows" value={rows.length} />
        <Stat label="New" value={newCount} color="text-sb-green" />
        <Stat label="Update" value={updateCount} color="text-sb-orange" />
        {unmatchedCount > 0 && <Stat label="Unmatched" value={unmatchedCount} color="text-sb-red" />}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left">
          <thead className="sticky top-0 bg-sb-navy border-b border-sb-inky/40">
            <tr>
              <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase w-8" />
              <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">SHOP / EMPLOYEE</th>
              {dataColumns.map(col => (
                <th key={col.key} className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">{col.label}</th>
              ))}
              <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">MATCH</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const isNew = !existingKeys.has(row.row_key)
              const isUpdate = existingKeys.has(row.row_key)
              const isTotal = row.row_type === 'total'

              return (
                <tr
                  key={i}
                  className={`border-b border-sb-inky/15 text-sb-cream/80 ${
                    isTotal ? 'bg-sb-inky/20 opacity-70' :
                    isNew ? 'bg-sb-green/5' :
                    isUpdate ? 'bg-sb-orange/5' :
                    ''
                  }`}
                >
                  <td className="px-3 py-2">
                    {isTotal ? null : row.row_key.includes(':')
                      ? <UserIcon size={11} className="text-sb-inky" />
                      : <Truck size={11} className="text-sb-inky" />
                    }
                  </td>
                  <td className="px-3 py-2 font-mono text-[12px]">{row.row_label}</td>
                  {dataColumns.map(col => (
                    <td key={col.key} className="px-3 py-2 font-mono text-[12px] text-right">
                      {row.data[col.key] != null ? String(row.data[col.key]) : '—'}
                    </td>
                  ))}
                  <td className="px-3 py-2">
                    {row.matched
                      ? <CheckCircle size={13} className="text-sb-green" />
                      : <AlertTriangle size={13} className="text-sb-orange" />
                    }
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      {error && (
        <div className="px-5 py-2 bg-sb-red/10 border-t border-sb-red/30">
          <p className="font-mono text-sb-red text-[12px]">{error}</p>
        </div>
      )}
      <div className="flex items-center justify-between px-5 py-3 border-t border-sb-inky/30">
        <button
          onClick={onBack}
          className="flex items-center gap-2 text-sb-cream/60 font-brand font-bold text-[12px] tracking-wide hover:text-sb-cream transition"
        >
          <ChevronLeft size={14} />
          BACK
        </button>

        <div className="flex items-center gap-3">
          {updateCount > 0 && (
            <p className="font-mono text-[11px] text-sb-orange/80">
              {updateCount} existing {updateCount === 1 ? 'row' : 'rows'} will be replaced
            </p>
          )}
          <button
            onClick={onCommit}
            disabled={committing}
            className="flex items-center gap-2 bg-sb-sky text-sb-navy font-brand font-bold text-[12px] tracking-wider px-5 py-2 rounded hover:brightness-105 transition disabled:opacity-50"
          >
            {committing ? 'SAVING…' : 'CONFIRM IMPORT'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className={`font-mono text-[18px] font-medium ${color ?? 'text-sb-cream'}`}>{value}</span>
      <span className="font-brand font-bold text-[9px] tracking-widest text-sb-inky uppercase">{label}</span>
    </div>
  )
}
