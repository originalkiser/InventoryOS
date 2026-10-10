// Navigation layout "Mega menu" (option D in the SB navigation concepts): section buttons sit in the top bar, on the same line as the profile and
// other small buttons. Opening one drops a panel of page cards (name, one-line description, badge) below that button — every card the same size,
// at most three across, centered on the button and pushed back on screen when an edge is in the way. Hover switches sections while one is open.
// The bar never scrolls: when the labels don't fit it shows icons only (the section name is the tooltip).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { NavLink, useLocation } from 'react-router-dom'
import { ChevronDown, Search } from 'lucide-react'
import sbIcon from '@/assets/SBOC-IconCream.png'
import { useNavBadge, useNavBadgeSum } from '@/hooks/useNavBadges'
import { ICONS, SECTION_ICONS } from './navIcons'
import { NAV_META } from './navMeta'
import { useMegaPrefs, applyMegaPrefs } from '@/hooks/useNavLayout'
import { CARD_W, CARD_GAP, PANEL_PAD, centeredLeft, panelCols, panelWidth } from './navPanel'
import { HOME_ITEM, useNavModel, type NavSection } from './useNavModel'
import type { NavItem } from './navData'

function Card({ item, index, onGo }: { item: NavItem; index: number; onGo: () => void }) {
  const badge = useNavBadge(item.key)
  return (
    <NavLink
      to={item.to!}
      role="menuitem"
      onClick={onGo}
      style={{ animationDelay: `${index * 40 + 40}ms`, width: CARD_W }}
      className={({ isActive }) =>
        `flex flex-col justify-center gap-0.5 rounded-[12px] border px-3 py-2 min-h-[58px] text-left transition-colors animate-[sbCascade_300ms_cubic-bezier(0.2,0.7,0.2,1)_backwards] ${isActive
          ? 'bg-sb-navy text-sb-cream border-sb-navy'
          : 'bg-cream text-navy border-navy/20 hover:bg-soft hover:border-inky'}`
      }
    >
      {({ isActive }) => (
        <>
          <span className="flex items-center gap-2 text-[12px] font-heading font-semibold uppercase tracking-[0.07em]">
            <span className="flex-shrink-0 opacity-80">{ICONS[item.key] ?? ICONS.dashboard}</span>
            <span className="flex-1 truncate">{item.label}</span>
            {badge > 0 && <span className="flex-shrink-0 rounded-full bg-sb-red text-sb-cream text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center">{badge}</span>}
          </span>
          {NAV_META[item.key]?.desc && <span className={`line-clamp-2 text-[11px] font-body leading-snug ${isActive ? 'text-sb-sky' : 'text-inky'}`}>{NAV_META[item.key].desc}</span>}
        </>
      )}
    </NavLink>
  )
}

function SectionButton({ section, active, open, labels, onToggle, onHover, btnRef }: {
  section: NavSection; active: boolean; open: boolean; labels: boolean; onToggle: () => void; onHover: () => void; btnRef: (el: HTMLButtonElement | null) => void
}) {
  const badge = useNavBadgeSum(section.items.map((i) => i.key))
  return (
    <button
      ref={btnRef} type="button" aria-haspopup="true" aria-expanded={open} aria-label={section.label} title={labels ? undefined : section.label}
      onClick={onToggle} onMouseEnter={onHover}
      className={`relative flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-heading font-semibold uppercase tracking-[0.07em] transition-colors ${active ? 'bg-sky text-sb-navy' : open ? 'bg-inky/50 text-chrome-fg' : 'text-chrome-fg hover:bg-inky/45'}`}
    >
      {/* The section icon is sky-colored for some sections — never let it vanish on the sky "you are here" pill. */}
      <span className={`flex-shrink-0 [&_svg]:w-4 [&_svg]:h-4 [&_img]:w-4 [&_img]:h-4 ${active ? '[&_svg]:!text-sb-navy' : ''}`}>{SECTION_ICONS[section.key]}</span>
      {labels && section.label}
      {badge > 0 && (labels
        ? <span className="rounded-full bg-sb-navy text-sb-cream text-[9px] font-mono leading-none px-1.5 py-0.5 min-w-[16px] text-center">{badge}</span>
        : <span className="absolute -top-0.5 -right-0.5 rounded-full bg-sb-red text-sb-cream text-[9px] font-mono leading-none px-1 py-0.5 min-w-[14px] text-center">{badge}</span>)}
      {labels && <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />}
    </button>
  )
}

