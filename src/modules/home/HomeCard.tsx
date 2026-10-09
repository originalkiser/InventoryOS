// The shell every Home card shares: rounded card, small-caps title with an optional "Open ›" link, and the edit-mode chrome (drag handle + remove).
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { GripVertical, X } from 'lucide-react'

export function HomeCard({ title, to, action, edit, onRemove, dark, children }: {
  title: string
  /** Where the "action" link goes. */
  to?: string
  action?: string
  edit?: boolean
  onRemove?: () => void
  /** The navy "identity" look (always navy, even in dark mode). */
  dark?: boolean
  children: ReactNode
}) {
  return (
    <section className={`relative h-full flex flex-col gap-2.5 overflow-hidden rounded-[14px] border p-4 transition-shadow ${dark
      ? 'bg-sb-navy text-sb-cream border-sb-navy'
      : 'bg-cream text-navy border-navy/20'} ${edit ? 'ring-2 ring-sky/60 ring-offset-1 ring-offset-page' : 'hover:shadow-[0_10px_24px_rgba(0,20,40,0.14)]'}`}>
      {edit && (
        <>
          <span className="home-drag absolute left-1.5 top-1.5 z-10 cursor-grab active:cursor-grabbing rounded-full bg-sb-navy text-sb-cream p-1 shadow" title="Drag to move"><GripVertical className="w-3.5 h-3.5" /></span>
          {onRemove && <button type="button" onClick={onRemove} title="Remove this card" className="absolute right-1.5 top-1.5 z-10 rounded-full bg-sb-navy text-sb-cream p-1 shadow hover:bg-[#C0392B]"><X className="w-3.5 h-3.5" /></button>}
        </>
      )}
      <div className={`flex items-center justify-between gap-2 ${edit ? 'pl-6 pr-6' : ''}`}>
        <h3 className={`text-[12px] font-heading font-semibold uppercase tracking-[0.16em] ${dark ? 'text-sky' : 'text-inky'}`}>{title}</h3>
        {to && action && !edit && <Link to={to} className={`text-[11px] font-body tracking-wide hover:underline ${dark ? 'text-sky' : 'text-inky'}`}>{action} ›</Link>}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2.5">{children}</div>
    </section>
  )
}

export const Big = ({ children, unit }: { children: ReactNode; unit?: string }) => (
  <div className="font-heading font-bold text-[34px] leading-none">{children}{unit && <small className="ml-1.5 text-[13px] font-body font-medium text-inky">{unit}</small>}</div>
)

export const CardEmpty = ({ children }: { children: ReactNode }) => <div className="text-xs font-body text-inky py-2">{children}</div>
