// Navigation layout "Floating dock" (option G in the SB navigation concepts): a small draggable toolbar of section icons that floats over the
// page. Clicking an icon fans that section's pages out as cards beside the dock; the search icon fans out a search panel. The dock can be
// dragged anywhere, snapped to an edge, rotated and collapsed to a single bubble. Its position follows the user across devices.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ChevronsUpDown, MoreHorizontal, Search } from 'lucide-react'
import sbIcon from '@/assets/SBOC-IconCream.png'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useNavBadgeSum } from '@/hooks/useNavBadges'
import { ICONS, SECTION_ICONS } from './navIcons'
import { NAV_META } from './navMeta'
import { NavResultList, useNavSearch } from './NavSearch'
import { HOME_ITEM, useNavModel } from './useNavModel'
import type { NavItem } from './navData'

interface DockPrefs { x: number | null; y: number | null; orient: 'v' | 'h'; mini: boolean; search: boolean }
const DEFAULT_DOCK: DockPrefs = { x: null, y: null, orient: 'v', mini: false, search: true }
type Edge = 'left' | 'right' | 'top' | 'bottom'
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

interface Pop { kind: 'section' | 'search' | 'menu'; id: string; pos: Edge; cx: number; cy: number; dl: number; dt: number; dr: number; db: number; fw: number; fh: number }
interface Slot { x: number; y: number; w: number; h: number; dx: number; dy: number }

/** Where each fan card goes: stacked beside a vertical dock, in a row beside a horizontal one — always kept on screen. */
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
  const out: Slot[] = []
  if (side) {
    const w = Math.max(160, Math.min(280, p.fw - 100)), h = 56
    const H = n * h + (n - 1) * G
    const y0 = clamp(p.cy - H / 2, 10, Math.max(10, p.fh - H - 10))
    const x = p.pos === 'left' ? p.dr + 10 : p.dl - 10 - w
    for (let i = 0; i < n; i++) { const y = y0 + i * (h + G); out.push({ x, y, w, h, dx: p.cx - (x + w / 2), dy: p.cy - (y + h / 2) }) }
  } else {
    const w = clamp(Math.floor((p.fw - 20 - (n - 1) * G) / n), 140, 200), h = 76
    const T = n * w + (n - 1) * G
    const x0 = Math.max(10, clamp(p.cx - T / 2, 10, Math.max(10, p.fw - T - 10)))
    const y = p.pos === 'top' ? p.db + 10 : p.dt - 10 - h
    for (let i = 0; i < n; i++) { const x = x0 + i * (w + G); out.push({ x, y, w, h, dx: p.cx - (x + w / 2), dy: p.cy - (y + h / 2) }) }
  }
  return out
}

function DockSectionButton({ id, label, icon, active, open, onClick, index }: {
  id: string; label: string; icon: React.ReactNode; active: boolean; open: boolean; onClick: (e: React.MouseEvent<HTMLButtonElement>) => void; index: number; keys: string[]
}) {
  return (
    <button type="button" data-dock-btn={id} aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={onClick}
      style={{ animationDelay: `${index * 45}ms` }}
      className={`relative w-[46px] h-[46px] flex-none grid place-items-center rounded-full transition-[background,transform] duration-150 hover:scale-[1.07] animate-[sbPopIn_320ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards] ${active ? 'bg-sky text-sb-navy' : open ? 'bg-inky/75' : 'hover:bg-inky/55'}`}>
      {icon}
    </button>
  )
}

function DockBadge({ keys }: { keys: string[] }) {
  const n = useNavBadgeSum(keys)
  return n > 0 ? <span className="absolute top-0.5 right-0.5 min-w-[17px] h-[17px] rounded-full bg-[#ff8a5c] text-black text-[10px] font-mono leading-[17px] text-center px-1">{n}</span> : null
}

