// Navigation layout "Floating dock" (option G in the SB navigation concepts): a small toolbar of section icons that floats over the page.
// Clicking an icon fans that section's pages out as cards beside the dock (all one size, up to three across); the search icon fans out a
// search panel. Hovering an icon names the section. The dock can float (drag it anywhere) or be snapped to the top, bottom, left or right edge —
// snapped, the workspace makes room for it — and can collapse to the SB logo when you click away. Its options live in Profile → Navigation.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import sbIcon from '@/assets/SBOC-IconCream.png'
import { useDockPrefs, type DockEdge } from '@/hooks/useNavLayout'
import { useNavBadgeSum } from '@/hooks/useNavBadges'
import { ICONS, SECTION_ICONS } from './navIcons'
import { NAV_META } from './navMeta'
import { NavResultList, useNavSearch } from './NavSearch'
import { HOME_ITEM, useNavModel } from './useNavModel'
import { CARD_W, MAX_COLS, centeredLeft, clampNum as clamp } from './navPanel'
import type { NavItem } from './navData'

const EDGE_MARGIN = 12

interface Pop { kind: 'section' | 'search'; id: string; pos: DockEdge; cx: number; cy: number; dl: number; dt: number; dr: number; db: number; fw: number; fh: number }
interface Slot { x: number; y: number; w: number; h: number; dx: number; dy: number }
interface Tip { label: string; x: number; y: number; pos: DockEdge }

/** Where each fan card goes: a grid of same-size cards (at most three across) beside a vertical dock or below/above a horizontal one, kept on screen. */
function fanLayout(p: Pop, n: number, search: boolean): Slot[] {
  const G = 8
  const side = p.pos === 'left' || p.pos === 'right'
  if (search) {
    const W = Math.min(330, p.fw - 20), H = Math.min(380, p.fh - 20)
    let x: number, y: number
    if (side) { x = p.pos === 'left' ? p.dr + 10 : p.dl - 10 - W; y = clamp(p.cy - H / 2, 10, p.fh - H - 10) }
    else { x = clamp(p.cx - W / 2, 10, p.fw - W - 10); y = p.pos === 'top' ? p.db + 10 : p.dt - 10 - H }
    return [{ x, y, w: W, h: H, dx: p.cx - (x + W / 2), dy: p.cy - (y + H / 2) }]
  }
  const h = 72
  const out: Slot[] = []
  if (side) {
    // Room beside the dock decides the width; the screen's height decides how many rows before a new column starts.
    const roomW = side && p.pos === 'left' ? p.fw - p.dr - 20 : p.dl - 20
    const maxRows = Math.max(1, Math.floor((p.fh - 20 + G) / (h + G)))
    const cols = Math.min(MAX_COLS, Math.max(1, Math.ceil(n / maxRows)))
    const rows = Math.min(n, Math.ceil(n / cols))
    const w = clamp(Math.floor((roomW - (cols - 1) * G) / cols), 170, CARD_W + 14)
    const H = rows * h + (rows - 1) * G
    const y0 = clamp(p.cy - H / 2, 10, Math.max(10, p.fh - H - 10))
    for (let i = 0; i < n; i++) {
      const c = Math.floor(i / rows), r = i % rows
      const x = p.pos === 'left' ? p.dr + 10 + c * (w + G) : p.dl - 10 - w - c * (w + G)
      const y = y0 + r * (h + G)
      out.push({ x, y, w, h, dx: p.cx - (x + w / 2), dy: p.cy - (y + h / 2) })
    }
  } else {
    const cols = Math.min(MAX_COLS, Math.max(1, n))
    const rows = Math.ceil(n / cols)
    const w = clamp(Math.floor((p.fw - 20 - (cols - 1) * G) / cols), 170, CARD_W + 14)
    const T = cols * w + (cols - 1) * G
    const x0 = centeredLeft(p.cx, T, p.fw, 10)
    const H = rows * h + (rows - 1) * G
    const y0 = p.pos === 'top' ? p.db + 10 : p.dt - 10 - H
    for (let i = 0; i < n; i++) {
      const c = i % cols, r = Math.floor(i / cols)
      const x = x0 + c * (w + G), y = y0 + r * (h + G)
      out.push({ x, y, w, h, dx: p.cx - (x + w / 2), dy: p.cy - (y + h / 2) })
    }
  }
  return out
}

