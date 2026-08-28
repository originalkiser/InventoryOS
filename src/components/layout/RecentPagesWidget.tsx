import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useRecentPagesStore } from '@/stores/recentPagesStore'
import { shortForLabel } from '@/lib/routeLabels'

// Rotating "jump back to a recent page" carousel — lives in the TopBar.
// Clicking the clock inline-reveals the group-of-3 buttons in the bar itself
// (not a dropdown panel); Cmd/Ctrl+K reveals it from anywhere; Alt+Left/
// Alt+Right (handled by useRecentPagesTracking, called once from TopBar) walk
// the linear visit stack independently of this carousel's own group paging,
// and are watched here (via the store's lastStackNav) so a hotkey press
// auto-reveals the widget, jumps to whichever group holds the landed-on
// page, and "pins" it open — any navigation through this widget (hotkey or a
// direct button click) keeps it open for a few seconds instead of the very
// next click elsewhere closing it.
const GROUP_SIZE = 3
const PIN_TIMEOUT_MS = 4000

// Immediate, stylized hover tooltip — mirrors Sidebar.tsx's own flyout
// (same colors/timing) instead of the browser's native `title` delay/style.
function useFlyout() {
  const [flyout, setFlyout] = useState<{ label: string; top: number; left: number } | null>(null)
  const show = (e: React.MouseEvent, label: string) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setFlyout({ label, top: r.bottom + 6, left: r.left + r.width / 2 })
  }
  const hide = () => setFlyout(null)
  const node = flyout && createPortal(
    <div
      style={{ top: flyout.top, left: flyout.left }}
      className="fixed -translate-x-1/2 z-[60] bg-[#002745] text-[#F2F1E6] text-xs font-heading px-2.5 py-1 rounded-md shadow-xl border border-[#F2F1E6]/15 pointer-events-none whitespace-nowrap animate-[fadeIn_120ms_ease-out]"
    >
      {flyout.label}
    </div>,
    document.body,
  )
  return { show, hide, node }
}

