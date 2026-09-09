import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Select, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useProductExceptions, useConfiguredProducts, type ProductExceptionRow } from './useProductExceptions'

const CEILING_UNIT_OPTIONS = [
  { value: 'cases', label: 'Cases (this product\'s own unit)' },
  { value: 'gallons', label: 'Gallons' },
]

/**
 * Per-shop, per-product overrides on top of the regular order config:
 *   Floor   — on-hand at/below this amount is physically inaccessible at
 *             this shop for this product (e.g. tank dead volume). Usable
 *             on-hand for every calculation is reduced by it — a 200qt
 *             reading with a 50qt floor is treated as 150qt throughout.
 *   Ceiling — a hard cap on how far this shop can be ordered up for this
 *             product, in either cases or gallons. Overrides the shop's
 *             regular capacity for just this one product.
 * Either can be set alone, or both together.
 */
export function OrdersV2Exceptions() {
  const navigate = useNavigate()
  const loc = useLocations()
  const { rows, loading, save, remove } = useProductExceptions()

  const [editId, setEditId] = useState<string | null>(null)
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [floorQty, setFloorQty] = useState('')
  const [ceilingQty, setCeilingQty] = useState('')
  const [ceilingUnit, setCeilingUnit] = useState<'cases' | 'gallons'>('cases')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const { products, loading: productsLoading } = useConfiguredProducts(locationId || null)

  const shopOptions = useMemo(
    () => loc.locations.map((l) => ({ value: l.id, label: l.shop_city || l.name })),
    [loc.locations],
  )
  const productOptions = useMemo(() => products.map((p) => ({ value: p, label: p })), [products])
  const shopLabel = (id: string) => loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id

  function resetForm() {
    setEditId(null); setLocationId(''); setProductId(''); setFloorQty(''); setCeilingQty(''); setCeilingUnit('cases'); setNotes('')
  }

  function openEdit(r: ProductExceptionRow) {
    setEditId(r.id)
    setLocationId(r.location_id)
    setProductId(r.product_id)
    setFloorQty(r.floor_qty?.toString() ?? '')
    setCeilingQty(r.ceiling_qty?.toString() ?? '')
    setCeilingUnit(r.ceiling_unit ?? 'cases')
    setNotes(r.notes ?? '')
  }

  async function onSubmit() {
    if (!locationId || !productId) return
    const num = (v: string): number | null => { const t = v.trim(); if (!t) return null; const n = Number(t); return isNaN(n) ? null : n }
    const floor = num(floorQty)
    const ceiling = num(ceilingQty)
    setSaving(true)
    const ok = await save({
      id: editId ?? undefined,
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
    if (editId === id) resetForm()
  }

  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Product Exceptions</h1>
        <p className="text-xs text-inky mt-0.5">
          Shop+product overrides on top of the regular order config. A floor removes on-hand that's there but not
          usable; a ceiling hard-caps how far this one shop/product can be ordered up, overriding its regular
          capacity.
        </p>
      </div>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">
          {editId ? 'Edit Exception' : 'Add Exception'}
        </h3>
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
          <Select label="Ceiling unit" value={ceilingUnit} onChange={(e) => setCeilingUnit(e.target.value as 'cases' | 'gallons')} options={CEILING_UNIT_OPTIONS} />
        </div>
        <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional — why this exception exists" />
        <div className="flex justify-end gap-2 pt-1">
          {editId && <Button variant="secondary" size="sm" onClick={resetForm}>Cancel Edit</Button>}
          <Button size="sm" loading={saving} disabled={!locationId || !productId} onClick={onSubmit}>
            {editId ? 'Save Changes' : 'Add Exception'}
          </Button>
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
                    <tr key={r.id} className="border-b border-navy/15 hover:bg-sky/10 cursor-pointer" onClick={() => openEdit(r)}>
                      <td className="px-3 py-1.5 text-navy">{shopLabel(r.location_id)}</td>
                      <td className="px-3 py-1.5 text-navy">{r.product_id}</td>
                      <td className="px-3 py-1.5 text-right text-navy">{r.floor_qty != null ? `${r.floor_qty} qt` : '—'}</td>
                      <td className="px-3 py-1.5 text-right text-navy">{r.ceiling_qty != null ? `${r.ceiling_qty} ${r.ceiling_unit}` : '—'}</td>
                      <td className="px-3 py-1.5 text-inky/70">{r.notes || '—'}</td>
                      <td className="px-3 py-1.5">
                        <button title="Delete" onClick={(e) => { e.stopPropagation(); onDelete(r.id) }}
                          className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </CardBody></Card>
    </div>
  )
}
