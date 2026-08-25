import { useEffect, useState } from 'react'
import { Modal, Button, Select, Input } from '@/components/ui'
import { resolutionNotes, type LocationComm } from './comms'

export interface WrapUpCommSeed {
  row: LocationComm
  status: string
  responseDate: string
  notes: string
}

interface Props {
  seed: WrapUpCommSeed | null
  statuses: string[]
  // Cancel, X, outside-click, Escape — all revert the status to what it was
  // before the inline edit that opened this modal (seed.row.status), since
  // that edit committed eagerly. Save is the only path that keeps it.
  onCancel: () => void
  onSave: (patch: Partial<LocationComm>) => void
}

// Response date has no dedicated column — stored in metadata.response_date,
// same no-migration approach as resolution_notes (see comms.ts).
function responseDateOf(r: LocationComm): string {
  const v = (r.metadata as any)?.response_date
  return typeof v === 'string' ? v : ''
}

/**
 * Fast wrap-up prompt shown when a communication's status moves to
 * Tentatively Closed or Closed — mirrors QuickResponseModal in Exception
 * Reporting. Pre-selects the closing status but says so plainly and lets it
 * be changed, so nothing is closed silently. The inline status edit already
 * committed by the time this opens; Cancel reverts it back to what it was.
 */
export function WrapUpCommModal({ seed, statuses, onCancel, onSave }: Props) {
  const [status, setStatus] = useState('')
  const [responseDate, setResponseDate] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    if (!seed) return
    setStatus(seed.status)
    setResponseDate(seed.responseDate)
    setNotes(seed.notes)
  }, [seed])

  if (!seed) return null

  const current = seed.row.status ?? ''
  const statusChanging = (status || '') !== current
  const statusList = [...new Set([...statuses, ...(status ? [status] : []), ...(current ? [current] : [])])]

  function save() {
    onSave({
      status: status || null,
      metadata: {
        ...(seed!.row.metadata ?? {}),
        response_date: responseDate || null,
        resolution_notes: notes.trim() || null,
      },
    })
  }

  return (
    <Modal open={!!seed} onClose={onCancel} title="Wrap Up Communication" size="sm">
      <div className="flex flex-col gap-3">
        {statusChanging && (
          <div className="rounded border border-sky/50 bg-sky/15 px-3 py-2">
            <p className="text-xs font-body text-navy leading-relaxed">
              Saving will set the status to <strong>{status || '—'}</strong>
              {current ? <> (currently <strong>{current}</strong>)</> : null}. Choose a different status below if
              that isn't right.
            </p>
          </div>
        )}

        <Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)}
          options={[{ value: '', label: 'Select status…' }, ...statusList.map((s) => ({ value: s, label: s }))]} />

        <Input label="Response Date" type="date" value={responseDate} onChange={(e) => setResponseDate(e.target.value)} />

        <div>
          <label className="text-xs font-heading text-inky uppercase tracking-wide block mb-1">Response Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} autoFocus
            className="w-full bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky"
            placeholder="What did the shop say?" />
        </div>

        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="text-[10px] font-mono text-inky/50">
            Cancel reverts the status back to {current ? <strong>{current}</strong> : 'what it was'}.
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
            <Button size="sm" onClick={save}>Save</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function seedFor(r: LocationComm, statusOverride?: string | null): WrapUpCommSeed {
  return {
    row: r,
    status: statusOverride ?? r.status ?? '',
    responseDate: responseDateOf(r),
    notes: resolutionNotes(r),
  }
}
