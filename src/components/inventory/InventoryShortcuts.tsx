import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical, Settings } from 'lucide-react'
import { SECTION_ITEMS, ICONS, type NavItem } from '@/components/layout/Sidebar'
import { useNavBadge } from '@/hooks/useNavBadges'
import { useProfilePref } from '@/hooks/useProfilePrefs'

const ITEMS: NavItem[] = [...SECTION_ITEMS.inventory.filter((i) => i.key !== 'dashboard' && i.to), { key: 'issues', label: 'Issues', to: '/issues' }]
const DEFAULT_ORDER = ITEMS.map((i) => i.key)
const byKey = new Map(ITEMS.map((i) => [i.key, i]))

// Reorderable quick-access buttons for the inventory sub-pages (Dashboard).
// Order follows the user across devices (profile-backed).
export function InventoryShortcuts() {
  const navigate = useNavigate()
  const [customize, setCustomize] = useState(false)
  const [orderPref, setOrderPref] = useProfilePref<string[]>('dashboard:inv-shortcuts', DEFAULT_ORDER)
  const order = useMemo(() => { const k = orderPref.filter((x) => byKey.has(x)); return [...k, ...DEFAULT_ORDER.filter((x) => !k.includes(x))] }, [orderPref])
  const persist = (next: string[]) => setOrderPref(next)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const shown = order.map((k) => byKey.get(k)).filter(Boolean) as NavItem[]

  return (
    <>
      <div className="flex flex-wrap justify-center gap-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragEnd={(e: DragEndEvent) => { const { active, over } = e; if (over && active.id !== over.id) persist(arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))) }}>
          <SortableContext items={order} strategy={rectSortingStrategy}>
            {shown.map((it) => (
              <Shortcut key={it.key} item={it} customize={customize}
                onGo={() => it.to && navigate(it.to)} />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Pinned to the page's top-right corner rather than sitting in the
          flow, so it never pushes the dashboard header around. Positions
          against Dashboard's root, which is the nearest relative ancestor. */}
      <div className="absolute top-0 right-0 z-20 flex items-center gap-2">
        {customize && (
          <button onClick={() => persist(DEFAULT_ORDER)}
            className="rounded-full bg-cream/80 border border-navy/30 text-navy px-3 py-1.5 text-xs font-mono shadow-lg hover:bg-cream hover:border-navy transition-colors">
            Reset
          </button>
        )}
        <button onClick={() => setCustomize((o) => !o)}
          title={customize ? 'Done customizing' : 'Customize shortcuts'}
          aria-label={customize ? 'Done customizing' : 'Customize shortcuts'}
          className={`flex items-center justify-center rounded-full p-2 shadow-lg transition-colors ${customize ? 'bg-sky text-navy hover:bg-sky/80' : 'bg-navy/80 text-cream hover:bg-navy'}`}>
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </>
  )
}

function Shortcut({ item, customize, onGo }: { item: NavItem; customize: boolean; onGo: () => void }) {
  const badge = useNavBadge(item.key)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key, disabled: !customize })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  return (
    <div ref={setNodeRef} style={style}
      className={`relative w-40 h-20 rounded-lg border flex flex-col items-center justify-center gap-1.5 text-sm font-heading text-navy transition-colors ${customize ? 'border-sky/60 bg-sky/5 cursor-grab active:cursor-grabbing' : 'border-navy/20 bg-cream hover:border-navy hover:bg-navy/5 cursor-pointer'}`}
      {...(customize ? { ...attributes, ...listeners } : { onClick: onGo })}>
      {customize && <GripVertical className="absolute top-1.5 left-1.5 w-3 h-3 text-inky/40" />}
      {badge > 0 && (
        <span className="absolute -top-1.5 -right-1.5 rounded-full bg-[#C0392B] text-[#F2F1E6] text-[10px] font-mono leading-none px-1.5 py-0.5 min-w-[18px] text-center shadow">{badge}</span>
      )}
      {ICONS[item.key] ?? null}
      <span className="text-center leading-tight px-1">{item.label}</span>
    </div>
  )
}
