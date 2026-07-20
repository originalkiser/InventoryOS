import { useMemo, useState } from 'react'
import {
  DndContext, PointerSensor, useSensor, useSensors, closestCenter, type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, useSortable, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Modal, Button } from '@/components/ui'

export interface ColItem { id: string; label: string }

interface Props {
  open: boolean
  onClose: () => void
  all: ColItem[]              // every manageable column (id + label)
  shown: string[]            // ordered ids of currently-visible columns
  onChange: (shown: string[]) => void
  onReset: () => void
}

function ShownRow({ id, index, label, onRemove }: { id: string; index: number; label: string; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-2 px-2 py-1.5 rounded border border-navy/20 bg-cream dark:bg-[#0e2638] ${isDragging ? 'opacity-70 shadow-lg' : ''}`}
    >
      <span {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-inky/40 hover:text-inky/70 shrink-0" title="Drag to reorder">
        <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 4a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 8a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 12a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2zM7 16a1 1 0 100-2 1 1 0 000 2zm6 0a1 1 0 100-2 1 1 0 000 2z" />
        </svg>
      </span>
      <span className="text-[10px] font-mono text-inky/50 w-5 text-right shrink-0">{index + 1}.</span>
      <span className="text-xs font-body text-navy dark:text-[#F2F1E6] flex-1 truncate">{label}</span>
      <button onClick={onRemove} className="text-inky/40 hover:text-[#C0392B] shrink-0" title="Hide column">✕</button>
    </div>
  )
}

export function ColumnManagerModal({ open, onClose, all, shown, onChange, onReset }: Props) {
  const [search, setSearch] = useState('')
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  const labelOf = useMemo(() => {
    const m = new Map(all.map((c) => [c.id, c.label]))
    return (id: string) => m.get(id) ?? id
  }, [all])

  const available = useMemo(() => {
    const shownSet = new Set(shown)
    const q = search.trim().toLowerCase()
    return all
      .filter((c) => !shownSet.has(c.id))
      .filter((c) => !q || c.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [all, shown, search])

  function handleDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = shown.indexOf(String(active.id))
    const newIdx = shown.indexOf(String(over.id))
    if (oldIdx < 0 || newIdx < 0) return
    onChange(arrayMove(shown, oldIdx, newIdx))
  }

  return (
    <Modal open={open} onClose={onClose} title="Manage Columns" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-[11px] font-mono text-inky/60">
          Drag to reorder the shown columns (numbered left→right in the table). Click ✕ to hide, or add any column from the list below.
        </p>

        {/* Shown */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-navy font-bold uppercase tracking-wide">Shown Columns ({shown.length})</span>
            <button onClick={onReset} className="text-[10px] font-mono text-inky/60 hover:text-navy underline decoration-dotted">Reset to default</button>
          </div>
          <div className="max-h-64 overflow-y-auto flex flex-col gap-1 rounded border border-navy/10 bg-navy/[0.02] dark:bg-[#F2F1E6]/[0.03] p-1.5">
            {shown.length === 0 ? (
              <p className="text-xs font-body italic text-inky/40 px-2 py-2">No columns shown — add some below.</p>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={shown} strategy={verticalListSortingStrategy}>
                  {shown.map((id, i) => (
                    <ShownRow key={id} id={id} index={i} label={labelOf(id)} onRemove={() => onChange(shown.filter((x) => x !== id))} />
                  ))}
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>

        {/* Available */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] font-mono text-navy font-bold uppercase tracking-wide">Available Columns ({available.length})</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search columns…"
            className="rounded border border-navy/30 bg-cream dark:bg-[#0e2638] px-2 py-1.5 text-xs font-body text-navy dark:text-[#F2F1E6] focus:border-sky focus:outline-none"
          />
          <div className="max-h-56 overflow-y-auto grid grid-cols-2 sm:grid-cols-3 gap-1 rounded border border-navy/10 p-1.5">
            {available.length === 0 ? (
              <p className="col-span-full text-xs font-body italic text-inky/40 px-2 py-2">
                {search ? 'No matches.' : 'All columns are shown.'}
              </p>
            ) : (
              available.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onChange([...shown, c.id])}
                  className="flex items-center gap-1.5 px-2 py-1 rounded text-left text-xs font-body text-navy dark:text-[#F2F1E6] hover:bg-navy/5 dark:hover:bg-[#F2F1E6]/5 transition-colors"
                  title={`Add ${c.label}`}
                >
                  <span className="text-inky/40 shrink-0">+</span>
                  <span className="truncate">{c.label}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex justify-end pt-1">
          <Button size="sm" onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  )
}
