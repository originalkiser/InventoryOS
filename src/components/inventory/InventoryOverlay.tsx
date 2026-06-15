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
        className="fixed bottom-4 right-4 z-[60] flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-4 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
        title="Inventory — all locations (Ctrl/Cmd+I)"
      >
        Inventory{open ? <span className="text-[10px] text-sky ml-1">●</span> : null}
      </button>
      {open && (
        <FloatingPanel
          title="Inventory · All Locations" prefix="inventory"
          mode={mode} width={width} mobile={mobile}
          onModeChange={onModeChange} onWidthChange={onWidthChange} onClose={() => onModeChange('hidden')}
        >
          <InventoryView maxHeight="100%" />
        </FloatingPanel>
      )}
    </>
  )
}
