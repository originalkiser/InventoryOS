import { useNavigate } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'
import { Report, ReportEntry } from '../../types'
import { getDaysUntil } from '../../lib/weekUtils'

interface Props {
  reports: Report[]
  entriesByReport: Record<string, ReportEntry[]>
}

export default function DepartmentCompletion({ reports, entriesByReport }: Props) {
  const navigate = useNavigate()

  if (reports.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <p className="font-brand font-bold text-sb-inky tracking-widest text-[13px] uppercase">No Reports Configured</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 p-6">
      {reports.map(report => {
        const entries = entriesByReport[report.id] ?? []
        const dataEntries = entries.filter(e => e.row_type !== 'total')
        const total = dataEntries.length
        const complete = dataEntries.filter(e => e.is_complete).length
        const overdue = dataEntries.filter(e =>
          !e.is_complete && e.due_date && getDaysUntil(e.due_date) !== null && getDaysUntil(e.due_date)! < 0
        ).length
        const pct = total > 0 ? Math.round((complete / total) * 100) : 0

        return (
          <button
            key={report.id}
            onClick={() => navigate(`/operations/outlier/report/${report.slug}`)}
            className="bg-sb-inky/10 border border-sb-inky/30 rounded-lg p-4 text-left hover:border-sb-sky/50 hover:bg-sb-inky/20 transition-all group"
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-brand font-bold text-sb-cream text-[13px] tracking-wide uppercase leading-tight">
                  {report.name}
                </h3>
                {report.department && (
                  <span className="font-mono text-[10px] text-sb-inky mt-0.5 block">{report.department.name}</span>
                )}
              </div>
              {overdue > 0 && (
                <span className="flex items-center gap-1 bg-sb-red/20 text-sb-red font-mono text-[11px] px-2 py-0.5 rounded">
                  <AlertTriangle size={10} />
                  {overdue}
                </span>
              )}
            </div>

            {total === 0 ? (
              <div className="flex items-center gap-2 mt-1">
                <div className="w-1.5 h-1.5 rounded-full bg-sb-inky/60" />
                <span className="font-mono text-[11px] text-sb-inky tracking-wide uppercase">Not submitted this week</span>
              </div>
            ) : (
              <>
                <div className="h-2 bg-sb-navy rounded-full overflow-hidden mb-2">
                  <div
                    className="h-full bg-sb-sky rounded-full transition-all duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[11px] text-sb-cream/60">{complete} / {total} complete</span>
                  <span className="font-mono text-[12px] text-sb-sky font-medium">{pct}%</span>
                </div>
              </>
            )}
          </button>
        )
      })}
    </div>
  )
}
