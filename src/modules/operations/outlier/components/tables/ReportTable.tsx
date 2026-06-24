import { useState, useCallback } from 'react'
import { Truck, User as UserIcon, ChevronUp, ChevronDown } from 'lucide-react'
import { ReportEntry, ColumnDef, Week } from '../../types'
import StreakCell from '../shared/StreakCell'
import DueDateCell from '../shared/DueDateCell'
import StatusPill from '../shared/StatusPill'

interface Props {
  entries: ReportEntry[]
  allEntries: ReportEntry[]   // all weeks, for streak calc
  allWeeks: Week[]
  currentWeekId: string
  columns: ColumnDef[]
  isEmployeeReport: boolean
  flashedIds?: Set<string>
  onCommentChange?: (id: string, comment: string) => void
  onDueDateChange?: (id: string, date: string) => void
  onCompleteToggle?: (id: string, val: boolean) => void
  editableByAM?: boolean
}

type SortDir = 'asc' | 'desc' | null

export default function ReportTable({
  entries,
  allEntries,
  allWeeks,
  currentWeekId,
  columns,
  isEmployeeReport,
  flashedIds,
  onCommentChange,
  onDueDateChange,
  onCompleteToggle,
  editableByAM,
}: Props) {
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>(null)

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : d === 'desc' ? null : 'asc')
      if (sortDir === 'desc') setSortKey(null)
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sorted = [...entries].sort((a, b) => {
    if (!sortKey || !sortDir) return 0
    // Check top-level typed columns first, then fall back to data bag
    const av = (a as any)[sortKey] ?? a.data[sortKey] ?? ''
    const bv = (b as any)[sortKey] ?? b.data[sortKey] ?? ''
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
    return sortDir === 'asc' ? cmp : -cmp
  })

  // Separate data rows from total rows
  const dataRows = sorted.filter(e => e.row_type !== 'total')
  const totalRows = sorted.filter(e => e.row_type === 'total')
  const displayRows = [...dataRows, ...totalRows]

  const dataColumns = columns.filter(c => c.type !== 'location' && c.type !== 'employee')

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="text-4xl mb-3">📋</div>
        <p className="font-brand font-bold text-sb-inky tracking-widest text-[13px] uppercase">
          No Data For This Week
        </p>
        <p className="font-mono text-sb-cream/40 text-[12px] mt-1">
          Paste a report to get started
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left sticky-table">
        <thead>
          <tr className="border-b border-sb-inky/40">
            <Th label={isEmployeeReport ? 'EMPLOYEE' : 'SHOP'} sortKey="row_label" current={sortKey} dir={sortDir} onSort={handleSort} sticky />
            {!isEmployeeReport && (
              <>
                <Th label="AREA MANAGER" sortKey="area_manager_name" current={sortKey} dir={sortDir} onSort={handleSort} />
                <Th label="RDO" sortKey="rdo_name" current={sortKey} dir={sortDir} onSort={handleSort} />
              </>
            )}
            {dataColumns.map(col => (
              <Th key={col.key} label={col.label} sortKey={col.key} current={sortKey} dir={sortDir} onSort={handleSort} />
            ))}
            <Th label="STREAK / LAST" sortKey={null} current={null} dir={null} onSort={() => {}} />
            <Th label="DUE DATE" sortKey="due_date" current={sortKey} dir={sortDir} onSort={handleSort} />
            <Th label="AM COMMENT" sortKey={null} current={null} dir={null} onSort={() => {}} />
            <Th label="STATUS" sortKey={null} current={null} dir={null} onSort={() => {}} />
          </tr>
        </thead>
        <tbody>
          {displayRows.map(entry => {
            const isTotal = entry.row_type === 'total'
            const isFlashed = flashedIds?.has(entry.id)
            const isComplete = entry.is_complete
            const isOverdue = !isComplete && entry.due_date
              ? new Date(entry.due_date) < new Date(new Date().toDateString())
              : false

            return (
              <tr
                key={entry.id}
                className={`border-b border-sb-inky/20 transition-colors ${
                  isFlashed ? 'row-flash' :
                  isTotal ? 'bg-sb-inky/20' :
                  isComplete ? 'bg-sb-green/5' :
                  isOverdue ? 'bg-sb-red/5' :
                  'hover:bg-sb-inky/10'
                } ${isTotal ? 'font-medium' : ''}`}
              >
                {/* Shop/Employee name */}
                <td className={`px-3 py-2.5 bg-sb-navy ${isTotal ? 'bg-sb-inky/20' : ''}`}>
                  <div className="flex items-center gap-2 min-w-[140px]">
                    {isTotal
                      ? null
                      : isEmployeeReport
                        ? <UserIcon size={12} className="text-sb-inky shrink-0" />
                        : <Truck size={12} className="text-sb-inky shrink-0" />
                    }
                    <span className={`font-mono text-[12px] ${isTotal ? 'text-sb-sky font-medium' : 'text-sb-cream'}`}>
                      {entry.row_label}
                    </span>
                  </div>
                </td>

                {/* Area Manager / RDO — only for shop reports, from enriched columns */}
                {!isEmployeeReport && (
                  <>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-[12px] text-sb-cream/70">
                        {entry.area_manager_name ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-mono text-[12px] text-sb-cream/70">
                        {entry.rdo_name ?? '—'}
                      </span>
                    </td>
                  </>
                )}

                {/* Data columns */}
                {dataColumns.map(col => (
                  <td key={col.key} className="px-3 py-2.5 text-right">
                    <span className="font-mono text-[12px] text-sb-cream/90">
                      {entry.data[col.key] != null ? String(entry.data[col.key]) : '—'}
                    </span>
                  </td>
                ))}

                {/* Streak / Last */}
                <td className="px-3 py-2.5">
                  {!isTotal && (
                    <StreakCell
                      rowKey={entry.row_key}
                      currentWeekId={currentWeekId}
                      allEntries={allEntries}
                      allWeeks={allWeeks}
                      columns={columns}
                    />
                  )}
                </td>

                {/* Due date */}
                <td className="px-3 py-2.5">
                  <DueDateCell
                    dueDate={entry.due_date}
                    isComplete={isComplete}
                    editable={editableByAM && !!onDueDateChange}
                    onChange={onDueDateChange ? (d) => onDueDateChange(entry.id, d) : undefined}
                  />
                </td>

                {/* AM Comment */}
                <td className="px-3 py-2.5 min-w-[180px]">
                  {editableByAM && onCommentChange ? (
                    <AMCommentInput
                      value={entry.am_comment ?? ''}
                      onChange={v => onCommentChange(entry.id, v)}
                    />
                  ) : (
                    <span className="font-mono text-[12px] text-sb-cream/70 line-clamp-2">
                      {entry.am_comment || <span className="text-sb-cream/25">—</span>}
                    </span>
                  )}
                </td>

                {/* Status */}
                <td className="px-3 py-2.5">
                  {!isTotal && (
                    editableByAM && onCompleteToggle ? (
                      <button
                        onClick={() => onCompleteToggle(entry.id, !isComplete)}
                        className={`w-5 h-5 rounded border transition-colors ${
                          isComplete
                            ? 'bg-sb-green border-sb-green'
                            : 'border-sb-inky hover:border-sb-sky'
                        }`}
                      >
                        {isComplete && <span className="text-sb-navy text-[10px] font-bold">✓</span>}
                      </button>
                    ) : (
                      <StatusPill isComplete={isComplete} dueDate={entry.due_date} />
                    )
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({
  label, sortKey, current, dir, onSort, sticky,
}: {
  label: string; sortKey: string | null; current: string | null; dir: SortDir; onSort: (k: string) => void; sticky?: boolean
}) {
  const active = sortKey && current === sortKey
  return (
    <th
      onClick={() => sortKey && onSort(sortKey)}
      className={`px-3 py-2.5 font-brand font-bold text-[10px] tracking-widest uppercase text-sb-inky select-none whitespace-nowrap ${
        sortKey ? 'cursor-pointer hover:text-sb-sky transition-colors' : ''
      } ${sticky ? 'sticky left-0 bg-sb-navy z-10' : ''} ${active ? 'text-sb-sky' : ''}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && dir === 'asc' && <ChevronUp size={10} />}
        {active && dir === 'desc' && <ChevronDown size={10} />}
      </span>
    </th>
  )
}

function AMCommentInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleBlur = useCallback(async () => {
    if (local === value) return
    setSaving(true)
    await Promise.resolve(onChange(local))
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }, [local, value, onChange])

  return (
    <div className="flex items-center gap-1.5">
      <input
        value={local}
        onChange={e => { setLocal(e.target.value); setSaved(false) }}
        onBlur={handleBlur}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder="Add comment…"
        className="flex-1 bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky placeholder:text-sb-cream/25 min-w-[120px]"
      />
      {saving && <span className="font-mono text-[10px] text-sb-inky animate-spin">⟳</span>}
      {saved && <span className="font-mono text-[10px] text-sb-green">✓</span>}
    </div>
  )
}
