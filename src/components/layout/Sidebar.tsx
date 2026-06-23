import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
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
import { isAdminOrDeveloper, getRoleLabel } from '@/lib/roles'
import sbLogo from '@/assets/logo-cream.png'
import sbIcon from '@/assets/SBOC-IconCream.png'

// ── Icons ──────────────────────────────────────────────────────────────────

function Icon({ d, d2 }: { d: string; d2?: string }) {
  return (
    <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d} />
      {d2 && <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={d2} />}
    </svg>
  )
}

const ICONS: Record<string, JSX.Element> = {
  dashboard: <Icon d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />,
  monthend: <Icon d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />,
  weekly: <Icon d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
  orders: <Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />,
  config: <Icon d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" d2="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
  outlier: <Icon d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />,
  projects: <Icon d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />,
  calendar: <Icon d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />,
  issues: <Icon d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />,
  meetings: <Icon d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />,
  'feature-requests': <Icon d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />,
  tasks: <Icon d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />,
  users: <Icon d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />,
  drag: (
    <svg className="w-3 h-3 flex-shrink-0 text-[#F2F1E6]/25" fill="currentColor" viewBox="0 0 24 24">
      <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
    </svg>
  ),
}

// ── Nav data ───────────────────────────────────────────────────────────────

interface NavItem {
  key: string
  label: string
  to: string | null
}

const SECTION_ITEMS: Record<string, NavItem[]> = {
  inventory: [
    { key: 'dashboard', label: 'Dashboard', to: '/dashboard' },
    { key: 'monthend', label: 'Month End Count', to: '/monthend' },
    { key: 'weekly', label: 'Weekly Count', to: '/weekly' },
    { key: 'orders', label: 'Orders', to: '/orders' },
    { key: 'projects', label: 'Projects', to: '/projects' },
    { key: 'config', label: 'Configuration', to: '/config' },
  ],
  operations: [],
  finance: [{ key: 'finance-soon', label: 'Coming Soon', to: null }],
  accounting: [{ key: 'accounting-soon', label: 'Coming Soon', to: null }],
  marketing: [{ key: 'marketing-soon', label: 'Coming Soon', to: null }],
}

const SECTION_META: Record<string, { label: string; emoji: string }> = {
  inventory: { label: 'Inventory', emoji: '📦' },
  operations: { label: 'Operations', emoji: '🏢' },
  finance: { label: 'Finance', emoji: '💰' },
  accounting: { label: 'Accounting', emoji: '📊' },
  marketing: { label: 'Marketing', emoji: '📣' },
}

const UTILITY_ITEMS: NavItem[] = [
  { key: 'calendar', label: 'Calendar', to: '/schedule' },
  { key: 'issues', label: 'Issues', to: '/issues' },
  { key: 'meetings', label: 'Meeting Notes', to: '/meetings' },
  { key: 'feature-requests', label: 'Feature Requests', to: '/feature-requests' },
  { key: 'tasks', label: 'Tasks', to: '/tasks' },
]

// ── Sub-components ─────────────────────────────────────────────────────────

