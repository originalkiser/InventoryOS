// A slim bar frozen at the top of the screen once a page's own title has scrolled away: "PAGE TITLE — TAB NAME". It reads the title (the first h1 of the
// page in view) and the selected tab (role=tab, aria-selected) from the page itself, so every page with a title and tabs gets it with no per-page code.
// A page whose header is already sticky never scrolls its title away, so the bar never appears there.
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

const visible = (el: Element) => (el as HTMLElement).offsetParent !== null
const clean = (s: string | null | undefined) => (s ?? '').replace(/\s*\(\d+\)\s*$/, '').trim()

export function StickyTitleBar() {
  const holder = useRef<HTMLDivElement>(null)
  const [info, setInfo] = useState<{ title: string; tab: string | null } | null>(null)
  const { pathname } = useLocation()

  useEffect(() => {
    const scroller = holder.current?.closest('.app-scroll') as HTMLElement | null
    if (!scroller) return
    let raf = 0
    const check = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const h1 = Array.from(scroller.querySelectorAll('main h1')).find(visible) as HTMLElement | undefined
        if (!h1) { setInfo(null); return }
        if (h1.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 8) { setInfo(null); return }
        const tab = Array.from(scroller.querySelectorAll('main [role="tab"][aria-selected="true"]')).find(visible)
        const next = { title: clean(h1.textContent), tab: tab ? clean(tab.textContent) : null }
        setInfo((cur) => (cur && cur.title === next.title && cur.tab === next.tab ? cur : next))
      })
    }
    // A tab click changes the selected tab without scrolling, so look again right after clicks too.
    const afterClick = () => window.setTimeout(check, 60)
    scroller.addEventListener('scroll', check, { passive: true })
    scroller.addEventListener('click', afterClick, true)
    window.addEventListener('resize', check)
    check()
    return () => { cancelAnimationFrame(raf); scroller.removeEventListener('scroll', check); scroller.removeEventListener('click', afterClick, true); window.removeEventListener('resize', check) }
  }, [pathname])

  return (
    <div ref={holder} className="sticky top-0 z-30 h-0 overflow-visible pointer-events-none">
      {info && (
        <div className="pointer-events-auto absolute inset-x-0 top-0 flex items-baseline gap-2 border-b border-navy/15 bg-page/95 px-3 py-2 backdrop-blur sm:px-6 animate-[fadeIn_120ms_ease-out]">
          <span className="text-base font-heading font-bold uppercase tracking-wide text-navy">{info.title}</span>
          {info.tab && <><span className="text-inky">—</span><span className="text-xs font-heading font-semibold uppercase tracking-wide text-navy">{info.tab}</span></>}
        </div>
      )}
    </div>
  )
}
