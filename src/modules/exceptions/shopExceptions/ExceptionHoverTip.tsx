// A styled hover card for one exception — icon, type, priority, summary and the first few items. Rendered in a portal so a card's
// own overflow clipping can't cut it off. Static sb-* colors so it reads the same in light and dark mode.
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { exceptionSummary, itemLine } from './describeException'
import { ExceptionTile, SEV_LABEL, TYPE_META, typeColor, type ShopException } from './shopExceptionTypes'

const SEV_TEXT: Record<number, string> = { 1: 'text-sb-cream/70', 2: 'text-[#E67E22]', 3: 'text-[#C0392B]' }
const MAX_ITEMS = 4
const TIP_WIDTH = 300

export function ExceptionHoverTip({ e, children, className }: { e: ShopException; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const show = () => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const below = r.top < 190
    setPos({ left: Math.min(Math.max(8, r.left + r.width / 2 - TIP_WIDTH / 2), window.innerWidth - TIP_WIDTH - 8), top: below ? r.bottom + 8 : r.top - 8, below })
  }
  const meta = TYPE_META[e.type]
  return (
    <span ref={ref} className={className ?? 'inline-flex'} onMouseEnter={show} onMouseLeave={() => setPos(null)} onFocus={show} onBlur={() => setPos(null)}>
      {children}
      {pos && createPortal(
        <div role="tooltip" style={{ ...typeColor(e.type), position: 'fixed', left: pos.left, top: pos.top, width: TIP_WIDTH, transform: pos.below ? undefined : 'translateY(-100%)', zIndex: 9999 }}
          className="pointer-events-none rounded-xl border border-sb-cream/15 bg-sb-navy text-sb-cream shadow-[0_10px_30px_rgba(0,0,0,0.45)] overflow-hidden">
          <div className="h-1" style={{ background: 'var(--c)' }} />
          <div className="p-3 flex flex-col gap-2">
            <div className="flex items-start gap-2.5">
              <ExceptionTile type={e.type} size={32} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-heading font-bold uppercase tracking-wide leading-tight">{meta.label}</div>
                <div className="text-[10px] font-mono text-sb-cream/70 mt-0.5">{exceptionSummary(e)}</div>
              </div>
              <span className={`text-[10px] font-mono font-bold uppercase tracking-wide ${SEV_TEXT[e.severity] ?? SEV_TEXT[1]}`}>{SEV_LABEL[e.severity]}</span>
            </div>
            <ul className="flex flex-col gap-1 rounded border border-sb-cream/10 bg-sb-cream/5 p-2">
              {e.items.slice(0, MAX_ITEMS).map((i) => (
                <li key={i.key} className="flex items-start gap-1.5 text-[10px] font-mono leading-snug">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full flex-none" style={{ background: 'var(--c)' }} />
                  <span className="min-w-0 break-words">{itemLine(e.type, i)}</span>
                </li>
              ))}
              {e.items.length > MAX_ITEMS && <li className="text-[10px] font-mono text-sb-cream/60 pl-3">+ {e.items.length - MAX_ITEMS} more</li>}
            </ul>
            <div className="text-[9px] font-mono uppercase tracking-widest text-sb-cream/50">Click to triage</div>
          </div>
        </div>,
        document.body,
      )}
    </span>
  )
}
