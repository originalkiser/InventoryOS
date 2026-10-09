// A horizontal scrollbar that stays at the bottom of the visible screen. When a table (or the page) is wider than its frame, its own scrollbar sits
// at the far bottom of the frame — often off screen — so this renders a mirror scrollbar that sticks to the bottom of the scrolling area for as long
// as the frame is in view, and keeps the two in sync. The frame's own horizontal bar is hidden (see .sb-hide-x-scroll in index.css).
import { useEffect, useRef, useState, type RefObject } from 'react'

export function StickyHScroll({ targetRef, pinLeft = false }: { targetRef: RefObject<HTMLElement>; /** The target scrolls horizontally itself (the page): keep the bar at its left edge. */ pinLeft?: boolean }) {
  const proxyRef = useRef<HTMLDivElement>(null)
  const [dims, setDims] = useState({ scroll: 0, client: 0 })

  useEffect(() => {
    const t = targetRef.current
    if (!t) return
    const measure = () => setDims((d) => (d.scroll === t.scrollWidth && d.client === t.clientWidth ? d : { scroll: t.scrollWidth, client: t.clientWidth }))
    measure()
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (ro) { ro.observe(t); for (const c of Array.from(t.children)) ro.observe(c) }
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [targetRef])

  const show = dims.scroll > dims.client + 1
  useEffect(() => {
    const t = targetRef.current, p = proxyRef.current
    if (!show || !t || !p) return
    let lock = false
    const fromTarget = () => { if (lock) { lock = false; return } if (p.scrollLeft !== t.scrollLeft) { lock = true; p.scrollLeft = t.scrollLeft } }
    const fromProxy = () => { if (lock) { lock = false; return } if (t.scrollLeft !== p.scrollLeft) { lock = true; t.scrollLeft = p.scrollLeft } }
    p.scrollLeft = t.scrollLeft
    t.addEventListener('scroll', fromTarget, { passive: true })
    p.addEventListener('scroll', fromProxy, { passive: true })
    return () => { t.removeEventListener('scroll', fromTarget); p.removeEventListener('scroll', fromProxy) }
  }, [show, targetRef, dims.scroll])

  if (!show) return null
  return (
    <div ref={proxyRef} className="sb-grid-scroll sticky bottom-0 z-20 overflow-x-auto overflow-y-hidden bg-page/80 backdrop-blur-sm"
      style={{ height: 14, ...(pinLeft ? { width: dims.client, left: 0 } : {}) }} aria-hidden="true">
      <div style={{ width: dims.scroll, height: 1 }} />
    </div>
  )
}
