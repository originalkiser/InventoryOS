import { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { NavLink } from 'react-router-dom'
import { useInventoryAlerts, useInventoryAlertsStore } from '@/hooks/useInventoryAlerts'
import {
  normalizeBlockedDays,
  formatBlockedDayLabel,
  upsertBlockedDay,
  removeBlockedDay,
} from '@/utils/blockedDays'
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
import { useDarkMode } from '@/hooks/useDarkMode'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useDeptAccess } from '@/hooks/useDeptAccess'
import { LocationExclusionsConfig } from './LocationExclusionsConfig'
import { isAdminOrDeveloper, getRoleLabel } from '@/lib/roles'
import sbLogo from '@/assets/logo-cream.png'
import sbIcon from '@/assets/SBOC-IconCream.png'
import {
  Package, Settings, Building2, DollarSign, TrendingUp, Megaphone,
  LayoutDashboard, BarChart2, CalendarDays, ClipboardList, FolderKanban,
  Database, Users, AlertTriangle, MessageSquare, Lightbulb,
  CheckCircle2, FileText, MapPin, GripVertical, ChevronRight,
  ChevronsLeft, ChevronsRight, Pin,
} from 'lucide-react'

// ── Icons ──────────────────────────────────────────────────────────────────

export const ICONS: Record<string, JSX.Element> = {
  dashboard: <LayoutDashboard className="w-4 h-4 flex-shrink-0" />,
  'on-hand': <Package className="w-4 h-4 flex-shrink-0" />,
  monthend: <BarChart2 className="w-4 h-4 flex-shrink-0" />,
  weekly: <CalendarDays className="w-4 h-4 flex-shrink-0" />,
  orders: <ClipboardList className="w-4 h-4 flex-shrink-0" />,
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
  'am-rd-lookup': <Users className="w-4 h-4 flex-shrink-0" />,
  'tank-monitors': <Database className="w-4 h-4 flex-shrink-0" />,
  'inventory-alerts': <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  'exception-reporting': <AlertTriangle className="w-4 h-4 flex-shrink-0" />,
  'location-comms': <MessageSquare className="w-4 h-4 flex-shrink-0" />,
  'marketing-planner': <Megaphone className="w-4 h-4 flex-shrink-0" />,
  drag: <GripVertical className="w-3 h-3 flex-shrink-0 text-[#F2F1E6]/25" />,
}

const SECTION_ICONS: Record<string, JSX.Element> = {
  inventory: <Package className="w-3.5 h-3.5 flex-shrink-0 text-sky" />,
  'global-config': <Settings className="w-3.5 h-3.5 flex-shrink-0 text-[#F2F1E6]/70" />,
  operations: <Building2 className="w-3.5 h-3.5 flex-shrink-0 text-[#E67E22]" />,
  finance: <DollarSign className="w-3.5 h-3.5 flex-shrink-0 text-[#2ECC71]" />,
  accounting: <TrendingUp className="w-3.5 h-3.5 flex-shrink-0 text-inky" />,
  marketing: <Megaphone className="w-3.5 h-3.5 flex-shrink-0 text-[#C0392B]" />,
}

// Subtle per-section tint + colored left accent so the section headers stand
// apart from each other on the dark sidebar (brand tokens only).
const SECTION_ACCENT: Record<string, string> = {
  inventory: 'bg-sky/15 border-l-2 border-sky',
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
    { key: 'projects', label: 'Projects', to: '/projects' },
    { key: 'config', label: 'Inventory Config', to: '/config' },
    { key: 'location-lookup', label: 'Location Lookup', to: '/location-lookup' },
    { key: 'am-rd-lookup', label: 'AM/RD Lookup', to: '/am-rd-lookup' },
    { key: 'tank-monitors', label: 'Tank Monitors', to: '/tank-monitors' },
    { key: 'inventory-alerts', label: 'Inventory Alerts', to: '/inventory-alerts' },
    { key: 'exception-reporting', label: 'Exception Reporting', to: '/exception-reporting' },
    { key: 'location-comms', label: 'Location Comms', to: '/location-comms' },
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
  marketing: [{ key: 'marketing-planner', label: 'Marketing Planner', to: '/marketing-planner' }],
}

