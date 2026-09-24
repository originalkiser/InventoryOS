import { useState, useEffect, useRef, useMemo, useContext, createContext } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'
import { useInventoryAlerts } from '@/hooks/useInventoryAlerts'
import { useNavBadge } from '@/hooks/useNavBadges'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useSidebarPrefs } from '@/hooks/useSidebarPrefs'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useDeptAccess } from '@/hooks/useDeptAccess'
import { isAdminOrDeveloper } from '@/lib/roles'
import sbLogo from '@/assets/logo-cream.png'
import sbIcon from '@/assets/SBOC-IconCream.png'
import droptopLogo from '@/assets/droptop-logo.png'
import {
  Package, Settings, Building2, DollarSign, TrendingUp, Megaphone,
  LayoutDashboard, BarChart2, CalendarDays, ClipboardList, FolderKanban,
  Database, Users, AlertTriangle, MessageSquare, Lightbulb,
  CheckCircle2, FileText, MapPin, GripVertical, ChevronRight,
  ChevronsLeft, ChevronsRight, Pin, Car, SlidersHorizontal,
} from 'lucide-react'
import { BiRuler, BiSpreadsheet, BiAbacus, BiCommentError, BiUserVoice } from 'react-icons/bi'
import { GrDatabase, GrMap } from 'react-icons/gr'

// ── Icons ──────────────────────────────────────────────────────────────────

export const ICONS: Record<string, JSX.Element> = {
  dashboard: <LayoutDashboard className="w-4 h-4 flex-shrink-0" />,
  'on-hand': <Package className="w-4 h-4 flex-shrink-0" />,
  monthend: <BiAbacus className="w-4 h-4 flex-shrink-0" />,
  weekly: <CalendarDays className="w-4 h-4 flex-shrink-0" />,
  orders: <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'orders-v2': <BiSpreadsheet className="w-4 h-4 flex-shrink-0" />,
  config: <Settings className="w-4 h-4 flex-shrink-0" />,
  'global-config': <Database className="w-4 h-4 flex-shrink-0" />,
  outlier: <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  'outlier-am': <Users className="w-4 h-4 flex-shrink-0" />,
  'outlier-leadership': <TrendingUp className="w-4 h-4 flex-shrink-0" />,
  projects: <FolderKanban className="w-4 h-4 flex-shrink-0" />,
  calendar: <CalendarDays className="w-4 h-4 flex-shrink-0" />,
  issues: <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  meetings: <MessageSquare className="w-4 h-4 flex-shrink-0" />,
  'feature-requests': <Lightbulb className="w-4 h-4 flex-shrink-0" />,
  tasks: <CheckCircle2 className="w-4 h-4 flex-shrink-0" />,
  forms: <FileText className="w-4 h-4 flex-shrink-0" />,
  users: <Users className="w-4 h-4 flex-shrink-0" />,
  locations: <MapPin className="w-4 h-4 flex-shrink-0" />,
  'location-lookup': <MapPin className="w-4 h-4 flex-shrink-0" />,
  'custom-shop-config': <SlidersHorizontal className="w-4 h-4 flex-shrink-0" />,
  'am-rd-lookup': <BiUserVoice className="w-4 h-4 flex-shrink-0" />,
  'tank-monitors': <BiRuler className="w-4 h-4 flex-shrink-0" />,
  'procurement-deck': <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  'inventory-alerts': <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  'exception-reporting': <BiCommentError className="w-4 h-4 flex-shrink-0" />,
  'location-comms': <MessageSquare className="w-4 h-4 flex-shrink-0" />,
  'marketing-planner': <Megaphone className="w-4 h-4 flex-shrink-0" />,
  'customer-heatmap': <GrMap className="w-4 h-4 flex-shrink-0" />,
  'droptop-orders': <FileText className="w-4 h-4 flex-shrink-0" />,
  'droptop-vehicles': <Car className="w-4 h-4 flex-shrink-0" />,
  'droptop-packages': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'package-mapping': <ClipboardList className="w-4 h-4 flex-shrink-0" />,
  'product-sales-history': <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  'staffing-report': <Users className="w-4 h-4 flex-shrink-0" />,
  'data-connections': <GrDatabase className="w-4 h-4 flex-shrink-0" />,
  drag: <GripVertical className="w-3 h-3 flex-shrink-0 text-[#F2F1E6]/25" />,
}

const SECTION_ICONS: Record<string, JSX.Element> = {
  inventory: <Package className="w-3.5 h-3.5 flex-shrink-0 text-sky" />,
  droptop: <img src={droptopLogo} alt="" className="w-3.5 h-3.5 flex-shrink-0 object-contain" />,
  'data-connections': <GrDatabase className="w-3.5 h-3.5 flex-shrink-0 text-sky" />,
  'global-config': <Settings className="w-3.5 h-3.5 flex-shrink-0 text-[#F2F1E6]/70" />,
  operations: <Building2 className="w-3.5 h-3.5 flex-shrink-0 text-[#E67E22]" />,
  finance: <DollarSign className="w-3.5 h-3.5 flex-shrink-0 text-[#2ECC71]" />,
  accounting: <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 text-inky" />,
  marketing: <Megaphone className="w-3.5 h-3.5 flex-shrink-0 text-[#C0392B]" />,
}

// Subtle per-section tint + colored left accent so the section headers stand
// apart from each other on the dark sidebar (brand tokens only). Droptop
// reuses accounting's inky accent — every distinct brand/exception color is
// already spoken for by the other 6 sections, and inky is the only one not
// directly adjacent to Droptop's position (between Inventory and
// Global Config/Operations), so it's the least confusing reuse.
const SECTION_ACCENT: Record<string, string> = {
  inventory: 'bg-sky/15 border-l-2 border-sky',
  droptop: 'bg-inky/25 border-l-2 border-inky',
  // Reuses Inventory's sky accent (this section was split out of Inventory
  // Config, and every other brand color is already spoken for) rather than
  // sitting inky-on-inky next to Droptop above it.
  'data-connections': 'bg-sky/15 border-l-2 border-sky',
  'global-config': 'bg-[#F2F1E6]/[0.08] border-l-2 border-[#F2F1E6]/40',
  operations: 'bg-[#E67E22]/15 border-l-2 border-[#E67E22]',
  finance: 'bg-[#2ECC71]/15 border-l-2 border-[#2ECC71]',
  accounting: 'bg-inky/25 border-l-2 border-inky',
  marketing: 'bg-[#C0392B]/15 border-l-2 border-[#C0392B]',
}

