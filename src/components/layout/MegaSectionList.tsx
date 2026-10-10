// Profile -> Navigation: the mega menu's sections as a drag-and-drop list (grab a row's handle and drop it where you want it) with a show/hide
// checkbox on each. Keyboard works too (focus the handle, Space to lift, arrows to move).
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVertical } from 'lucide-react'

interface Item { key: string; label: string }

function Row({ item, shown, disabled, onToggle }: { item: Item; shown: boolean; disabled: boolean; onToggle: (shown: boolean) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key, disabled })
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1.5 rounded-md border px-1.5 py-1 ${isDragging ? 'z-10 border-sky bg-sky/20 shadow-md' : 'border-navy/15 dark:border-[#F2F1E6]/15 bg-transparent'}`}>
      <button type="button" disabled={disabled} aria-label={`Drag ${item.label} to reorder`} {...attributes} {...listeners}
        className="flex-shrink-0 cursor-grab touch-none text-navy/60 dark:text-[#F2F1E6]/70 hover:text-navy disabled:cursor-default disabled:opacity-40 active:cursor-grabbing">
        <GripVertical className="w-4 h-4" />
      </button>
      <input type="checkbox" className="accent-sky" disabled={disabled} checked={shown} onChange={(e) => onToggle(e.target.checked)} aria-label={`Show ${item.label}`} />
      <span className={`flex-1 text-xs font-body ${shown ? 'text-navy dark:text-[#F2F1E6]' : 'text-navy/50 dark:text-[#F2F1E6]/50 line-through'}`}>{item.label}</span>
    </div>
  )
}

export function MegaSectionList({ items, hidden, disabled, onReorder, onToggle }: {
  items: Item[]
  hidden: string[]
  disabled: boolean
  onReorder: (keys: string[]) => void
  onToggle: (key: string, shown: boolean) => void
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const keys = items.map((i) => i.key)
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return
    const from = keys.indexOf(String(e.active.id)), to = keys.indexOf(String(e.over.id))
    if (from < 0 || to < 0) return
    onReorder(arrayMove(keys, from, to))
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={keys} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-1">
          {items.map((it) => (
            <Row key={it.key} item={it} shown={!hidden.includes(it.key)} disabled={disabled} onToggle={(shown) => onToggle(it.key, shown)} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}