function DockSectionButton({ id, label, icon, active, open, onClick, index, total, leaving, onTip }: {
  id: string; label: string; icon: React.ReactNode; active: boolean; open: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  index: number; total: number; leaving: boolean; onTip: (el: HTMLElement | null, label: string) => void; keys: string[]
}) {
  return (
    <button type="button" data-dock-btn={id} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={onClick}
      onMouseEnter={(e) => onTip(e.currentTarget, label)} onMouseLeave={() => onTip(null, label)}
      style={{ animationDelay: leaving ? `${(total - index) * 28}ms` : `${index * 45}ms` }}
      className={`relative w-[46px] h-[46px] flex-none grid place-items-center rounded-full transition-[background,transform] duration-150 hover:scale-[1.07] ${leaving ? 'animate-[sbPopOut_240ms_ease-in_forwards]' : 'animate-[sbPopIn_320ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards]'} ${active ? 'bg-sky text-sb-navy [&_svg]:!text-sb-navy' : open ? 'bg-inky/75' : 'hover:bg-inky/55'}`}>
      {icon}
    </button>
  )
}

function DockBadge({ keys }: { keys: string[] }) {
  const n = useNavBadgeSum(keys)
  return n > 0 ? <span className="absolute top-0.5 right-0.5 min-w-[17px] h-[17px] rounded-full bg-sb-orange text-black text-[10px] font-mono leading-[17px] text-center px-1">{n}</span> : null
}

