import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRecentPagesStore } from '@/stores/recentPagesStore'
import { shortForLabel } from '@/lib/routeLabels'

// Rotating "jump back to a recent page" carousel — lives in the TopBar next
// to the pill-config gear. Cmd/Ctrl+K reveals it from anywhere; Alt+Left/
// Alt+Right (handled by useRecentPagesTracking, called once from TopBar) walk
// the linear visit stack independently of this carousel's own group paging.
//
// Ported from a working HTML/CSS prototype — the group-of-3 pagination,
// hover-reveals-chevron behavior, and slide easing match that prototype;
// colors are restyled to the app's real tokens (sky stands in for the
// prototype's gold highlight, since gold isn't an approved color).
const GROUP_SIZE = 3

export function RecentPagesWidget() {
  const navigate = useNavigate()
  const recentPages = useRecentPagesStore((s) => s.recentPages)
  const [open, setOpen] = useState(false)
  const [groupIndex, setGroupIndex] = useState(0)
  const [hoverArrow, setHoverArrow] = useState<'left' | 'right' | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const groups: typeof recentPages[] = []
  for (let i = 0; i < recentPages.length; i += GROUP_SIZE) groups.push(recentPages.slice(i, i + GROUP_SIZE))
  const activePath = recentPages[0]?.path

  // Clamp groupIndex if the list shrinks/reflows while open.
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
    setOpen(false)
    navigate(path)
  }

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Recent pages (⌘K)"
        className="flex items-center justify-center w-7 h-7 rounded border border-[#F2F1E6]/20 text-[#F2F1E6]/60 hover:text-[#F2F1E6] transition-all"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-72 bg-[#002745] border border-[#F2F1E6]/20 rounded-xl shadow-xl p-3 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Jump back to</span>
            {groups.length > 1 && (
              <div className="flex gap-1">
                {groups.map((_, i) => (
                  <span key={i} className={`w-1 h-1 rounded-full transition-all ${i === groupIndex ? 'bg-sky scale-125' : 'bg-[#F2F1E6]/25'}`} />
                ))}
              </div>
            )}
          </div>

          {groups.length === 0 ? (
            <p className="text-xs font-mono text-[#F2F1E6]/40 italic py-2 text-center">Nothing visited yet this session.</p>
          ) : (
            <div className="relative overflow-hidden">
              <div
                className="flex transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
                style={{ transform: `translateX(-${groupIndex * 100}%)` }}
              >
                {groups.map((group, gi) => (
                  <div key={gi} className="flex justify-center gap-4 w-full flex-shrink-0">
                    {group.map((page, pi) => {
                      const isFirst = pi === 0
                      const isLast = pi === group.length - 1
                      return (
                        <div
                          key={page.path}
                          className="flex flex-col items-center gap-1.5"
                          onMouseEnter={() => {
                            if (isLast && gi < groups.length - 1) setHoverArrow('right')
                            else if (isFirst && gi > 0) setHoverArrow('left')
                          }}
                          onMouseLeave={() => setHoverArrow(null)}
                        >
                          <button
                            onClick={() => visit(page.path)}
                            title={page.label}
                            className={[
                              'w-12 h-12 rounded-full border-[1.5px] font-heading font-semibold text-sm flex items-center justify-center transition-all',
                              page.path === activePath
                                ? 'border-sky bg-sky text-[#002745] shadow-[0_0_0_4px_rgba(183,224,222,0.18)]'
                                : 'border-sky/35 bg-[#0F2138] text-sky hover:border-sky hover:shadow-[0_0_0_4px_rgba(183,224,222,0.12)]',
                            ].join(' ')}
                          >
                            {shortForLabel(page.label)}
                          </button>
                          <span className="text-[9px] font-mono text-[#F2F1E6]/55 max-w-[64px] truncate text-center">{page.label}</span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>

              {hoverArrow === 'right' && (
                <button
                  onClick={() => setGroupIndex((i) => Math.min(groups.length - 1, i + 1))}
                  aria-label="More pages"
                  className="absolute right-0 top-1/2 -translate-y-1/2 w-7 h-12 rounded-lg border border-sky/40 bg-[#002745]/90 text-sky flex items-center justify-center hover:bg-sky/15"
                >
                  ›
                </button>
              )}
              {hoverArrow === 'left' && (
                <button
                  onClick={() => setGroupIndex((i) => Math.max(0, i - 1))}
                  aria-label="Previous pages"
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-7 h-12 rounded-lg border border-sky/40 bg-[#002745]/90 text-sky flex items-center justify-center hover:bg-sky/15"
                >
                  ‹
                </button>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 border-t border-[#F2F1E6]/10 text-[9px] font-mono text-[#F2F1E6]/40">
            <span><kbd className="px-1 py-0.5 rounded bg-sky/10 border border-sky/25 text-sky">⌥←</kbd> last page</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sky/10 border border-sky/25 text-sky">⌥→</kbd> snap forward</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sky/10 border border-sky/25 text-sky">⌘K</kbd> reveal</span>
          </div>
        </div>
      )}
    </div>
  )
}
