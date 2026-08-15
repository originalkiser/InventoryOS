import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { SECTION_ITEMS, ICONS, type NavItem } from '@/components/layout/Sidebar'
import { useInventoryAlertsStore } from '@/hooks/useInventoryAlerts'
import { useProfilePref } from '@/hooks/useProfilePrefs'

const ITEMS = SECTION_ITEMS.inventory.filter((i) => i.key !== 'dashboard' && i.to)
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
  const alertCount = useInventoryAlertsStore((s) => s.derivedCount)

  return (
    <>
      <div className="flex flex-wrap justify-center gap-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter}
          onDragEnd={(e: DragEndEvent) => { const { active, over } = e; if (over && active.id !== over.id) persist(arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))) }}>
          <SortableContext items={order} strategy={rectSortingStrategy}>
            {shown.map((it) => (
              <Shortcut key={it.key} item={it} customize={customize}
                badge={it.key === 'inventory-alerts' ? alertCount : 0}
                onGo={() => it.to && navigate(it.to)} />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Floating customize control — bottom-right, like Location Lookup */}
      <div className="fixed bottom-6 right-6 z-30 flex items-center gap-2">
        {customize && (
          <button onClick={() => persist(DEFAULT_ORDER)}
            className="rounded-full bg-cream border border-navy/30 text-navy px-3 py-2.5 text-xs font-mono shadow-lg hover:border-navy transition-colors">
            Reset
          </button>
        )}
        <button onClick={() => setCustomize((o) => !o)}
          className="rounded-full bg-navy text-cream px-5 py-2.5 text-xs font-mono uppercase tracking-wide shadow-lg hover:bg-navy/90 transition-colors">
          {customize ? 'Done' : 'Customize'}
        </button>
      </div>
    </>
  )
}

function Shortcut({ item, customize, badge, onGo }: { item: NavItem; customize: boolean; badge: number; onGo: () => void }) {
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