export function MegaNav() {
  const { sections, utility } = useNavModel()
  const { pathname } = useLocation()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [labels, setLabels] = useState(true)
  const [anchor, setAnchor] = useState<{ cx: number; bottom: number } | null>(null)
  const [vw, setVw] = useState(() => window.innerWidth)
  const navRef = useRef<HTMLElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const btnRefs = useRef(new Map<string, HTMLButtonElement>())
  const fullWidth = useRef(0)

  const { order, hidden } = useMegaPrefs()
  const all: NavSection[] = applyMegaPrefs([...sections, { key: 'shortcuts', label: 'Shortcuts', blurb: 'Calendar, tasks, issues and more', items: utility }], order, hidden)
  const hasActive = (items: NavItem[]) => items.some((i) => i.to && (pathname === i.to || pathname.startsWith(`${i.to}/`)))
  const current = all.find((s) => s.key === openKey)
  const homeActive = pathname === HOME_ITEM.to

  useEffect(() => { setOpenKey(null) }, [pathname])

  // Labels when they all fit, icons only when they don't — so the bar never needs to scroll.
  useLayoutEffect(() => { fullWidth.current = 0; setLabels(true) }, [all.length])
  useLayoutEffect(() => {
    const el = navRef.current
    if (!el) return
    const measure = () => {
      setVw(window.innerWidth)
      if (labels) {
        if (el.scrollWidth > el.clientWidth + 1) { fullWidth.current = el.scrollWidth; setLabels(false) }
      } else if (fullWidth.current && el.clientWidth >= fullWidth.current) setLabels(true)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [labels, all.length])

  const place = (key: string) => {
    const b = btnRefs.current.get(key)
    if (!b) return
    const r = b.getBoundingClientRect()
    setAnchor({ cx: r.left + r.width / 2, bottom: r.bottom })
  }
  const openSection = (key: string) => { place(key); setOpenKey(key) }
  useEffect(() => { if (openKey) place(openKey) }, [labels, vw]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!openKey) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (navRef.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpenKey(null)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenKey(null) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [openKey])

  const w = current ? panelWidth(current.items.length) : 0

  return (
    <>
      <nav ref={navRef} aria-label="Main" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-chrome-fg">
        <img src={sbIcon} alt="SB Net" draggable={false} className="h-10 w-auto mr-1.5 flex-shrink-0" />
        <NavLink to={HOME_ITEM.to!} title={labels ? undefined : 'Home'} aria-label="Home"
          className={`flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-[13px] font-heading font-semibold uppercase tracking-[0.07em] transition-colors ${homeActive ? 'bg-sky text-sb-navy' : 'text-chrome-fg hover:bg-inky/45'}`}>
          <span className="[&_svg]:w-4 [&_svg]:h-4">{ICONS.home}</span>{labels && 'Home'}
        </NavLink>
        {all.map((s) => (
          <SectionButton key={s.key} section={s} labels={labels} active={hasActive(s.items)} open={openKey === s.key}
            btnRef={(el) => { if (el) btnRefs.current.set(s.key, el); else btnRefs.current.delete(s.key) }}
            onToggle={() => (openKey === s.key ? setOpenKey(null) : openSection(s.key))} onHover={() => { if (openKey) openSection(s.key) }} />
        ))}
        <button type="button" onClick={() => window.dispatchEvent(new Event('sb-open-palette'))} aria-label="Search pages and actions" title="Search (Ctrl K)"
          className="ml-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-chrome-fg hover:bg-inky/45 transition-colors">
          <Search className="w-[18px] h-[18px]" />
        </button>
      </nav>
      {current && anchor && createPortal(
        <div ref={panelRef} role="menu" aria-label={current.label} key={current.key}
          style={{ position: 'fixed', top: anchor.bottom + 6, left: centeredLeft(anchor.cx, w, vw), width: w, padding: PANEL_PAD }}
          className="z-[70] rounded-2xl border border-navy/20 bg-pop text-navy shadow-[0_20px_40px_rgba(0,0,0,0.28)] animate-[sbReveal_240ms_ease-out] max-h-[calc(100vh-80px)] overflow-y-auto">
          {current.blurb && <div className="mb-2 px-0.5 text-[10px] font-body uppercase tracking-[0.14em] text-inky">{current.label} · {current.blurb}</div>}
          <div className="grid" style={{ gridTemplateColumns: `repeat(${panelCols(current.items.length)}, ${CARD_W}px)`, gap: CARD_GAP }}>
            {current.items.map((item, i) => <Card key={item.key} item={item} index={i} onGo={() => setOpenKey(null)} />)}
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