function StarButton({ active, onClick }: { active: boolean; onClick: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      title={active ? 'Remove from favorites' : 'Add to favorites'}
      className={[
        'flex-shrink-0 transition-all duration-100 rounded p-0.5',
        active ? 'text-yellow-400 opacity-100' : 'text-[#F2F1E6]/25 opacity-0 group-hover:opacity-100 hover:text-yellow-300',
      ].join(' ')}
    >
      <svg className="w-3 h-3" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
      </svg>
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
              : 'text-[#4F7489] hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
          ].join(' ')
        }
      >
        <span className="group-hover/row:hidden">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        <span className="hidden group-hover/row:block">{ICONS[item.key] ?? (item.key.startsWith('outlier-') ? ICONS.outlier : ICONS.dashboard)}</span>
        {showLabel && <span className="truncate flex-1">{item.label}</span>}
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
        <div className="px-3 pt-3 pb-1 text-[10px] font-heading text-[#F2F1E6]/35 uppercase tracking-widest">
          ⭐ Favorites
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
      ? itemOrder.map((k) => baseItems.find((i) => i.key === k)).filter((i): i is NavItem => !!i)
      : baseItems

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleItemDragEnd = (event: DragEndEvent, setItemOrd: (k: string, items: string[]) => void) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = items.findIndex((i) => i.key === active.id)
    const newIdx = items.findIndex((i) => i.key === over.id)
    if (oldIdx !== -1 && newIdx !== -1) {
      const reordered = arrayMove(items, oldIdx, newIdx)
      setItemOrd(sectionKey, reordered.map((i) => i.key))
    }
  }

  if (!showLabels) {
    return (
      <div ref={setNodeRef} style={style} className="py-0.5">
        {items.map((item) => (
          <div key={item.key} className="group/row">
            <NavItemLink item={item} showLabel={false} onNavClick={onNavClick} />
          </div>
        ))}
      </div>
    )
  }

  return (
    <div ref={setNodeRef} style={style} className="py-0.5">
      {/* Section header */}
      <div className="flex items-center gap-1 px-2 py-1.5 group/section">
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
          <span className="text-[10px] leading-none">{meta?.emoji}</span>
          <span className="text-[10px] font-heading text-[#F2F1E6]/50 uppercase tracking-widest truncate flex-1">
            {meta?.label}
          </span>
          <svg
            className={[
              'w-3 h-3 flex-shrink-0 text-[#F2F1E6]/30 transition-transform duration-150',
              collapsed ? '' : 'rotate-90',
            ].join(' ')}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Section items */}
      {!collapsed && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={(e) => handleItemDragEnd(e, () => {})}
        >
          <SortableContext items={items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
            {items.map((item) => (
              <SortableNavItem
                key={item.key}
                item={item}
                showLabel
                isFavorite={favorites.includes(item.key)}
                onToggleFavorite={onToggleFavorite}
                onNavClick={onNavClick}
              />
            ))}
          </SortableContext>
        </DndContext>
      )}
    </div>
  )
}

