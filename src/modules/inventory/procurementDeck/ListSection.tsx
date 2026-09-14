import { useState } from 'react'
import { Plus, X, ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui'
import type { ListItemRow } from './types'

export function ListSection({ title, accent, items, onAdd, onSave, onDelete, onMove }: {
  title: string
  accent?: 'green' | 'orange'
  items: ListItemRow[]
  onAdd: (text: string) => void
  onSave: (id: string, text: string) => void
  onDelete: (id: string) => void
  onMove: (id: string, dir: -1 | 1) => void
}) {
  const [draft, setDraft] = useState('')
  const dot = accent === 'green' ? 'bg-[#2ECC71]' : accent === 'orange' ? 'bg-[#E67E22]' : 'bg-sky'
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-mono text-inky uppercase tracking-wide">{title}</span>
      <div className="flex flex-col gap-1.5">
        {items.map((it, idx) => (
          <div key={it.id} className="flex items-start gap-2 group">
            <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} />
            <textarea
              defaultValue={it.item_text}
              rows={1}
              onBlur={(e) => { if (e.target.value !== it.item_text) onSave(it.id, e.target.value) }}
              className="flex-1 bg-transparent border border-transparent hover:border-navy/20 focus:border-sky rounded px-1.5 py-0.5 text-xs font-body text-navy resize-y focus:outline-none"
            />
            <div className="flex flex-col opacity-0 group-hover:opacity-100 flex-shrink-0">
              <button onClick={() => onMove(it.id, -1)} disabled={idx === 0} className="text-inky/40 hover:text-navy disabled:opacity-20"><ChevronUp className="w-3 h-3" /></button>
              <button onClick={() => onMove(it.id, 1)} disabled={idx === items.length - 1} className="text-inky/40 hover:text-navy disabled:opacity-20"><ChevronDown className="w-3 h-3" /></button>
            </div>
            <button onClick={() => onDelete(it.id)} className="text-inky/40 hover:text-[#C0392B] opacity-0 group-hover:opacity-100 flex-shrink-0 mt-0.5"><X className="w-3 h-3" /></button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { onAdd(draft.trim()); setDraft('') } }}
          placeholder="Add item…"
          className="flex-1 bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky"
        />
        <Button size="sm" variant="secondary" onClick={() => { if (draft.trim()) { onAdd(draft.trim()); setDraft('') } }} disabled={!draft.trim()}><Plus className="w-3 h-3" /></Button>
      </div>
    </div>
  )
}
