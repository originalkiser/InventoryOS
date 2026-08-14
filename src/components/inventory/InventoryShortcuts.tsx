import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'
import { SECTION_ITEMS, ICONS, type NavItem } from '@/components/layout/Sidebar'

const ORDER_KEY = 'dashboard:inv-shortcuts'
const ITEMS = SECTION_ITEMS.inventory.filter((i) => i.key !== 'dashboard' && i.to)
const DEFAULT_ORDER = ITEMS.map((i) => i.key)
const byKey = new Map(ITEMS.map((i) => [i.key, i]))

// Reorderable quick-access buttons for the inventory sub-pages (Dashboard).
export function InventoryShortcuts() {
  const navigate = useNavigate()
  const [customize, setCustomize] = useState(false)
  const [order, setOrder] = useState<string[]>(() => {
    try { const s = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null'); if (Array.isArray(s)) { const k = s.filter((x: string) => byKey.has(x)); return [...k, ...DEFAULT_ORDER.filter((x) => !k.includes(x))] } } catch { /* ignore */ }
    return DEFAULT_ORDER
  })
  const persist = (next: string[]) => { setOrder(next); try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch { /* ignore */ } }
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const shown = order.map((k) => byKey.get(k)).filter(Boolean) as NavItem[]

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <DndContext sensors={sensors} collisionDetection={closestCenter}
        onDragEnd={(e: DragEndEvent) => { const { active, over } = e; if (over && active.id !== over.id) persist(arrayMove(order, order.indexOf(String(active.id)), order.indexOf(String(over.id)))) }}>
        <SortableContext items={order} strategy={horizontalListSortingStrategy}>
          {shown.map((it) => <Shortcut key={it.key} item={it} customize={customize} onGo={() => it.to && navigate(it.to)} />)}
        </SortableContext>
      </DndContext>
      <div className="ml-auto flex items-center gap-2">
        {customize && <button onClick={() => persist(DEFAULT_ORDER)} className="text-[10px] font-mono text-inky hover:text-navy underline decoration-dotted">reset</button>}
        <button onClick={() => setCustomize((o) => !o)} className="text-[10px] font-mono uppercase tracking-wide text-inky border border-navy/30 rounded px-2 py-1.5 hover:border-navy">
          {customize ? 'Done' : 'Customize'}
        </button>
      </div>
    </div>
  )
}

function Shortcut({ item, customize, onGo }: { item: NavItem; customize: boolean; onGo: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key, disabled: !customize })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }
  return (
    <div ref={setNodeRef} style={style}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-heading text-navy transition-colors ${customize ? 'border-sky/60 bg-sky/5 cursor-grab active:cursor-grabbing' : 'border-navy/20 bg-cream hover:border-navy hover:bg-navy/5 cursor-pointer'}`}
      {...(customize ? { ...attributes, ...listeners } : { onClick: onGo })}>
      {customize && <GripVertical className="w-3 h-3 text-inky/40 flex-shrink-0" />}
      {ICONS[item.key] ?? null}
      <span>{item.label}</span>
    </div>
  )
}
