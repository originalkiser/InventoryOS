import { useEffect } from 'react'
import { FloatingPanel, type PanelMode } from '@/components/shared/FloatingPanel'
import { InventoryView } from './InventoryView'

interface Props {
  mode: PanelMode
  width: number
  mobile: boolean
  onModeChange: (m: PanelMode) => void
  onToggle: () => void
  onWidthChange: (w: number) => void
}

// All-locations inventory as a corner overlay (float / pin-right / hidden),
// same chrome as Location Lookup. Trigger sits bottom-right, below the Lookup pill.
export function InventoryOverlay({ mode, width, mobile, onModeChange, onToggle, onWidthChange }: Props) {
  const open = mode !== 'hidden'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); onToggle() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle])

  return (
    <>
      <button
        onClick={onToggle}
        className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-[#00e5ff]/40 bg-[#161820] px-4 py-2 font-mono text-xs text-[#00e5ff] shadow-lg hover:bg-[#00e5ff]/10"
        title="Inventory — all locations (Ctrl/Cmd+I)"
      >
        📊 Inventory{open ? <span className={['text-[10px]', mode === 'docked' ? 'text-[#ffb300]' : 'text-[#00e5ff]'].join(' ')}>●</span> : null}
      </button>
      {open && (
        <FloatingPanel
          title="Inventory · All Locations" accent="#00e5ff" prefix="inventory"
          mode={mode} width={width} mobile={mobile}
          onModeChange={onModeChange} onWidthChange={onWidthChange} onClose={() => onModeChange('hidden')}
        >
          <InventoryView maxHeight="100%" />
        </FloatingPanel>
      )}
    </>
  )
}
