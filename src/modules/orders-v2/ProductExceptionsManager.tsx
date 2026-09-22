import { useMemo, useState } from 'react'
import { Button, Card, CardBody, Combobox, Input, Select, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useProductExceptions, useConfiguredProducts, caseTypeLabel, type ProductExceptionRow } from './useProductExceptions'
import { ExceptionEditModal } from './ExceptionEditModal'
import { GLOBAL_EXCEPTION_LOCATION_ID, type CeilingUnit } from './useOrdersV2'

/**
 * The actual add/list/edit UI for shop+product exceptions — extracted out
 * of the standalone Product Exceptions page so it can ALSO be rendered
 * inside a modal from Orders v2 Review (added 2026-09-22, per request:
 * "do not open a new page and make us go back to the main order page and
 * reopen the order"). The standalone page wraps this with its own header/
 * back-link; the Review page wraps it with a plain Modal.
 *
 *   Floor   — on-hand at/below this amount is physically inaccessible at
 *             this shop for this product (e.g. tank dead volume). Usable
 *             on-hand for every calculation is reduced by it — a 200qt
 *             reading with a 50qt floor is treated as 150qt throughout.
 *   Ceiling — a hard cap on how far this shop can be ordered up for this
 *             product, in the product's own unit, quarts, or gallons.
 *             Overrides the shop's regular capacity for just this one
 *             product.
 * Either can be set alone, or both together.
 *
 * Editing an existing row happens ONLY via its own "Edit" button, in a
 * modal — clicking anywhere else in the row (e.g. to select/copy its
 * Notes text) used to silently load that row into this form and overwrite
 * whatever new exception was mid-typed. Add and Edit are now fully
 * separate: this form only ever adds, and never gets seeded from a row.
 */
