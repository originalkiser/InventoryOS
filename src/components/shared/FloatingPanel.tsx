import { useState } from 'react'

// Shared corner-overlay shell used by Location Lookup and Inventory. Three
// modes: docked (full-height right, pushes content via the parent), floating
// (hovers on top, repositionable + resizable, persists across nav), hidden.
export type PanelMode = 'hidden' | 'docked' | 'floating'

interface FloatingPanelProps {
  title: string
  mode: PanelMode
  width: number
  mobile: boolean
  prefix: string // localStorage key prefix for size/position
  headerActions?: React.ReactNode
  onModeChange: (m: PanelMode) => void
  onWidthChange: (w: number) => void
  onClose: () => void
  children: React.ReactNode
  /** Pixels reserved at the top (TopBar height). Panel never overlaps above this. */
  topOffset?: number
  /** Sidebar width in px — floating panel won't be dragged to overlap it. */
  sidebarWidth?: number
}

export function FloatingPanel({
  title, mode, width, mobile, prefix, headerActions, onModeChange, onWidthChange, onClose, children,
  topOffset = 48, sidebarWidth = 0,
}: FloatingPanelProps) {
  const docked = mode === 'docked' && !mobile
  const sizeKey = `${prefix}.size`
  const posKey = `${prefix}.pos`
  const [height, setHeight] = useState<number>(() => Number(localStorage.getItem(sizeKey)) || Math.round(window.innerHeight * 0.6))
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(() => {
    try { return JSON.parse(localStorage.getItem(posKey) || 'null') } catch { return null }
  })
  const right = pos?.right ?? 16
  const clampedBottom = Math.max(pos?.bottom ?? 16, 0)

  const maxPanelHeight = window.innerHeight - topOffset

  function startResize(e: React.MouseEvent) {
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY, sw = width, sh = height
    const move = (ev: MouseEvent) => {
      onWidthChange(Math.min(Math.max(sw + (sx - ev.clientX), 320), window.innerWidth - 40))
      setHeight(Math.min(Math.max(sh + (sy - ev.clientY), 240), maxPanelHeight))
    }
    const up = () => {
      localStorage.setItem(sizeKey, String(height))
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  function startMove(e: React.MouseEvent) {
    if (mobile || docked) return
    const sx = e.clientX, sy = e.clientY, sr = right, sb = clampedBottom
    const move = (ev: MouseEvent) => {
      const maxRight = Math.max(0, window.innerWidth - width - sidebarWidth)
      const nr = Math.min(Math.max(sr - (ev.clientX - sx), 0), maxRight)
      const nb = Math.min(Math.max(sb - (ev.clientY - sy), 0), window.innerHeight - topOffset - height)
      setPos({ right: nr, bottom: nb })
    }
    const up = () => {
      setPos((p) => { if (p) localStorage.setItem(posKey, JSON.stringify(p)); return p })
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }

  const style: React.CSSProperties = mobile
    ? { position: 'fixed', left: 0, right: 0, bottom: 0, height: '70vh', zIndex: 65 }
    : docked
    ? { position: 'fixed', top: topOffset, right: 0, bottom: 0, width, zIndex: 65 }
    : { position: 'fixed', right, bottom: clampedBottom, width, height: Math.min(height, maxPanelHeight), maxHeight: maxPanelHeight, zIndex: 65 }

  return (
    <div style={style} className="flex flex-col overflow-hidden rounded-lg border border-navy/40 bg-cream shadow-2xl">
      {!mobile && <div onMouseDown={startResize} className="absolute left-0 top-0 z-10 h-3 w-3 cursor-nwse-resize" title="Drag to resize" />}

      <div onMouseDown={startMove} className={['flex items-center justify-between bg-navy border-b border-navy/40 px-3 py-2', (mobile || docked) ? '' : 'cursor-move'].join(' ')}>
        <span className="text-xs font-heading font-bold text-cream uppercase tracking-wide">{title}</span>
        <div className="flex items-center gap-1" onMouseDown={(e) => e.stopPropagation()}>
          {headerActions}
          {!mobile && (
            <>
              <button onClick={() => onModeChange('floating')} title="Float on top"
                className={['p-1 rounded text-sm transition-colors', mode === 'floating' ? 'text-sky' : 'text-inky/50 hover:text-cream'].join(' ')}>⬛</button>
              <button onClick={() => onModeChange('docked')} title="Pin to right (push content)"
                className={['p-1 rounded text-sm transition-colors', mode === 'docked' ? 'text-sky' : 'text-inky/50 hover:text-cream'].join(' ')}>📌</button>
            </>
          )}
          <button onClick={onClose} className="p-1 text-inky/50 hover:text-cream transition-colors" title="Hide">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3">{children}</div>
    </div>
  )
}
