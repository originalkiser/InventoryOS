import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfigTab } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardHeader, CardBody, Combobox, MultiSelectDropdown } from '@/components/ui'

interface ProductOnHandException {
  id: string
  location_id: string | null
  product_id: string
  note: string | null
}

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy placeholder-inky/40 focus:outline-none focus:border-sky'

// Product + shop pairs excluded from the "Oil On Hand — Not Configured to
// Order" recount check — for a product intentionally kept on hand at a shop
// (or every shop, when location_id is left blank) without being part of the
// normal order config. Not scoped to a count_month, so an exception here
// applies to future periods automatically.
export function ProductOnHandExceptionsPanel() {
  const { profile } = useAuthStore()
  const { data, insert, remove } = useConfigTab<ProductOnHandException>('product_on_hand_exceptions', 'inventory')
  const loc = useLocations()
  const [allShops, setAllShops] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [productIds, setProductIds] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [productOptions, setProductOptions] = useState<{ value: string }[]>([])

  // Every product ID that's ever shown up in Product Usage — the broadest
  // source of real product codes, including generic catalog SKUs that
  // wouldn't be in Global Products.
  useEffect(() => {
    if (!profile?.company_id) return
    ;(async () => {
      const sb = supabase as any
      const seen = new Set<string>()
      const PAGE = 1000
      let from = 0
      for (;;) {
        const { data: rows, error } = await sb.schema('inventory').from('product_usage')
          .select('product_id').eq('company_id', profile.company_id)
          .order('id', { ascending: true }).range(from, from + PAGE - 1)
        if (error) break
        const batch = (rows ?? []) as { product_id: string }[]
        for (const r of batch) if (r.product_id) seen.add(r.product_id)
        if (batch.length < PAGE) break
        from += PAGE
      }
      setProductOptions([...seen].sort().map((v) => ({ value: v })))
    })()
  }, [profile?.company_id])

  async function add() {
    if (!allShops && !locationId) return
    if (productIds.length === 0) return
    for (const pid of productIds) {
      await insert({ location_id: allShops ? null : locationId, product_id: pid, note: note.trim() || null } as Partial<ProductOnHandException>)
    }
    setAllShops(false); setLocationId(''); setProductIds([]); setNote('')
  }

  return (
    <Card>
      <CardHeader>
        <span className="text-xs font-mono text-navy uppercase tracking-wide">Product On-Hand Exceptions</span>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          Excluded from the "Oil On Hand — Not Configured to Order" check. Applies to future counts too — not just this period.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/70">
              <input type="checkbox" checked={allShops} onChange={(e) => { setAllShops(e.target.checked); if (e.target.checked) setLocationId('') }} className="accent-sky" />
              All shops
            </label>
            {!allShops && (
              <div className="w-48">
                <Combobox options={loc.options} value={locationId} onChange={setLocationId} placeholder="Shop…" />
              </div>
            )}
          </div>
          <MultiSelectDropdown
            options={productOptions}
            selected={productIds}
            onChange={setProductIds}
            placeholder="Product ID(s)…"
            showAllOption={false}
            countNoun="products"
            searchable
          />
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className={`${fieldCls} flex-1 min-w-[160px]`} />
          <Button size="sm" onClick={add} disabled={(!allShops && !locationId) || productIds.length === 0}>Add Exception</Button>
        </div>
        {data.length === 0 ? (
          <p className="text-xs font-mono text-inky/40 italic">No exceptions yet.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {data.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1 text-xs font-mono">
                <span className="text-navy w-40 truncate">{r.location_id ? loc.labelOf(r.location_id) : 'All Shops'}</span>
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
