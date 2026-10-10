// Right-click -> Pin / Unpin for a page, for the layouts that have no sidebar to do it from (the mega menu's page cards, the Home page's pinned
// pages). Uses the same favorites list as the sidebar's own Pin, so a page pinned here shows up there and vice versa.
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pin, PinOff } from 'lucide-react'
import { useSidebarPrefs } from '@/hooks/useSidebarPrefs'

interface MenuState { x: number; y: number; key: string; label: string }

export function usePinMenu() {
  const { favorites, toggleFavorite } = useSidebarPrefs()
  const [menu, setMenu] = useState<MenuState | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('scroll', close, true)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('click', close); window.removeEventListener('contextmenu', close); window.removeEventListener('scroll', close, true); window.removeEventListener('keydown', esc) }
  }, [menu])

  const isPinned = (key: string) => favorites.includes(key)
  /** Spread onto the element: `onContextMenu={pin.onContextMenu(item.key, item.label)}`. */
  const onContextMenu = (key: string, label: string) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, key, label }) }
  const element = menu ? createPortal(
    <div style={{ top: Math.min(menu.y, window.innerHeight - 56), left: Math.min(menu.x, window.innerWidth - 190) }}
      className="fixed z-[90] w-44 rounded-lg border border-navy/20 bg-pop py-1 shadow-[0_12px_30px_rgba(0,0,0,0.3)] font-heading"
      onClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <button type="button" onClick={() => { toggleFavorite(menu.key); setMenu(null) }}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] uppercase tracking-wide text-navy hover:bg-soft">
        {isPinned(menu.key) ? <><PinOff className="w-3.5 h-3.5" /> Unpin page</> : <><Pin className="w-3.5 h-3.5" /> Pin page</>}
      </button>
    </div>,
    document.body,
  ) : null
  return { isPinned, onContextMenu, element }
}