// ── Nav data ───────────────────────────────────────────────────────────────

export interface NavItem {
  key: string
  label: string
  to: string | null
}

export const SECTION_ITEMS: Record<string, NavItem[]> = {
  inventory: [
    { key: 'dashboard', label: 'Dashboard', to: '/dashboard' },
    { key: 'on-hand', label: 'On Hand', to: '/on-hand' },
    { key: 'monthend', label: 'Month End Count', to: '/monthend' },
    { key: 'weekly', label: 'Weekly Count', to: '/weekly' },
    { key: 'orders', label: 'Orders', to: '/orders' },
    { key: 'orders-v2', label: 'Orders v2', to: '/orders-v2' },
    { key: 'po-status', label: 'PO Status', to: '/po-status' },
    { key: 'projects', label: 'Projects', to: '/projects' },
    { key: 'config', label: 'Inventory Config', to: '/config' },
    { key: 'location-lookup', label: 'Location Lookup', to: '/location-lookup' },
    { key: 'custom-shop-config', label: 'Custom Shop Config', to: '/custom-shop-config' },
    { key: 'am-rd-lookup', label: 'AM/RD Lookup', to: '/am-rd-lookup' },
    { key: 'tank-monitors', label: 'Tank Monitors', to: '/tank-monitors' },
    { key: 'procurement-deck', label: 'Procurement Deck', to: '/procurement-deck' },
    { key: 'inventory-alerts', label: 'Inventory Alerts', to: '/inventory-alerts' },
    { key: 'exception-reporting', label: 'Exception Reporting', to: '/exception-reporting' },
    { key: 'location-comms', label: 'Location Comms', to: '/location-comms' },
  ],
  droptop: [
    { key: 'customer-heatmap', label: 'Customer Heatmap', to: '/customer-heatmap' },
    { key: 'droptop-orders', label: 'Droptop Orders', to: '/droptop-orders' },
    { key: 'droptop-vehicles', label: 'Vehicles', to: '/droptop-vehicles' },
    { key: 'droptop-packages', label: 'Packages', to: '/droptop-packages' },
    { key: 'package-mapping', label: 'Package Mapping', to: '/package-mapping' },
    { key: 'product-sales-history', label: 'Product Sales History', to: '/product-sales-history' },
    { key: 'staffing-report', label: 'Staffing Report', to: '/staffing-report' },
  ],
  'data-connections': [
    { key: 'data-connections', label: 'Data Connections', to: '/data-connections' },
  ],
  'global-config': [
    { key: 'global-config', label: 'Global Config', to: '/global-config' },
  ],
  operations: [
    { key: 'outlier', label: 'Outlier Reporting', to: '/operations/outlier' },
    { key: 'outlier-am', label: 'AM Dashboard', to: '/operations/outlier/am-dashboard' },
    { key: 'outlier-leadership', label: 'Leadership', to: '/operations/outlier/leadership' },
  ],
  finance: [{ key: 'finance-soon', label: 'Coming Soon', to: null }],
  accounting: [{ key: 'accounting-soon', label: 'Coming Soon', to: null }],
  marketing: [
    { key: 'marketing-planner', label: 'Marketing Planner', to: '/marketing-planner' },
    { key: 'menu-board', label: 'Menu Board', to: '/menu-board' },
  ],
}

const SECTION_META: Record<string, { label: string }> = {
  inventory: { label: 'Inventory' },
  droptop: { label: 'Droptop' },
  'data-connections': { label: 'Data Connections' },
  'global-config': { label: 'Configuration' },
  operations: { label: 'Operations' },
  finance: { label: 'Finance' },
  accounting: { label: 'Accounting' },
  marketing: { label: 'Marketing' },
}

/**
 * Every top-level sidebar section that can be granted to a user through the
 * admin panel — i.e. all of them except `global-config`, which stays
 * admin/developer only. Derived from SECTION_ITEMS so a newly-added section
 * automatically becomes assignable (see UsersPage's ManageUserModal, which
 * also auto-creates the matching platform.departments row on save). The
 * `key` doubles as the department slug and the sidebar section key.
 */
export const ASSIGNABLE_SECTIONS: { key: string; label: string }[] =
  Object.keys(SECTION_ITEMS)
    .filter((k) => k !== 'global-config')
    .map((k) => ({ key: k, label: SECTION_META[k]?.label ?? k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) }))

const UTILITY_ITEMS: NavItem[] = [
  { key: 'calendar', label: 'Calendar', to: '/schedule' },
  { key: 'tasks', label: 'Tasks', to: '/tasks' },
  { key: 'issues', label: 'Issues', to: '/issues' },
  { key: 'meetings', label: 'Meeting Notes', to: '/meetings' },
  { key: 'forms', label: 'Forms', to: '/forms' },
  { key: 'locations', label: 'Locations', to: '/locations' },
  { key: 'feature-requests', label: 'Feature Requests', to: '/feature-requests' },
]

// ── Sub-components ─────────────────────────────────────────────────────────

// Pin/Rearrange now live behind a right-click menu instead of an always-on
// hover star + drag handle — both were flagged as visually distracting, and
// the star/outline/handle combo was eating into the row's own width, which
// is what caused labels like "Product Sales Histo…" to clip. `rearranging`
// is a single global flag (not per-section) — selecting "Rearrange" from
// ANY item's context menu turns on drag handles everywhere (every section's
// own item list, plus Pinned, which previously had no reordering at all)
// until "Save" is clicked. Defaults are safe no-ops so NavItemLink/
// SortableNavItem can't crash if ever rendered outside ExpandedSidebar's
// provider (e.g. reused in a future context with no menu/rearrange UI).
interface RearrangeCtxValue {
  rearranging: boolean
  openMenu: (e: React.MouseEvent, item: NavItem, isFavorite: boolean, onToggleFavorite?: (key: string) => void) => void
}
const RearrangeCtx = createContext<RearrangeCtxValue>({ rearranging: false, openMenu: () => {} })