export function ProductExceptionsManager({ onChanged }: { onChanged?: (locationId?: string) => void }) {
  const loc = useLocations()
  const { rows, loading, save, remove } = useProductExceptions()

  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  // Global (all shops) still uses the picked shop's own product list purely
  // to browse/pick a product id — the shop itself is discarded at save time
  // in favor of GLOBAL_EXCEPTION_LOCATION_ID. See ExceptionEditModal's own
  // scope toggle for the same choice from the Review page.
  const [scope, setScope] = useState<'shop' | 'global'>('shop')
  const [floorQty, setFloorQty] = useState('')
  const [ceilingQty, setCeilingQty] = useState('')
  const [ceilingUnit, setCeilingUnit] = useState<CeilingUnit>('cases')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [editRow, setEditRow] = useState<ProductExceptionRow | null>(null)

  const { products, loading: productsLoading } = useConfiguredProducts(locationId || null)

  const shopOptions = useMemo(
    () => loc.locations.map((l) => ({ value: l.id, label: l.shop_city || l.name })),
    [loc.locations],
  )
  const productOptions = useMemo(() => products.map((p) => ({ value: p.product_id, label: p.product_id })), [products])
  const shopLabel = (id: string) => (id === GLOBAL_EXCEPTION_LOCATION_ID ? 'All Shops'
    : loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id)
  const selectedProductCaseLabel = caseTypeLabel(products.find((p) => p.product_id === productId)?.uom)
  const ceilingUnitOptions = [
    { value: 'cases', label: `${selectedProductCaseLabel} (this product's own unit)` },
    { value: 'quarts', label: 'Quarts' },
    { value: 'gallons', label: 'Gallons' },
  ]

  function resetForm() {
    setLocationId(''); setProductId(''); setScope('shop'); setFloorQty(''); setCeilingQty(''); setCeilingUnit('cases'); setNotes('')
  }

  async function onSubmit() {
    if (!locationId || !productId) return
    const num = (v: string): number | null => { const t = v.trim(); if (!t) return null; const n = Number(t); return isNaN(n) ? null : n }
    const floor = num(floorQty)
    const ceiling = num(ceilingQty)
    const targetLocationId = scope === 'global' ? GLOBAL_EXCEPTION_LOCATION_ID : locationId
    setSaving(true)
    const ok = await save({
      location_id: targetLocationId, product_id: productId,
      floor_qty: floor, ceiling_qty: ceiling, ceiling_unit: ceiling != null ? ceilingUnit : null,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (ok) { resetForm(); onChanged?.(targetLocationId) }
  }

  async function onDelete(row: ProductExceptionRow) {
    if (!confirm('Delete this exception?')) return
    await remove(row.id)
    onChanged?.(row.location_id)
  }

  return (
    <div className="flex flex-col gap-4">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Add Exception</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Combobox label="Shop" options={shopOptions} value={locationId}
              onChange={(v) => { setLocationId(v); setProductId('') }} placeholder="Select shop…" />
            <span className="text-[10px] font-mono text-inky/50">Used to browse that shop's products, below — see "Applies to" if this should cover every shop.</span>
          </div>
          <div>
            <Combobox label="Product" options={productOptions} value={productId} onChange={setProductId}
              placeholder={!locationId ? 'Select a shop first…' : productsLoading ? 'Loading…' : 'Select product…'} />
            {locationId && !productsLoading && products.length === 0 && (
              <span className="text-[10px] font-mono text-inky/50">No products configured for this shop yet.</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-mono text-inky/60">Applies to</span>
          <div className="flex gap-1.5">
            {(['shop', 'global'] as const).map((s) => (
              <button key={s} type="button" onClick={() => setScope(s)}
                className={`px-2.5 py-1 text-xs font-mono rounded border ${scope === s ? 'border-navy bg-navy text-cream' : 'border-navy/30 text-inky hover:border-navy'}`}>
                {s === 'shop' ? 'Selected shop only' : 'All shops'}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="flex flex-col gap-0.5">
            <Input label="Floor (quarts)" type="number" step={1} value={floorQty} onChange={(e) => setFloorQty(e.target.value)} />
            <span className="text-[10px] font-mono text-inky/50">On-hand at/below this is treated as unusable</span>
          </div>
          <Input label="Ceiling" type="number" step={1} value={ceilingQty} onChange={(e) => setCeilingQty(e.target.value)} />
          <Select label="Ceiling unit" value={ceilingUnit} onChange={(e) => setCeilingUnit(e.target.value as CeilingUnit)} options={ceilingUnitOptions} />
        </div>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — why this exception exists" />
        <div className="flex justify-end gap-2 pt-1">
          <Button size="sm" loading={saving} disabled={!locationId || !productId} onClick={onSubmit}>Add Exception</Button>
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-2">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Existing Exceptions</h3>
        {loading ? <div className="py-8 flex justify-center"><SbLoader size={32} /></div>
          : rows.length === 0 ? <p className="text-xs font-mono text-inky/60 py-4">No exceptions configured yet.</p>
          : (
            <div className="overflow-auto rounded border border-navy/30">
              <table className="w-full text-xs font-mono">
                <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                  <th className="px-3 py-2 text-left">Shop</th>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Floor</th>
                  <th className="px-3 py-2 text-right">Ceiling</th>
                  <th className="px-3 py-2 text-left">Notes</th>
                  <th className="px-3 py-2" />
                </tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-navy/15">
                      <td className="px-3 py-1.5 text-navy">{shopLabel(r.location_id)}</td>
                      <td className="px-3 py-1.5 text-navy">{r.product_id}</td>
                      <td className="px-3 py-1.5 text-right text-navy">{r.floor_qty != null ? `${r.floor_qty} qt` : '—'}</td>
                      <td className="px-3 py-1.5 text-right text-navy">{r.ceiling_qty != null ? `${r.ceiling_qty} ${r.ceiling_unit}` : '—'}</td>
                      <td className="px-3 py-1.5 text-inky/70 select-text">{r.notes || '—'}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <button onClick={() => setEditRow(r)} className="text-xs font-mono text-inky hover:underline mr-2">Edit</button>
                        <button onClick={() => onDelete(r)} title="Delete" className="text-inky/40 hover:text-[#C0392B] align-middle">×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardBody></Card>

      {editRow && (
        <ExceptionEditModal
          open={!!editRow}
          onClose={() => setEditRow(null)}
          locationId={editRow.location_id}
          productId={editRow.product_id}
          shopLabel={shopLabel(editRow.location_id)}
          onSaved={onChanged}
        />
      )}
    </div>
  )
}
