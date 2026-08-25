import { useState } from 'react'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardHeader, CardBody, Combobox } from '@/components/ui'

interface OilOnHandException {
  id: string
  location_id: string
  product_id: string
  note: string | null
}

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-sky'

// Product + shop pairs excluded from the "oil on hand, not configured to
// order" recount check — for oil intentionally kept on hand at a shop
// without being part of its normal order config.
export function OilOnHandExceptionsPanel() {
  const { data, insert, remove } = useConfigTab<OilOnHandException>('oil_on_hand_exceptions', 'inventory')
  const loc = useLocations()
  const [locationId, setLocationId] = useState('')
  const [productId, setProductId] = useState('')
  const [note, setNote] = useState('')

  async function add() {
    if (!locationId || !productId.trim()) return
    const ok = await insert({ location_id: locationId, product_id: productId.trim(), note: note.trim() || null } as Partial<OilOnHandException>)
    if (ok) { setLocationId(''); setProductId(''); setNote('') }
  }

  return (
    <Card>
      <CardHeader>
        <span className="text-xs font-mono text-navy uppercase tracking-wide">Oil On-Hand Exceptions</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          Excluded from the "Oil On Hand — Not Configured to Order" check below.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Combobox options={loc.options} value={locationId} onChange={setLocationId} placeholder="Shop…" />
          </div>
          <input value={productId} onChange={(e) => setProductId(e.target.value)} placeholder="Product ID" className={`${fieldCls} w-36`} />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${fieldCls} flex-1 min-w-[160px]`} />
          <Button size="sm" onClick={add} disabled={!locationId || !productId.trim()}>Add Exception</Button>
        </div>
        {data.length === 0 ? (
          <p className="text-xs font-mono text-inky/40 italic">No exceptions yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {data.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1 text-xs font-mono">
                <span className="text-navy w-40 truncate">{loc.labelOf(r.location_id)}</span>
                <span className="text-navy w-28 truncate">{r.product_id}</span>
                <span className="text-inky/60 flex-1 truncate">{r.note || '—'}</span>
                <button onClick={() => remove(r.id)} title="Remove exception" className="text-inky/50 hover:text-red-500 text-sm leading-none flex-shrink-0">×</button>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  )
}
