import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { BiCarousel } from 'react-icons/bi'
import { useRecentPagesStore } from '@/stores/recentPagesStore'

// "Jump back to a recent page" row — lives in the TopBar. Clicking the
// window-stack icon inline-reveals up to 3 numbered buttons (1st/2nd/3rd
// most recently distinct page, in ring order — see recentPagesStore.ts for
// why that order only changes on a genuinely new page visit) in the bar
// itself, not a dropdown; Cmd/Ctrl+K reveals it from anywhere; Alt+Left/
// Alt+Right (handled by useRecentPagesTracking, called once from TopBar)
// cycle this same ring circularly and are watched here (via the store's
// lastCycleNav) so a hotkey press auto-reveals the row, pulses the
// newly-active button, and "pins" it open — any navigation through this
// widget (hotkey or a direct button click) keeps it open for a few seconds
// instead of the very next click elsewhere closing it.
const PIN_TIMEOUT_MS = 4000
const PULSE_MS = 1500

export function RecentPagesWidget() {
  const navigate = useNavigate()
  const recentPages = useRecentPagesStore((s) => s.recentPages)
  const activePath = useRecentPagesStore((s) => s.activePath)
  const lastCycleNav = useRecentPagesStore((s) => s.lastCycleNav)
  const recordJump = useRecentPagesStore((s) => s.recordJump)
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const [pulsePath, setPulsePath] = useState<string | null>(null)
  const [labelPos, setLabelPos] = useState<{ top: number; left: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const pinTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout>>()

  function armPin() {
    setOpen(true)
    setPinned(true)
    clearTimeout(pinTimerRef.current)
    pinTimerRef.current = setTimeout(() => { setPinned(false); setOpen(false) }, PIN_TIMEOUT_MS)
  }

  // A hotkey cycle (or a direct button click) just happened — reveal, pulse
  // the newly-active button, and pin. Unpins itself after a few seconds of
  // no further navigation through this widget.
  useEffect(() => {
    if (!lastCycleNav) return
    setPulsePath(lastCycleNav.path)
    armPin()
    clearTimeout(pulseTimerRef.current)
    pulseTimerRef.current = setTimeout(() => setPulsePath(null), PULSE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCycleNav?.at])

  useEffect(() => () => { clearTimeout(pinTimerRef.current); clearTimeout(pulseTimerRef.current) }, [])

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
  // the same as a hotkey cycle, so the row doesn't vanish the instant you
  // interact with the page you just landed on.
  function visit(path: string) {
    armPin()
    recordJump(path)
    navigate(path)
  }

  // Explicit click on the icon always wins — closes even while pinned, and
  // clears the pin so a stray click right after doesn't reopen anything.
  function toggleOpen() {
    clearTimeout(pinTimerRef.current)
    setPinned(false)
    setOpen((v) => !v)
  }

  // Single label line: a hovered button always wins; otherwise, while
  // pinned open from a keyboard cycle, show the current (active) page's
  // full name; otherwise nothing shows. Never more than one at a time.
  const hoveredLabel = hoveredPath ? recentPages.find((p) => p.path === hoveredPath)?.label : undefined
  const activeLabel = pinned ? recentPages.find((p) => p.path === activePath)?.label : undefined
  const label = hoveredLabel ?? activeLabel ?? null

  // Positioned below the whole row (not a per-button floating tooltip) so it
  // reads as one persistent caption under the icons, per the "keep it until
  // the row itself closes" behavior — recomputed whenever it (re)appears.
  useLayoutEffect(() => {
    if (!label || !ref.current) { setLabelPos(null); return }
    const r = ref.current.getBoundingClientRect()
    setLabelPos({ top: r.bottom + 4, left: r.left + r.width / 2 })
  }, [label, open])

  return (
    <div className={`relative flex items-center flex-shrink-0 ${open ? 'gap-1.5' : 'gap-0'}`} ref={ref}>
      <button
        onClick={toggleOpen}
        title="Recent pages — Alt+← / Alt+→ / Ctrl+K"
        className={[
          'flex items-center justify-center w-7 h-7 rounded border transition-all flex-shrink-0',
          open ? 'border-sky text-sky' : 'border-[#F2F1E6]/20 text-[#F2F1E6]/60 hover:text-[#F2F1E6]',
        ].join(' ')}
      >
        <BiCarousel className="w-4 h-4" />
      </button>

      {/* Inline reveal — grows in the TopBar row itself, not a dropdown. At
          most 3 buttons, one per tracked page, numbered by ring position —
          no grouping/paging, since the ring itself never holds more than 3. */}
      <div className={`overflow-visible transition-[max-width,opacity] duration-300 ease-out ${open && recentPages.length > 0 ? 'max-w-[160px] opacity-100' : 'max-w-0 opacity-0'}`}>
        <div className="flex items-center gap-2 pl-0.5">
          {recentPages.map((page, i) => (
            <button
              key={page.path}
              onClick={() => visit(page.path)}
              onMouseEnter={() => setHoveredPath(page.path)}
              onMouseLeave={() => setHoveredPath(null)}
              className={[
                'w-8 h-8 rounded-full border-[1.5px] font-heading font-semibold text-xs flex items-center justify-center transition-all flex-shrink-0',
                page.path === activePath
                  ? 'border-sky bg-sky text-[#002745]'
                  : 'border-sky/35 bg-[#0F2138] text-sky hover:border-sky',
                pulsePath === page.path ? 'row-flash' : '',
              ].join(' ')}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>

      {open && label && labelPos && createPortal(
        <div
          style={{ top: labelPos.top, left: labelPos.left }}
          className="fixed -translate-x-1/2 z-[60] bg-[#002745] text-[#F2F1E6] text-xs font-heading px-2.5 py-1 rounded-md shadow-xl border border-[#F2F1E6]/15 pointer-events-none whitespace-nowrap animate-[fadeIn_120ms_ease-out]"
        >
          {label}
        </div>,
        document.body,
      )}
    </div>
  )
}
