import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface Props {
  /** Tooltip body — any node. */
  content: React.ReactNode
  children: React.ReactNode
  /** Where the tip sits relative to the trigger. */
  placement?: 'top' | 'bottom'
  /** ms to wait before showing, so a cursor just passing over doesn't flash tooltips. */
  delay?: number
  className?: string
}

/**
 * Stylized hover tooltip (a styled card, not the browser's plain `title`), portalled to <body> so a table's
 * overflow / sticky columns can't clip it. Fixed brand colors (static navy/cream) regardless of the app's
 * light/dark theme — it's always a dark card. Non-interactive: it disappears when the cursor leaves the trigger.
 */
export function HoverTip({ content, children, placement = 'top', delay = 120, className = '' }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean }>({ left: 0, top: 0, above: true })
  const ref = useRef<HTMLSpanElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const timer = useRef<number | null>(null)

  const place = useCallback(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const tw = tipRef.current?.offsetWidth ?? 220
    const th = tipRef.current?.offsetHeight ?? 60
    const margin = 8
    let above = placement === 'top'
    if (above && r.top - th - margin < 4) above = false
    if (!above && r.bottom + th + margin > window.innerHeight - 4) above = true
    const left = Math.min(Math.max(8, r.left + r.width / 2 - tw / 2), window.innerWidth - tw - 8)
    setPos({ left, top: above ? r.top - th - margin : r.bottom + margin, above })
  }, [placement])

  const show = () => { timer.current = window.setTimeout(() => setOpen(true), delay) }
  const hide = () => {
    if (timer.current) { window.clearTimeout(timer.current); timer.current = null }
    setOpen(false)
  }
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])
  // Measure after the tip is in the DOM, then place it.
  useEffect(() => { if (open) place() }, [open, place, content])

  return (
    <span ref={ref} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} className={`inline-flex ${className}`}>
      {children}
      {open && createPortal(
        <div
          ref={tipRef}
          role="tooltip"
          style={{ position: 'fixed', left: pos.left, top: pos.top, zIndex: 400, maxWidth: 280 }}
          className="pointer-events-none rounded-lg border border-[#B7E0DE]/40 bg-[#002745] px-3 py-2 text-[#F2F1E6] shadow-xl animate-[fadeIn_100ms_ease-out]"
        >
          {content}
        </div>,
        document.body,
      )}
    </span>
  )
}

/** The standard "color swatch + name + description" body used for flag/tag/legend tips. */
export function SwatchTipBody({ color, title, description }: { color: string; title: string; description?: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 inline-block w-3 h-3 rounded-sm flex-shrink-0 border border-[#F2F1E6]/30" style={{ background: color }} />
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-heading font-bold leading-tight">{title}</span>
        {description && <span className="text-[11px] font-mono leading-snug text-[#F2F1E6]/80">{description}</span>}
      </div>
    </div>
  )
}
