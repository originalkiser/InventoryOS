import type { ReactNode } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

export interface QuickAccessItem {
  key: string
  label: string
  icon: ReactNode
  open: boolean
  onClick: () => void
}

// Shared renderer behind AppShell's floating bottom-corner FABs and TopBar's
// inline "topbar-left" row — same item list/click behavior, three possible
// homes (Profile → Quick Access Buttons → Position).
type QuickAccessBarProps =
  | { variant: 'floating'; anchor: 'left' | 'right'; offset: number; items: QuickAccessItem[]; collapsed: boolean; onToggleCollapsed: () => void }
  | { variant: 'topbar'; items: QuickAccessItem[] }

export function QuickAccessBar(props: QuickAccessBarProps) {
  if (props.variant === 'topbar') {
    // Always expanded horizontally — no collapse nub, label always visible
    // (not hover-only like the floating variant), per the user's own ask.
    return (
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {props.items.map((f) => (
          <button
            key={f.key}
            onClick={f.onClick}
            title={f.open ? `${f.label} (open — click to close)` : f.label}
            className={[
              'flex items-center gap-1.5 h-7 px-2 rounded border transition-all flex-shrink-0',
              f.open
                ? 'border-sb-green text-[#F2F1E6] shadow-[0_0_10px_2px_rgba(46,204,113,0.45)]'
                : 'border-[#F2F1E6]/20 text-[#F2F1E6]/70 hover:text-[#F2F1E6] hover:border-[#F2F1E6]/40',
            ].join(' ')}
          >
            {f.icon}
            <span className="text-[10px] font-heading uppercase tracking-wide whitespace-nowrap">{f.label}</span>
          </button>
        ))}
      </div>
    )
  }

  const { anchor, offset, items, collapsed, onToggleCollapsed } = props
  const alignClass = anchor === 'right' ? 'items-end' : 'items-start'
  return (
    <div
      className={`fixed bottom-4 z-30 flex flex-col ${alignClass} gap-2`}
      style={anchor === 'right' ? { right: offset } : { left: offset }}
    >
      {/* Buttons stay mounted and slide down/up so collapse/expand animates. */}
      <div className={`flex flex-col ${alignClass} gap-2 origin-bottom transition-all duration-200 ease-out ${collapsed ? 'opacity-0 translate-y-4 pointer-events-none' : 'opacity-100 translate-y-0'}`}>
        {items.map((f) => <QuickFab key={f.key} title={f.label} onClick={f.onClick} active={f.open}>{f.icon}</QuickFab>)}
      </div>
      <button
        onClick={onToggleCollapsed}
        title={collapsed ? 'Show quick access' : 'Hide quick access'}
        aria-label={collapsed ? 'Show quick access' : 'Hide quick access'}
        className="flex items-center justify-center w-10 h-6 rounded-full bg-navy/80 text-cream shadow-lg hover:bg-navy transition-colors"
      >
        {collapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
    </div>
  )
}

function QuickFab({ title, onClick, active, children }: { title: string; onClick: () => void; active?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={active ? `${title} (open — click to close)` : title}
      aria-label={title}
      className={[
        'group flex items-center h-10 rounded-full text-cream px-2.5 transition-colors animate-[fabRise_200ms_ease-out] border-2',
        active
          ? 'bg-navy border-sb-green shadow-[0_0_12px_3px_rgba(46,204,113,0.5)]'
          : 'bg-navy border-transparent hover:bg-navy/90',
      ].join(' ')}
    >
      {children}
      <span className="max-w-0 group-hover:max-w-[160px] overflow-hidden whitespace-nowrap text-xs font-heading transition-[max-width,margin] duration-200 group-hover:ml-2">{title}</span>
    </button>
  )
}
