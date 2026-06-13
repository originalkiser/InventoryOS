import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupOverlay } from '@/modules/locations/LocationLookupOverlay'
import { InventoryLeftPanel } from '@/components/inventory/InventoryLeftPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const OPEN_KEY = 'locationLookup.open'
const PIN_KEY = 'locationLookup.pinned'
const WIDTH_KEY = 'locationLookup.width'

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 480px)')
  const [pinned, setPinned] = useState(() => localStorage.getItem(PIN_KEY) === '1')
  const [open, setOpen] = useState(() => pinned || localStorage.getItem(OPEN_KEY) === '1')
  const [width, setWidth] = useState(() => Number(localStorage.getItem(WIDTH_KEY)) || 420)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const location = useLocation()

  function setOpenP(o: boolean) { setOpen(o); localStorage.setItem(OPEN_KEY, o ? '1' : '0') }
  function setPinnedP(p: boolean) {
    setPinned(p); localStorage.setItem(PIN_KEY, p ? '1' : '0')
    if (p) setOpenP(true)
  }
  function setWidthP(w: number) { setWidth(w); localStorage.setItem(WIDTH_KEY, String(w)) }

  // Pinned (non-mobile) pushes the content left by the panel width.
  const push = pinned && open && !mobile

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
        open={open} pinned={pinned} width={width} mobile={mobile}
        onOpenChange={setOpenP} onPinnedChange={setPinnedP} onWidthChange={setWidthP}
      />
      <InventoryLeftPanel />
    </div>
  )
}
