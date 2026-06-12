import { useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupPanel } from '@/modules/locations/LocationLookupPanel'

export function AppShell() {
  const [locationPanelOpen, setLocationPanelOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const location = useLocation()

  return (
    <div className="flex h-screen overflow-hidden bg-[#0f1117] font-mono">
      <Sidebar
        locationPanelOpen={locationPanelOpen}
        onToggleLocationPanel={() => setLocationPanelOpen((v) => !v)}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />

      <div className="flex flex-col flex-1 min-w-0">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {locationPanelOpen && (
        <LocationLookupPanel onClose={() => setLocationPanelOpen(false)} />
      )}
    </div>
  )
}
