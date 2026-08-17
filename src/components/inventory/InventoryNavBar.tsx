import { useMemo, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Eye, EyeOff, Settings2, Check } from 'lucide-react'
import { SECTION_ITEMS, ICONS, type NavItem } from '@/components/layout/Sidebar'
import { useNavBadge } from '@/hooks/useNavBadges'
import { useProfilePref } from '@/hooks/useProfilePrefs'

const ITEMS: NavItem[] = [...SECTION_ITEMS.inventory.filter((i) => i.to), { key: 'issues', label: 'Issues', to: '/issues' }]
const DEFAULT_ORDER = ITEMS.map((i) => i.key)
const byKey = new Map(ITEMS.map((i) => [i.key, i]))

// Persistent one-row nav for inventory pages: horizontally scrollable, with a
// Customize mode to drag-reorder and hide buttons the user rarely uses. Order +
// hidden set follow the user across devices (profile-backed).
export function InventoryNavBar() {
  const [customize, setCustomize] = useState(false)
  const [orderPref, setOrderPref] = useProfilePref<string[]>('inv-navbar:order', DEFAULT_ORDER)
  const [hidden, setHidden] = useProfilePref<string[]>('inv-navbar:hidden', [])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))

  // Reconcile stored order against the current item set (keep known, append new).
  const order = useMemo(() => { const k = orderPref.filter((x) => byKey.has(x)); return [...k, ...DEFAULT_ORDER.filter((x) => !k.includes(x))] }, [orderPref])
  const persistOrder = (n: string[]) => setOrderPref(n)
  const toggleHide = (k: string) => setHidden(hidden.includes(k) ? hidden.filter((x) => x !== k) : [...hidden, k])

  const list = order.map((k) => byKey.get(k)).filter(Boolean) as NavItem[]
  const visible = customize ? list : list.filter((i) => !hidden.includes(i.key))

  return (
    <div className="sticky top-0 z-20 bg-cream/95 backdrop-blur border-b border-navy/15 flex items-center gap-2 px-3 sm:px-6 py-1.5">
      <div className="flex items-center gap-1.5 overflow-x-auto flex-1 hover-scroll-x">
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragEnd={(e: DragEndEvent) => { const { active, over } = e; if (over && active.id !== over.id) persistOrder(arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))) }}>
          <SortableContext items={visible.map((i) => i.key)} strategy={horizontalListSortingStrategy}>
            {visible.map((it) => (
              <NavPill key={it.key} item={it} customize={customize} hidden={hidden.includes(it.key)}
                onToggleHide={() => toggleHide(it.key)} />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <button onClick={() => setCustomize((o) => !o)} title={customize ? 'Done' : 'Customize navigation'}
        className="flex-shrink-0 inline-flex items-center gap-1 rounded-md border border-navy/30 px-2 py-1.5 text-[11px] font-mono text-inky hover:border-navy">
        {customize ? <><Check className="w-3.5 h-3.5" /> Done</> : <Settings2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  )
}

function NavPill({ item, customize, hidden, onToggleHide }: { item: NavItem; customize: boolean; hidden: boolean; onToggleHide: () => void }) {
  const badge = useNavBadge(item.key)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key, disabled: !customize })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  const cls = 'flex-shrink-0 inline-flex items-center gap-1.5 rounded-md px-2.5 h-8 text-xs font-heading transition-colors'
  const inner = (
    <>
      {ICONS[item.key] ?? null}
      <span className="whitespace-nowrap">{item.label}</span>
      {badge > 0 && <span className="ml-0.5 rounded-full bg-[#C0392B] text-[#F2F1E6] text-[9px] font-mono leading-none px-1.5 py-0.5 min-w-[16px] text-center">{badge}</span>}
    </>
  )

  if (customize) {
    return (
      <div ref={setNodeRef} style={style} className={`${cls} border border-sky/60 bg-sky/5 text-navy cursor-grab active:cursor-grabbing ${hidden ? 'opacity-40' : ''}`} {...attributes} {...listeners}>
        <GripVertical className="w-3 h-3 text-inky/40" />
        {inner}
        <button onClick={(e) => { e.stopPropagation(); onToggleHide() }} onPointerDown={(e) => e.stopPropagation()} title={hidden ? 'Show' : 'Hide'} className="text-inky/50 hover:text-navy">
          {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
    )
  }
  return (
    <NavLink ref={setNodeRef} style={style} to={item.to!}
      className={({ isActive }) => `${cls} ${isActive ? 'bg-navy text-cream' : 'text-navy border border-transparent hover:bg-navy/5 hover:border-navy/20'}`}>
      {inner}
    </NavLink>
  )
}
