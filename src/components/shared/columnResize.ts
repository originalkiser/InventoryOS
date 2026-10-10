// Column resizing for the grid-style tables. Dragging only moves a cyan guide line down the table (straight DOM, no React render and no table
// relayout per mouse move); the width is applied once, on release. Used by the shared DataTable and by the hand-built tables (Location Lookup's
// tank monitors), so they all behave the same.
import { useCallback, useState } from 'react'

export function beginColumnDrag(
  e: { preventDefault: () => void; stopPropagation: () => void; clientX?: number; touches?: ArrayLike<{ clientX: number }> },
  opts: { th: HTMLElement; startWidth: number; min?: number; max?: number; scroller?: HTMLElement | null; onCommit: (width: number) => void },
) {
  e.preventDefault()
  e.stopPropagation()
  const pointX = (ev: MouseEvent | TouchEvent) => ('touches' in ev ? ev.touches[0]?.clientX ?? ev.changedTouches[0]?.clientX ?? 0 : ev.clientX)
  const startX = e.touches ? e.touches[0].clientX : (e.clientX ?? 0)
  const min = opts.min ?? 40, max = opts.max ?? 800, startW = opts.startWidth
  const rect = (opts.scroller ?? opts.th.closest('table') ?? opts.th).getBoundingClientRect()
  const thRight = opts.th.getBoundingClientRect().right
  const line = document.createElement('div')
  line.style.cssText = `position:fixed;z-index:9999;pointer-events:none;width:2px;background:#00e5ff;box-shadow:0 0 6px rgba(0,229,255,0.7);top:${rect.top}px;height:${rect.height}px;left:${thRight - 1}px`
  document.body.appendChild(line)
  const prevCursor = document.body.style.cursor
  document.body.style.cursor = 'col-resize'
  const clampDelta = (dx: number) => Math.min(max, Math.max(min, startW + dx)) - startW
  const move = (ev: MouseEvent | TouchEvent) => { line.style.left = `${thRight - 1 + clampDelta(pointX(ev) - startX)}px` }
  const up = (ev: MouseEvent | TouchEvent) => {
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up)
    document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); document.removeEventListener('touchcancel', up)
    line.remove()
    document.body.style.cursor = prevCursor
    const size = Math.round(startW + clampDelta(pointX(ev) - startX))
    if (size !== startW) opts.onCommit(size)
  }
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
  document.addEventListener('touchmove', move); document.addEventListener('touchend', up); document.addEventListener('touchcancel', up)
}

/** Column widths for a hand-built table, remembered in this browser under `storageKey`. */
export function useColumnWidths(storageKey: string) {
  const [widths, setWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, number> } catch { return {} }
  })
  const setWidth = useCallback((id: string, w: number) => {
    setWidths((cur) => {
      const next = { ...cur, [id]: w }
      try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }, [storageKey])
  return { widths, setWidth }
}
