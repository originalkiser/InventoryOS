// Navigation layout "Mega menu" (option D in the SB navigation concepts): a bar of section buttons across the top; opening one drops a panel of
// page cards (name, one-line description, badge). Hover switches sections while one is open. The page-level search lives at the right end.
import { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, Search } from 'lucide-react'
import sbIcon from '@/assets/SBOC-IconCream.png'
import { useNavBadge, useNavBadgeSum } from '@/hooks/useNavBadges'
import { ICONS, SECTION_ICONS } from './navIcons'
import { NAV_META } from './navMeta'
import { HOME_ITEM, useNavModel, type NavSection } from './useNavModel'
import type { NavItem } from './navData'

function Card({ item, index, onGo }: { item: NavItem; index: number; onGo: () => void }) {
  const badge = useNavBadge(item.key)
  return (
    <NavLink
      to={item.to!}
      role="menuitem"
      onClick={onGo}
      style={{ animationDelay: `${index * 45 + 60}ms` }}
      className={({ isActive }) =>
        `flex flex-col gap-0.5 rounded-[13px] border px-3.5 py-3 text-left transition-colors animate-[sbCascade_300ms_cubic-bezier(0.2,0.7,0.2,1)_backwards] ${isActive
          ? 'bg-navy text-cream border-navy'
          : 'bg-cream text-navy border-navy/20 hover:bg-soft hover:border-inky'}`
      }
    >
      {({ isActive }) => (
        <>
          <span className="flex items-center gap-2 text-sm font-heading font-semibold uppercase tracking-[0.07em]">
            <span className="flex-shrink-0 opacity-80">{ICONS[item.key] ?? ICONS.dashboard}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {badge > 0 && <span className="flex-shrink-0 rounded-full bg-[#C0392B] text-sb-cream text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center">{badge}</span>}
          </span>
          {NAV_META[item.key]?.desc && <span className={`text-[11.5px] font-body leading-snug ${isActive ? 'text-sky' : 'text-inky'}`}>{NAV_META[item.key].desc}</span>}
        </>
      )}
    </NavLink>
  )
}

function SectionButton({ section, active, open, onToggle, onHover }: {
  section: NavSection; active: boolean; open: boolean; onToggle: () => void; onHover: () => void
}) {
  const badge = useNavBadgeSum(section.items.map((i) => i.key))
  return (
    <button
      type="button" aria-haspopup="true" aria-expanded={open}
      onClick={onToggle} onMouseEnter={onHover}
      className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-heading font-semibold uppercase tracking-[0.09em] transition-colors ${active ? 'bg-sky text-sb-navy' : open ? 'bg-inky/50 text-chrome-fg' : 'text-chrome-fg hover:bg-inky/45'}`}
    >
      <span className="flex-shrink-0 [&_svg]:w-4 [&_svg]:h-4">{SECTION_ICONS[section.key]}</span>
      {section.label}
      {badge > 0 && <span className="rounded-full bg-sb-navy text-sb-cream text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center">{badge}</span>}
      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  )
}

export function MegaNav() {
  const { sections, utility } = useNavModel()
  const { pathname } = useLocation()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setOpenKey(null) }, [pathname])
  useEffect(() => {
    if (!openKey) return
    const down = (e: MouseEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpenKey(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenKey(null) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [openKey])

  const all: NavSection[] = [...sections, { key: 'shortcuts', label: 'Shortcuts', blurb: 'Calendar, tasks, issues and more', items: utility }]
  const hasActive = (items: NavItem[]) => items.some((i) => i.to && (pathname === i.to || pathname.startsWith(`${i.to}/`)))
  const current = all.find((s) => s.key === openKey)
  const homeActive = pathname === HOME_ITEM.to

  return (
    <div ref={wrapRef} className="relative z-40">
      <nav aria-label="Main" className="flex items-center gap-1 bg-chrome text-chrome-fg border-b border-chrome-fg/10 px-3 py-2 overflow-x-auto app-scroll">
        <img src={sbIcon} alt="SB Net" className="h-8 w-auto mr-2 flex-shrink-0 opacity-90" />
        <NavLink to={HOME_ITEM.to!} className={`flex items-center gap-2 whitespace-nowrap rounded-full px-3.5 py-2 text-[13px] font-heading font-semibold uppercase tracking-[0.09em] transition-colors ${homeActive ? 'bg-sky text-sb-navy' : 'text-chrome-fg hover:bg-inky/45'}`}>
          {ICONS.home}Home
        </NavLink>
        {all.map((s) => (
          <SectionButton key={s.key} section={s} active={hasActive(s.items)} open={openKey === s.key}
            onToggle={() => setOpenKey(openKey === s.key ? null : s.key)} onHover={() => { if (openKey) setOpenKey(s.key) }} />
        ))}
        <div className="flex-1 min-w-[12px]" />
        <button type="button" onClick={() => window.dispatchEvent(new Event('sb-open-palette'))}
          className="flex flex-shrink-0 items-center gap-2 rounded-full border border-chrome-fg/45 px-3.5 py-1.5 text-xs font-body text-chrome-fg hover:border-chrome-fg hover:bg-inky/35 transition-colors">
          <Search className="w-3.5 h-3.5" /> Go to…<kbd className="ml-2 text-[9px] border border-chrome-fg/45 rounded px-1">Ctrl K</kbd>
        </button>
      </nav>
      {current && (
        <>
          <div className="fixed inset-0 -z-10 bg-black/35 animate-[fadeIn_160ms_ease-out]" aria-hidden onMouseDown={() => setOpenKey(null)} />
          <div role="menu" aria-label={current.label} key={current.key}
            className="absolute left-0 right-0 top-full bg-pop text-navy border-b border-navy/20 shadow-[0_20px_40px_rgba(0,0,0,0.25)] p-4 animate-[sbReveal_260ms_ease-out] max-h-[70vh] overflow-y-auto">
            {current.blurb && <div className="mb-3 text-[11px] font-body uppercase tracking-[0.14em] text-inky">{current.label} · {current.blurb}</div>}
            <div className="grid gap-2.5 grid-cols-[repeat(auto-fit,minmax(210px,1fr))]">
              {current.items.map((item, i) => <Card key={item.key} item={item} index={i} onGo={() => setOpenKey(null)} />)}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
