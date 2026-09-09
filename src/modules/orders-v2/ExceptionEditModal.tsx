import { useEffect, useState } from 'react'
import { Button, Input, Modal, Select } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useProductExceptions, caseTypeLabel } from './useProductExceptions'
import type { CeilingUnit } from './useOrdersV2'

const sb = () => supabase as any

/**
 * Add-or-edit a single shop+product exception. Shared by two entry points:
 *   - Orders v2 -> Product Exceptions' own "Edit" button (locationId/
 *     productId come from the row clicked; caseUnitLabel omitted, so this
 *     self-fetches the product's configured UOM).
 *   - Location Lookup's config table Exception cell (locationId/productId
 *     come from the shop/row already on screen; caseUnitLabel passed
 *     directly from that row's own metadata.uom — no extra fetch needed).
 * locationId/productId are fixed for the life of the modal — changing
 * which shop/product an exception applies to means deleting and adding a
 * new one, not editing in place.
 */
export function ExceptionEditModal({
  open, onClose, locationId, productId, shopLabel, productLabel, caseUnitLabel, onSaved,
}: {
  open: boolean
  onClose: () => void
  locationId: string
  productId: string
  shopLabel?: string
  productLabel?: string
  caseUnitLabel?: string
  onSaved?: () => void
}) {
  const { rows, save, remove } = useProductExceptions()
  const [floorQty, setFloorQty] = useState('')
  const [ceilingQty, setCeilingQty] = useState('')
  const [ceilingUnit, setCeilingUnit] = useState<CeilingUnit>('cases')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [fetchedUom, setFetchedUom] = useState<string | null>(null)

  const existing = rows.find((r) => r.location_id === locationId && r.product_id === productId) ?? null

  // Seed the form from whatever's already saved (if anything) every time the
  // modal opens for a new location/product pair — not on every `rows`
  // refresh, or a save mid-edit would stomp on what's still being typed.
  useEffect(() => {
    if (!open) return
    setFloorQty(existing?.floor_qty?.toString() ?? '')
    setCeilingQty(existing?.ceiling_qty?.toString() ?? '')
    setCeilingUnit(existing?.ceiling_unit ?? 'cases')
    setNotes(existing?.notes ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, locationId, productId])

  useEffect(() => {
    if (!open || caseUnitLabel !== undefined) return
    let cancelled = false
    sb().schema('inventory').from('location_order_config')
      .select('metadata').eq('location_id', locationId).eq('product_id', productId).maybeSingle()
      .then(({ data }: any) => { if (!cancelled) setFetchedUom((data?.metadata as any)?.uom ?? null) })
    return () => { cancelled = true }
  }, [open, locationId, productId, caseUnitLabel])

  const resolvedCaseLabel = caseTypeLabel(caseUnitLabel ?? fetchedUom)
  const ceilingUnitOptions = [
    { value: 'cases', label: `${resolvedCaseLabel} (this product's own unit)` },
    { value: 'quarts', label: 'Quarts' },
    { value: 'gallons', label: 'Gallons' },
  ]

  async function onSubmit() {
    const num = (v: string): number | null => { const t = v.trim(); if (!t) return null; const n = Number(t); return isNaN(n) ? null : n }
    const floor = num(floorQty)
    const ceiling = num(ceilingQty)
    setSaving(true)
    const ok = await save({
      id: existing?.id, location_id: locationId, product_id: productId,
      floor_qty: floor, ceiling_qty: ceiling, ceiling_unit: ceiling != null ? ceilingUnit : null,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (ok) { onSaved?.(); onClose() }
  }

  async function onDelete() {
    if (!existing) return
    if (!confirm('Delete this exception?')) return
    await remove(existing.id)
    onSaved?.()
    onClose()
  }

  const title = [shopLabel, productLabel ?? productId].filter(Boolean).join(' — ')

  return (
    <Modal open={open} onClose={onClose} title={`${existing ? 'Edit' : 'Add'} Exception${title ? ` — ${title}` : ''}`}>
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col gap-0.5">
            <Input label="Floor (quarts)" type="number" step={1} value={floorQty} onChange={(e) => setFloorQty(e.target.value)} />
            <span className="text-[10px] font-mono text-inky/50">On-hand at/below this is treated as unusable</span>
          </div>
          <Input label="Ceiling" type="number" step={1} value={ceilingQty} onChange={(e) => setCeilingQty(e.target.value)} />
          <Select label="Ceiling unit" value={ceilingUnit} onChange={(e) => setCeilingUnit(e.target.value as CeilingUnit)} options={ceilingUnitOptions} />
        </div>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — why this exception exists" />
        <div className="flex justify-between gap-2 pt-1">
          <div>{existing && <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>}</div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={onSubmit}>{existing ? 'Save Changes' : 'Add Exception'}</Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
