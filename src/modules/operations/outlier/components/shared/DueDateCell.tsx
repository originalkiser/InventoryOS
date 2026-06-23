import { Check, Calendar } from 'lucide-react'
import { getDaysUntil } from '../../lib/weekUtils'
import { format, parseISO } from 'date-fns'

interface Props {
  dueDate: string | null
  isComplete: boolean
  editable?: boolean
  onChange?: (date: string) => void
}

export default function DueDateCell({ dueDate, isComplete, editable, onChange }: Props) {
  if (isComplete) {
    return (
      <span className="flex items-center gap-1 text-sb-green font-mono text-[12px]">
        <Check size={11} />
        DONE
      </span>
    )
  }

  const days = getDaysUntil(dueDate)
  const displayDate = dueDate
    ? format(parseISO(dueDate), 'MMM d')
    : '—'

  const colorClass =
    days === null ? 'text-sb-cream/50'
    : days < 0   ? 'text-sb-red font-medium'
    : days <= 2  ? 'text-sb-orange'
    : 'text-sb-green'

  const label =
    days === null ? displayDate
    : days < 0   ? 'OVERDUE'
    : days === 0 ? 'TODAY'
    : days === 1 ? '1 DAY LEFT'
    : days <= 2  ? `${days} DAYS LEFT`
    : displayDate

  if (editable && onChange) {
    return (
      <div className="flex items-center gap-1">
        <Calendar size={11} className="text-sb-inky shrink-0" />
        <input
          type="date"
          value={dueDate ?? ''}
          onChange={e => onChange(e.target.value)}
          className={`bg-transparent font-mono text-[12px] ${colorClass} focus:outline-none cursor-pointer`}
        />
      </div>
    )
  }

  return (
    <span className={`flex items-center gap-1 font-mono text-[12px] ${colorClass}`}>
      <Calendar size={11} className="shrink-0 opacity-60" />
      {label}
    </span>
  )
}
