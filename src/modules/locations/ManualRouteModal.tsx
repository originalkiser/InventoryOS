import { useState } from 'react'
import { Modal, Button, Input } from '@/components/ui'
import type { Location } from '@/types'

interface Props {
  origin: Location
  destination: Location
  existing?: { distance_miles: number | null; drive_time_minutes: number | null } | null
  onSave: (distanceMiles: number, driveTimeMinutes: number) => Promise<void>
  onClose: () => void
}

export function ManualRouteModal({ origin, destination, existing, onSave, onClose }: Props) {
  const [miles, setMiles] = useState(existing?.distance_miles != null ? String(existing.distance_miles) : '')
  const [minutes, setMinutes] = useState(existing?.drive_time_minutes != null ? String(existing.drive_time_minutes) : '')
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    const mi = parseFloat(miles)
    const min = parseInt(minutes, 10)
    if (!isFinite(mi) || mi <= 0) return
    if (!isFinite(min) || min <= 0) return
    setSaving(true)
    try {
      await onSave(mi, min)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="Enter Route Data Manually" size="sm">
      <div className="flex flex-col gap-4">
        <div className="rounded bg-navy/5 px-3 py-2 text-xs font-mono text-navy">
          <span className="text-inky/60">From</span>{' '}
          <strong>{origin.name}</strong>{' '}
          <span className="text-inky/60">to</span>{' '}
          <strong>{destination.name}</strong>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Distance (miles)"
            type="number"
            min="0"
            step="0.1"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
            placeholder="e.g. 12.4"
          />
          <Input
            label="Drive time (minutes)"
            type="number"
            min="0"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="e.g. 18"
          />
        </div>

        <p className="text-[10px] font-mono text-inky/50">
          Manual entries are saved as-is with no route geometry. Route lines will appear dashed on the map.
        </p>
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button
          size="sm"
          loading={saving}
          onClick={handleSave}
          disabled={!miles || !minutes}
        >
          Save Route Data
        </Button>
      </div>
    </Modal>
  )
}
