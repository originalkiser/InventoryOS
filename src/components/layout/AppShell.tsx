import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { CheckCircle2, MapPin, MessageSquare, Package, ChevronUp, ChevronDown } from 'lucide-react'
import { Sidebar, SECTION_ITEMS } from './Sidebar'
import { TopBar } from './TopBar'
import { InventoryNavBar } from '@/components/inventory/InventoryNavBar'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { LocationLookupOverlay } from '@/modules/locations/LocationLookupOverlay'
import { InventoryOverlay } from '@/components/inventory/InventoryOverlay'
import { MeetingOverlay } from '@/modules/meetings/MeetingOverlay'
import type { PanelMode } from '@/components/shared/FloatingPanel'
import { useMediaQuery } from '@/hooks/useMediaQuery'

const LOOKUP_MODE_KEY = 'locationLookup.mode'
const LOOKUP_WIDTH_KEY = 'locationLookup.width'
const INV_MODE_KEY = 'inventory.mode'
const INV_WIDTH_KEY = 'inventory.width'
const TASKS_MODE_KEY = 'tasks.mode'
const TASKS_WIDTH_KEY = 'todaysTasks.width'
const MEETING_MODE_KEY = 'quickMeeting.mode'
const MEETING_WIDTH_KEY = 'quickMeeting.width'

