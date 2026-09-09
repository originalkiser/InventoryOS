import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, CardBody, Combobox, Input, Select, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useProductExceptions, useConfiguredProducts, caseTypeLabel, type ProductExceptionRow } from './useProductExceptions'
import { ExceptionEditModal } from './ExceptionEditModal'
import type { CeilingUnit } from './useOrdersV2'

/**
 * Per-shop, per-product overrides on top of the regular order config:
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
export function OrdersV2Exceptions() {
  const navigate = useNavigate()
  const loc = useLocations()
  const { rows, loading, save, remove } = useProductExceptions()

  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
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
  const shopLabel = (id: string) => loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id
  const selectedProductCaseLabel = caseTypeLabel(products.find((p) => p.product_id === productId)?.uom)
  const ceilingUnitOptions = [
    { value: 'cases', label: `${selectedProductCaseLabel} (this product's own unit)` },
    { value: 'quarts', label: 'Quarts' },
    { value: 'gallons', label: 'Gallons' },
  ]

  function resetForm() {
    setLocationId(''); setProductId(''); setFloorQty(''); setCeilingQty(''); setCeilingUnit('cases'); setNotes('')
  }

  async function onSubmit() {
    if (!locationId || !productId) return
    const num = (v: string): number | null => { const t = v.trim(); if (!t) return null; const n = Number(t); return isNaN(n) ? null : n }
    const floor = num(floorQty)
    const ceiling = num(ceilingQty)
    setSaving(true)
    const ok = await save({
      location_id: locationId, product_id: productId,
      floor_qty: floor, ceiling_qty: ceiling, ceiling_unit: ceiling != null ? ceilingUnit : null,
      notes: notes.trim() || null,
    })
    setSaving(false)
    if (ok) resetForm()
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this exception?')) return
    await remove(id)
  }

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Product Exceptions</h1>
        <p className="text-xs text-inky mt-0.5">
          Shop+product overrides on top of the regular order config. A floor removes on-hand that's there but not
          usable; a ceiling hard-caps how far this one shop/product can be ordered up, overriding its regular
          capacity. Also editable from a shop's own Order Config on Location Lookup — click the Exception cell there.
        </p>
      </div>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Add Exception</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Combobox label="Shop" options={shopOptions} value={locationId}
            onChange={(v) => { setLocationId(v); setProductId('') }} placeholder="Select shop…" />
          <div>
            <Combobox label="Product" options={productOptions} value={productId} onChange={setProductId}
              placeholder={!locationId ? 'Select a shop first…' : productsLoading ? 'Loading…' : 'Select product…'} />
            {locationId && !productsLoading && products.length === 0 && (
              <span className="text-[10px] font-mono text-inky/50">No products configured for this shop yet.</span>
            )}
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
                        <button onClick={() => onDelete(r.id)} title="Delete" className="text-inky/40 hover:text-[#C0392B] align-middle">×</button>
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
        />
      )}
    </div>
  )
}
