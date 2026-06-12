import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupPanel, PIN_KEY } from '@/modules/locations/LocationLookupPanel'

export function AppShell() {
  // Pinned lookup stays open across reloads.
  const [pinned, setPinned] = useState(() => localStorage.getItem(PIN_KEY) === '1')
  const [locationPanelOpen, setLocationPanelOpen] = useState(pinned)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const location = useLocation()

  function togglePin() {
    setPinned((p) => {
      const next = !p
      localStorage.setItem(PIN_KEY, next ? '1' : '0')
      if (next) setLocationPanelOpen(true)
      return next
    })
  }

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117] font-mono">
      <Sidebar
        locationPanelOpen={locationPanelOpen}
        onToggleLocationPanel={() => setLocationPanelOpen((v) => !v)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />

      <div className={['flex flex-col flex-1 min-w-0', locationPanelOpen ? 'mr-[480px]' : ''].join(' ')}>
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {locationPanelOpen && (
        <LocationLookupPanel
          onClose={() => setLocationPanelOpen(false)}
          pinned={pinned}
          onTogglePin={togglePin}
        />
      )}
    </div>
  )
}
