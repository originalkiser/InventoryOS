import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
const TASKS_MODE_KEY = 'tasks.mode'
const TASKS_WIDTH_KEY = 'todaysTasks.width'

const FAB_KEYS = { meeting: 'sb:fab:meeting', lookup: 'sb:fab:lookup', inventory: 'sb:fab:inventory', tasks: 'sb:fab:tasks' }
function readFabPrefs() {
  return {
    meeting:   localStorage.getItem(FAB_KEYS.meeting)   !== 'false',
    lookup:    localStorage.getItem(FAB_KEYS.lookup)    !== 'false',
    inventory: localStorage.getItem(FAB_KEYS.inventory) !== 'false',
    tasks:     localStorage.getItem(FAB_KEYS.tasks)     !== 'false',
  }
}

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 640px)')
  const navigate = useNavigate()
  const [lookupMode, setLookupMode] = useState<PanelMode>(() => (localStorage.getItem(LOOKUP_MODE_KEY) as PanelMode) || 'hidden')
  const [lookupWidth, setLookupWidth] = useState(() => Number(localStorage.getItem(LOOKUP_WIDTH_KEY)) || 420)
  const [invMode, setInvMode] = useState<PanelMode>(() => (localStorage.getItem(INV_MODE_KEY) as PanelMode) || 'hidden')
  const [invWidth, setInvWidth] = useState(() => Number(localStorage.getItem(INV_WIDTH_KEY)) || 460)
  const [tasksMode, setTasksMode] = useState<PanelMode>(() => (localStorage.getItem(TASKS_MODE_KEY) as PanelMode) || 'hidden')
  const [tasksWidth, setTasksWidth] = useState(() => Number(localStorage.getItem(TASKS_WIDTH_KEY)) || 360)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [fabPrefs, setFabPrefs] = useState(readFabPrefs)
  const [topBarHeight, setTopBarHeight] = useState(48)
  const topBarRef = useRef<HTMLDivElement>(null)
  const lastLookup = useRef<Exclude<PanelMode, 'hidden'>>(lookupMode === 'docked' ? 'docked' : 'floating')
  const lastInv = useRef<Exclude<PanelMode, 'hidden'>>(invMode === 'docked' ? 'docked' : 'floating')
  const lastTasks = useRef<Exclude<PanelMode, 'hidden'>>(tasksMode === 'docked' ? 'docked' : 'floating')
  const location = useLocation()

  // Measure TopBar height so panels can stay below it even when it wraps
  useLayoutEffect(() => {
    const el = topBarRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTopBarHeight(el.offsetHeight))
    ro.observe(el)
    setTopBarHeight(el.offsetHeight)
    return () => ro.disconnect()
  }, [])

  // Close mobile nav on every route change
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  // Re-read FAB prefs when ProfilePanel writes them
  useEffect(() => {
    const handler = () => setFabPrefs(readFabPrefs())
    window.addEventListener('fab-prefs-changed', handler)
    return () => window.removeEventListener('fab-prefs-changed', handler)
  }, [])

  // Only one panel can be docked at a time (they share the right-edge push).
  function undockOthers(except: 'lookup' | 'inv' | 'tasks') {
    if (except !== 'lookup' && lookupMode === 'docked') { setLookupMode('floating'); localStorage.setItem(LOOKUP_MODE_KEY, 'floating') }
    if (except !== 'inv' && invMode === 'docked') { setInvMode('floating'); localStorage.setItem(INV_MODE_KEY, 'floating') }
    if (except !== 'tasks' && tasksMode === 'docked') { setTasksMode('floating'); localStorage.setItem(TASKS_MODE_KEY, 'floating') }
  }
  function setLookupModeP(m: PanelMode) {
    setLookupMode(m); localStorage.setItem(LOOKUP_MODE_KEY, m)
    if (m !== 'hidden') lastLookup.current = m
    if (m === 'docked') undockOthers('lookup')
  }
  function setInvModeP(m: PanelMode) {
    setInvMode(m); localStorage.setItem(INV_MODE_KEY, m)
    if (m !== 'hidden') lastInv.current = m
    if (m === 'docked') undockOthers('inv')
  }
  function setTasksModeP(m: PanelMode) {
    setTasksMode(m); localStorage.setItem(TASKS_MODE_KEY, m)
    if (m !== 'hidden') lastTasks.current = m
    if (m === 'docked') undockOthers('tasks')
  }
  function toggleTasks() {
    setTasksMode((cur) => {
      const next: PanelMode = cur === 'hidden' ? lastTasks.current : 'hidden'
      localStorage.setItem(TASKS_MODE_KEY, next)
      return next
    })
  }
  function openTasks() {
    setTasksMode((cur) => {
      if (cur !== 'hidden') return cur
      localStorage.setItem(TASKS_MODE_KEY, lastTasks.current)
      return lastTasks.current
    })
  }
  function setLookupWidthP(w: number) { setLookupWidth(w); localStorage.setItem(LOOKUP_WIDTH_KEY, String(w)) }
  function setInvWidthP(w: number) { setInvWidth(w); localStorage.setItem(INV_WIDTH_KEY, String(w)) }
  function setTasksWidthP(w: number) { setTasksWidth(w); localStorage.setItem(TASKS_WIDTH_KEY, String(w)) }

  const pushWidth = !mobile
    ? (lookupMode === 'docked' ? lookupWidth : invMode === 'docked' ? invWidth : tasksMode === 'docked' ? tasksWidth : 0)
    : 0
  // w-14 collapsed (56px), w-64 expanded (256px)
  const sidebarWidth = mobile ? 0 : sidebarCollapsed ? 56 : 256

  return (
    <div className="flex h-screen overflow-hidden bg-cream font-body">
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
        mobile={mobile}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />

      <div className="flex flex-col flex-1 min-w-0 relative">
        <div ref={topBarRef}>
          <TopBar
            mobile={mobile}
            onMobileMenuOpen={() => setMobileNavOpen((v) => !v)}
            tasksMode={tasksMode}
            tasksWidth={tasksWidth}
            tasksTopOffset={topBarHeight}
            tasksSidebarWidth={sidebarWidth}
            onTasksModeChange={setTasksModeP}
            onTasksWidthChange={setTasksWidthP}
            onToggleTasks={toggleTasks}
            onOpenTasks={openTasks}
          />
        </div>
        {/* Only the scrollable content area shifts right for docked panels —
            TopBar always spans full width above the panel. */}
        <div
          className="flex-1 overflow-auto app-scroll transition-[margin] duration-150"
          style={{ marginRight: pushWidth || undefined }}
        >
          <main className="p-3 sm:p-6">
            <ErrorBoundary key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
          {/* Spacer so scrolled-to-bottom content clears the FAB row */}
          <div className="h-16" />
        </div>
      </div>

      {/* Floating action buttons — bottom-left, anchored next to sidebar, always above map/content */}
      {(fabPrefs.meeting || fabPrefs.lookup || fabPrefs.inventory || fabPrefs.tasks) && (
        <div
          className="fixed bottom-4 z-[1000] flex items-center gap-2 transition-[left] duration-200"
          style={{ left: mobile ? '1rem' : sidebarCollapsed ? '4.25rem' : '16.75rem' }}
        >
          {fabPrefs.tasks && (
            <button
              onClick={toggleTasks}
              className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
              title="Tasks"
            >
              {tasksMode !== 'hidden' && <span className="inline-block w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_3px_rgba(74,222,128,0.7)]" />}
              {!mobile && 'Tasks'}
              {mobile && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" /></svg>}
            </button>
          )}
          {fabPrefs.meeting && (
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
          )}
          {fabPrefs.lookup && (
            <button
              onClick={() => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')}
              className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
              title="Location Lookup (Ctrl/Cmd+L)"
            >
              {lookupMode !== 'hidden' && <span className="inline-block w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_3px_rgba(74,222,128,0.7)]" />}
              {!mobile && 'Lookup'}
              {mobile && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>}
            </button>
          )}
          {fabPrefs.inventory && (
            <button
              onClick={() => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')}
              className="flex items-center gap-1.5 rounded-full border border-navy/40 bg-navy px-3 py-2 font-heading text-xs text-cream shadow-lg hover:bg-inky uppercase tracking-wide"
              title="Inventory — all locations (Ctrl/Cmd+I)"
            >
              {invMode !== 'hidden' && <span className="inline-block w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_3px_rgba(74,222,128,0.7)]" />}
              {!mobile && 'Inventory'}
              {mobile && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 10V7" /></svg>}
            </button>
          )}
        </div>
      )}

      <LocationLookupOverlay
        mode={lookupMode} width={lookupWidth} mobile={mobile} topOffset={topBarHeight} sidebarWidth={sidebarWidth}
        onModeChange={setLookupModeP} onToggle={() => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')} onWidthChange={setLookupWidthP}
      />
      <InventoryOverlay
        mode={invMode} width={invWidth} mobile={mobile} topOffset={topBarHeight} sidebarWidth={sidebarWidth}
        onModeChange={setInvModeP} onToggle={() => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')} onWidthChange={setInvWidthP}
      />
    </div>
  )
}
