import { useState } from 'react'
import { ChevronDown, ChevronRight, Flame, AlertTriangle } from 'lucide-react'
import { Department, Report, ReportEntry, Week, ColumnDef } from '../../types'
import { getDaysUntil } from '../../lib/weekUtils'
import { computeStreak } from '../../lib/streakCalc'
import ReportTable from '../tables/ReportTable'

interface Props {
  departments: Department[]
  reports: Report[]
  entriesByReport: Record<string, ReportEntry[]>
  allEntries: ReportEntry[]
  allWeeks: Week[]
  currentWeekId: string
}

export default function LeadershipDashboard({ departments, reports, entriesByReport, allEntries, allWeeks, currentWeekId }: Props) {
  const [expandedReports, setExpandedReports] = useState<Set<string>>(new Set())

  function toggleReport(id: string) {
    setExpandedReports(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  // Summary metrics
  const allCurrentEntries = Object.values(entriesByReport).flat()
  const dataEntries = allCurrentEntries.filter(e => e.row_type !== 'total')
  const totalRows = dataEntries.length
  const commentedRows = dataEntries.filter(e => e.am_comment).length
  const completeRows = dataEntries.filter(e => e.is_complete).length
  const overdueRows = dataEntries.filter(e =>
    !e.is_complete && e.due_date && getDaysUntil(e.due_date) !== null && getDaysUntil(e.due_date)! < 0
  ).length

  const activeReports = Object.keys(entriesByReport).filter(id => (entriesByReport[id]?.length ?? 0) > 0).length

  return (
    <div className="p-6 space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <MetricCard label="Active Reports" value={activeReports} />
        <MetricCard label="Total Rows" value={totalRows} />
        <MetricCard label="% Commented" value={totalRows > 0 ? `${Math.round(commentedRows / totalRows * 100)}%` : '—'} />
        <MetricCard label="% Complete" value={totalRows > 0 ? `${Math.round(completeRows / totalRows * 100)}%` : '—'} />
        <MetricCard label="Overdue" value={overdueRows} valueColor={overdueRows > 0 ? 'text-sb-red' : undefined} />
      </div>

      {/* Reports by department */}
      {[
        ...departments.map(dept => ({
          id: dept.id,
          label: dept.name,
          rpts: reports.filter(r => r.department_id === dept.id),
        })),
        {
          id: '__unassigned__',
          label: 'All Reports',
          rpts: reports.filter(r => !r.department_id),
        },
      ].filter(g => g.rpts.length > 0).map(group => {
        const { id: groupId, label: groupLabel, rpts: deptReports } = group

        return (
          <div key={groupId}>
            <h2 className="font-brand font-bold text-sb-sky tracking-widest text-[12px] uppercase mb-3 border-b border-sb-inky/30 pb-2">
              {groupLabel}
            </h2>
            <div className="space-y-2">
              {deptReports.map(report => {
                const entries = entriesByReport[report.id] ?? []
                const dataE = entries.filter(e => e.row_type !== 'total')
                const total = dataE.length
                const commented = dataE.filter(e => e.am_comment).length
                const complete = dataE.filter(e => e.is_complete).length
                const overdue = dataE.filter(e =>
                  !e.is_complete && e.due_date && getDaysUntil(e.due_date)! < 0
                ).length
                const streakAlerts = dataE.filter(e => {
                  const s = computeStreak(e.row_key, currentWeekId, allEntries, allWeeks)
                  return s.type === 'streak' && (s.count ?? 0) >= 3
                }).length

                const expanded = expandedReports.has(report.id)

                return (
                  <div key={report.id} className="border border-sb-inky/30 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleReport(report.id)}
                      className="w-full flex items-center gap-3 px-4 py-3 bg-sb-inky/10 hover:bg-sb-inky/20 transition-colors text-left"
                    >
                      {expanded ? <ChevronDown size={14} className="text-sb-inky shrink-0" /> : <ChevronRight size={14} className="text-sb-inky shrink-0" />}
                      <span className="font-brand font-bold text-sb-cream text-[12px] tracking-wide uppercase flex-1">{report.name}</span>
                      <span className="font-mono text-[11px] text-sb-cream/50 mr-3">{total} rows</span>

                      {/* Progress bars */}
                      <div className="hidden sm:flex items-center gap-4 mr-3">
                        <MiniProgress label="COMMENTS" val={commented} total={total} />
                        <MiniProgress label="COMPLETE" val={complete} total={total} />
                      </div>

                      {overdue > 0 && (
                        <span className="flex items-center gap-1 bg-sb-red/20 text-sb-red font-mono text-[10px] px-1.5 py-0.5 rounded mr-1">
                          <AlertTriangle size={10} />
                          {overdue}
                        </span>
                      )}
                      {streakAlerts > 0 && (
                        <span className="flex items-center gap-1 bg-sb-red/10 text-sb-red font-mono text-[10px] px-1.5 py-0.5 rounded">
                          <Flame size={10} />
                          {streakAlerts}
                        </span>
                      )}
                    </button>

                    {expanded && entries.length > 0 && (
                      <div className="border-t border-sb-inky/20">
                        <ReportTable
                          entries={entries}
                          allEntries={allEntries}
                          allWeeks={allWeeks}
                          currentWeekId={currentWeekId}
                          columns={report.columns}
                          isEmployeeReport={report.is_employee_report}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function MetricCard({ label, value, valueColor }: { label: string; value: number | string; valueColor?: string }) {
  return (
    <div className="bg-sb-inky/10 border border-sb-inky/30 rounded-lg px-4 py-3">
      <div className={`font-mono text-[24px] font-medium ${valueColor ?? 'text-sb-cream'}`}>{value}</div>
      <div className="font-brand font-bold text-[9px] tracking-widest text-sb-inky uppercase mt-0.5">{label}</div>
    </div>
  )
}

function MiniProgress({ label, val, total }: { label: string; val: number; total: number }) {
  const pct = total > 0 ? Math.round(val / total * 100) : 0
  return (
    <div className="flex flex-col items-end gap-0.5 w-24">
      <div className="flex items-center justify-between w-full">
        <span className="font-brand font-bold text-[8px] tracking-widest text-sb-inky uppercase">{label}</span>
        <span className="font-mono text-[10px] text-sb-cream/60">{pct}%</span>
      </div>
      <div className="h-1 w-full bg-sb-navy rounded-full overflow-hidden">
        <div className="h-full bg-sb-sky rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}
