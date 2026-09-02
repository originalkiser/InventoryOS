import { useNavigate } from 'react-router-dom'

export type OrderStep = 'review' | 'final' | 'export'

const STEPS: { key: OrderStep; n: number; label: string; path: (id: string) => string }[] = [
  { key: 'review', n: 1, label: 'Review Order', path: (id) => `/orders-v2/draft/${id}` },
  { key: 'final', n: 2, label: 'Final Review', path: (id) => `/orders-v2/draft/${id}/final` },
  { key: 'export', n: 3, label: 'Export', path: (id) => `/orders-v2/draft/${id}/export` },
]

/**
 * A single draft's journey — Review → Final Review → Export — as clickable
 * numbered steps, so a user can jump straight to any stage instead of only
 * stepping forward/back one page at a time. Every step is reachable at any
 * time (a draft's data isn't destroyed by visiting a later or earlier page),
 * so nothing here is disabled or locked — clicking a number just navigates.
 */
export function OrderStepper({ draftId, current }: { draftId: string; current: OrderStep }) {
  const navigate = useNavigate()
  const currentIdx = STEPS.findIndex((s) => s.key === current)

  return (
    <div className="flex items-center gap-2 py-1">
      {STEPS.map((step, i) => {
        const isCurrent = step.key === current
        return (
          <div key={step.key} className="flex items-center gap-2 flex-1 last:flex-none">
            <button
              onClick={() => navigate(step.path(draftId))}
              className="flex flex-col items-center gap-1 flex-shrink-0 group"
            >
              <span className={[
                'w-7 h-7 rounded-full flex items-center justify-center text-xs font-heading font-bold transition-colors',
                isCurrent
                  ? 'border-2 border-sky text-sky bg-sky/10'
                  : 'border border-navy/30 text-inky/60 group-hover:border-sky/60 group-hover:text-sky',
              ].join(' ')}>
                {step.n}
              </span>
              <span className={[
                'text-[10px] font-mono uppercase tracking-wide whitespace-nowrap transition-colors',
                isCurrent ? 'text-sky font-bold' : 'text-inky/60 group-hover:text-sky',
              ].join(' ')}>
                {step.label}
              </span>
            </button>
            {i < STEPS.length - 1 && (
              <div className={`h-px flex-1 min-w-[24px] ${i < currentIdx ? 'bg-sky/40' : 'bg-navy/15'}`} />
            )}
          </div>
        )
      })}
    </div>
  )
}
