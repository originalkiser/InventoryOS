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
        {props.items.filter((f) => !f.open).map((f) => (
          <button
            key={f.key}
            onClick={f.onClick}
            title={f.label}
            className="flex items-center gap-1.5 h-7 px-2 rounded border border-[#F2F1E6]/20 text-[#F2F1E6]/70 hover:text-[#F2F1E6] hover:border-[#F2F1E6]/40 transition-all flex-shrink-0"
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
        {items.filter((f) => !f.open).map((f) => <QuickFab key={f.key} title={f.label} onClick={f.onClick}>{f.icon}</QuickFab>)}
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

function QuickFab({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="group flex items-center h-10 rounded-full bg-navy text-cream shadow-lg px-2.5 hover:bg-navy/90 transition-colors animate-[fabRise_200ms_ease-out]">
      {children}
      <span className="max-w-0 group-hover:max-w-[160px] overflow-hidden whitespace-nowrap text-xs font-heading transition-[max-width,margin] duration-200 group-hover:ml-2">{title}</span>
    </button>
  )
}
