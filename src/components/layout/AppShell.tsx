import { useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupOverlay, type LookupMode } from '@/modules/locations/LocationLookupOverlay'
import { InventoryLeftPanel } from '@/components/inventory/InventoryLeftPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const MODE_KEY = 'locationLookup.mode'
const WIDTH_KEY = 'locationLookup.width'

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 480px)')
  const [mode, setMode] = useState<LookupMode>(() => (localStorage.getItem(MODE_KEY) as LookupMode) || 'hidden')
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 420)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  // Remember which open mode to restore when the trigger re-opens it.
  const lastOpen = useRef<Exclude<LookupMode, 'hidden'>>(mode === 'docked' ? 'docked' : 'floating')
  const location = useLocation()

  function setModeP(m: LookupMode) {
    setMode(m); localStorage.setItem(MODE_KEY, m)
    if (m !== 'hidden') lastOpen.current = m
  }
  function toggle() { setModeP(mode === 'hidden' ? lastOpen.current : 'hidden') }
  function setWidthP(w: number) { setWidth(w); localStorage.setItem(WIDTH_KEY, String(w)) }

  // Only the docked mode pushes content; float hovers on top.
  const push = mode === 'docked' && !mobile

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117] font-mono">
      <Sidebar collapsed={sidebarCollapsed} onToggleCollapsed={() => setSidebarCollapsed((v) => !v)} />

      <div className="flex flex-col flex-1 min-w-0 transition-[margin] duration-150" style={{ marginRight: push ? width : undefined }}>
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <LocationLookupOverlay
        mode={mode} width={width} mobile={mobile}
        onModeChange={setModeP} onToggle={toggle} onWidthChange={setWidthP}
      />
      <InventoryLeftPanel />
    </div>
  )
}
