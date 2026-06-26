import { useEffect } from 'react'
import { FloatingPanel, type PanelMode } from '@/components/shared/FloatingPanel'
import { InventoryView } from './InventoryView'

interface Props {
  mode: PanelMode
  width: number
  mobile: boolean
  topOffset?: number
  onModeChange: (m: PanelMode) => void
  onToggle: () => void
  onWidthChange: (w: number) => void
}

// All-locations inventory as a corner overlay (float / pin-right / hidden),
// same chrome as Location Lookup. Trigger sits bottom-right, below the Lookup pill.
export function InventoryOverlay({ mode, width, mobile, topOffset, onModeChange, onToggle, onWidthChange }: Props) {
  const open = mode !== 'hidden'

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); onToggle() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onToggle])

  return open ? (
    <FloatingPanel
      title="Inventory · All Locations" prefix="inventory"
      mode={mode} width={width} mobile={mobile} topOffset={topOffset}
      onModeChange={onModeChange} onWidthChange={onWidthChange} onClose={() => onModeChange('hidden')}
    >
      <InventoryView maxHeight="100%" />
    </FloatingPanel>
  ) : null
}