export function AppShell() {
  const mobile = useMediaQuery('(max-width: 640px)')
  const [lookupMode, setLookupMode] = useState<PanelMode>(() => (localStorage.getItem(LOOKUP_MODE_KEY) as PanelMode) || 'hidden')
  const [lookupWidth, setLookupWidth] = useState(() => Number(localStorage.getItem(LOOKUP_WIDTH_KEY)) || 420)
  const [invMode, setInvMode] = useState<PanelMode>(() => (localStorage.getItem(INV_MODE_KEY) as PanelMode) || 'hidden')
  const [invWidth, setInvWidth] = useState(() => Number(localStorage.getItem(INV_WIDTH_KEY)) || 460)
  const [tasksMode, setTasksMode] = useState<PanelMode>(() => (localStorage.getItem(TASKS_MODE_KEY) as PanelMode) || 'hidden')
  const [tasksWidth, setTasksWidth] = useState(() => Number(localStorage.getItem(TASKS_WIDTH_KEY)) || 360)
  const [meetingMode, setMeetingMode] = useState<PanelMode>(() => (localStorage.getItem(MEETING_MODE_KEY) as PanelMode) || 'hidden')
  const [meetingWidth, setMeetingWidth] = useState(() => Number(localStorage.getItem(MEETING_WIDTH_KEY)) || 460)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [fabCollapsed, setFabCollapsedP] = useProfilePref<boolean>('quickfab:collapsed', false)
  const [topBarHeight, setTopBarHeight] = useState(48)
  const topBarRef = useRef<HTMLDivElement>(null)
  const lastLookup = useRef<Exclude<PanelMode, 'hidden'>>(lookupMode === 'docked' ? 'docked' : 'floating')
  const lastInv = useRef<Exclude<PanelMode, 'hidden'>>(invMode === 'docked' ? 'docked' : 'floating')
  const lastTasks = useRef<Exclude<PanelMode, 'hidden'>>(tasksMode === 'docked' ? 'docked' : 'floating')
  const lastMeeting = useRef<Exclude<PanelMode, 'hidden'>>(meetingMode === 'docked' ? 'docked' : 'floating')
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
      else if (action === 'meeting') setMeetingModeP(meetingMode === 'hidden' ? lastMeeting.current : 'hidden')
      else if (action === 'lookup') setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden')
      else if (action === 'inventory') setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden')
    }
    window.addEventListener('sb-quick-access', handler as EventListener)
    return () => window.removeEventListener('sb-quick-access', handler as EventListener)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookupMode, invMode, meetingMode])

  // Only one panel can be docked at a time (they share the right-edge push).
  function undockOthers(except: 'lookup' | 'inv' | 'tasks' | 'meeting') {
    if (except !== 'lookup' && lookupMode === 'docked') { setLookupMode('floating'); localStorage.setItem(LOOKUP_MODE_KEY, 'floating') }
    if (except !== 'inv' && invMode === 'docked') { setInvMode('floating'); localStorage.setItem(INV_MODE_KEY, 'floating') }
    if (except !== 'tasks' && tasksMode === 'docked') { setTasksMode('floating'); localStorage.setItem(TASKS_MODE_KEY, 'floating') }
    if (except !== 'meeting' && meetingMode === 'docked') { setMeetingMode('floating'); localStorage.setItem(MEETING_MODE_KEY, 'floating') }
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
  function setMeetingModeP(m: PanelMode) {
    setMeetingMode(m); localStorage.setItem(MEETING_MODE_KEY, m)
    if (m !== 'hidden') lastMeeting.current = m
    if (m === 'docked') undockOthers('meeting')
  }
  function setMeetingWidthP(w: number) { setMeetingWidth(w); localStorage.setItem(MEETING_WIDTH_KEY, String(w)) }
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
    ? (lookupMode === 'docked' ? lookupWidth : invMode === 'docked' ? invWidth : tasksMode === 'docked' ? tasksWidth : meetingMode === 'docked' ? meetingWidth : 0)
    : 0
  // w-14 collapsed (56px), w-64 expanded (256px)
  const sidebarWidth = mobile ? 0 : sidebarCollapsed ? 56 : 256

  // Show the inventory quick-nav bar on inventory-section routes — except the
  // Dashboard, which has its own large shortcut buttons.
  const isInventoryRoute = location.pathname !== '/dashboard' &&
    SECTION_ITEMS.inventory.some((i) => i.to && (location.pathname === i.to || location.pathname.startsWith(`${i.to}/`)))

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
          {isInventoryRoute && <InventoryNavBar />}
          <main className="p-3 sm:p-6">
            <ErrorBoundary key={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
          {/* Spacer so scrolled-to-bottom content clears the FAB row */}
          <div className="h-16" />
        </div>
      </div>

      {/* Quick-access FABs — always available on desktop now that the in-sidebar
          grid is gone. Bottom-right stack, labels on hover; a button hides while
          its panel is open; collapses to a nub. */}
      {!mobile && (
        <div className="fixed bottom-4 z-30 flex flex-col items-end gap-2" style={{ right: (pushWidth || 0) + 16 }}>
          {!fabCollapsed && [
            { t: "Today's Tasks", icon: <CheckCircle2 className="w-5 h-5" />, open: tasksMode !== 'hidden', on: toggleTasks },
            { t: 'Location Lookup', icon: <MapPin className="w-5 h-5" />, open: lookupMode !== 'hidden', on: () => setLookupModeP(lookupMode === 'hidden' ? lastLookup.current : 'hidden') },
            { t: 'Quick Meeting', icon: <MessageSquare className="w-5 h-5" />, open: meetingMode !== 'hidden', on: () => setMeetingModeP(meetingMode === 'hidden' ? lastMeeting.current : 'hidden') },
            { t: 'Inventory', icon: <Package className="w-5 h-5" />, open: invMode !== 'hidden', on: () => setInvModeP(invMode === 'hidden' ? lastInv.current : 'hidden') },
          ].filter((f) => !f.open).map((f) => <QuickFab key={f.t} title={f.t} onClick={f.on}>{f.icon}</QuickFab>)}
          <button onClick={() => setFabCollapsedP(!fabCollapsed)} title={fabCollapsed ? 'Show quick access' : 'Hide quick access'} aria-label={fabCollapsed ? 'Show quick access' : 'Hide quick access'}
            className="flex items-center justify-center w-10 h-6 rounded-full bg-navy/80 text-cream shadow-lg hover:bg-navy transition-colors">
            {fabCollapsed ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
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
      <MeetingOverlay
        mode={meetingMode} width={meetingWidth} mobile={mobile} topOffset={topBarHeight} sidebarWidth={sidebarWidth}
        onModeChange={setMeetingModeP} onWidthChange={setMeetingWidthP}
      />
    </div>
  )
}

function QuickFab({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} title={title} aria-label={title}
      className="group flex items-center h-10 rounded-full bg-navy text-cream shadow-lg px-2.5 hover:bg-navy/90 transition-colors animate-[fabRise_200ms_ease-out]">
      {children}
      <span className="max-w-0 group-hover:max-w-[160px] overflow-hidden whitespace-nowrap text-xs font-heading transition-[max-width,margin] duration-200 group-hover:ml-2">{title}</span>
    </button>
  )
}
