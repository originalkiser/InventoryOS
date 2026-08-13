import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupOverlay } from '@/modules/locations/LocationLookupOverlay'
import { InventoryOverlay } from '@/components/inventory/InventoryOverlay'
import { MeetingModal } from '@/modules/meetings/MeetingModal'
import type { PanelMode } from '@/components/shared/FloatingPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const LOOKUP_MODE_KEY = 'locationLookup.mode'
const LOOKUP_WIDTH_KEY = 'locationLookup.width'
const INV_MODE_KEY = 'inventory.mode'
const INV_WIDTH_KEY = 'inventory.width'
const TASKS_MODE_KEY = 'tasks.mode'
const TASKS_WIDTH_KEY = 'todaysTasks.width'

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 640px)')
  const [lookupMode, setLookupMode] = useState<PanelMode>(() => (localStorage.getItem(LOOKUP_MODE_KEY) as PanelMode) || 'hidden')
  const [lookupWidth, setLookupWidth] = useState(() => Number(localStorage.getItem(LOOKUP_WIDTH_KEY)) || 420)
  const [invMode, setInvMode] = useState<PanelMode>(() => (localStorage.getItem(INV_MODE_KEY) as PanelMode) || 'hidden')
  const [invWidth, setInvWidth] = useState(() => Number(localStorage.getItem(INV_WIDTH_KEY)) || 460)
  const [tasksMode, setTasksMode] = useState<PanelMode>(() => (localStorage.getItem(TASKS_MODE_KEY) as PanelMode) || 'hidden')
  const [tasksWidth, setTasksWidth] = useState(() => Number(localStorage.getItem(TASKS_WIDTH_KEY)) || 360)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [quickMeetingOpen, setQuickMeetingOpen] = useState(false)
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

  // Sidebar Quick Access grid triggers the overlay/nav actions.
  useEffect(() => {
    const handler = (e: Event) => {
      const action = (e as CustomEvent).detail as string
      if (action === 'tasks') toggleTasks()
      else if (action === 'meeting') setQuickMeetingOpen(true)
      else if (action === 'lookup') setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')
      else if (action === 'inventory') setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')
    }
    window.addEventListener('sb-quick-access', handler as EventListener)
    return () => window.removeEventListener('sb-quick-access', handler as EventListener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupMode, invMode])

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

      <LocationLookupOverlay
        mode={lookupMode} width={lookupWidth} mobile={mobile} topOffset={topBarHeight} sidebarWidth={sidebarWidth}
        onModeChange={setLookupModeP} onToggle={() => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')} onWidthChange={setLookupWidthP}
      />
      <InventoryOverlay
        mode={invMode} width={invWidth} mobile={mobile} topOffset={topBarHeight} sidebarWidth={sidebarWidth}
        onModeChange={setInvModeP} onToggle={() => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')} onWidthChange={setInvWidthP}
      />
      <MeetingModal open={quickMeetingOpen} quick onClose={() => setQuickMeetingOpen(false)} />
    </div>
  )
}
