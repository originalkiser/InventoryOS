import { useState } from 'react'
import { Modal, Button, Input, Select } from '@/components/ui'
import type { IssueColumnType, IssueTrackerColumn } from '@/types'

const TYPE_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'status', label: 'Status (pill)' },
  { value: 'checkbox', label: 'Checkbox' },
]

// Existing columns the new one can be positioned after (built-ins + customs).
const BUILTIN_AFTER = [
  { value: '', label: 'Start (after built-in columns)' },
]

export function AddIssueColumnModal({ open, onClose, existingColumns, onAdd }: {
  open: boolean
  onClose: () => void
  existingColumns: IssueTrackerColumn[]
  onAdd: (label: string, type: IssueColumnType, afterColumnId: string | null) => void
}) {
  const [label, setLabel] = useState('')
  const [type, setType] = useState<IssueColumnType>('text')
  const [after, setAfter] = useState('')

  function submit() {
    if (!label.trim()) return
    onAdd(label.trim(), type, after || null)
    setLabel(''); setType('text'); setAfter(''); onClose()
  }

  const afterOptions = [
    ...BUILTIN_AFTER,
    ...existingColumns.map((c) => ({ value: c.id, label: `After “${c.label}”` })),
  ]

  return (
    <Modal open={open} onClose={onClose} title="Add Column">
      <div className="flex flex-col gap-3">
        <Input label="Column Name" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Priority" />
        <Select label="Type" options={TYPE_OPTIONS} value={type} onChange={(e) => setType(e.target.value as IssueColumnType)} />
        <Select label="Position" options={afterOptions} value={after} onChange={(e) => setAfter(e.target.value)} />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!label.trim()}>Add Column</Button>
        </div>
      </div>
    </Modal>
  )
}
