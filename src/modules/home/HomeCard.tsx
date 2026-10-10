// The shell every Home card shares: rounded card, small-caps title with an optional "Open ›" link, and the edit-mode chrome (drag handle + remove).
// Cards size themselves to their content: the shell measures its own content and reports the natural height to the grid (HomePage), which sets
// the row span from it.
import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { GripVertical, X } from 'lucide-react'

/** Provided by HomePage around each card so the shell knows which card it is and where to report its height. */
export const HomeCardCtx = createContext<{ id: string; report: (id: string, naturalPx: number) => void } | null>(null)

export function HomeCard({ title, to, action, onOpen, edit, onRemove, dark, children }: {
  title: string
  /** Where the "action" link goes. */
  to?: string
  action?: string
  /** When set, the action opens something over the page (a modal) instead of navigating. */
  onOpen?: () => void
  edit?: boolean
  onRemove?: () => void
  /** The navy "identity" look (always navy, even in dark mode). */
  dark?: boolean
  children: ReactNode
}) {
  const ctx = useContext(HomeCardCtx)
  const sectionRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  // natural height = everything that isn't the body's visible box + the body's own content height
  useLayoutEffect(() => {
    if (!ctx) return
    const sec = sectionRef.current, body = bodyRef.current, inner = innerRef.current
    if (!sec || !body || !inner) return
    const measure = () => ctx.report(ctx.id, Math.ceil(sec.clientHeight - body.clientHeight + inner.offsetHeight))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(inner)
    ro.observe(sec)
    return () => ro.disconnect()
  }, [ctx])

  const actionClass = `text-[11px] font-body tracking-wide hover:underline ${dark ? 'text-sky' : 'text-inky'}`
  return (
    <section ref={sectionRef} className={`relative h-full flex flex-col gap-2.5 overflow-hidden rounded-[14px] border p-4 transition-shadow ${dark
      ? 'bg-sb-navy text-sb-cream border-sb-navy'
      : 'bg-cream text-navy border-navy/20'} ${edit ? 'ring-2 ring-sky/60 ring-offset-1 ring-offset-page' : 'hover:shadow-[0_10px_24px_rgba(0,20,40,0.14)]'}`}>
      {edit && (
        <>
          <span className="home-drag absolute left-1.5 top-1.5 z-10 cursor-grab active:cursor-grabbing rounded-full bg-sb-navy text-sb-cream p-1 shadow" title="Drag to move"><GripVertical className="w-3.5 h-3.5" /></span>
          {onRemove && <button type="button" onClick={onRemove} title="Remove this card" className="absolute right-1.5 top-1.5 z-10 rounded-full bg-sb-navy text-sb-cream p-1 shadow hover:bg-sb-red"><X className="w-3.5 h-3.5" /></button>}
        </>
      )}
      <div className={`flex items-center justify-between gap-2 ${edit ? 'pl-6 pr-6' : ''}`}>
        <h3 className={`text-[12px] font-heading font-semibold uppercase tracking-[0.16em] ${dark ? 'text-sky' : 'text-inky'}`}>{title}</h3>
        {!edit && onOpen && action && <button type="button" onClick={onOpen} className={actionClass}>{action} ›</button>}
        {!edit && !onOpen && to && action && <Link to={to} className={actionClass}>{action} ›</Link>}
      </div>
      <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto">
        <div ref={innerRef} className="flex flex-col gap-2.5">{children}</div>
      </div>
    </section>
  )
}

export const Big = ({ children, unit }: { children: ReactNode; unit?: string }) => (
  <div className="font-heading font-bold text-[34px] leading-none">{children}{unit && <small className="ml-1.5 text-[13px] font-body font-medium text-inky">{unit}</small>}</div>
)

export const CardEmpty = ({ children }: { children: ReactNode }) => <div className="text-xs font-body text-inky py-2">{children}</div>
