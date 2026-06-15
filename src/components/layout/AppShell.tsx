import { useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupOverlay } from '@/modules/locations/LocationLookupOverlay'
import { InventoryOverlay } from '@/components/inventory/InventoryOverlay'
import type { PanelMode } from '@/components/shared/FloatingPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const LOOKUP_MODE_KEY = 'locationLookup.mode'
const LOOKUP_WIDTH_KEY = 'locationLookup.width'
const INV_MODE_KEY = 'inventory.mode'
const INV_WIDTH_KEY = 'inventory.width'

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 480px)')
  const [lookupMode, setLookupMode] = useState<PanelMode>(() => (localStorage.getItem(LOOKUP_MODE_KEY) as PanelMode) || 'hidden')
  const [lookupWidth, setLookupWidth] = useState(() => Number(localStorage.getItem(LOOKUP_WIDTH_KEY)) || 420)
  const [invMode, setInvMode] = useState<PanelMode>(() => (localStorage.getItem(INV_MODE_KEY) as PanelMode) || 'hidden')
  const [invWidth, setInvWidth] = useState(() => Number(localStorage.getItem(INV_WIDTH_KEY)) || 460)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const lastLookup = useRef<Exclude<PanelMode, 'hidden'>>(lookupMode === 'docked' ? 'docked' : 'floating')
  const lastInv = useRef<Exclude<PanelMode, 'hidden'>>(invMode === 'docked' ? 'docked' : 'floating')
  const location = useLocation()

  // Only one panel can dock at a time (they'd overlap on the right) — docking one
  // bumps the other from docked to floating.
  function setLookupModeP(m: PanelMode) {
    setLookupMode(m); localStorage.setItem(LOOKUP_MODE_KEY, m)
    if (m !== 'hidden') lastLookup.current = m
    if (m === 'docked' && invMode === 'docked') { setInvMode('floating'); localStorage.setItem(INV_MODE_KEY, 'floating') }
  }
  function setInvModeP(m: PanelMode) {
    setInvMode(m); localStorage.setItem(INV_MODE_KEY, m)
    if (m !== 'hidden') lastInv.current = m
    if (m === 'docked' && lookupMode === 'docked') { setLookupMode('floating'); localStorage.setItem(LOOKUP_MODE_KEY, 'floating') }
  }
  function setLookupWidthP(w: number) { setLookupWidth(w); localStorage.setItem(LOOKUP_WIDTH_KEY, String(w)) }
  function setInvWidthP(w: number) { setInvWidth(w); localStorage.setItem(INV_WIDTH_KEY, String(w)) }

  // Push content for whichever panel is docked.
  const pushWidth = !mobile
    ? (lookupMode === 'docked' ? lookupWidth : invMode === 'docked' ? invWidth : 0)
    : 0

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117] font-mono">
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((v) => !v)} />

      <div className="flex flex-col flex-1 min-w-0 transition-[margin] duration-150" style={{ marginRight: pushWidth || undefined }}>
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <LocationLookupOverlay
        mode={lookupMode} width={lookupWidth} mobile={mobile}
        onModeChange={setLookupModeP} onToggle={() => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')} onWidthChange={setLookupWidthP}
      />
      <InventoryOverlay
        mode={invMode} width={invWidth} mobile={mobile}
        onModeChange={setInvModeP} onToggle={() => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')} onWidthChange={setInvWidthP}
      />
    </div>
  )
}