const SECTION_META: Record<string, { label: string }> = {
  inventory: { label: 'Inventory' },
  'global-config': { label: 'Configuration' },
  operations: { label: 'Operations' },
  finance: { label: 'Finance' },
  accounting: { label: 'Accounting' },
  marketing: { label: 'Marketing' },
}

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

function StarButton({ active, onClick }: { active: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? 'Unpin' : 'Pin to top'}
      className={[
        'flex-shrink-0 transition-all duration-100 rounded p-0.5',
        active ? 'text-sky opacity-100' : 'text-[#F2F1E6]/25 opacity-0 group-hover:opacity-100 hover:text-sky',
      ].join(' ')}
    >
      <Pin className="w-3.5 h-3.5" fill={active ? 'currentColor' : 'none'} />
    </button>
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
}: {
  item: NavItem
  showLabel: boolean
  isFavorite?: boolean
  onToggleFavorite?: (key: string) => void
  onNavClick?: () => void
  draggable?: boolean
  dragListeners?: Record<string, unknown>
  dragRef?: (el: HTMLDivElement | null) => void
  dragStyle?: React.CSSProperties
}) {
  const base = 'flex items-center gap-2.5 px-2 py-2 mx-1 rounded text-sm font-heading transition-all duration-100 group'
  const alertCount = useInventoryAlertsStore((s) => s.derivedCount)
  const showAlertBadge = item.key === 'inventory-alerts' && alertCount > 0 && showLabel

  if (!item.to) {
    return (
      <div className={`${base} text-[#F2F1E6]/25 cursor-default text-xs`} ref={dragRef} style={dragStyle}>
        {showLabel && <span className="truncate italic">{item.label}</span>}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1" ref={dragRef} style={dragStyle}>
      {draggable && (
        <span {...dragListeners} className="cursor-grab opacity-0 group-hover/row:opacity-100 flex-shrink-0 pl-0.5 hover:text-[#F2F1E6]/50 transition-opacity">
          {ICONS.drag}
        </span>
      )}
      <NavLink
        to={item.to}
        onClick={onNavClick}
        className={({ isActive }) =>
          [
            base,
            'flex-1 min-w-0',
            isActive
              ? 'bg-[#F2F1E6]/10 text-[#F2F1E6] border-b-2 border-sky'
              : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
          ].join(' ')
        }
      >
        <span className="group-hover/row:hidden">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        <span className="hidden group-hover/row:block">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        {showLabel && <span className="truncate flex-1">{item.label}</span>}
        {showAlertBadge && (
          <span className="flex-shrink-0 rounded-full bg-[#C0392B] text-[#F2F1E6] text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center">{alertCount}</span>
        )}
        {showLabel && onToggleFavorite && (
          <StarButton
            active={!!isFavorite}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFavorite(item.key) }}
          />
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
      />
    </div>
  )
}

function FavoritesSection({
  favorites,
  showLabels,
  onToggleFavorite,
  onNavClick,
}: {
  favorites: string[]
  showLabels: boolean
  onToggleFavorite: (key: string) => void
  onNavClick?: () => void
}) {
  const allItems = [...Object.values(SECTION_ITEMS).flat(), ...UTILITY_ITEMS]
  const favItems = favorites
    .map((k) => allItems.find((i) => i.key === k))
    .filter((i): i is NavItem => !!i)

  if (favItems.length === 0) return null

  return (
    <div className="pb-1">
      {showLabels && (
        <div className="px-3 pt-3 pb-1 text-[10px] font-heading text-[#F2F1E6]/45 uppercase tracking-widest flex items-center gap-1">
          <Pin className="w-3 h-3" fill="currentColor" /> Pinned
        </div>
      )}
      {favItems.map((item) => (
        <div key={item.key} className="group/row">
          <NavItemLink
            item={item}
            showLabel={showLabels}
            isFavorite
            onToggleFavorite={onToggleFavorite}
            onNavClick={onNavClick}
          />
        </div>
      ))}
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
  const { setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }
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
    <div ref={setNodeRef} style={style} className="group/row">
      <div className="flex items-center gap-1">
        <NavLink
          to={item.to!}
          onClick={onNavClick}
          className={({ isActive }) =>
            [
              base,
              'flex-1 min-w-0',
              isActive
                ? 'bg-[#F2F1E6]/10 text-[#F2F1E6] border-b-2 border-sky'
                : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
            ].join(' ')
          }
        >
          {ICONS.outlier}
          {showLabel && <span className="truncate flex-1">{item.label}</span>}
          {showLabel && onToggleFavorite && (
            <StarButton
              active={!!isFavorite}
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleFavorite(item.key) }}
            />
          )}
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

      {/* Section items — animated slide */}
      <div className={['grid transition-[grid-template-rows] duration-500 ease-in-out', collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'].join(' ')}>
        <div className="overflow-hidden">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleItemDragEnd}
          >
            <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
              {items.map((item, idx) => (
                <div
                  key={item.key}
                  className={isOpening ? 'sb-drop-in' : ''}
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
              <span className="truncate flex-1 pr-4">{item.label}</span>
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

function ProfileButton({ onOpen, collapsed }: { onOpen: () => void; collapsed: boolean }) {
  const { profile } = useAuthStore()
  const initials = (profile?.full_name ?? profile?.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-2.5 px-3 py-2.5 border-t border-[#F2F1E6]/8 hover:bg-[#F2F1E6]/5 transition-colors w-full text-left"
    >
      <div className="w-7 h-7 rounded-full bg-[#4F7489] flex items-center justify-center text-[10px] font-heading text-[#F2F1E6] flex-shrink-0">
        {initials}
      </div>
      {!collapsed && (
        <div className="flex-1 min-w-0">
          <div className="text-xs font-heading text-[#F2F1E6]/80 truncate">
            {profile?.full_name ?? profile?.email ?? 'User'}
          </div>
          <div className="text-[10px] font-mono text-[#F2F1E6]/35 truncate">
            {getRoleLabel(profile?.role)}
          </div>
        </div>
      )}
    </button>
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

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
]

// ── Profile Panel (slide-out drawer) ──────────────────────────────────────

// Quick-access hover FABs the user can enable/disable (shown bottom-right).
export const QUICK_FAB_META: { key: string; label: string }[] = [
  { key: 'tasks', label: "Today's Tasks" },
  { key: 'lookup', label: 'Location Lookup' },
  { key: 'meeting', label: 'Quick Meeting' },
  { key: 'inventory', label: 'Inventory' },
]
export const QUICK_FAB_DEFAULT = QUICK_FAB_META.map((f) => f.key)

function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { profile, setProfile } = useAuthStore()
  const { dark, toggle } = useDarkMode()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowedSections = useDeptAccess()
  const [enabledFabs, setEnabledFabs] = useProfilePref<string[]>('quickfab:enabled', QUICK_FAB_DEFAULT)
  const [hiddenSections, setHiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])
  const accessibleSections = Object.keys(SECTION_ITEMS).filter((k) => (k === 'global-config' ? isAdmin : allowedSections !== null ? allowedSections.has(k) : true))
  const sectionLabel = (k: string) => k.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  // Schedule state — initialized from profile
  const [workStart, setWorkStart] = useState(profile?.work_start_time?.slice(0, 5) ?? '08:00')
  const [workEnd, setWorkEnd] = useState(profile?.work_end_time?.slice(0, 5) ?? '17:00')
  const [eodEnabled, setEodEnabled] = useState(profile?.eod_review_enabled ?? true)
  const [eodTime, setEodTime] = useState(profile?.eod_review_time?.slice(0, 5) ?? '16:45')
  const [taskPopups, setTaskPopups] = useState(profile?.task_popups_enabled ?? true)
  const [timezone, setTimezone] = useState(profile?.popup_timezone ?? 'America/Chicago')
  const [autoPush, setAutoPush] = useState(profile?.auto_push_tasks ?? false)
  const [skipWeekends, setSkipWeekends] = useState(profile?.skip_weekends_holidays ?? false)
  const [schedSaving, setSchedSaving] = useState(false)
  const [schedSaved, setSchedSaved] = useState(false)
  const [blockedDays, setBlockedDays] = useState(() => normalizeBlockedDays(profile?.blocked_days))
  const [newBlockedDate, setNewBlockedDate] = useState('')
  const [newBlockedNote, setNewBlockedNote] = useState('')

  async function saveSchedule() {
    if (!profile?.id) return
    setSchedSaving(true)
    const updates = {
      work_start_time: workStart,
      work_end_time: workEnd,
      eod_review_enabled: eodEnabled,
      eod_review_time: eodTime,
      task_popups_enabled: taskPopups,
      popup_timezone: timezone,
      auto_push_tasks: autoPush,
      skip_weekends_holidays: skipWeekends,
      updated_at: new Date().toISOString(),
    }
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update(updates).eq('id', profile.id).select().single()
    setSchedSaving(false)
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setSchedSaved(true)
    setTimeout(() => setSchedSaved(false), 2000)
  }

  async function addBlockedDay() {
    if (!newBlockedDate || !profile?.id) return
    const updated = upsertBlockedDay(blockedDays, {
      date: newBlockedDate,
      ...(newBlockedNote.trim() ? { note: newBlockedNote.trim() } : {}),
    })
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setBlockedDays(updated)
    setNewBlockedDate('')
    setNewBlockedNote('')
  }

  async function removeBlockedDayEntry(date: string) {
    if (!profile?.id) return
    const updated = removeBlockedDay(blockedDays, date)
    const { data, error } = await (supabase as any).schema('platform').from('user_profiles')
      .update({ blocked_days: updated }).eq('id', profile.id).select().single()
    if (error) { console.error(error); return }
    setProfile({ ...profile, ...data })
    setBlockedDays(updated)
  }

  const initials = (profile?.full_name ?? profile?.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <>
      <div
        className="fixed inset-0 z-50"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="profile-panel fixed right-0 top-0 bottom-0 z-50 w-80 bg-[#F2F1E6] dark:bg-[#002745] shadow-2xl border-l border-navy/20 dark:border-[#F2F1E6]/10 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <span className="text-xs font-heading text-navy dark:text-[#F2F1E6] uppercase tracking-widest">Profile</span>
          <button
            onClick={onClose}
            className="text-inky hover:text-navy dark:text-[#F2F1E6]/60 dark:hover:text-[#F2F1E6] transition-colors p-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable content — grows with the number of profile options */}
        <div className="flex-1 min-h-0 overflow-y-auto">
        {/* User info */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-navy dark:bg-[#4F7489] flex items-center justify-center text-cream text-sm font-heading flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-heading text-navy dark:text-[#F2F1E6] truncate">
              {profile?.full_name ?? '—'}
            </div>
            <div className="text-xs font-mono text-inky dark:text-[#F2F1E6]/60 truncate">
              {profile?.email}
            </div>
            <div className="mt-1 inline-block text-[10px] font-heading text-[#F2F1E6] bg-[#4F7489] rounded px-1.5 py-0.5 uppercase tracking-wide">
              {getRoleLabel(profile?.role)}
            </div>
          </div>
        </div>

        {/* Appearance */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
            Appearance
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-body text-navy dark:text-[#F2F1E6]">
              {dark ? 'Dark mode' : 'Light mode'}
            </span>
            <button
              onClick={toggle}
              className={[
                'relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none',
                dark ? 'bg-[#4F7489]' : 'bg-navy/20',
              ].join(' ')}
            >
              <span className={[
                'inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200',
                dark ? 'translate-x-[18px]' : 'translate-x-0.5',
              ].join(' ')} />
            </button>
          </div>
        </div>

        {/* Location Exclusions */}
        <LocationExclusionsConfig />

        {/* Quick Access hover buttons */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">Quick Access Buttons</div>
          <p className="text-[10px] font-mono text-inky/60 dark:text-[#F2F1E6]/50 mb-2">Which hover buttons show in the bottom-right corner.</p>
          <div className="flex flex-col gap-1.5">
            {QUICK_FAB_META.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                <input type="checkbox" checked={enabledFabs.includes(f.key)} onChange={() => setEnabledFabs(enabledFabs.includes(f.key) ? enabledFabs.filter((x) => x !== f.key) : [...enabledFabs, f.key])} className="accent-sky" />
                {f.label}
              </label>
            ))}
          </div>
        </div>

        {/* Sidebar sections */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">Sidebar Sections</div>
          <p className="text-[10px] font-mono text-inky/60 dark:text-[#F2F1E6]/50 mb-2">Uncheck a section to hide it from the sidebar.</p>
          <div className="flex flex-col gap-1.5">
            {accessibleSections.map((k) => (
              <label key={k} className="flex items-center gap-2 text-xs font-body text-navy dark:text-[#F2F1E6] cursor-pointer">
                <input type="checkbox" checked={!hiddenSections.includes(k)} onChange={() => setHiddenSections(hiddenSections.includes(k) ? hiddenSections.filter((x) => x !== k) : [...hiddenSections, k])} className="accent-sky" />
                {sectionLabel(k)}
              </label>
            ))}
          </div>
        </div>

        {/* Daily Schedule */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
            Daily Schedule
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Work Start</label>
              <input type="time" value={workStart} onChange={(e) => setWorkStart(e.target.value)}
                style={{ colorScheme: dark ? 'dark' : 'light' }}
                className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Work End</label>
              <input type="time" value={workEnd} onChange={(e) => setWorkEnd(e.target.value)}
                style={{ colorScheme: dark ? 'dark' : 'light' }}
                className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
            </div>
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Timezone</label>
              <select value={timezone} onChange={(e) => setTimezone(e.target.value)}
                className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-cream dark:bg-navy/40 text-navy dark:text-cream px-2 py-1 focus:border-[#00e5ff] focus:outline-none max-w-[160px]">
                {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz.replace('America/', '').replace('Pacific/', '')}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Task Popups</span>
              <button onClick={() => setTaskPopups((v) => !v)}
                className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', taskPopups ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', taskPopups ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
              </button>
            </div>
          </div>
        </div>

        {/* End of Day Review */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
            End of Day Review
          </div>
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Enable EOD Prompt</span>
              <button onClick={() => setEodEnabled((v) => !v)}
                className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', eodEnabled ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', eodEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
              </button>
            </div>
            {eodEnabled && (
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-mono text-navy dark:text-[#F2F1E6] whitespace-nowrap">Prompt at</label>
                <input type="time" value={eodTime} onChange={(e) => setEodTime(e.target.value)}
                  style={{ colorScheme: dark ? 'dark' : 'light' }}
                  className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-navy text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none" />
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Auto-push incomplete</span>
              <button onClick={() => setAutoPush((v) => !v)}
                className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', autoPush ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', autoPush ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-navy dark:text-[#F2F1E6]">Skip weekends &amp; holidays</span>
              <button onClick={() => setSkipWeekends((v) => !v)}
                className={['relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-200 focus:outline-none', skipWeekends ? 'bg-[#4F7489]' : 'bg-navy/20'].join(' ')}>
                <span className={['inline-block h-3.5 w-3.5 rounded-full bg-white shadow transform transition-transform duration-200', skipWeekends ? 'translate-x-[18px]' : 'translate-x-0.5'].join(' ')} />
              </button>
            </div>
          </div>
          <button onClick={saveSchedule} disabled={schedSaving}
            className={['mt-3 w-full text-xs font-mono rounded px-3 py-1.5 transition-colors', schedSaved ? 'bg-green-600 text-white' : 'bg-navy dark:bg-[#4F7489] text-cream hover:bg-inky disabled:opacity-40'].join(' ')}>
            {schedSaving ? 'Saving…' : schedSaved ? '✓ Saved' : 'Save Schedule'}
          </button>
        </div>

        {/* My Blocked Days */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-1">
            My Blocked Days
          </div>
          <p className="text-[10px] font-mono text-inky/70 dark:text-[#F2F1E6]/50 mb-3">
            Tasks won&apos;t push to these dates.
          </p>
          <div className="flex flex-col gap-2 mb-3">
            <input
              type="date"
              value={newBlockedDate}
              onChange={(e) => setNewBlockedDate(e.target.value)}
              style={{ colorScheme: dark ? 'dark' : 'light' }}
              className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-[#0D3555] text-navy dark:text-[#F2F1E6] px-2 py-1 focus:border-[#00e5ff] focus:outline-none"
            />
            <input
              type="text"
              value={newBlockedNote}
              onChange={(e) => setNewBlockedNote(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addBlockedDay()}
              placeholder="Note (optional)"
              className="text-xs font-mono rounded border border-navy/20 dark:border-[#F2F1E6]/20 bg-[#F2F1E6] dark:bg-[#0D3555] text-navy dark:text-[#F2F1E6] placeholder-inky/50 px-2 py-1 focus:border-[#00e5ff] focus:outline-none"
            />
            <button
              onClick={addBlockedDay}
              disabled={!newBlockedDate}
              className="text-xs font-mono rounded px-2 py-1 bg-navy dark:bg-[#4F7489] text-cream hover:bg-inky disabled:opacity-40 transition-colors"
            >
              + Add
            </button>
          </div>
          {blockedDays.length === 0 ? (
            <p className="text-[10px] font-mono text-inky/50 dark:text-[#F2F1E6]/40 italic">No blocked days.</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {blockedDays.map((bd) => (
                <div key={bd.date} className="flex items-center justify-between gap-2">
                  <span className="text-[10px] font-mono text-navy dark:text-[#F2F1E6] flex-1 min-w-0 break-words">
                    {formatBlockedDayLabel(bd)}
                  </span>
                  <button
                    onClick={() => removeBlockedDayEntry(bd.date)}
                    className="text-[10px] font-mono text-inky/50 hover:text-[#C0392B] dark:text-[#F2F1E6]/40 dark:hover:text-[#C0392B] transition-colors flex-shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Outlook Sync (placeholder for Phase 9) */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
            Integrations
          </div>
          <div className="flex items-center justify-between opacity-40 cursor-not-allowed" title="Available after Microsoft login is configured">
            <div>
              <div className="text-sm font-body text-navy dark:text-cream">Outlook Calendar Sync</div>
              <div className="text-[10px] font-mono text-inky dark:text-[#F2F1E6]/70 mt-0.5 leading-relaxed">
                Sync your Outlook calendar to SB Net
              </div>
            </div>
            <div className="h-5 w-9 rounded-full bg-navy/20 flex-shrink-0" />
          </div>
        </div>

        {/* Admin link */}
        {isAdminOrDeveloper(profile?.role) && (
          <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10">
            <div className="text-[10px] font-heading text-navy/60 dark:text-[#F2F1E6]/90 uppercase tracking-widest mb-3">
              Administration
            </div>
            <NavLink
              to="/admin/users"
              onClick={onClose}
              className="flex items-center gap-2 text-sm font-body text-navy dark:text-[#F2F1E6] hover:text-inky dark:hover:text-[#F2F1E6]/80 transition-colors"
            >
              {ICONS.users}
              User Management
            </NavLink>
            <NavLink
              to="/dev-hub"
              onClick={onClose}
              className="flex items-center gap-2 mt-2 text-sm font-body text-navy dark:text-[#F2F1E6] hover:text-inky dark:hover:text-[#F2F1E6]/80 transition-colors"
            >
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
              </svg>
              Developer Hub
            </NavLink>
          </div>
        )}

        {/* Sign out */}
        <div className="px-4 py-4 mt-auto">
          <button
            onClick={() => supabase.auth.signOut()}
            className="flex items-center gap-2 text-sm font-body text-[#C0392B] hover:text-[#A93226] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            Sign out
          </button>
        </div>
        </div>
      </div>
    </>
  )
}

// ── Collapsed icon-only view ──────────────────────────────────────────────

function CollapsedNav({
  onProfileOpen,
  onNavClick,
  onToggleCollapsed,
}: {
  onProfileOpen: () => void
  onNavClick?: () => void
  onToggleCollapsed?: () => void
}) {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowedSections = useDeptAccess()
  const [hiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])
  const { sectionCollapsed } = useSidebarPrefs()
  // Mirror the General (utility) section's expanded/pinned state so the collapsed
  // rail shows exactly what was visible in the expanded sidebar.
  const genExpanded = (() => { try { return localStorage.getItem('sb:sc:expanded') !== 'false' } catch { return true } })()
  const genPinned: string[] = (() => { try { return JSON.parse(localStorage.getItem('sb:sc:pinned') || '[]') } catch { return [] } })()
  const shownUtility = genExpanded ? UTILITY_ITEMS : UTILITY_ITEMS.filter((i) => genPinned.includes(i.key))
  // Hover flyout label — rendered via portal so it escapes the sidebar's clip.
  const [flyout, setFlyout] = useState<{ label: string; top: number } | null>(null)
  const showFlyout = (e: React.MouseEvent, label: string) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFlyout({ label, top: r.top + r.height / 2 }) }
  const allItems = Object.entries(SECTION_ITEMS)
    .filter(([k]) => {
      if (hiddenSections.includes(k)) return false
      if (sectionCollapsed[k]) return false // only show items from expanded sections
      if (k === 'global-config') return isAdmin
      if (allowedSections !== null) return allowedSections.has(k)
      return true
    })
    .flatMap(([, items]) => items)
  const initials = (profile?.full_name ?? profile?.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto hover-scroll py-2">
        {allItems.filter((i) => i.to).map((item) => (
          <NavLink
            key={item.key}
            to={item.to!}
            onClick={onNavClick}
            onMouseEnter={(e) => showFlyout(e, item.label)}
            onMouseLeave={() => setFlyout(null)}
            className={({ isActive }) =>
              [
                'flex items-center justify-center py-2.5 mx-1 rounded transition-all duration-100',
                isActive
                  ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                  : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
              ].join(' ')
            }
          >
            {ICONS[item.key] ?? ICONS.dashboard}
          </NavLink>
        ))}
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
      <button
        onClick={onProfileOpen}
        className="flex items-center justify-center py-2.5 border-t border-[#F2F1E6]/8 hover:bg-[#F2F1E6]/5 transition-colors"
        title="Profile"
      >
        <div className="w-7 h-7 rounded-full bg-[#4F7489] flex items-center justify-center text-[10px] font-heading text-[#F2F1E6]">
          {initials}
        </div>
      </button>
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
}: {
  onNavClick?: () => void
  showHeader?: boolean
  onToggleCollapsed?: () => void
}) {
  const [profileOpen, setProfileOpen] = useState(false)
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
    setItemOrder,
  } = useSidebarPrefs()

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
    <>
      {/* Header */}
      {showHeader && (
        <div className="flex items-center px-3 h-12 border-b border-[#F2F1E6]/8 flex-shrink-0">
          <span className="text-sm font-heading font-bold text-[#F2F1E6] tracking-wide uppercase">Strickland Brothers</span>
        </div>
      )}

      {/* Scrollable nav */}
      <div className="flex-1 overflow-y-auto hover-scroll">
        <FavoritesSection
          favorites={favorites}
          showLabels
          onToggleFavorite={toggleFavorite}
          onNavClick={onNavClick}
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
                collapsed={!!sectionCollapsed[sectionKey]}
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

      {/* Profile button */}
      <ProfileButton onOpen={() => setProfileOpen(true)} collapsed={false} />

      {/* Logo watermark + SB Net wordmark */}
      <div className="px-3 py-3 flex items-center justify-center gap-2 border-t border-[#F2F1E6]/8">
        <img src={sbLogo} alt="Strickland Brothers" className="max-w-[80px] opacity-40" />
        <span className="text-xs font-heading text-[#F2F1E6]/50 tracking-widest uppercase">SB Net</span>
      </div>

      {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
    </>
  )
}

export function Sidebar({ collapsed, onToggleCollapsed, mobile, mobileOpen, onMobileClose }: SidebarProps) {
  useInventoryAlerts() // load alert counts once for the nav badge
  const [profileOpen, setProfileOpen] = useState(false)

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
        collapsed ? 'w-14' : 'w-64',
      ].join(' ')}
    >
      {collapsed ? (
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
          <CollapsedNav onProfileOpen={() => setProfileOpen(true)} onToggleCollapsed={onToggleCollapsed} />
          {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
        </>
      ) : (
        <ExpandedSidebar showHeader onToggleCollapsed={onToggleCollapsed} />
      )}
    </aside>
  )
}
