import { useEffect, useState } from 'react'
import { Modal, Button, Select, Input } from '@/components/ui'
import type { ExceptionReport } from './exceptions'

export interface QuickResponseSeed {
  row: ExceptionReport
  status: string
  responseDate: string
  notes: string
}

interface Props {
  seed: QuickResponseSeed | null
  statuses: string[]
  onClose: () => void
  onSave: (patch: Partial<ExceptionReport>) => void
}

/**
 * Fast wrap-up prompt shown when a report looks finished — a response date was
 * entered, or the status was moved to a closed state. Pre-selects the closing
 * status but says so plainly and lets it be changed, so nothing is closed
 * silently. Only the three fields that matter at that moment; the pencil still
 * opens full detail.
 */
export function QuickResponseModal({ seed, statuses, onClose, onSave }: Props) {
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
      date_of_shop_action: responseDate || null,
      response_notes: notes.trim() || null,
    })
    onClose()
  }

  return (
    <Modal open={!!seed} onClose={onClose} title="Wrap Up Exception" size="sm">
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
            Cancel keeps the edit you just made and changes nothing else.
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={save}>Save</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