export function NavDock() {
  const { sections, utility } = useNavModel()
  const navigate = useNavigate()
  const [prefs, setPrefs] = useProfilePref<DockPrefs>('nav:dock', DEFAULT_DOCK)
  const p: DockPrefs = { ...DEFAULT_DOCK, ...prefs }
  const [xy, setXy] = useState<{ x: number; y: number } | null>(null)
  const [pop, setPop] = useState<Pop | null>(null)
  const [dragging, setDragging] = useState(false)
  const [q, setQ] = useState('')
  const dockRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { pathname } = useLocation()

  const clampXY = useCallback((x: number, y: number) => {
    const d = dockRef.current?.getBoundingClientRect()
    const w = d?.width ?? 60, h = d?.height ?? 60
    return { x: clamp(x, 6, Math.max(6, window.innerWidth - w - 6)), y: clamp(y, 6, Math.max(6, window.innerHeight - h - 6)) }
  }, [])

  // First placement (or a saved one), and re-clamping when the dock's own size changes (rotate / collapse / search toggle) or the window does.
  useLayoutEffect(() => {
    const d = dockRef.current?.getBoundingClientRect()
    if (!d) return
    if (p.x == null || p.y == null) setXy(clampXY(12, (window.innerHeight - d.height) / 2))
    else setXy(clampXY(p.x, p.y))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.orient, p.mini, p.search, sections.length])
  useEffect(() => {
    const onResize = () => setXy((cur) => (cur ? clampXY(cur.x, cur.y) : cur))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [clampXY])
  useEffect(() => { setPop(null) }, [p.orient, p.mini, p.search])

  useEffect(() => {
    if (!pop) return
    const down = (e: PointerEvent) => { const t = e.target as HTMLElement; if (!t.closest('[data-dock]') && !t.closest('[data-fan]')) setPop(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null) }
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key) }
  }, [pop])
  useEffect(() => { if (pop?.kind === 'search') setTimeout(() => inputRef.current?.focus(), 120) }, [pop?.kind])

  const save = (patch: Partial<DockPrefs>) => setPrefs({ ...p, ...patch })
  const snap = (edge: Edge) => {
    const orient: 'v' | 'h' = edge === 'left' || edge === 'right' ? 'v' : 'h'
    save({ orient, mini: false, x: null, y: null })
    // Place once the new orientation has rendered.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const d = dockRef.current?.getBoundingClientRect()
      if (!d) return
      const m = 12
      const x = edge === 'left' ? m : edge === 'right' ? window.innerWidth - d.width - m : (window.innerWidth - d.width) / 2
      const y = edge === 'top' ? m : edge === 'bottom' ? window.innerHeight - d.height - m : (window.innerHeight - d.height) / 2
      const c = clampXY(x, y)
      setXy(c)
      setPrefs({ ...p, orient, mini: false, x: c.x, y: c.y })
    }))
  }

  const dragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!xy) return
    if ((e.target as HTMLElement).closest('[data-dock-btn]') && !p.mini) return
    drag.current = { sx: e.clientX, sy: e.clientY, ox: xy.x, oy: xy.y, moved: false }
    setPop(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy
    if (!d.moved && Math.hypot(dx, dy) < 4) return
    d.moved = true
    setDragging(true)
    setXy(clampXY(d.ox + dx, d.oy + dy))
  }
  const dragEnd = () => {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (!d) return
    if (!d.moved) { if (p.mini) save({ mini: false }); return }
    if (xy) setPrefs({ ...p, x: xy.x, y: xy.y })
  }

  const openPop = (kind: Pop['kind'], id: string, e: React.MouseEvent<HTMLButtonElement>) => {
    if (pop && pop.kind === kind && pop.id === id) { setPop(null); return }
    const b = e.currentTarget.getBoundingClientRect()
    const d = dockRef.current!.getBoundingClientRect()
    const fw = window.innerWidth, fh = window.innerHeight
    const pos: Edge = p.orient === 'v' ? (d.left + d.width / 2 < fw / 2 ? 'left' : 'right') : (d.top + d.height / 2 < fh / 2 ? 'top' : 'bottom')
    setQ('')
    setPop({ kind, id, pos, cx: b.left + b.width / 2, cy: b.top + b.height / 2, dl: d.left, dt: d.top, dr: d.right, db: d.bottom, fw, fh })
  }

  const go = (item: NavItem) => { if (item.to) navigate(item.to); setPop(null) }
  const { results, hl, setHl, run, onKeyDown } = useNavSearch(q, () => setPop(null))

  const vertical = p.orient === 'v'
  const popItems: NavItem[] = pop?.kind === 'section' ? (pop.id === 'shortcuts' ? utility : sections.find((s) => s.key === pop.id)?.items ?? []) : []
  const menuItems: { label: string; sub?: string; on: () => void }[] = [
    { label: 'Snap left', on: () => snap('left') }, { label: 'Snap right', on: () => snap('right') },
    { label: 'Snap top', on: () => snap('top') }, { label: 'Snap bottom', on: () => snap('bottom') },
    { label: vertical ? 'Make horizontal' : 'Make vertical', on: () => save({ orient: vertical ? 'h' : 'v', x: null, y: null }) },
    { label: p.search ? 'Hide search' : 'Show search', on: () => save({ search: !p.search }) },
    { label: 'Collapse to a bubble', on: () => save({ mini: true }) },
  ]
  const slots = pop ? fanLayout(pop, pop.kind === 'section' ? popItems.length : menuItems.length, pop.kind === 'search') : []
  const isActive = (items: NavItem[]) => items.some((i) => i.to && (pathname === i.to || pathname.startsWith(`${i.to}/`)))

  const sep = <span className={`flex-none bg-chrome-fg/30 ${vertical ? 'w-[26px] h-[1.5px] my-0.5' : 'h-[26px] w-[1.5px] mx-0.5'}`} />

  return (
    <>
      <div
        ref={dockRef} data-dock
        onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd}
        style={{ left: xy?.x ?? 12, top: xy?.y ?? 120, visibility: xy ? 'visible' : 'hidden' }}
        className={`fixed z-[62] flex items-center gap-1.5 p-2 bg-chrome text-chrome-fg select-none touch-none ${dragging ? 'cursor-grabbing shadow-[0_18px_40px_rgba(0,20,40,0.5)]' : 'cursor-grab shadow-[0_12px_30px_rgba(0,20,40,0.35)]'} ${p.mini ? 'rounded-full p-1.5' : 'rounded-full'} ${vertical ? 'flex-col' : 'flex-row'}`}
        role="navigation" aria-label="Main"
      >
        {p.mini ? (
          <button type="button" aria-label="Expand navigation" className="w-[54px] h-[54px] grid place-items-center rounded-full hover:bg-inky/45 animate-[sbPopIn_300ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards]"><img src={sbIcon} alt="" className="h-11 w-auto" /></button>
        ) : (
          <>
            <img src={sbIcon} alt="SB Net" className={`h-11 w-auto flex-none ${vertical ? 'mx-[3px] mt-0.5 mb-1' : 'mx-1.5'} animate-[sbPopIn_320ms_cubic-bezier(0.2,0.9,0.3,1.2)_backwards]`} draggable={false} />
            <DockSectionButton id="home" label="Home" icon={ICONS.home} active={pathname === HOME_ITEM.to} open={false} index={0} keys={[]}
              onClick={() => navigate(HOME_ITEM.to!)} />
            {sep}
            {sections.map((s, i) => (
              <div key={s.key} className="relative flex-none">
                <DockSectionButton id={s.key} label={s.label} index={i + 1} keys={s.items.map((x) => x.key)}
                  icon={<span className="[&_svg]:w-5 [&_svg]:h-5 [&_img]:w-5 [&_img]:h-5">{SECTION_ICONS[s.key]}</span>}
                  active={isActive(s.items)} open={pop?.kind === 'section' && pop.id === s.key}
                  onClick={(e) => (s.items.length === 1 ? go(s.items[0]) : openPop('section', s.key, e))} />
                <DockBadge keys={s.items.map((x) => x.key)} />
              </div>
            ))}
            <div className="relative flex-none">
              <DockSectionButton id="shortcuts" label="Shortcuts" index={sections.length + 1} keys={utility.map((x) => x.key)} icon={ICONS.calendar}
                active={isActive(utility)} open={pop?.kind === 'section' && pop.id === 'shortcuts'} onClick={(e) => openPop('section', 'shortcuts', e)} />
              <DockBadge keys={utility.map((x) => x.key)} />
            </div>
            {p.search && (<>{sep}<DockSectionButton id="search" label="Search" index={sections.length + 2} keys={[]} icon={<Search className="w-5 h-5" />} active={false} open={pop?.kind === 'search'} onClick={(e) => openPop('search', 'search', e)} /></>)}
            {sep}
            <DockSectionButton id="menu" label="Dock options" index={sections.length + 3} keys={[]} icon={<MoreHorizontal className="w-5 h-5" />} active={false} open={pop?.kind === 'menu'} onClick={(e) => openPop('menu', 'menu', e)} />
          </>
        )}
      </div>

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
          ) : pop.kind === 'menu' ? (
            menuItems.map((m, i) => (
              <button key={m.label} type="button" onClick={() => { m.on(); setPop(null) }}
                className="absolute pointer-events-auto flex items-center rounded-[14px] border border-navy/20 bg-pop px-4 text-left text-[13px] font-heading font-semibold uppercase tracking-[0.07em] text-navy shadow-[0_8px_22px_rgba(0,20,40,0.22)] hover:bg-soft hover:border-inky animate-[sbEmerge_440ms_cubic-bezier(0.2,0.9,0.3,1.12)_backwards]"
                style={{ left: slots[i].x, top: slots[i].y, width: slots[i].w, height: slots[i].h, animationDelay: `${i * 55}ms`, ['--dx' as string]: `${slots[i].dx}px`, ['--dy' as string]: `${slots[i].dy}px` }}>
                <ChevronsUpDown className="w-3.5 h-3.5 mr-2 opacity-60" />{m.label}
              </button>
            ))
          ) : (
            popItems.map((item, i) => {
              const cur = pathname === item.to
              return (
                <button key={item.key} type="button" onClick={() => go(item)}
                  className={`absolute pointer-events-auto flex flex-col justify-center gap-px overflow-hidden rounded-[14px] border px-3.5 py-2 text-left shadow-[0_8px_22px_rgba(0,20,40,0.22)] animate-[sbEmerge_440ms_cubic-bezier(0.2,0.9,0.3,1.12)_backwards] ${cur ? 'bg-sb-navy text-sb-cream border-sb-navy' : 'bg-pop text-navy border-navy/20 hover:bg-soft hover:border-inky'}`}
                  style={{ left: slots[i].x, top: slots[i].y, width: slots[i].w, height: slots[i].h, animationDelay: `${i * 55}ms`, ['--dx' as string]: `${slots[i].dx}px`, ['--dy' as string]: `${slots[i].dy}px` }}>
                  <span className="truncate text-[13px] font-heading font-semibold uppercase tracking-[0.07em]">{item.label}</span>
                  {NAV_META[item.key]?.desc && <span className={`truncate text-[11px] font-body ${cur ? 'text-sky' : 'text-inky'}`}>{NAV_META[item.key].desc}</span>}
                </button>
              )
            })
          )}
        </div>
      )}
    </>
  )
}