function SidebarContextMenu({
  x, y, isFavorite, onPin, onRearrange, onClose,
}: {
  x: number
  y: number
  isFavorite: boolean
  onPin: () => void
  onRearrange: () => void
  onClose: () => void
}) {
  useEffect(() => {
    window.addEventListener('click', onClose)
    window.addEventListener('contextmenu', onClose)
    window.addEventListener('scroll', onClose, true)
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('contextmenu', onClose)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('keydown', esc)
    }
  }, [onClose])

  // Clamped so a right-click near the bottom/right of the viewport doesn't
  // render the menu partly off-screen.
  const top = Math.min(y, window.innerHeight - 90)
  const left = Math.min(x, window.innerWidth - 168)

  return createPortal(
    <div
      style={{ top, left }}
      className="fixed z-[70] w-40 bg-[#002745] border border-[#F2F1E6]/15 rounded-md shadow-2xl py-1 font-heading animate-[fadeIn_100ms_ease-out]"
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={onPin}
        className="w-full flex items-center gap-2 text-left px-3 py-2 text-xs text-[#F2F1E6]/80 hover:bg-[#F2F1E6]/10 hover:text-[#F2F1E6] transition-colors"
      >
        <Pin className="w-3.5 h-3.5" fill={isFavorite ? 'currentColor' : 'none'} />
        {isFavorite ? 'Unpin' : 'Pin to top'}
      </button>
      <button
        onClick={onRearrange}
        className="w-full flex items-center gap-2 text-left px-3 py-2 text-xs text-[#F2F1E6]/80 hover:bg-[#F2F1E6]/10 hover:text-[#F2F1E6] transition-colors"
      >
        <GripVertical className="w-3.5 h-3.5" />
        Rearrange
      </button>
    </div>,
    document.body,
  )
}

