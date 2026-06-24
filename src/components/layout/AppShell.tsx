import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
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
  const mobile = useMediaQuery('(max-width: 640px)')
  const navigate = useNavigate()
  const [lookupMode, setLookupMode] = useState<PanelMode>(() => (localStorage.getItem(LOOKUP_MODE_KEY) as PanelMode) || 'hidden')
  const [lookupWidth, setLookupWidth] = useState(() => Number(localStorage.getItem(LOOKUP_WIDTH_KEY)) || 420)
  const [invMode, setInvMode] = useState<PanelMode>(() => (localStorage.getItem(INV_MODE_KEY) as PanelMode) || 'hidden')
  const [invWidth, setInvWidth] = useState(() => Number(localStorage.getItem(INV_WIDTH_KEY)) || 460)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const lastLookup = useRef<Exclude<PanelMode, 'hidden'>>(lookupMode === 'docked' ? 'docked' : 'floating')
  const lastInv = useRef<Exclude<PanelMode, 'hidden'>>(invMode === 'docked' ? 'docked' : 'floating')
  const location = useLocation()

  // Close mobile nav on every route change
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

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

  const pushWidth = !mobile
    ? (lookupMode === 'docked' ? lookupWidth : invMode === 'docked' ? invWidth : 0)
    : 0

  return (
    <div className="flex h-screen overflow-hidden bg-cream font-body">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        mobile={mobile}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <div className="flex flex-col flex-1 min-w-0 relative transition-[margin] duration-150" style={{ marginRight: pushWidth || undefined }}>
        <TopBar mobile={mobile} onMobileMenuOpen={() => setMobileNavOpen((v) => !v)} />
        <main className="flex-1 overflow-auto p-3 sm:p-6">
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
        {/* Invisible structural spacer — reserves the same height as the floating
            button row so <main> (flex-1) physically ends above it.
            No background, no border; purely a layout constraint. */}
        <div className="flex-shrink-0 h-16" />
      </div>

      {/* Floating action buttons — bottom-left, anchored next to sidebar */}
      <div
        className="fixed bottom-4 z-[60] flex items-center gap-2 transition-[left] duration-200"
        style={{ left: mobile ? '1rem' : sidebarCollapsed ? '4.25rem' : '16.75rem' }}
      >
        <button
          onClick={() => navigate('/meetings?quick=1')}
          className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
          title="Quick Meeting — opens notes with date + time pre-filled"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          {!mobile && 'Meeting'}
        </button>
        <button
          onClick={() => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')}
          className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
          title="Location Lookup (Ctrl/Cmd+L)"
        >
          {lookupMode !== 'hidden' && <span className="text-[10px] text-sky">●</span>}
          {!mobile && 'Lookup'}
          {mobile && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>}
        </button>
        <button
          onClick={() => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')}
          className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
          title="Inventory — all locations (Ctrl/Cmd+I)"
        >
          {invMode !== 'hidden' && <span className="text-[10px] text-sky">●</span>}
          {!mobile && 'Inventory'}
          {mobile && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 10V7" /></svg>}
        </button>
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
