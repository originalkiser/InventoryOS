import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui'
import type { KpiItem } from './types'

export function KpiSection({ title, items, onSave, onAdd, onDelete }: {
  title?: string
  items: KpiItem[]
  onSave: (kpiKey: string, label: string, valueText: string, sortOrder: number) => void
  onAdd: (label: string) => void
  onDelete: (id: string) => void
}) {
  const [newLabel, setNewLabel] = useState('')
  return (
    <div className="flex flex-col gap-2">
      {title && <span className="text-[11px] font-mono text-inky uppercase tracking-wide">{title}</span>}
      <div className="flex flex-wrap gap-3">
        {items.map((k) => (
          <div key={k.id} className="relative group flex flex-col gap-1 rounded-lg bg-navy px-4 py-3 min-w-[160px]">
            <button onClick={() => onDelete(k.id)} className="absolute top-1 right-1 text-[#F2F1E6]/30 hover:text-[#C0392B] opacity-0 group-hover:opacity-100"><X className="w-3 h-3" /></button>
            <input
              defaultValue={k.label}
              onBlur={(e) => { if (e.target.value !== k.label) onSave(k.kpi_key, e.target.value, k.value_text ?? '', k.sort_order) }}
              className="bg-transparent text-[10px] font-mono uppercase tracking-wide text-[#F2F1E6]/70 focus:outline-none border-b border-transparent focus:border-sky/50"
            />
            <input
              defaultValue={k.value_text ?? ''}
              onBlur={(e) => { if (e.target.value !== (k.value_text ?? '')) onSave(k.kpi_key, k.label, e.target.value, k.sort_order) }}
              className="bg-transparent text-lg font-heading font-bold text-[#F2F1E6] focus:outline-none border-b border-transparent focus:border-sky/50"
            />
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-1">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && newLabel.trim()) { onAdd(newLabel.trim()); setNewLabel('') } }}
          placeholder="New KPI label…"
          className="w-48 bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:border-sky"
        />
        <Button size="sm" variant="secondary" onClick={() => { if (newLabel.trim()) { onAdd(newLabel.trim()); setNewLabel('') } }} disabled={!newLabel.trim()}><Plus className="w-3 h-3 mr-1" /> Add</Button>
      </div>
    </div>
  )
}