function UtilityNav({
  order,
  showLabels,
  onNavClick,
  hideLabel,
}: {
  order: string[]
  showLabels: boolean
  onNavClick?: () => void
  hideLabel?: boolean
}) {
  const orderedItems = order
    .map((k) => UTILITY_ITEMS.find((i) => i.key === k))
    .filter((i): i is NavItem => !!i)
  // Include any items not in persisted order
  const missing = UTILITY_ITEMS.filter((i) => !order.includes(i.key))
  const items = [...orderedItems, ...missing]

  return (
    <div className="pt-1 pb-1">
      {showLabels && !hideLabel && (
        <div className="px-3 pt-1 pb-0.5 text-[10px] font-heading text-[#F2F1E6]/30 uppercase tracking-widest">
          Quick Access
        </div>
      )}
      {items.map((item) => (
        item.to ? (
          <NavLink
            key={item.key}
            to={item.to}
            onClick={onNavClick}
            className={({ isActive }) =>
              [
                'flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded text-xs font-heading transition-all duration-100',
                isActive
                  ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                  : 'text-[#4F7489] hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
              ].join(' ')
            }
          >
            {ICONS[item.key] ?? ICONS.dashboard}
            {showLabels && <span className="truncate">{item.label}</span>}
          </NavLink>
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

// ── Profile Panel (slide-out drawer) ──────────────────────────────────────

function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { profile } = useAuthStore()
  const { dark, toggle } = useDarkMode()

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
      <div className="fixed right-0 top-0 bottom-0 z-50 w-80 bg-cream dark:bg-navy shadow-2xl border-l border-navy/20 dark:border-[#F2F1E6]/10 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-navy/10 dark:border-[#F2F1E6]/10">
          <span className="text-xs font-heading text-navy dark:text-cream uppercase tracking-widest">Profile</span>
          <button
            onClick={onClose}
            className="text-inky hover:text-navy dark:text-[#F2F1E6]/60 dark:hover:text-[#F2F1E6] transition-colors p-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* User info */}
        <div className="px-4 py-4 border-b border-navy/10 dark:border-[#F2F1E6]/10 flex items-start gap-3">
          <div className="w-12 h-12 rounded-full bg-navy dark:bg-[#4F7489] flex items-center justify-center text-cream text-sm font-heading flex-shrink-0">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-heading text-navy dark:text-cream truncate">
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
            <span className="text-sm font-body text-navy dark:text-cream">
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
                dark ? 'translate-x-4.5' : 'translate-x-1',
              ].join(' ')} />
            </button>
          </div>
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
              className="flex items-center gap-2 text-sm font-body text-navy dark:text-cream hover:text-inky dark:hover:text-[#F2F1E6]/80 transition-colors"
            >
              {ICONS.users}
              User Management
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
  const allItems = Object.values(SECTION_ITEMS).flat()
  const initials = (profile?.full_name ?? profile?.email ?? '?')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex-1 overflow-y-auto py-2">
        {allItems.filter((i) => i.to).map((item) => (
          <NavLink
            key={item.key}
            to={item.to!}
            onClick={onNavClick}
            title={item.label}
            className={({ isActive }) =>
              [
                'flex items-center justify-center py-2.5 mx-1 rounded transition-all duration-100',
                isActive
                  ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                  : 'text-[#4F7489] hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
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
            className="flex items-center justify-center w-8 h-8 rounded text-[#4F7489] hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}

      <div className="border-t border-[#F2F1E6]/8 py-1">
        {UTILITY_ITEMS.map((item) =>
          item.to ? (
            <NavLink
              key={item.key}
              to={item.to}
              onClick={onNavClick}
              title={item.label}
              className={({ isActive }) =>
                [
                  'flex items-center justify-center py-2 mx-1 rounded transition-all duration-100',
                  isActive
                    ? 'bg-[#F2F1E6]/10 text-[#F2F1E6]'
                    : 'text-[#4F7489] hover:text-[#F2F1E6] hover:bg-[#F2F1E6]/5',
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
  const [outlierItems, setOutlierItems] = useState<NavItem[]>([])

  useEffect(() => {
    async function loadOutlierDepts() {
      try {
        const sb = supabase as any
        const { data } = await sb.schema('outlier').from('departments').select('id, name').order('name')
        if (data && data.length > 0) {
          setOutlierItems(
            data.map((d: any) => ({
              key: `outlier-${d.id}`,
              label: d.name,
              to: `/operations/outlier/${d.id}`,
            }))
          )
        }
      } catch {
        // outlier schema not configured — leave operations empty
      }
    }
    loadOutlierDepts()
  }, [])

  const {
    sectionOrder,
    sectionCollapsed,
    itemOrder,
    favorites,
    utilityNavOrder,
    setSectionOrder,
    toggleSection,
    toggleFavorite,
  } = useSidebarPrefs()

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
          <span className="text-xs font-heading text-[#F2F1E6]/60 tracking-widest uppercase">SB Net</span>
        </div>
      )}

      {/* Scrollable nav */}
      <div className="flex-1 overflow-y-auto">
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
          <SortableContext items={sectionOrder} strategy={verticalListSortingStrategy}>
            {sectionOrder.map((sectionKey) => (
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
                overrideItems={sectionKey === 'operations' && outlierItems.length > 0 ? outlierItems : undefined}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Collapse toggle — above quick access */}
      {onToggleCollapsed && (
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-[#F2F1E6]/8">
          <span className="text-[10px] font-heading text-[#F2F1E6]/30 uppercase tracking-widest">Quick Access</span>
          <button
            onClick={onToggleCollapsed}
            title="Collapse sidebar"
            className="flex items-center gap-1 text-[#4F7489] hover:text-[#F2F1E6] transition-colors px-1.5 py-1 rounded hover:bg-[#F2F1E6]/5"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
      )}

      {/* Utility nav */}
      <UtilityNav order={utilityNavOrder} showLabels onNavClick={onNavClick} hideLabel />

      {/* Profile button */}
      <ProfileButton onOpen={() => setProfileOpen(true)} collapsed={false} />

      {/* Logo watermark */}
      <div className="px-3 py-2 flex justify-center border-t border-[#F2F1E6]/8">
        <img src={sbLogo} alt="Strickland Brothers" className="w-full max-w-[100px] opacity-40" />
      </div>

      {profileOpen && <ProfilePanel onClose={() => setProfileOpen(false)} />}
    </>
  )
}

export function Sidebar({ collapsed, onToggleCollapsed, mobile, mobileOpen, onMobileClose }: SidebarProps) {
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
              className="text-[#4F7489] hover:text-[#F2F1E6] transition-colors"
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
