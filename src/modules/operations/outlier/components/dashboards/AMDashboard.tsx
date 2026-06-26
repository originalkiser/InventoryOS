import { useState, useEffect } from 'react'
import { ExternalLink, MessageSquare } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Report, ReportEntry, Week, UserProfile, AMLocation } from '../../types'
import { getDaysUntil, getThisWeekFriday, toDateString } from '../../lib/weekUtils'
import { format } from 'date-fns'
import StreakCell from '../shared/StreakCell'
import DueDateCell from '../shared/DueDateCell'
import toast from 'react-hot-toast'

interface Props {
  profile: UserProfile
  amLocations: AMLocation[]
  reports: Report[]
  entriesByReport: Record<string, ReportEntry[]>
  allEntries: ReportEntry[]
  allWeeks: Week[]
  currentWeekId: string
  onRefresh: () => void
}

export default function AMDashboard({ profile, amLocations, reports, entriesByReport, allEntries, allWeeks, currentWeekId, onRefresh }: Props) {
  const navigate = useNavigate()
  const sb = supabase as any
  const locationIds = new Set(amLocations.map(l => l.location_id))

  // Entries explicitly assigned to this user (via the user dropdown override)
  const [assignedEntries, setAssignedEntries] = useState<ReportEntry[]>([])
  useEffect(() => {
    if (!currentWeekId) return
    sb.schema('outlier').from('report_entries')
      .select('*')
      .eq('week_id', currentWeekId)
      .or(`am_assigned_user_id.eq.${profile.id},rdo_assigned_user_id.eq.${profile.id}`)
      .then(({ data }: any) => { if (data) setAssignedEntries(data as ReportEntry[]) })
  }, [currentWeekId, profile.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const friday = getThisWeekFriday()
  const daysLeft = getDaysUntil(toDateString(friday))

  // suppress unused import warning
  void format

  const daysColor =
    daysLeft === null ? 'text-sb-cream' :
    daysLeft < 0      ? 'text-sb-red' :
    daysLeft <= 2     ? 'text-sb-orange' :
    'text-sb-green'

  // Count uncommented items
  const allMyEntries = Object.values(entriesByReport).flat().filter(e =>
    locationIds.has(e.row_key) || amLocations.some(l => e.row_key.startsWith(l.location_id))
  )
  const uncommented = allMyEntries.filter(e => !e.am_comment && !e.is_complete && e.row_type !== 'total').length

  async function saveComment(entryId: string, comment: string) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ am_comment: comment, updated_at: new Date().toISOString() })
      .eq('id', entryId)
    if (error) { console.error('[Comment save]', error); toast.error('Failed to save comment'); return }
    toast.success('Comment saved')
    onRefresh()
    sb.schema('outlier').from('report_entries')
      .update({ am_comment_updated_at: new Date().toISOString(), am_comment_updated_by: profile.id })
      .eq('id', entryId)
      .then(() => {})
  }

  async function saveDueDate(entryId: string, date: string) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ due_date: date, updated_at: new Date().toISOString() })
      .eq('id', entryId)
    if (error) toast.error('Failed to save due date')
    else onRefresh()
  }

  async function toggleComplete(entryId: string, val: boolean) {
    const { error } = await sb.schema('outlier').from('report_entries')
      .update({ is_complete: val, updated_at: new Date().toISOString() })
      .eq('id', entryId)
    if (error) toast.error('Failed to update')
    else { toast.success(val ? 'Marked complete' : 'Marked incomplete'); onRefresh() }
  }

  const reportsWithMyEntries = reports.filter(r => {
    const entries = entriesByReport[r.id] ?? []
    return entries.some(e =>
      locationIds.has(e.row_key) || amLocations.some(l => e.row_key.startsWith(l.location_id))
    )
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header section */}
      <div className="bg-sb-inky/10 border border-sb-inky/30 rounded-lg p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-brand font-bold text-sb-cream text-[18px] tracking-wider uppercase">
              {profile.full_name ?? profile.work_email}
            </h1>
            <p className="font-mono text-sb-inky text-[12px] mt-1">
              {[profile.region, profile.area].filter(Boolean).join(' · ')}
            </p>
            <p className="font-mono text-[11px] text-sb-cream/50 mt-1">
              {(() => {
                const items = allMyEntries.filter(e => e.row_type !== 'total').length
                return `${items} assigned ${items === 1 ? 'item' : 'items'}`
              })()}
              {uncommented > 0 && (
                <span className="text-sb-orange ml-2">· {uncommented} need{uncommented === 1 ? 's' : ''} attention</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-center">
              <div className={`font-mono text-[42px] font-medium leading-none ${daysColor}`}>
                {daysLeft !== null && daysLeft >= 0 ? daysLeft : daysLeft !== null ? '!' : '?'}
              </div>
              <div className="font-brand font-bold text-[9px] tracking-widest text-sb-inky uppercase mt-1">
                {daysLeft !== null && daysLeft < 0 ? 'OVERDUE' : 'DAYS LEFT'}
              </div>
            </div>
            <div className="text-center">
              <div className={`font-mono text-[42px] font-medium leading-none ${uncommented > 0 ? 'text-sb-orange' : 'text-sb-green'}`}>
                {uncommented}
              </div>
              <div className="font-brand font-bold text-[9px] tracking-widest text-sb-inky uppercase mt-1">UNCOMMENTED</div>
            </div>
          </div>
        </div>
      </div>

      {/* Assigned-to-me section: entries where this user was manually assigned as AM or RDO */}
      {assignedEntries.length > 0 && (
        <div className="border border-sb-sky/40 rounded-lg overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 bg-sb-sky/10 border-b border-sb-sky/20">
            <MessageSquare size={13} className="text-sb-sky" />
            <h2 className="font-brand font-bold text-sb-sky tracking-wider text-[13px] uppercase">Assigned to Me</h2>
            <span className="font-mono text-[11px] text-sb-inky ml-auto">{assignedEntries.length} item{assignedEntries.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left sticky-table">
              <thead>
                <tr className="border-b border-sb-inky/30">
                  <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase sticky left-0 bg-sb-navy">SHOP</th>
                  <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">ASSIGNED AS</th>
                  <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">DUE DATE</th>
                  <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase min-w-[200px]">AM COMMENT</th>
                  <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">DONE</th>
                </tr>
              </thead>
              <tbody>
                {assignedEntries.map(entry => {
                  const role = entry.am_assigned_user_id === profile.id ? 'Area Manager' : 'Regional Director'
                  const columns: { key: string; label: string; type: string }[] = []
                  return (
                    <AMEntryRow
                      key={entry.id}
                      entry={entry}
                      columns={columns}
                      allEntries={allEntries}
                      allWeeks={allWeeks}
                      reportColumns={[]}
                      currentWeekId={currentWeekId}
                      onSaveComment={saveComment}
                      onSaveDueDate={saveDueDate}
                      onToggleComplete={toggleComplete}
                      assignedRole={role}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Report sections */}
      {reportsWithMyEntries.length === 0 && assignedEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16">
          <p className="font-brand font-bold text-sb-inky tracking-widest text-[13px] uppercase">No items assigned this week</p>
        </div>
      ) : reportsWithMyEntries.length === 0 ? null : (
        reportsWithMyEntries.map(report => {
          const myEntries = (entriesByReport[report.id] ?? []).filter(e =>
            locationIds.has(e.row_key) || amLocations.some(l => e.row_key.startsWith(l.location_id))
          )
          const dataColumns = report.columns.filter(c => c.type !== 'location' && c.type !== 'employee')

          return (
            <div key={report.id} className="border border-sb-inky/30 rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-5 py-3 bg-sb-inky/10 border-b border-sb-inky/20">
                <div>
                  <h2 className="font-brand font-bold text-sb-cream tracking-wider text-[13px] uppercase">{report.name}</h2>
                  {report.department && (
                    <span className="font-mono text-[10px] text-sb-inky">{report.department.name}</span>
                  )}
                </div>
                <button
                  onClick={() => navigate(`/operations/outlier/report/${report.slug}`)}
                  className="flex items-center gap-1.5 font-brand font-bold text-[11px] text-sb-sky tracking-wide hover:text-sb-cream transition"
                >
                  <ExternalLink size={12} />
                  OPEN FULL TABLE
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left sticky-table">
                  <thead>
                    <tr className="border-b border-sb-inky/30">
                      <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase sticky left-0 bg-sb-navy">SHOP</th>
                      {dataColumns.map(col => (
                        <th key={col.key} className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">{col.label}</th>
                      ))}
                      <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">STREAK</th>
                      <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">DUE DATE</th>
                      <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase min-w-[200px]">AM COMMENT</th>
                      <th className="px-3 py-2 font-brand font-bold text-[10px] tracking-widest text-sb-inky uppercase">DONE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {myEntries.map(entry => (
                      <AMEntryRow
                        key={entry.id}
                        entry={entry}
                        columns={dataColumns}
                        allEntries={allEntries}
                        allWeeks={allWeeks}
                        reportColumns={report.columns}
                        currentWeekId={currentWeekId}
                        onSaveComment={saveComment}
                        onSaveDueDate={saveDueDate}
                        onToggleComplete={toggleComplete}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })
      )
      }
    </div>
  )
}

function AMEntryRow({
  entry, columns, allEntries, allWeeks, reportColumns, currentWeekId,
  onSaveComment, onSaveDueDate, onToggleComplete, assignedRole,
}: {
  entry: ReportEntry
  columns: { key: string; label: string; type: string }[]
  allEntries: ReportEntry[]
  allWeeks: Week[]
  reportColumns: import('../../types').ColumnDef[]
  currentWeekId: string
  onSaveComment: (id: string, v: string) => Promise<void>
  onSaveDueDate: (id: string, v: string) => Promise<void>
  onToggleComplete: (id: string, v: boolean) => Promise<void>
  assignedRole?: string
}) {
  const [comment, setComment] = useState(entry.am_comment ?? '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function handleBlur() {
    if (comment === (entry.am_comment ?? '')) return
    setSaving(true)
    await onSaveComment(entry.id, comment)
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <tr className={`border-b border-sb-inky/15 hover:bg-sb-inky/10 transition-colors ${entry.is_complete ? 'bg-sb-green/5' : ''}`}>
      <td className="px-3 py-2.5 sticky left-0 bg-sb-navy font-mono text-[12px] text-sb-cream">{entry.row_label}</td>
      {assignedRole && (
        <td className="px-3 py-2.5">
          <span className="font-mono text-[11px] text-sb-sky/80">{assignedRole}</span>
        </td>
      )}
      {columns.map(col => (
        <td key={col.key} className="px-3 py-2.5 font-mono text-[12px] text-sb-cream/80 text-right">
          {entry.data[col.key] != null ? String(entry.data[col.key]) : '—'}
        </td>
      ))}
      <td className="px-3 py-2.5">
        <StreakCell
          rowKey={entry.row_key}
          currentWeekId={currentWeekId}
          allEntries={allEntries}
          allWeeks={allWeeks}
          columns={reportColumns}
        />
      </td>
      <td className="px-3 py-2.5">
        <DueDateCell
          dueDate={entry.due_date}
          isComplete={entry.is_complete}
          editable
          onChange={d => onSaveDueDate(entry.id, d)}
        />
      </td>
      <td className="px-3 py-2.5 min-w-[200px]">
        <div className="flex items-center gap-1.5">
          <MessageSquare size={11} className="text-sb-inky shrink-0" />
          <input
            value={comment}
            onChange={e => { setComment(e.target.value); setSaved(false) }}
            onBlur={handleBlur}
            onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            placeholder="Add comment…"
            className="flex-1 bg-sb-inky/20 text-sb-cream font-mono text-[12px] px-2 py-1 rounded border border-sb-inky/40 focus:outline-none focus:border-sb-sky placeholder:text-sb-cream/25"
          />
          {saving && <span className="font-mono text-[10px] text-sb-inky">⟳</span>}
          {saved && <span className="font-mono text-[10px] text-sb-green">✓</span>}
        </div>
      </td>
      <td className="px-3 py-2.5">
        <button
          onClick={() => onToggleComplete(entry.id, !entry.is_complete)}
          className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
            entry.is_complete ? 'bg-sb-green border-sb-green' : 'border-sb-inky hover:border-sb-sky'
          }`}
        >
          {entry.is_complete && <span className="text-sb-navy text-[10px] font-bold">✓</span>}
        </button>
      </td>
    </tr>
  )
}
