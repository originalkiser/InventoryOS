import { Check } from 'lucide-react'
import { getDaysUntil } from '../../lib/weekUtils'

interface Props {
  isComplete: boolean
  dueDate: string | null
}

export default function StatusPill({ isComplete, dueDate }: Props) {
  if (isComplete) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-sb-green/20 text-sb-green font-mono text-[11px] font-medium">
        <Check size={10} />
        DONE
      </span>
    )
  }

  const days = getDaysUntil(dueDate)

  if (days === null || days > 2) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sb-inky/30 text-sb-cream/70 font-mono text-[11px]">
        PENDING
      </span>
    )
  }

  if (days < 0) {
    return (
      <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sb-red/20 text-sb-red font-mono text-[11px] font-medium">
        OVERDUE
      </span>
    )
  }

  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-sb-orange/20 text-sb-orange font-mono text-[11px] font-medium">
      PENDING
    </span>
  )
}
