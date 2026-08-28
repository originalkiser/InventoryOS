import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useRecentPagesStore } from '@/stores/recentPagesStore'
import { shortForLabel } from '@/lib/routeLabels'

// Rotating "jump back to a recent page" carousel — lives in the TopBar.
// Clicking the clock inline-reveals the group-of-3 buttons in the bar itself
// (not a dropdown panel); Cmd/Ctrl+K reveals it from anywhere; Alt+Left/
// Alt+Right (handled by useRecentPagesTracking, called once from TopBar) walk
// the linear visit stack independently of this carousel's own group paging.
const GROUP_SIZE = 3

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
  const [open, setOpen] = useState(false)
  const [groupIndex, setGroupIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const { show: showTip, hide: hideTip, node: tipNode } = useFlyout()

  const groups: typeof recentPages[] = []
  for (let i = 0; i < recentPages.length; i += GROUP_SIZE) groups.push(recentPages.slice(i, i + GROUP_SIZE))
  const activePath = recentPages[0]?.path

  useEffect(() => {
    if (groupIndex > 0 && groupIndex > groups.length - 1) setGroupIndex(Math.max(0, groups.length - 1))
  }, [groups.length, groupIndex])

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

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

  function visit(path: string) {
    hideTip()
    navigate(path)
  }

  return (
    <div className="relative flex items-center gap-1.5 flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
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
          spot). A key-changed fade is a safe stand-in for the slide. */}
      <div className={`overflow-hidden transition-[max-width,opacity] duration-300 ease-out ${open && groups.length > 0 ? 'max-w-[220px] opacity-100' : 'max-w-0 opacity-0'}`}>
        <div className="relative flex items-center gap-1 pl-0.5">
          {groups.length > 0 && (
            <div key={groupIndex} className="flex justify-center gap-3 w-[168px] flex-shrink-0 animate-[fadeIn_150ms_ease-out]">
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
                        onClick={(e) => { e.stopPropagation(); setGroupIndex((i) => Math.max(0, i - 1)) }}
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
                        onClick={(e) => { e.stopPropagation(); setGroupIndex((i) => Math.min(groups.length - 1, i + 1)) }}
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
