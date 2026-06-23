import { X } from 'lucide-react'
import { useEffect } from 'react'
import { ReportEntry, Week, ColumnDef } from '../../types'
import { formatWeekLabelFromStrings } from '../../lib/weekUtils'

interface Props {
  entry: ReportEntry | null
  week: Week | null
  columns: ColumnDef[]
  onClose: () => void
}

export default function SlideOver({ entry, week, columns, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!entry || !week) return null

  const weekLabel = formatWeekLabelFromStrings(week.week_start, week.week_end)

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-sb-onyx/50 z-40"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="fixed right-0 top-0 h-full w-[420px] bg-sb-navy border-l border-sb-inky/50 z-50 flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-sb-inky/30">
          <div>
            <p className="font-brand font-bold text-sb-sky text-[12px] tracking-widest uppercase">
              Historical Entry
            </p>
            <p className="font-mono text-sb-cream/60 text-[11px] mt-0.5">{weekLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="text-sb-cream/50 hover:text-sb-cream transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <div>
            <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase mb-1">
              Shop / Employee
            </p>
            <p className="font-mono text-sb-cream text-[13px]">{entry.row_label}</p>
          </div>

          {columns.filter(c => c.type !== 'location' && c.type !== 'employee').map(col => (
            <div key={col.key}>
              <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase mb-1">
                {col.label}
              </p>
              <p className="font-mono text-sb-cream text-[13px]">
                {entry.data[col.key] != null
                  ? String(entry.data[col.key])
                  : <span className="text-sb-cream/30">—</span>
                }
              </p>
            </div>
          ))}

          {entry.am_comment && (
            <div>
              <p className="font-brand font-bold text-[10px] text-sb-inky tracking-widest uppercase mb-1">
                AM Comment
              </p>
              <p className="font-mono text-sb-cream/80 text-[12px] leading-relaxed">
                {entry.am_comment}
              </p>
              {entry.am_comment_updated_at && (
                <p className="font-mono text-sb-inky text-[10px] mt-1">
                  {new Date(entry.am_comment_updated_at).toLocaleString()}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