export function NavDock() {
  const { sections, utility } = useNavModel()
  const navigate = useNavigate()
  const { prefs: p, update } = useDockPrefs()
  const snapped = p.snap !== 'none'
  // A snapped dock's direction follows its edge; a floating one uses the chosen direction.
  const vertical = snapped ? p.snap === 'left' || p.snap === 'right' : p.orient === 'v'
  const [xy, setXy] = useState<{ x: number; y: number } | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  const [tip, setTip] = useState<Tip | null>(null)
  const [dragging, setDragging] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [q, setQ] = useState('')
  const dockRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const collapseTimer = useRef<number | undefined>(undefined)
  const { pathname } = useLocation()

  const clampXY = useCallback((x: number, y: number) => {
    const d = dockRef.current?.getBoundingClientRect()
    const w = d?.width ?? 60, h = d?.height ?? 60
    return { x: clamp(x, 6, Math.max(6, window.innerWidth - w - 6)), y: clamp(y, 6, Math.max(6, window.innerHeight - h - 6)) }
  }, [])

  // Where the dock sits: pinned to its edge when snapped, else where it was dragged (or a first placement), re-clamped when its own size
  // changes (rotate / collapse / search toggle) or the window does.
  const place = useCallback(() => {
    const d = dockRef.current?.getBoundingClientRect()
    if (!d) return
    const fw = window.innerWidth, fh = window.innerHeight
    if (p.snap !== 'none') {
      const x = p.snap === 'left' ? EDGE_MARGIN : p.snap === 'right' ? fw - d.width - EDGE_MARGIN : (fw - d.width) / 2
      const y = p.snap === 'top' ? EDGE_MARGIN : p.snap === 'bottom' ? fh - d.height - EDGE_MARGIN : (fh - d.height) / 2
      setXy({ x, y })
    } else if (p.x == null || p.y == null) setXy(clampXY(12, (fh - d.height) / 2))
    else setXy(clampXY(p.x, p.y))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.snap, p.x, p.y, clampXY])
  useLayoutEffect(() => { place() }, [place, vertical, p.mini, p.search, sections.length, leaving])
  useEffect(() => {
    const onResize = () => place()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [place])
  useEffect(() => { setPop(null); setTip(null) }, [vertical, p.mini, p.search, p.snap])
  useEffect(() => () => window.clearTimeout(collapseTimer.current), [])

  useEffect(() => {
    if (!pop) return
    const down = (e: PointerEvent) => { const t = e.target as HTMLElement; if (!t.closest('[data-dock]') && !t.closest('[data-fan]')) setPop(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null) }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [pop])
  useEffect(() => { if (pop?.kind === 'search') setTimeout(() => inputRef.current?.focus(), 120) }, [pop?.kind])

  // Collapse to the logo bubble with the buttons popping out one by one; expanding pops them back in (they animate on mount).
  const total = sections.length + 4
  const collapse = useCallback(() => {
    if (p.mini || leaving) return
    setPop(null); setTip(null); setLeaving(true)
    collapseTimer.current = window.setTimeout(() => { update({ mini: true }); setLeaving(false) }, total * 28 + 260)
  }, [p.mini, leaving, total, update])
  const expand = () => { setTip(null); update({ mini: false }) }

  // "Collapse when I click away": any press outside the dock and its pop-outs.
  useEffect(() => {
    if (!p.autoCollapse || p.mini || leaving) return
    const down = (e: PointerEvent) => { const t = e.target as HTMLElement; if (!t.closest('[data-dock]') && !t.closest('[data-fan]')) collapse() }
    document.addEventListener('pointerdown', down)
    return () => document.removeEventListener('pointerdown', down)
  }, [p.autoCollapse, p.mini, leaving, collapse])

  const showTip = (el: HTMLElement | null, label: string) => {
    if (!el || dragging) { setTip(null); return }
    const b = el.getBoundingClientRect()
    const d = dockRef.current?.getBoundingClientRect()
    const fw = window.innerWidth, fh = window.innerHeight
    const pos: DockEdge = vertical ? ((d?.left ?? 0) + (d?.width ?? 0) / 2 < fw / 2 ? 'left' : 'right') : ((d?.top ?? 0) + (d?.height ?? 0) / 2 < fh / 2 ? 'top' : 'bottom')
    setTip({ label, pos, x: b.left + b.width / 2, y: b.top + b.height / 2 })
  }

  const dragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!xy) return
    if ((e.target as HTMLElement).closest('[data-dock-btn]') && !p.mini) return
    drag.current = { sx: e.clientX, sy: e.clientY, ox: xy.x, oy: xy.y, moved: false }
    setPop(null)
    if (!snapped) e.currentTarget.setPointerCapture(e.pointerId)
  }
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || snapped) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    setDragging(true); setTip(null)
    setXy(clampXY(d.ox + dx, d.oy + dy))
  }
  const dragEnd = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (!d) return
    if (!d.moved) { if (p.mini) expand(); return }
    if (xy) update({ x: xy.x, y: xy.y })
  }

  const openPop = (kind: Pop['kind'], id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    setTip(null)
    if (pop && pop.kind === kind && pop.id === id) { setPop(null); return }
    const b = e.currentTarget.getBoundingClientRect()
    const d = dockRef.current!.getBoundingClientRect()
    const fw = window.innerWidth, fh = window.innerHeight
    const pos: DockEdge = vertical ? (d.left + d.width / 2 < fw / 2 ? 'left' : 'right') : (d.top + d.height / 2 < fh / 2 ? 'top' : 'bottom')
    setQ('')
    setPop({ kind, id, pos, cx: b.left + b.width / 2, cy: b.top + b.height / 2, dl: d.left, dt: d.top, dr: d.right, db: d.bottom, fw, fh })
  }

  const go = (item: NavItem) => { if (item.to) navigate(item.to); setPop(null) }
  const { results, hl, setHl, run, onKeyDown } = useNavSearch(q, () => setPop(null))

  const popItems: NavItem[] = pop?.kind === 'section' ? (pop.id === 'shortcuts' ? utility : sections.find((s) => s.key === pop.id)?.items ?? []) : []
  const slots = pop ? fanLayout(pop, popItems.length, pop.kind === 'search') : []
  const isActive = (items: NavItem[]) => items.some((i) => i.to && (pathname === i.to || pathname.startsWith(`${i.to}/`)))

  const sep = <span className={`flex-none bg-chrome-fg/30 ${vertical ? 'w-[26px] h-[1.5px] my-0.5' : 'h-[26px] w-[1.5px] mx-0.5'}`} />
  const cursor = snapped ? '' : dragging ? 'cursor-grabbing' : 'cursor-grab'

  return (
    <>
      <div
        ref={dockRef} data-dock
        onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}
        style={{ left: xy?.x ?? 12, top: xy?.y ?? 120, visibility: xy ? 'visible' : 'hidden' }}
        className={`fixed z-[62] flex items-center gap-1.5 p-2 bg-chrome text-chrome-fg select-none touch-none ${cursor} ${dragging ? 'shadow-[0_18px_40px_rgba(0,20,40,0.5)]' : 'shadow-[0_12px_30px_rgba(0,20,40,0.35)]'} ${p.mini ? 'rounded-full p-1.5' : 'rounded-full'} ${vertical ? 'flex-col' : 'flex-row'}`}
        role="navigation" aria-label="Main"
      >
        {p.mini ? (
          <button type="button" aria-label="Expand navigation" onClick={() => { if (snapped) expand() }}
            className="w-[54px] h-[54px] grid place-items-center rounded-full hover:bg-inky/45 animate-[sbPopIn_300ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards]"><img src={sbIcon} alt="" className="h-11 w-auto" /></button>
        ) : (
          <>
            <img src={sbIcon} alt="SB Net" draggable={false}
              className={`h-11 w-auto flex-none ${vertical ? 'mx-[3px] mt-0.5 mb-1' : 'mx-1.5'} ${leaving ? 'animate-[sbPopOut_240ms_ease-in_forwards]' : 'animate-[sbPopIn_320ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards]'}`} />
            <DockSectionButton id="home" label="Home" icon={ICONS.home} active={pathname === HOME_ITEM.to} open={false} index={0} total={total} leaving={leaving} keys={[]} onTip={showTip}
              onClick={() => navigate(HOME_ITEM.to!)} />
            {sep}
            {sections.map((s, i) => (
              <div key={s.key} className="relative flex-none">
                <DockSectionButton id={s.key} label={s.label} index={i + 1} total={total} leaving={leaving} keys={s.items.map((x) => x.key)} onTip={showTip}
                  icon={<span className="[&_svg]:w-5 [&_svg]:h-5 [&_img]:w-5 [&_img]:h-5">{SECTION_ICONS[s.key]}</span>}
                  active={isActive(s.items)} open={pop?.kind === 'section' && pop.id === s.key}
                  onClick={(e) => (s.items.length === 1 ? go(s.items[0]) : openPop('section', s.key, e))} />
                <DockBadge keys={s.items.map((x) => x.key)} />
              </div>
            ))}
            <div className="relative flex-none">
              <DockSectionButton id="shortcuts" label="Shortcuts" index={sections.length + 1} total={total} leaving={leaving} keys={utility.map((x) => x.key)} icon={ICONS.calendar} onTip={showTip}
                active={isActive(utility)} open={pop?.kind === 'section' && pop.id === 'shortcuts'} onClick={(e) => openPop('section', 'shortcuts', e)} />
              <DockBadge keys={utility.map((x) => x.key)} />
            </div>
            {p.search && (<>{sep}<DockSectionButton id="search" label="Search" index={sections.length + 2} total={total} leaving={leaving} keys={[]} onTip={showTip} icon={<Search className="w-5 h-5" />} active={false} open={pop?.kind === 'search'} onClick={(e) => openPop('search', 'search', e)} /></>)}
          </>
        )}
      </div>

      {tip && !pop && !leaving && (
        <div aria-hidden className="pointer-events-none fixed z-[63]" style={{ left: tip.x, top: tip.y }}>
          <div className={`absolute whitespace-nowrap rounded-lg bg-sb-navy px-2.5 py-1.5 text-[11px] font-heading font-semibold uppercase tracking-[0.1em] text-sb-cream shadow-[0_8px_20px_rgba(0,20,40,0.35)] ring-1 ring-sb-sky/40 animate-[sbPopIn_160ms_ease-out_backwards] ${
            tip.pos === 'left' ? 'left-[34px] -translate-y-1/2' : tip.pos === 'right' ? 'right-[34px] -translate-y-1/2' : tip.pos === 'top' ? 'top-[34px] -translate-x-1/2' : 'bottom-[34px] -translate-x-1/2'}`}>
            {tip.label}
          </div>
        </div>
      )}

      {pop && (
        <div data-fan className="fixed inset-0 z-[61] pointer-events-none">
          {pop.kind === 'search' ? (
            <div className="absolute pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-navy/20 bg-pop text-navy shadow-[0_12px_30px_rgba(0,20,40,0.3)] animate-[sbEmerge_440ms_cubic-bezier(0.2,0.9,0.3,1.12)_backwards]"
              style={{ left: slots[0].x, top: slots[0].y, width: slots[0].w, height: slots[0].h, ['--dx' as string]: `${slots[0].dx}px`, ['--dy' as string]: `${slots[0].dy}px` }}>
              <div className="flex items-center gap-2.5 border-b border-navy/15 px-3.5 py-2.5">
                <Search className="w-4 h-4 text-inky" />
                <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown} placeholder="Search pages & actions" aria-label="Search pages and actions"
                  className="flex-1 min-w-0 bg-transparent outline-none text-sm font-body text-navy placeholder:text-inky/70" />
              </div>
              <div className="flex-1 overflow-y-auto">
                {q.trim() ? <NavResultList results={results} hl={hl} setHl={setHl} run={run} query={q} tone="pop" />
                  : <div className="px-4 py-8 text-center text-xs font-body text-inky">Type a page or an action</div>}
              </div>
            </div>
          ) : (
            popItems.map((item, i) => {
              const cur = pathname === item.to
              return (
                <button key={item.key} type="button" onClick={() => go(item)}
                  className={`absolute pointer-events-auto flex flex-col justify-center gap-0.5 overflow-hidden rounded-[14px] border px-3.5 py-2 text-left shadow-[0_8px_22px_rgba(0,20,40,0.22)] animate-[sbEmerge_440ms_cubic-bezier(0.2,0.9,0.3,1.12)_backwards] ${cur ? 'bg-sb-navy text-sb-cream border-sb-navy' : 'bg-pop text-navy border-navy/20 hover:bg-soft hover:border-inky'}`}
                  style={{ left: slots[i].x, top: slots[i].y, width: slots[i].w, height: slots[i].h, animationDelay: `${i * 45}ms`, ['--dx' as string]: `${slots[i].dx}px`, ['--dy' as string]: `${slots[i].dy}px` }}>
                  <span className="line-clamp-2 text-[12px] leading-tight font-heading font-semibold uppercase tracking-[0.07em]">{item.label}</span>
                  {NAV_META[item.key]?.desc && <span className={`line-clamp-2 text-[11px] leading-snug font-body ${cur ? 'text-sb-sky' : 'text-inky'}`}>{NAV_META[item.key].desc}</span>}
                </button>
              )
            })
          )}
        </div>
      )}
    </>
  )
}
