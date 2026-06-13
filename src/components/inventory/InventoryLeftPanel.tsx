import { useEffect, useState } from 'react'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { InventoryView } from './InventoryView'

// Left-side, all-locations inventory panel. Floating drawer toggled by a
// bottom-left pill; full-width on mobile.
export function InventoryLeftPanel() {
  const mobile = useMediaQuery('(max-width: 480px)')
  const [open, setOpen] = useState(false)

  // Esc closes.
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open])

  return (
    <>
      <button onClick={() => setOpen((o) => !o)}
        className="fixed bottom-4 left-4 z-[60] flex items-center gap-1.5 rounded-full border border-[#00e5ff]/40 bg-[#161820] px-4 py-2 font-mono text-xs text-[#00e5ff] shadow-lg hover:bg-[#00e5ff]/10"
        title="Inventory — all locations">
        📊 Inventory
      </button>
      {open && (
        <div style={mobile ? { position: 'fixed', inset: 0, zIndex: 55 } : { position: 'fixed', top: 0, bottom: 0, left: 0, width: 460, zIndex: 55 }}
          className="flex flex-col overflow-hidden border-r border-[#2a2d3e] bg-[#161820] shadow-2xl">
          <div className="flex items-center justify-between border-b border-[#2a2d3e] px-3 py-2">
            <span className="text-xs font-mono font-semibold uppercase tracking-wide text-[#00e5ff]">Inventory · All Locations</span>
            <button onClick={() => setOpen(false)} className="p-1 text-gray-500 hover:text-white" title="Close">✕</button>
          </div>
          <div className="flex-1 overflow-auto p-3">
            <InventoryView maxHeight="calc(100vh - 140px)" />
          </div>
        </div>
      )}
    </>
  )
}
