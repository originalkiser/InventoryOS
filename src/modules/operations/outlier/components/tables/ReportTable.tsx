import { useState, useCallback, useEffect, useRef } from 'react'
import { Truck, User as UserIcon, ChevronUp, ChevronDown } from 'lucide-react'
import { ReportEntry, ColumnDef, Week } from '../../types'
import StreakCell from '../shared/StreakCell'
import DueDateCell from '../shared/DueDateCell'
import StatusPill from '../shared/StatusPill'

// Keys that are handled as fixed columns — exclude from user data columns to avoid duplicates
const FIXED_KEYS = new Set([
  'area_manager', 'area_manager_name', 'am',
  'rdo', 'rdo_name', 'director',
  'regional_director', 'regional director',
  'am_comment', 'am_comments', 'comments',
  'due_date', 'due date',
  'status', 'completed', 'is_complete',
  'submitted_by', 'submitted_by_override',
])

function normalizeKey(k: string) {
  return k.toLowerCase().replace(/[\s-]+/g, '_')
}

interface AppUser { id: string; full_name: string | null; email: string }

interface Props {
  entries: ReportEntry[]
  allEntries: ReportEntry[]
  allWeeks: Week[]
  currentWeekId: string
  columns: ColumnDef[]
  isEmployeeReport: boolean
  flashedIds?: Set<string>
  onCommentChange?: (id: string, comment: string) => void
  onDueDateChange?: (id: string, date: string) => void
  onCompleteToggle?: (id: string, val: boolean) => void
  onAMNameChange?: (id: string, name: string, userId?: string | null) => void
  onRDONameChange?: (id: string, name: string, userId?: string | null) => void
  appUsers?: AppUser[]
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
  onAMNameChange,
  onRDONameChange,
  appUsers,
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
    const av = (a as any)[sortKey] ?? a.data[sortKey] ?? ''
    const bv = (b as any)[sortKey] ?? b.data[sortKey] ?? ''
    const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true })
    return sortDir === 'asc' ? cmp : -cmp
  })

  const dataRows = sorted.filter(e => e.row_type !== 'total')
  const totalRows = sorted.filter(e => e.row_type === 'total')
  const displayRows = [...dataRows, ...totalRows]

  // User-defined data columns: exclude location/employee identifiers AND fixed columns
  const dataColumns = columns.filter(c =>
    c.type !== 'location' &&
    c.type !== 'employee' &&
    !FIXED_KEYS.has(normalizeKey(c.key))
  )

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
    <div className="overflow-auto max-h-[calc(100vh-300px)]">
      <table className="w-full text-left sticky-table">
        <thead className="sticky top-0">
          <tr className="border-b border-sb-inky/40">
            {/* Shop/Employee — always first, sticky */}
            <Th label={isEmployeeReport ? 'EMPLOYEE' : 'SHOP'} sortKey="row_label" current={sortKey} dir={sortDir} onSort={handleSort} sticky />

            {/* User-defined data columns */}
            {dataColumns.map(col => (
              <Th key={col.key} label={col.label} sortKey={col.key} current={sortKey} dir={sortDir} onSort={handleSort} />
            ))}

            {/* Fixed enriched columns: AM → RDO (shop reports only) */}
            {!isEmployeeReport && (
              <>
                <Th label="AREA MANAGER" sortKey="area_manager_name" current={sortKey} dir={sortDir} onSort={handleSort} />
                <Th label="REGIONAL DIRECTOR" sortKey="rdo_name" current={sortKey} dir={sortDir} onSort={handleSort} />
              </>
            )}

            {/* Fixed trailing columns */}
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
                {/* Shop/Employee name — sticky */}
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

                {/* User data columns */}
                {dataColumns.map(col => (
                  <td key={col.key} className="px-3 py-2.5 text-right">
                    <span className="font-mono text-[12px] text-sb-cream/90">
                      {entry.data[col.key] != null ? String(entry.data[col.key]) : '—'}
                    </span>
                  </td>
                ))}

                {/* Area Manager / RDO — text entry + optional user picker */}
                {!isEmployeeReport && (
                  <>
                    <td className="px-3 py-2.5 min-w-[180px]">
                      {!isTotal && onAMNameChange ? (
                        <AMUserInput
                          value={entry.area_manager_name ?? ''}
                          currentUserId={entry.am_assigned_user_id}
                          placeholder="Area manager…"
                          appUsers={appUsers}
                          onChange={(name, userId) => onAMNameChange(entry.id, name, userId)}
                        />
                      ) : (
                        <span className="font-mono text-[12px] text-sb-cream/70">
                          {entry.area_manager_name ?? '—'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 min-w-[180px]">
                      {!isTotal && onRDONameChange ? (
                        <AMUserInput
                          value={entry.rdo_name ?? ''}
                          currentUserId={entry.rdo_assigned_user_id}
                          placeholder="Regional director…"
                          appUsers={appUsers}
                          onChange={(name, userId) => onRDONameChange(entry.id, name, userId)}
                        />
                      ) : (
                        <span className="font-mono text-[12px] text-sb-cream/70">
                          {entry.rdo_name ?? '—'}
                        </span>
                      )}
                    </td>
                  </>
                )}

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

// Combined text input + optional user-picker dropdown for AM/RDO cells
function AMUserInput({ value, currentUserId, placeholder, appUsers, onChange }: {
  value: string
  currentUserId?: string | null
  placeholder?: string
  appUsers?: AppUser[]
  onChange: (name: string, userId?: string | null) => void
}) {
  const [local, setLocal] = useState(value)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!pickerOpen) return
    function onOut(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [pickerOpen])

  // Sync local value if parent value changes (e.g. user selected from picker on another row)
  useEffect(() => { setLocal(value) }, [value])

  async function handleBlur() {
    if (local === value) return
    setSaving(true)
    await onChange(local, undefined) // free-text edit: don't change userId assignment
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  async function pickUser(userId: string) {
    const user = appUsers?.find(u => u.id === userId)
    const name = user ? (user.full_name ?? user.email ?? '') : ''
    setLocal(name)
    setPickerOpen(false)
    setSaving(true)
    await onChange(name, userId || null)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const hasUsers = appUsers && appUsers.length > 0

  return (
    <div className="flex items-center gap-1">
      <input
        value={local}
        onChange={e => { setLocal(e.target.value); setSaved(false) }}
        onBlur={handleBlur}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder={placeholder}
        className="flex-1 bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky placeholder:text-sb-cream/25 min-w-[110px]"
      />
      {saving && <span className="font-mono text-[10px] text-sb-inky animate-spin">⟳</span>}
      {saved && <span className="font-mono text-[10px] text-sb-green">✓</span>}
      {hasUsers && (
        <div className="relative shrink-0" ref={pickerRef}>
          <button
            onClick={() => setPickerOpen(o => !o)}
            title="Pick from SB Net users"
            className={`p-1 rounded border transition-colors ${pickerOpen ? 'border-sb-sky text-sb-sky' : 'border-sb-inky/40 text-sb-inky hover:border-sb-sky hover:text-sb-sky'}`}
          >
            <UserIcon size={11} />
          </button>
          {pickerOpen && (
            <div className="absolute top-full right-0 mt-1 z-20 bg-sb-navy border border-sb-inky/40 rounded shadow-xl min-w-[180px] max-h-56 overflow-y-auto">
              <button
                onClick={() => pickUser('')}
                className="block w-full text-left px-3 py-1.5 font-mono text-[11px] text-sb-inky hover:bg-sb-inky/30 border-b border-sb-inky/20"
              >
                — Clear / Auto —
              </button>
              {appUsers!.map(u => (
                <button
                  key={u.id}
                  onClick={() => pickUser(u.id)}
                  className={`block w-full text-left px-3 py-1.5 font-mono text-[11px] hover:bg-sb-inky/30 transition-colors ${u.id === currentUserId ? 'text-sb-sky' : 'text-sb-cream'}`}
                >
                  {u.full_name ?? u.email}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function InlineTextInput({ value, placeholder, onChange }: {
  value: string
  placeholder?: string
  onChange: (v: string) => void
}) {
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
    <div className="flex items-center gap-1">
      <input
        value={local}
        onChange={e => { setLocal(e.target.value); setSaved(false) }}
        onBlur={handleBlur}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        placeholder={placeholder}
        className="flex-1 bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky placeholder:text-sb-cream/25 min-w-[110px]"
      />
      {saving && <span className="font-mono text-[10px] text-sb-inky animate-spin">⟳</span>}
      {saved && <span className="font-mono text-[10px] text-sb-green">✓</span>}
    </div>
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
