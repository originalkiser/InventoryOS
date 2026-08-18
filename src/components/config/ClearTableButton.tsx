import React, { useEffect, useState } from 'react'
import { Button, Input, Modal } from '@/components/ui'

interface Props {
  clearAll: () => Promise<void>
  label?: string
  description?: React.ReactNode
  /**
   * Extra, table-specific consequence shown in the warning — use it when other
   * tables reference this one's rows by id (e.g. locations).
   */
  impact?: React.ReactNode
}

// Destructive "delete every row" action. Deliberately high-friction: rows are
// hard-deleted and any re-upload generates brand-new ids, so anything that
// references those rows by id is silently orphaned (this is exactly how a
// locations replace once detached historical exception reports, comms, and
// project assignments). Requires typing REMOVE to confirm.
export function ClearTableButton({ clearAll, label = 'Remove Data from Table', description, impact }: Props) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  useEffect(() => { if (!open) setConfirmText('') }, [open])

  async function onConfirm() {
    setBusy(true)
    await clearAll()
    setBusy(false)
    setOpen(false)
  }

  const armed = confirmText.trim().toUpperCase() === 'REMOVE'

  return (
    <>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Remove All Data" size="sm">
        <div className="flex flex-col gap-4">
          <p className="text-sm font-body text-navy">
            {description ?? (
              <>This will permanently delete <strong>all rows</strong> in this table for your workspace. This cannot be undone.</>
            )}
          </p>

          <div className="rounded border border-[#C0392B]/40 bg-[#C0392B]/5 px-3 py-2 flex flex-col gap-1.5">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">What this can break</span>
            <p className="text-xs font-body text-navy leading-relaxed">
              Re-uploading after a full removal creates rows with <strong>new internal ids</strong>. Anything that
              already points at the old rows keeps the old id and is left orphaned — it won't error loudly, it just
              stops matching.
            </p>
            {impact && <p className="text-xs font-body text-navy leading-relaxed">{impact}</p>}
            <p className="text-xs font-body text-navy leading-relaxed">
              To correct or replace data <strong>without</strong> breaking those links, upload with{' '}
              <strong>"Update changes only"</strong>, or select the specific rows in the table and use{' '}
              <strong>Delete selected</strong>.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-heading text-inky uppercase tracking-wide">
              Type <span className="font-mono text-[#C0392B]">REMOVE</span> to confirm
            </label>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="REMOVE" />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={onConfirm} disabled={busy || !armed}>
              {busy ? 'Removing…' : 'Yes, Remove All'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
