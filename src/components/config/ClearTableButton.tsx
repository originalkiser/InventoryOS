import { useState } from 'react'
import { Button, Modal } from '@/components/ui'

interface Props {
  clearAll: () => Promise<void>
  label?: string
}

export function ClearTableButton({ clearAll, label = 'Remove Data from Table' }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function onConfirm() {
    setBusy(true)
    await clearAll()
    setBusy(false)
    setOpen(false)
  }

  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Remove All Data" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-body text-navy">
            This will permanently delete <strong>all rows</strong> in this table for your workspace. This cannot be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy}>
              {busy ? 'Removing…' : 'Yes, Remove All'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
