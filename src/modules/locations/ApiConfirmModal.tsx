import { Modal, Button } from '@/components/ui'
import type { Location } from '@/types'

interface Props {
  pairs: [Location, Location][]
  onConfirm: () => void
  onClose: () => void
  loading?: boolean
}

export function ApiConfirmModal({ pairs, onConfirm, onClose, loading }: Props) {
  // Approximate cost: Google Routes API charges ~$0.005 per route element
  const estimatedCost = (pairs.length * 0.005).toFixed(3)

  return (
    <Modal open onClose={onClose} title="Confirm API Route Lookup" size="sm">
      <div className="flex flex-col gap-4">
        <div className="rounded bg-navy/5 px-3 py-2.5 text-xs font-mono text-navy space-y-1">
          <p><strong>{pairs.length}</strong> route segment{pairs.length !== 1 ? 's' : ''} will be sent to Google Routes API.</p>
          <p className="text-inky/60">Estimated cost: ~${estimatedCost} USD</p>
        </div>

        <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5">
          {pairs.map(([o, d], i) => (
            <div key={i} className="flex items-center gap-2 text-[10px] font-mono text-navy px-1">
              <span className="font-bold text-navy/70">{o.name}</span>
              <span className="text-inky/40">→</span>
              <span className="font-bold text-navy/70">{d.name}</span>
            </div>
          ))}
        </div>

        <p className="text-[10px] font-mono text-inky/50">
          Results are saved to the database immediately. This action cannot be undone but can be overwritten manually.
          Only admin/developer users can trigger this action.
        </p>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>Cancel</Button>
        <Button size="sm" loading={loading} onClick={onConfirm}>
          Confirm — Run API
        </Button>
      </div>
    </Modal>
  )
}
