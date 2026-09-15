import { useState } from 'react'
import { Info } from 'lucide-react'
import { format } from 'date-fns'
import { Modal, Button } from '@/components/ui'
import type { FieldHistoryEntry } from './types'
import { formatValue, type ValueFormat } from './formatting'

// The "i" button next to a field that's been edited before — shows every
// prior value (grid cells: value_num under `format`; KPIs: value_text) with
// a Revert to write it straight back as the current value. Shown whenever
// history exists for the field, independent of the orange "changed this
// session" highlight, which is separate session-only state.
export function FieldHistoryButton({ label, entries, format: fmt, onRevert }: {
  label: string
  entries: FieldHistoryEntry[]
  format?: ValueFormat
  onRevert: (value: number | null, valueText: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  if (entries.length === 0) return null
  return (
    <>
      <button onClick={() => setOpen(true)} title="View history / revert" className="text-inky/40 hover:text-sky flex-shrink-0">
        <Info className="w-3 h-3" />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`History — ${label}`} size="sm">
        <div className="flex flex-col gap-2">
          {entries.map((e) => (
            <div key={e.id} className="flex items-center justify-between gap-2 border border-navy/15 rounded px-2 py-1.5">
              <div className="flex flex-col">
                <span className="text-xs font-mono text-navy">
                  {fmt ? formatValue(e.old_value_num, fmt) : (e.old_value_text || '—')}
                </span>
                <span className="text-[10px] font-mono text-inky/50">{format(new Date(e.changed_at), 'MMM d, yyyy h:mm a')}</span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => { onRevert(e.old_value_num, e.old_value_text); setOpen(false) }}>Revert</Button>
            </div>
          ))}
        </div>
      </Modal>
    </>
  )
}
