import { format } from 'date-fns'
import { useDroptopDataCompleteness } from '@/hooks/useDroptopDataCompleteness'

// Tells a user how far back they can run reporting on Droptop-derived data
// without risking a partial-shop-coverage month — backed by the historical
// backfill's own "never marks a month done until every shop has it" walk
// (see get_droptop_backfill_completeness's own comment). Renders nothing
// while loading or if no backfill has ever run for this connection, rather
// than showing a potentially confusing placeholder.
export function DataCompletenessBadge({ connectionKey }: { connectionKey: 'droptop_orders' | 'droptop_time_clock' }) {
  const { completeFrom, loading } = useDroptopDataCompleteness(connectionKey)
  if (loading || !completeFrom) return null

  const label = format(new Date(`${completeFrom}T00:00:00`), 'MMM yyyy')
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-mono text-inky/70 border border-navy/20 rounded px-2 py-1 cursor-help self-end mb-[1px]"
      title={`Every shop is confirmed to have complete order data from ${label} through today. A report run further back than ${label} may be missing some shops for the earliest months in that range.`}
    >
      Data confirmed complete back to {label}
    </span>
  )
}