function NavItemLink({
  item,
  showLabel,
  isFavorite,
  onToggleFavorite,
  onNavClick,
  draggable,
  dragListeners,
  dragRef,
  dragStyle,
  outlined,
}: {
  item: NavItem
  showLabel: boolean
  isFavorite?: boolean
  onToggleFavorite?: (key: string) => void
  onNavClick?: () => void
  /** True only for a row that's part of an actual sortable list (a real
   * section's items, or Pinned) — gates whether the drag handle can ever
   * render at all. Visibility within that is further gated on `rearranging`
   * below, so the handle only shows once "Rearrange" is picked from the
   * context menu, not on hover. */
  draggable?: boolean
  dragListeners?: Record<string, unknown>
  dragRef?: (el: HTMLDivElement | null) => void
  dragStyle?: React.CSSProperties
  /** A light border framing the row — used for real section sub-items so
   * they read as distinct rows against the section's own shaded panel.
   * Deliberately NOT passed for Pinned items (flush, no panel behind them). */
  outlined?: boolean
}) {
  const { rearranging, openMenu } = useContext(RearrangeCtx)
  const base = 'flex items-center gap-2.5 px-2 py-2 mx-1 rounded text-sm font-heading transition-all duration-100 group'
  const badge = useNavBadge(item.key)
  const showBadge = badge > 0 && showLabel
  const showGrip = draggable && rearranging

  if (!item.to) {
    return (
      <div className={`${base} text-[#F2F1E6]/25 cursor-default text-xs`} ref={dragRef} style={dragStyle}>
        {showLabel && <span className="truncate italic">{item.label}</span>}
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1"
      ref={dragRef}
      style={dragStyle}
      onContextMenu={(e) => openMenu(e, item, !!isFavorite, onToggleFavorite)}
    >
      {showGrip && (
        <span {...dragListeners} className="cursor-grab flex-shrink-0 pl-0.5 text-[#F2F1E6]/40 hover:text-[#F2F1E6]/70 transition-colors">
          {ICONS.drag}
        </span>
      )}
      <NavLink
        to={item.to}
        onClick={(e) => {
          // Rearrange mode is a drag-only surface — clicking a row while
          // it's active shouldn't navigate away mid-reorder.
          if (rearranging) { e.preventDefault(); return }
          onNavClick?.()
        }}
        className={({ isActive }) =>
          [
            base,
            'flex-1 min-w-0',
            isActive
              ? 'bg-[#F2F1E6]/10 text-[#F2F1E6] border-b-2 border-sky'
              : `text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 ${outlined ? 'border border-[#F2F1E6]/10' : ''}`,
          ].join(' ')
        }
      >
        <span className="group-hover/row:hidden">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        <span className="hidden group-hover/row:block">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        {showLabel && <span className="truncate flex-1">{item.label}</span>}
        {showBadge && (
          <span className="flex-shrink-0 rounded-full bg-[#C0392B] text-[#F2F1E6] text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center">{badge}</span>
        )}
      </NavLink>
    </div>
  )
}

function SortableNavItem({
  item,
  showLabel,
  isFavorite,
  onToggleFavorite,
  onNavClick,
  outlined,
}: {
  item: NavItem
  showLabel: boolean
  isFavorite?: boolean
  onToggleFavorite?: (key: string) => void
  onNavClick?: () => void
  outlined?: boolean
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: 'relative',
    zIndex: isDragging ? 10 : undefined,
  }

  return (
    <div className="group/row" ref={setNodeRef} style={style} {...attributes}>
      <NavItemLink
        item={item}
        showLabel={showLabel}
        isFavorite={isFavorite}
        onToggleFavorite={onToggleFavorite}
        onNavClick={onNavClick}
        draggable
        dragListeners={listeners as Record<string, unknown>}
        outlined={outlined}
      />
    </div>
  )
}

function FavoritesSection({
  favorites,
  showLabels,
  onToggleFavorite,
  onNavClick,
  setFavoritesOrder,
}: {
  favorites: string[]
  showLabels: boolean
  onToggleFavorite: (key: string) => void
  onNavClick?: () => void
  /** Previously the Pinned section could only ever grow in pin-order — no
   * UI ever called this. Now sortable via the same global Rearrange mode
   * as regular section items (see RearrangeCtx above). */
  setFavoritesOrder: (v: string[]) => void
}) {
  const allItems = [...Object.values(SECTION_ITEMS).flat(), ...UTILITY_ITEMS]
  const favItems = favorites
    .map((k) => allItems.find((i) => i.key === k))
    .filter((i): i is NavItem => !!i)

  if (favItems.length === 0) return null

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = favorites.indexOf(String(active.id))
    const newIdx = favorites.indexOf(String(over.id))
    if (oldIdx !== -1 && newIdx !== -1) setFavoritesOrder(arrayMove(favorites, oldIdx, newIdx))
  }

  return (
    <div className="pb-1">
      {showLabels && (
        <div className="px-3 pt-3 pb-1 text-[10px] font-heading text-[#F2F1E6]/45 uppercase tracking-widest flex items-center gap-1">
          <Pin className="w-3 h-3" fill="currentColor" /> Pinned
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={favItems.map((i) => i.key)} strategy={verticalListSortingStrategy}>
          {favItems.map((item) => (
            <SortableNavItem
              key={item.key}
              item={item}
              showLabel={showLabels}
              isFavorite
              onToggleFavorite={onToggleFavorite}
              onNavClick={onNavClick}
            />
          ))}
        </SortableContext>
      </DndContext>
      {showLabels && <div className="mx-3 mt-2 border-t border-[#F2F1E6]/8" />}
    </div>
  )
}

function OutlierExpandableItem({
  item,
  showLabel,
  isFavorite,
  onToggleFavorite,
  onNavClick,
}: {
  item: NavItem
  showLabel: boolean
  isFavorite?: boolean
  onToggleFavorite?: (key: string) => void
  onNavClick?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const { rearranging, openMenu } = useContext(RearrangeCtx)
  const [expanded, setExpanded] = useState(false)
  const [reports, setReports] = useState<{ id: string; name: string; slug: string }[]>([])
  const prevExpandedRef = useRef(expanded)
  const [isOpening, setIsOpening] = useState(false)
  useEffect(() => {
    if (!prevExpandedRef.current && expanded) {
      setIsOpening(true)
      const t = setTimeout(() => setIsOpening(false), reports.length * 60 + 300)
      prevExpandedRef.current = expanded
      return () => clearTimeout(t)
    }
    prevExpandedRef.current = expanded
  }, [expanded, reports.length])

  useEffect(() => {
    ;(supabase as any).schema('outlier').from('reports')
      .select('id, name, slug')
      .order('sort_order')
      .then(({ data }: any) => setReports(data ?? []))
  }, [])

  const base = 'flex items-center gap-2.5 px-2 py-2 mx-1 rounded text-sm font-heading transition-all duration-100 group'

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/row"
      onContextMenu={(e) => openMenu(e, item, !!isFavorite, onToggleFavorite)}
    >
      <div className="flex items-center gap-1">
        {rearranging && (
          <span {...listeners} {...attributes} className="cursor-grab flex-shrink-0 pl-0.5 text-[#F2F1E6]/40 hover:text-[#F2F1E6]/70 transition-colors">
            {ICONS.drag}
          </span>
        )}
        <NavLink
          to={item.to!}
          onClick={(e) => {
            if (rearranging) { e.preventDefault(); return }
            onNavClick?.()
          }}
          className={({ isActive }) =>
            [
              base,
              'flex-1 min-w-0',
              isActive
                ? 'bg-[#F2F1E6]/10 text-[#F2F1E6] border-b-2 border-sky'
                : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 border border-[#F2F1E6]/10',
            ].join(' ')
          }
        >
          {ICONS.outlier}
          {showLabel && <span className="truncate flex-1">{item.label}</span>}
        </NavLink>
        {showLabel && reports.length > 0 && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex-shrink-0 mr-1 p-1 rounded text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 transition-colors"
            title={expanded ? 'Collapse reports' : 'Expand reports'}
          >
            <ChevronRight
              className={['w-3 h-3 transition-transform duration-150', expanded ? 'rotate-90' : ''].join(' ')}
            />
          </button>
        )}
      </div>
      {showLabel && (
        <div className={['grid transition-[grid-template-rows] duration-500 ease-in-out', expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'].join(' ')}>
          <div className="overflow-hidden">
            <div className="ml-5 border-l border-[#F2F1E6]/10 mb-0.5">
              {reports.map((r, idx) => (
                <div key={r.id} className={isOpening ? 'sb-drop-in' : ''} style={isOpening ? { animationDelay: `${idx * 60}ms` } : undefined}>
                  <NavLink
                    to={`/operations/outlier/report/${r.slug}`}
                    onClick={onNavClick}
                    className={({ isActive }) =>
                      [
                        'flex items-center gap-2 pl-3 pr-2 py-1.5 text-xs font-heading transition-all duration-100',
                        isActive
                          ? 'text-[#F2F1E6] bg-[#F2F1E6]/8'
                          : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
                      ].join(' ')
                    }
                  >
                    <svg className="w-3 h-3 flex-shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <span className="truncate">{r.name}</span>
                  </NavLink>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SortableSection({
  sectionKey,
  collapsed,
  showLabels,
  favorites,
  onToggleFavorite,
  onToggleCollapse,
  onNavClick,
  itemOrder,
  overrideItems,
  onSetItemOrder,
}: {
  sectionKey: string
  collapsed: boolean
  showLabels: boolean
  favorites: string[]
  onToggleFavorite: (key: string) => void
  onToggleCollapse: () => void
  onNavClick?: () => void
  itemOrder: string[]
  overrideItems?: NavItem[]
  onSetItemOrder?: (sectionKey: string, items: string[]) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sectionKey })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
  const meta = SECTION_META[sectionKey]

  const baseItems = overrideItems ?? SECTION_ITEMS[sectionKey] ?? []
  const items =
    itemOrder.length > 0
      // Saved order first, then any newer items not yet in the saved order so
      // newly-added nav entries aren't dropped for users with custom ordering.
      ? [
          ...itemOrder.map((k) => baseItems.find((i) => i.key === k)).filter((i): i is NavItem => !!i),
          ...baseItems.filter((i) => !itemOrder.includes(i.key)),
        ]
      : baseItems

  const prevCollapsedRef = useRef(collapsed)
  const [isOpening, setIsOpening] = useState(false)
  useEffect(() => {
    if (prevCollapsedRef.current && !collapsed) {
      setIsOpening(true)
      const t = setTimeout(() => setIsOpening(false), items.length * 60 + 300)
      prevCollapsedRef.current = collapsed
      return () => clearTimeout(t)
    }
    prevCollapsedRef.current = collapsed
  }, [collapsed, items.length])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleItemDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = items.findIndex((i) => i.key === active.id)
    const newIdx = items.findIndex((i) => i.key === over.id)
    if (oldIdx !== -1 && newIdx !== -1) {
      const reordered = arrayMove(items, oldIdx, newIdx)
      onSetItemOrder?.(sectionKey, reordered.map((i) => i.key))
    }
  }

  if (!showLabels) {
    return (
      <div ref={setNodeRef} style={style} className="py-0.5">
        {items.map((item) => (
          item.key === 'outlier' ? (
            <OutlierExpandableItem key={item.key} item={item} showLabel={false} onNavClick={onNavClick} />
          ) : (
            <div key={item.key} className="group/row">
              <NavItemLink item={item} showLabel={false} onNavClick={onNavClick} />
            </div>
          )
        ))}
      </div>
    )
  }

  // Data Connections is a single-item section by design — wrapping exactly
  // one link in a full section header (chevron, collapse, drag handle) was
  // pure indirection for what's really just a button. Rendered as a plain
  // top-level link instead, same as a collapsed-sidebar item. If this
  // section ever grows a second item, this check stops matching and it
  // falls through to the normal section treatment below, unchanged.
  if (sectionKey === 'data-connections' && items.length === 1) {
    return (
      <div ref={setNodeRef} style={style} className="py-0.5">
        <NavItemLink
          item={items[0]}
          showLabel
          isFavorite={favorites.includes(items[0].key)}
          onToggleFavorite={onToggleFavorite}
          onNavClick={onNavClick}
        />
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} className="py-0.5">
      {/* Section header */}
      <div className={`flex items-center gap-1 px-2 py-1.5 group/section rounded-r ${SECTION_ACCENT[sectionKey] ?? ''}`}>
        {/* Drag handle for the section */}
        <span
          {...listeners}
          {...attributes}
          className="cursor-grab opacity-0 group-hover/section:opacity-100 flex-shrink-0 transition-opacity hover:text-[#F2F1E6]/50"
          title="Drag to reorder section"
        >
          {ICONS.drag}
        </span>
        {/* Collapse toggle */}
        <button
          onClick={onToggleCollapse}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          {SECTION_ICONS[sectionKey]}
          <span className="text-[10px] font-heading text-[#F2F1E6]/80 uppercase tracking-widest truncate flex-1">
            {meta?.label}
          </span>
          <ChevronRight
            className={[
              'w-3 h-3 flex-shrink-0 text-[#F2F1E6]/30 transition-transform duration-150',
              collapsed ? '' : 'rotate-90',
            ].join(' ')}
          />
        </button>
      </div>

      {/* Section items — animated slide. A gentle shaded panel (vs. the flat
          sidebar background) reads as "these are nested under the header
          above them" at a glance, without a hard border. No side margin of
          its own — each row's own `mx-1` (NavItemLink's `base`) is the only
          inset, matching Pinned's spacing exactly. The previous mx-1.5 here
          stacked on top of that same mx-1, eating ~12px of usable row width
          for no visual benefit and contributing to labels like "Product
          Sales Histo…" clipping. */}
      <div className={['grid transition-[grid-template-rows] duration-500 ease-in-out', collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'].join(' ')}>
        <div className="overflow-hidden rounded-md bg-black/10">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleItemDragEnd}
          >
            <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
              {items.map((item, idx) => (
                <div
                  key={item.key}
                  className={['py-px', isOpening ? 'sb-drop-in' : ''].join(' ')}
                  style={isOpening ? { animationDelay: `${idx * 60}ms` } : undefined}
                >
                  {item.key === 'outlier' ? (
                    <OutlierExpandableItem
                      item={item}
                      showLabel
                      isFavorite={favorites.includes(item.key)}
                      onToggleFavorite={onToggleFavorite}
                      onNavClick={onNavClick}
                    />
                  ) : (
                    <SortableNavItem
                      item={item}
                      showLabel
                      isFavorite={favorites.includes(item.key)}
                      onToggleFavorite={onToggleFavorite}
                      onNavClick={onNavClick}
                      outlined
                    />
                  )}
                </div>
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    </div>
  )
}

function UtilityNav({
  order,
  onNavClick,
  onToggleCollapsed,
}: {
  order: string[]
  onNavClick?: () => void
  onToggleCollapsed?: () => void
}) {
  const orderedItems = order
    .map((k) => UTILITY_ITEMS.find((i) => i.key === k))
    .filter((i): i is NavItem => !!i)
  // Include any items not in persisted order
  const missing = UTILITY_ITEMS.filter((i) => !order.includes(i.key))
  const items = [...orderedItems, ...missing]

  const [expanded, setExpanded] = useState(() => localStorage.getItem('sb:sc:expanded') !== 'false')
  const [pinned, setPinned] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sb:sc:pinned') || '[]') } catch { return [] }
  })
  useEffect(() => { localStorage.setItem('sb:sc:expanded', String(expanded)) }, [expanded])
  useEffect(() => { localStorage.setItem('sb:sc:pinned', JSON.stringify(pinned)) }, [pinned])
  const togglePin = (key: string) => setPinned((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]))

  const shown = expanded ? items : items.filter((i) => pinned.includes(i.key))
  const issuesBadge = useNavBadge('issues')
  const tasksBadge = useNavBadge('tasks')
  const calendarBadge = useNavBadge('calendar')
  const badgeFor = (key: string) => (key === 'issues' ? issuesBadge : key === 'tasks' ? tasksBadge : key === 'calendar' ? calendarBadge : 0)

  return (
    <div className="pt-1 pb-1 border-t border-[#F2F1E6]/8">
      <div className="flex items-center justify-between px-2 py-1">
        <button
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center gap-1 text-[10px] font-heading text-[#F2F1E6]/30 uppercase tracking-widest hover:text-[#F2F1E6]/60 transition-colors"
        >
          <span>General</span>
          <ChevronRight className={['w-3.5 h-3.5 transition-transform', expanded ? 'rotate-90' : ''].join(' ')} />
        </button>
        {onToggleCollapsed && (
          <button
            onClick={onToggleCollapsed}
            title="Collapse sidebar"
            className="flex items-center gap-1 text-[#F2F1E6]/70 hover:text-[#F2F1E6] border border-[#F2F1E6]/20 hover:border-[#F2F1E6]/40 bg-[#F2F1E6]/5 hover:bg-[#F2F1E6]/10 transition-colors px-1.5 py-1 rounded"
          >
            <ChevronsLeft className="w-4 h-4" />
          </button>
        )}
      </div>
      {shown.map((item) => (
        item.to ? (
          <div key={item.key} className="relative group">
            <NavLink
              to={item.to}
              onClick={onNavClick}
              className={({ isActive }) =>
                [
                  'flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded text-xs font-heading transition-all duration-100',
                  isActive
                    ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                    : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
                ].join(' ')
              }
            >
              {ICONS[item.key] ?? ICONS.dashboard}
              <span className="truncate flex-1">{item.label}</span>
              {badgeFor(item.key) > 0 && (
                <span className={['flex-shrink-0 rounded-full bg-[#C0392B] text-[#F2F1E6] text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center transition-opacity', expanded ? 'mr-4 group-hover:opacity-0' : ''].join(' ')}>{badgeFor(item.key)}</span>
              )}
            </NavLink>
            {expanded && (
              <button
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(item.key) }}
                title={pinned.includes(item.key) ? 'Unpin' : 'Pin'}
                className={['absolute right-2 top-1/2 -translate-y-1/2 transition-opacity', pinned.includes(item.key) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'].join(' ')}
              >
                <Pin className={['w-3 h-3', pinned.includes(item.key) ? 'text-sky fill-current' : 'text-[#4F7489]/60 hover:text-[#F2F1E6]'].join(' ')} />
              </button>
            )}
          </div>
        ) : null
      ))}
    </div>
  )
}

// ── Quick Access grid (2×2) — triggers the overlay/nav actions in AppShell ──
const QUICK_ACCESS = [
  { id: 'tasks', label: 'Tasks' },
  { id: 'lookup', label: 'Lookup' },
  { id: 'meeting', label: 'Meeting' },
  { id: 'inventory', label: 'Inventory' },
] as const
const QA_ICON: Record<string, JSX.Element> = {
  tasks: <CheckCircle2 className="w-4 h-4" />,
  lookup: <MapPin className="w-4 h-4" />,
  meeting: <MessageSquare className="w-4 h-4" />,
  inventory: <Package className="w-4 h-4" />,
}

function QuickAccessGrid({ onNavClick }: { onNavClick?: () => void }) {
  const [expanded, setExpanded] = useState(() => localStorage.getItem('sb:qa:expanded') !== 'false')
  const [pinned, setPinned] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('sb:qa:pinned') || '[]') } catch { return [] }
  })
  useEffect(() => { localStorage.setItem('sb:qa:expanded', String(expanded)) }, [expanded])
  useEffect(() => { localStorage.setItem('sb:qa:pinned', JSON.stringify(pinned)) }, [pinned])
  const togglePin = (id: string) => setPinned((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const trigger = (id: string) => { window.dispatchEvent(new CustomEvent('sb-quick-access', { detail: id })); onNavClick?.() }

  const items = expanded ? [...QUICK_ACCESS] : QUICK_ACCESS.filter((i) => pinned.includes(i.id))

  return (
    <div className="border-t border-[#F2F1E6]/8 px-2 py-2 flex flex-col gap-1.5">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center justify-between w-full px-1 text-[10px] font-heading text-[#F2F1E6]/30 uppercase tracking-widest hover:text-[#F2F1E6]/60 transition-colors"
      >
        <span>Quick Access</span>
        <ChevronRight className={['w-3.5 h-3.5 transition-transform', expanded ? 'rotate-90' : ''].join(' ')} />
      </button>
      {items.length > 0 && (
        <div className="grid grid-cols-2 gap-1.5">
          {items.map((item) => (
            <div key={item.id} className="relative">
              <button
                onClick={() => trigger(item.id)}
                title={item.label}
                className="w-full flex flex-col items-center justify-center gap-1 rounded-lg py-2.5 border border-[#F2F1E6]/10 text-[11px] font-heading text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 transition-all"
              >
                {QA_ICON[item.id]}
                <span>{item.label}</span>
              </button>
              {expanded && (
                <button
                  onClick={(e) => { e.stopPropagation(); togglePin(item.id) }}
                  title={pinned.includes(item.id) ? 'Unpin' : 'Pin'}
                  className="absolute top-1 right-1"
                >
                  <Pin className={['w-3 h-3 transition-colors', pinned.includes(item.id) ? 'text-sky fill-current' : 'text-[#4F7489]/50 hover:text-[#F2F1E6]'].join(' ')} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Quick-access hover FABs the user can enable/disable — position and which
// ones are enabled are both editable from ProfilePanel.tsx, which was moved
// out of this file (opened from the TopBar next to End Day instead of a
// sidebar footer button) but still imports these from here.
export const QUICK_FAB_META: { key: string; label: string }[] = [
  { key: 'tasks', label: "Today's Tasks" },
  { key: 'lookup', label: 'Location Lookup' },
  { key: 'meeting', label: 'Quick Meeting' },
  { key: 'inventory', label: 'Inventory' },
]
export const QUICK_FAB_DEFAULT = QUICK_FAB_META.map((f) => f.key)
export type QuickFabPosition = 'bottom-right' | 'bottom-left' | 'topbar-left'

// ── Collapsed icon-only view ──────────────────────────────────────────────

function CollapsedNav({
  onNavClick,
  onToggleCollapsed,
  onPeekSection,
}: {
  onNavClick?: () => void
  onToggleCollapsed?: () => void
  /** Requests a "peek" — temporarily expand the full sidebar with this one
   * section forced open, so a section that's collapsed in the full view
   * (and therefore has none of its items shown here at all) still has a
   * way in from the icon rail. See Sidebar's peekSection state. */
  onPeekSection?: (key: string) => void
}) {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowedSections = useDeptAccess()
  const [hiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])
  const { sectionOrder, sectionCollapsed, favorites } = useSidebarPrefs()
  // Pinned items stay visible on the collapsed rail too.
  const itemByKey = useMemo(() => { const m = new Map<string, NavItem>(); for (const items of Object.values(SECTION_ITEMS)) for (const it of items) m.set(it.key, it); for (const it of UTILITY_ITEMS) m.set(it.key, it); return m }, [])
  const favItems = favorites.map((k) => itemByKey.get(k)).filter((i): i is NavItem => !!i)
  // Mirror the General (utility) section's expanded/pinned state so the collapsed
  // rail shows exactly what was visible in the expanded sidebar.
  const genExpanded = (() => { try { return localStorage.getItem('sb:sc:expanded') !== 'false' } catch { return true } })()
  const genPinned: string[] = (() => { try { return JSON.parse(localStorage.getItem('sb:sc:pinned') || '[]') } catch { return [] } })()
  const shownUtility = genExpanded ? UTILITY_ITEMS : UTILITY_ITEMS.filter((i) => genPinned.includes(i.key))
  // Hover flyout label — rendered via portal so it escapes the sidebar's clip.
  const [flyout, setFlyout] = useState<{ label: string; top: number } | null>(null)
  const showFlyout = (e: React.MouseEvent, label: string) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFlyout({ label, top: r.top + r.height / 2 }) }
  const visibleSectionKeys = sectionOrder.filter((k) => {
    if (hiddenSections.includes(k)) return false
    if (k === 'global-config') return isAdmin
    if (allowedSections !== null) return allowedSections.has(k)
    return true
  })
  const itemLinkClass = ({ isActive }: { isActive: boolean }) =>
    [
      'flex items-center justify-center py-2.5 mx-1 rounded transition-all duration-100',
      isActive ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]' : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
    ].join(' ')

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto hover-scroll py-2">
        {favItems.length > 0 && (
          <>
            {favItems.filter((i) => i.to).map((item) => (
              <NavLink
                key={`fav-${item.key}`}
                to={item.to!}
                onClick={onNavClick}
                onMouseEnter={(e) => showFlyout(e, item.label)}
                onMouseLeave={() => setFlyout(null)}
                className={itemLinkClass}
              >
                {ICONS[item.key] ?? ICONS.dashboard}
              </NavLink>
            ))}
            <div className="mx-2 my-1 border-t border-[#F2F1E6]/10" />
          </>
        )}
        {visibleSectionKeys.map((k) => {
          // Data Connections bypasses the collapse mechanism entirely in the
          // full sidebar too (see SortableSection's own special-case) — always
          // just a plain link here, never a launcher button.
          if (k === 'data-connections') {
            const item = SECTION_ITEMS[k]?.[0]
            if (!item?.to) return null
            return (
              <NavLink
                key={item.key}
                to={item.to}
                onClick={onNavClick}
                onMouseEnter={(e) => showFlyout(e, item.label)}
                onMouseLeave={() => setFlyout(null)}
                className={itemLinkClass}
              >
                {ICONS[item.key] ?? ICONS.dashboard}
              </NavLink>
            )
          }
          // A section collapsed in the full sidebar previously had NONE of
          // its items shown here at all — now it gets one launcher icon
          // (the section's own header icon) that peeks the full sidebar
          // open with just that section expanded, so it's reachable from
          // the icon rail without permanently expanding everything.
          if (sectionCollapsed[k]) {
            return (
              <button
                key={`sec-${k}`}
                onClick={() => onPeekSection?.(k)}
                onMouseEnter={(e) => showFlyout(e, SECTION_META[k]?.label ?? k)}
                onMouseLeave={() => setFlyout(null)}
                title={SECTION_META[k]?.label}
                className="w-full flex items-center justify-center py-2.5 mx-1 rounded transition-all duration-100 text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5"
              >
                {SECTION_ICONS[k] ?? ICONS.dashboard}
              </button>
            )
          }
          return (SECTION_ITEMS[k] ?? []).filter((i) => i.to).map((item) => (
            <NavLink
              key={item.key}
              to={item.to!}
              onClick={onNavClick}
              onMouseEnter={(e) => showFlyout(e, item.label)}
              onMouseLeave={() => setFlyout(null)}
              className={itemLinkClass}
            >
              {ICONS[item.key] ?? ICONS.dashboard}
            </NavLink>
          ))
        })}
      </div>
      {/* Expand/collapse toggle — above quick access */}
      {onToggleCollapsed && (
        <div className="flex items-center justify-center py-1.5 border-t border-[#F2F1E6]/8">
          <button
            onClick={onToggleCollapsed}
            title="Expand sidebar"
            className="flex items-center justify-center w-8 h-8 rounded text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 transition-colors"
          >
            <ChevronsRight className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="border-t border-[#F2F1E6]/8 py-1">
        {shownUtility.map((item) =>
          item.to ? (
            <NavLink
              key={item.key}
              to={item.to}
              onClick={onNavClick}
              onMouseEnter={(e) => showFlyout(e, item.label)}
              onMouseLeave={() => setFlyout(null)}
              className={({ isActive }) =>
                [
                  'flex items-center justify-center py-2 mx-1 rounded transition-all duration-100',
                  isActive
                    ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                    : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
                ].join(' ')
              }
            >
              {ICONS[item.key] ?? ICONS.dashboard}
            </NavLink>
          ) : null
        )}
      </div>
      {flyout && createPortal(
        <div style={{ top: flyout.top, left: 60 }}
          className="fixed -translate-y-1/2 z-[60] bg-[#002745] text-[#F2F1E6] text-xs font-heading px-2.5 py-1 rounded-md shadow-xl border border-[#F2F1E6]/15 pointer-events-none whitespace-nowrap animate-[fadeIn_120ms_ease-out]">
          {flyout.label}
        </div>,
        document.body,
      )}
    </div>
  )
}

// ── Main Sidebar ────────────────────────────────────────────────────────────

interface SidebarProps {
  collapsed: boolean
  onToggleCollapsed: () => void
  mobile: boolean
  mobileOpen: boolean
  onMobileClose: () => void
}

function ExpandedSidebar({
  onNavClick,
  showHeader,
  onToggleCollapsed,
  forceExpandSection,
}: {
  onNavClick?: () => void
  showHeader?: boolean
  onToggleCollapsed?: () => void
  /** Set while "peeking" out from the collapsed rail into one specific
   * section (see Sidebar's own peekSection state below) — visually forces
   * that one section open without touching the user's persisted
   * sectionCollapsed preference, so it goes back to however they had it
   * once the peek ends. */
  forceExpandSection?: string | null
}) {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowedSections = useDeptAccess()
  const [hiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])

  const {
    sectionOrder,
    sectionCollapsed,
    itemOrder,
    favorites,
    utilityNavOrder,
    setSectionOrder,
    toggleSection,
    toggleFavorite,
    setFavoritesOrder,
    setItemOrder,
  } = useSidebarPrefs()

  // Global rearrange mode + the right-click menu that turns it on — see
  // RearrangeCtx's own comment above for why this is one flag for the whole
  // sidebar rather than per-section.
  const [rearranging, setRearranging] = useState(false)
  const [menu, setMenu] = useState<{
    x: number; y: number; item: NavItem; isFavorite: boolean; onToggleFavorite?: (key: string) => void
  } | null>(null)
  const openMenu = (e: React.MouseEvent, item: NavItem, isFavorite: boolean, onToggleFavorite?: (key: string) => void) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, item, isFavorite, onToggleFavorite })
  }

  const visibleSectionOrder = useMemo(
    () => sectionOrder.filter((k) => {
      if (hiddenSections.includes(k)) return false
      if (k === 'global-config') return isAdmin
      if (allowedSections !== null) return allowedSections.has(k)
      return true
    }),
    [sectionOrder, isAdmin, allowedSections, hiddenSections]
  )

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  function handleSectionDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = sectionOrder.indexOf(String(active.id))
    const newIdx = sectionOrder.indexOf(String(over.id))
    if (oldIdx !== -1 && newIdx !== -1) {
      setSectionOrder(arrayMove(sectionOrder, oldIdx, newIdx))
    }
  }

  return (
    <RearrangeCtx.Provider value={{ rearranging, openMenu }}>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center px-3 h-12 border-b border-[#F2F1E6]/8 flex-shrink-0 overflow-hidden">
          <span className="text-sm font-heading font-bold text-[#F2F1E6] tracking-wide uppercase whitespace-nowrap animate-[swipeRight_260ms_ease-out]">Strickland Brothers</span>
        </div>
      )}

      {/* Scrollable nav */}
      <div className="flex-1 overflow-y-auto hover-scroll">
        {rearranging && (
          <div className="sticky top-0 z-20 flex items-center justify-between gap-2 px-3 py-2 bg-sky/20 border-b border-sky/40 backdrop-blur-sm">
            <span className="text-[10px] font-heading text-[#F2F1E6] uppercase tracking-wide">Drag items to reorder</span>
            <button
              onClick={() => setRearranging(false)}
              className="flex-shrink-0 px-2.5 py-1 rounded bg-sb-green text-[#002745] text-[10px] font-heading font-bold uppercase tracking-wide hover:brightness-110 transition-all"
            >
              Save
            </button>
          </div>
        )}
        <FavoritesSection
          favorites={favorites}
          showLabels
          onToggleFavorite={toggleFavorite}
          onNavClick={onNavClick}
          setFavoritesOrder={setFavoritesOrder}
        />

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleSectionDragEnd}
        >
          <SortableContext items={visibleSectionOrder} strategy={verticalListSortingStrategy}>
            {visibleSectionOrder.map((sectionKey) => (
              <SortableSection
                key={sectionKey}
                sectionKey={sectionKey}
                collapsed={forceExpandSection === sectionKey ? false : !!sectionCollapsed[sectionKey]}
                showLabels
                favorites={favorites}
                onToggleFavorite={toggleFavorite}
                onToggleCollapse={() => toggleSection(sectionKey)}
                onNavClick={onNavClick}
                itemOrder={itemOrder[sectionKey] ?? []}
                overrideItems={undefined}
                onSetItemOrder={setItemOrder}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Shortcuts — collapsible + pinnable, with the sidebar-collapse control */}
      <UtilityNav order={utilityNavOrder} onNavClick={onNavClick} onToggleCollapsed={onToggleCollapsed} />

      {/* Logo watermark + SB Net wordmark — profile now opens from the TopBar */}
      <div className="px-3 py-3 flex items-center justify-center gap-2 border-t border-[#F2F1E6]/8">
        <img src={sbLogo} alt="Strickland Brothers" className="max-w-[80px] opacity-40" />
        <span className="text-xs font-heading text-[#F2F1E6]/50 tracking-widest uppercase">SB Net</span>
      </div>

      {menu && (
        <SidebarContextMenu
          x={menu.x}
          y={menu.y}
          isFavorite={menu.isFavorite}
          onPin={() => { menu.onToggleFavorite?.(menu.item.key); setMenu(null) }}
          onRearrange={() => { setRearranging(true); setMenu(null) }}
          onClose={() => setMenu(null)}
        />
      )}
    </RearrangeCtx.Provider>
  )
}

export function Sidebar({ collapsed, onToggleCollapsed, mobile, mobileOpen, onMobileClose }: SidebarProps) {
  useInventoryAlerts() // load alert counts once for the nav badge

  // A "peek" temporarily shows the full sidebar with one section forced
  // open, entered by clicking that section's launcher icon on the
  // collapsed rail (CollapsedNav's onPeekSection — for a section that's
  // folded shut in the full view and therefore has none of its own items
  // shown on the rail at all). Purely local visual state — it never
  // touches the real collapsed prop or the persisted sectionCollapsed
  // preference — so picking a page, or explicitly re-collapsing, just
  // drops back to the icon rail exactly as it was.
  const [peekSection, setPeekSection] = useState<string | null>(null)
  const peeking = collapsed && peekSection !== null
  const handleCollapseToggle = () => {
    if (peeking) { setPeekSection(null); return }
    onToggleCollapsed()
  }

  // Mobile: fixed overlay drawer
  if (mobile) {
    if (!mobileOpen) return null
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
          onClick={onMobileClose}
          aria-hidden="true"
        />
        <aside className="fixed left-0 top-0 bottom-0 z-50 w-64 flex flex-col bg-[#002745] shadow-2xl">
          <div className="flex items-center justify-between px-3 h-12 border-b border-[#F2F1E6]/8 flex-shrink-0">
            <img src={sbLogo} alt="SB Net" className="h-5 opacity-80" />
            <button
              onClick={onMobileClose}
              className="text-[#F2F1E6]/60 hover:text-[#F2F1E6] transition-colors p-1"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <ExpandedSidebar onNavClick={onMobileClose} />
        </aside>
      </>
    )
  }

  // Desktop — collapsible
  return (
    <aside
      className={[
        'flex flex-col h-full bg-[#002745] border-r border-[#002745]/40 transition-all duration-200 flex-shrink-0',
        collapsed && !peeking ? 'w-14' : 'w-64',
      ].join(' ')}
    >
      {collapsed && !peeking ? (
        <>
          <div className="flex items-center justify-center px-3 h-12 border-b border-[#F2F1E6]/8">
            <button
              onClick={onToggleCollapsed}
              className="text-[#F2F1E6]/60 hover:text-[#F2F1E6] transition-colors"
              aria-label="Expand sidebar"
            >
              <img src={sbIcon} alt="SB" className="w-6 opacity-70" />
            </button>
          </div>
          <CollapsedNav onToggleCollapsed={onToggleCollapsed} onPeekSection={setPeekSection} />
        </>
      ) : (
        <ExpandedSidebar
          showHeader
          onToggleCollapsed={handleCollapseToggle}
          onNavClick={peeking ? () => setPeekSection(null) : undefined}
          forceExpandSection={peeking ? peekSection : null}
        />
      )}
    </aside>
  )
}
