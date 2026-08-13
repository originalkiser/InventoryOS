import { FloatingPanel, type PanelMode } from '@/components/shared/FloatingPanel'
import { MeetingForm } from './MeetingModal'

interface Props {
  mode: PanelMode
  width: number
  mobile: boolean
  topOffset?: number
  sidebarWidth?: number
  onModeChange: (m: PanelMode) => void
  onWidthChange: (w: number) => void
}

// Quick meeting capture as a corner overlay (float / pin-right / hidden) — same
// chrome as Location Lookup / Inventory, so it hovers over the screen, stays put
// on click-out, and is resizable/dockable. Content still accessible behind it.
export function MeetingOverlay({ mode, width, mobile, topOffset, sidebarWidth, onModeChange, onWidthChange }: Props) {
  const open = mode !== 'hidden'
  return open ? (
    <FloatingPanel
      title="Quick Meeting" prefix="quickMeeting"
      mode={mode} width={width} mobile={mobile} topOffset={topOffset} sidebarWidth={sidebarWidth}
      onModeChange={onModeChange} onWidthChange={onWidthChange} onClose={() => onModeChange('hidden')}
    >
      <div className="flex-1 min-h-0 overflow-y-auto pr-1">
        <MeetingForm open onClose={() => onModeChange('hidden')} quick />
      </div>
    </FloatingPanel>
  ) : null
}
