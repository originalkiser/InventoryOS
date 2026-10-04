import { useNavigate } from 'react-router-dom'
import { Check } from 'lucide-react'

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
 *
 * Direct ask 2026-09-29: a step you've already moved PAST (positionally
 * before the current one — you can freely jump backward too, so this is
 * "have I been further than this" not "is this literally done forever")
 * gets a checkmark and a green glow instead of its plain number, and the
 * whole strip is centered to roughly the middle third of the page instead
 * of stretching edge to edge.
 */
export function OrderStepper({ draftId, current, onBeforeNavigate, compact = false }: {
  /** Hide the step labels (just the numbered circles) — used once the page is scrolled. */
  compact?: boolean
  draftId: string
  current: OrderStep
  /** Return false to cancel the navigation (Review uses this to hold the user until they've seen the last row). */
  onBeforeNavigate?: (target: OrderStep) => boolean
}) {
  const navigate = useNavigate()
  const currentIdx = STEPS.findIndex((s) => s.key === current)

  return (
    <div className="flex justify-center">
      {/* Direct ask 2026-09-30: equal spacing between the connecting lines
          regardless of label text width — each step used to be a flex-1
          column sized by its OWN content (so "Final Review" claimed more
          width than "Export"), which pushed the lines between them
          unevenly. A fixed width per step (independent of label length)
          makes the flex-1 lines between them mathematically equal by
          construction, since the flanking columns are now identical. */}
      {/* data-confetti-floor lives on THIS inner, tightly-sized (max-w-md,
          centered) div rather than the outer full-width flex row above —
          found live 2026-09-30: marking the outer row made the "floor"
          span the ENTIRE page width, so confetti was registering a hit
          (and resting) far out in empty space to either side of the
          actual visible circles/lines, not on them. */}
      <div data-confetti-floor className="flex items-center gap-2 py-1 w-full max-w-md">
        {STEPS.map((step, i) => {
          const isCurrent = step.key === current
          const isPassed = i < currentIdx
          return (
            <div key={step.key} className="flex items-center gap-2 flex-1 last:flex-none">
              <button
                onClick={() => { if (onBeforeNavigate && !onBeforeNavigate(step.key)) return; navigate(step.path(draftId)) }}
                className="flex flex-col items-center gap-1 w-[72px] flex-shrink-0 group"
              >
                <span className={[
                  'w-7 h-7 rounded-full flex items-center justify-center text-xs font-heading font-bold transition-all',
                  isPassed
                    ? 'border-2 border-[#2ECC71] text-[#2ECC71] bg-[#2ECC71]/10 shadow-[0_0_8px_2px_rgba(46,204,113,0.45)]'
                    : isCurrent
                    ? 'border-2 border-sky text-sky bg-sky/10'
                    : 'border border-navy/30 text-inky/60 group-hover:border-sky/60 group-hover:text-sky',
                ].join(' ')}>
                  {isPassed ? <Check className="w-3.5 h-3.5" /> : step.n}
                </span>
                {!compact && <span className={[
                  'text-[10px] font-mono uppercase tracking-wide whitespace-nowrap transition-colors',
                  isPassed ? 'text-[#2ECC71] font-bold' : isCurrent ? 'text-sky font-bold' : 'text-inky/60 group-hover:text-sky',
                ].join(' ')}>
                  {step.label}
                </span>}
              </button>
              {i < STEPS.length - 1 && (
                <div className={`h-px flex-1 min-w-[24px] ${i < currentIdx ? 'bg-[#2ECC71]/50' : 'bg-navy/15'}`} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
