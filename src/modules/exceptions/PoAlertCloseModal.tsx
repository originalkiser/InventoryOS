// "Close (No Receipt)" modal — direct feedback 2026-09-25: replaces the old
// bulkCloseOld()'s instant confirm()+bulk-write with a real review step.
// Unlike PoAlertEmailModal (steps through shops one at a time), this shows
// every candidate PO across every shop on ONE screen, each as its own
// bordered card — the ask was explicitly "show all POs that need to be
// closed with no receipt on one modal", not a per-shop wizard.
//
// Clicking a card is the action itself (not a staged checkbox committed
// later): it writes status='Closed' immediately, with a green overlay +
// checkmark to confirm. Clicking an already-closed card reverts it back to
// whatever status it had when this modal opened (captured once, in
// `originalStatus`, not always DEFAULT_STATUS) — "if they accidentally
// click on one, allow them to click again to remove the check."
import { useMemo, useState } from 'react'
import { HiOutlineCheckCircle } from 'react-icons/hi'
import { Modal } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

export interface PoCloseCandidate {
  id: string
  location_id: string | null
  po_id: string
  custom_po_id: string | null
  notes: string | null
  status: string
  days_late: number | null
}

interface Props {
  open: boolean
  onClose: () => void
  alerts: PoCloseCandidate[]
  shopLabel: (id: string | null) => string
  instructions: string
  onChanged?: () => void
}

const CLOSED_NOTE = 'Closed — no receipt confirmed (too old to pursue further)'

export function PoAlertCloseModal({ open, onClose, alerts, shopLabel, instructions, onChanged }: Props) {
  const { profile } = useAuthStore()
  const [closedIds, setClosedIds] = useState<Set<string>>(new Set())
  const [busyId, setBusyId] = useState<string | null>(null)

  const originalStatus = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of alerts) m.set(a.id, a.status)
    return m
  }, [alerts])

  async function toggle(a: PoCloseCandidate) {
    setBusyId(a.id)
    const closing = !closedIds.has(a.id)
    const patch = closing
      ? { status: 'Closed', notes: a.notes || CLOSED_NOTE }
      : { status: originalStatus.get(a.id) ?? 'Pending Shop/AM Response' }
    const { error } = await (supabase as any).schema('inventory').from('po_receipt_alerts')
      .update({ ...patch, updated_by: profile?.id ?? null, last_change_source: 'po-alert-close', updated_at: new Date().toISOString() })
      .eq('id', a.id)
    setBusyId(null)
    if (error) { toast.error(error.message); return }
    setClosedIds((prev) => { const next = new Set(prev); if (closing) next.add(a.id); else next.delete(a.id); return next })
    onChanged?.()
  }

  return (
    <Modal
      open={open}
      onClose={() => { onClose(); setClosedIds(new Set()) }}
      title="Close Purchase Orders — No Receipt"
      size="lg"
    >
      {alerts.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-6">No POs match the current day threshold.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-body text-inky">
            Click a PO to mark it closed (no receipt) — click again to undo. {closedIds.size} of {alerts.length} marked.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-[26rem] overflow-y-auto">
            {alerts.map((a) => {
              const done = closedIds.has(a.id)
              return (
                <button
                  key={a.id}
                  type="button"
                  disabled={busyId === a.id}
                  onClick={() => void toggle(a)}
                  className={[
                    'relative text-left rounded border p-3 flex flex-col gap-1 transition-colors',
                    done ? 'border-[#2ECC71] bg-[#2ECC71]/20' : 'border-navy/20 hover:border-navy/40 bg-cream dark:bg-[#0e2638]',
                    busyId === a.id ? 'opacity-60' : '',
                  ].join(' ')}
                >
                  {done && (
                    <span className="absolute top-2 right-2 text-[#2ECC71]">
                      <HiOutlineCheckCircle className="w-6 h-6" />
                    </span>
                  )}
                  <span className="text-xs font-heading font-bold text-navy dark:text-[#F2F1E6] pr-6">{shopLabel(a.location_id)}</span>
                  <span className="text-[11px] font-mono text-inky">PO #: {a.po_id}</span>
                  {a.custom_po_id && <span className="text-[11px] font-mono text-inky">Custom PO ID: {a.custom_po_id}</span>}
                  <span className="text-[11px] font-mono text-inky/70">{a.days_late ?? '?'} day(s) late</span>
                  {a.notes && <span className="text-[10px] font-mono text-inky/60 italic pr-6">{a.notes}</span>}
                </button>
              )
            })}
          </div>
          <div className="rounded border border-navy/10 bg-navy/[0.03] px-3 py-2">
            <p className="text-[10px] font-mono text-inky/50 whitespace-pre-line leading-relaxed">{instructions}</p>
          </div>
          <div className="flex justify-end">
            <button onClick={() => { onClose(); setClosedIds(new Set()) }} className="text-xs font-mono text-inky/60 hover:text-navy hover:underline">Done</button>
          </div>
        </div>
      )}
    </Modal>
  )
}