export function RecentPagesWidget() {
  const navigate = useNavigate()
  const recentPages = useRecentPagesStore((s) => s.recentPages)
  const visitStack = useRecentPagesStore((s) => s.visitStack)
  const visitCursor = useRecentPagesStore((s) => s.visitCursor)
  const lastStackNav = useRecentPagesStore((s) => s.lastStackNav)
  const recordJump = useRecentPagesStore((s) => s.recordJump)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [groupIndex, setGroupIndex] = useState(0)
  const [direction, setDirection] = useState<'back' | 'forward' | 'jump' | null>(null)
  // Bumped on every navigation through this widget (hotkey or button click)
  // so the swipe replays every time, even when the destination happens to
  // land in the SAME group as before (e.g. bouncing between only 2 pages —
  // keying the animation off groupIndex alone never changes in that case).
  const [animTick, setAnimTick] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const pinTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const { show: showTip, hide: hideTip, node: tipNode } = useFlyout()

  const groups: typeof recentPages[] = []
  for (let i = 0; i < recentPages.length; i += GROUP_SIZE) groups.push(recentPages.slice(i, i + GROUP_SIZE))
  // The visit stack (not recentPages[0]) is the source of truth for "current
  // page" — recordVisit deliberately skips reordering recentPages when a
  // hotkey nav triggers it, so recentPages[0] goes stale the moment you use
  // Alt+Left/Alt+Right.
  const activePath = visitStack[visitCursor]

  useEffect(() => {
    if (groupIndex > 0 && groupIndex > groups.length - 1) setGroupIndex(Math.max(0, groups.length - 1))
  }, [groups.length, groupIndex])

  function armPin() {
    setOpen(true)
    setPinned(true)
    clearTimeout(pinTimerRef.current)
    pinTimerRef.current = setTimeout(() => { setPinned(false); setOpen(false) }, PIN_TIMEOUT_MS)
  }

  // A hotkey nav just happened — reveal, jump to that page's group, pick the
  // slide direction, and pin. Unpins itself after a few seconds of no
  // further navigation through this widget.
  useEffect(() => {
    if (!lastStackNav) return
    const idx = recentPages.findIndex((p) => p.path === lastStackNav.path)
    if (idx !== -1) setGroupIndex(Math.floor(idx / GROUP_SIZE))
    setDirection(lastStackNav.direction)
    setAnimTick((t) => t + 1)
    armPin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStackNav?.at])

  useEffect(() => () => clearTimeout(pinTimerRef.current), [])

  useEffect(() => {
    if (!open || pinned) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open, pinned])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Clicking a page button is navigation through this widget too — pin it
  // the same as a hotkey jump, so the panel doesn't vanish the instant you
  // interact with the page you just landed on.
  function visit(path: string) {
    hideTip()
    armPin()
    recordJump(path)
    navigate(path)
  }

  function pageGroup(dir: 'back' | 'forward', nextIndex: number) {
    setDirection(dir)
    setAnimTick((t) => t + 1)
    setGroupIndex(nextIndex)
  }

  // Explicit click on the clock always wins — closes even while pinned, and
  // clears the pin so a stray click right after doesn't reopen anything.
  function toggleOpen() {
    clearTimeout(pinTimerRef.current)
    setPinned(false)
    setDirection(null)
    setOpen((v) => !v)
  }

  const animClass = direction === 'back' ? 'animate-[swipeRight_180ms_ease-out]'
    : direction === 'forward' ? 'animate-[swipeLeft_180ms_ease-out]'
    : 'animate-[fadeIn_150ms_ease-out]'

  return (
    <div className={`relative flex items-center flex-shrink-0 ${open ? 'gap-1.5' : 'gap-0'}`} ref={ref}>
      <button
        onClick={toggleOpen}
        onMouseEnter={(e) => showTip(e, 'Recent pages — Alt+← / Alt+→ / Ctrl+K')}
        onMouseLeave={hideTip}
        className={[
          'flex items-center justify-center w-7 h-7 rounded border transition-all flex-shrink-0',
          open ? 'border-sky text-sky' : 'border-[#F2F1E6]/20 text-[#F2F1E6]/60 hover:text-[#F2F1E6]',
        ].join(' ')}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {/* Inline reveal — grows in the TopBar row itself, not a dropdown.
          Renders only the current group's own (<=3) buttons — a sliding
          track of every group at once was here before, but its percentage
          transform was relative to the whole track's width rather than one
          group's, so with more than one group the offset math was wrong
          (showed more than 3, and going back never landed on the right
          spot). A key-changed directional swipe stands in for a true slide. */}
      <div className={`overflow-hidden transition-[max-width,opacity] duration-300 ease-out ${open && groups.length > 0 ? 'max-w-[220px] opacity-100' : 'max-w-0 opacity-0'}`}>
        <div className="relative flex items-center gap-1 pl-0.5">
          {groups.length > 0 && (
            <div key={animTick} className={`flex justify-center gap-3 w-[168px] flex-shrink-0 ${animClass}`}>
              {groups[groupIndex].map((page, pi) => {
                const showLeftEdge = pi === 0 && groupIndex > 0
                const showRightEdge = pi === groups[groupIndex].length - 1 && groupIndex < groups.length - 1
                return (
                  <div key={page.path} className="group/btn relative">
                    {/* Chevron shares this hover zone with the button below it
                        (not the whole carousel), so moving the pointer from
                        the button onto the chevron never crosses a gap that
                        would fire mouseleave and hide it first. */}
                    {showLeftEdge && (
                      <button
                        onClick={(e) => { e.stopPropagation(); pageGroup('back', Math.max(0, groupIndex - 1)) }}
                        aria-label="Previous pages"
                        className="absolute -left-4 top-1/2 -translate-y-1/2 w-4 h-8 flex items-center justify-center text-sky opacity-0 group-hover/btn:opacity-100 pointer-events-none group-hover/btn:pointer-events-auto transition-opacity"
                      >
                        ‹
                      </button>
                    )}
                    <button
                      onClick={() => visit(page.path)}
                      onMouseEnter={(e) => showTip(e, page.label)}
                      onMouseLeave={hideTip}
                      className={[
                        'w-8 h-8 rounded-full border-[1.5px] font-heading font-semibold text-[10px] flex items-center justify-center transition-all',
                        page.path === activePath
                          ? 'border-sky bg-sky text-[#002745]'
                          : 'border-sky/35 bg-[#0F2138] text-sky hover:border-sky',
                      ].join(' ')}
                    >
                      {shortForLabel(page.label)}
                    </button>
                    {showRightEdge && (
                      <button
                        onClick={(e) => { e.stopPropagation(); pageGroup('forward', Math.min(groups.length - 1, groupIndex + 1)) }}
                        aria-label="More pages"
                        className="absolute -right-4 top-1/2 -translate-y-1/2 w-4 h-8 flex items-center justify-center text-sky opacity-0 group-hover/btn:opacity-100 pointer-events-none group-hover/btn:pointer-events-auto transition-opacity"
                      >
                        ›
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {groups.length > 1 && (
            <div className="flex gap-0.5 flex-shrink-0">
              {groups.map((_, i) => (
                <span key={i} className={`w-1 h-1 rounded-full transition-all ${i === groupIndex ? 'bg-sky scale-125' : 'bg-[#F2F1E6]/25'}`} />
              ))}
            </div>
          )}
        </div>
      </div>

      {tipNode}
    </div>
  )
}
