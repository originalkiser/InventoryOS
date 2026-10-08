// Valvoline orders already on their way. A Valvoline order can sit 1-3 weeks before it lands, so a shop re-ordered before the last one
// arrives gets double-ordered. This finds the earlier orders (Valvoline Order Database — it also holds every order SB Net finalized) whose
// ETA is still ahead and that Droptop shows no receipt for, so generation can count them toward the on hand projected to delivery.
import { supabase } from '@/lib/supabase'

const sb = () => supabase as any

export interface InboundOrderLine {
  location_id: string
  /** Our product id: Valvoline base id + BB (bay box) or D (drum), e.g. VRP530BB. */
  product_id: string
  qty: number
  po_number: string
  po_date: string
}

const pkey = (s: string) => s.trim().toUpperCase()
const chunked = <T,>(rows: T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < rows.length; i += n) out.push(rows.slice(i, i + n)); return out }

/**
 * Units still inbound per `location|product` (the key generation uses). A line counts when it was ordered BEFORE the order being built,
 * its ETA (from the shop's schedule, as of the day it was ordered) is today or later, and Droptop's receipt for that PO + product hasn't
 * covered it (a partial receipt leaves the rest inbound).
 */
export function computeInbound(input: {
  lines: InboundOrderLine[]
  orderDate: string
  today: string
  etaFor: (locationId: string, orderedOn: string) => string | null
  /** `PO number|PRODUCT` -> units Droptop shows received. */
  received: Map<string, number>
}): Map<string, { units: number; eta: string }> {
  const out = new Map<string, { units: number; eta: string }>()
  for (const l of input.lines) {
    if (!(l.qty > 0) || l.po_date >= input.orderDate) continue // an order from this same run (or later) is never "earlier"
    const eta = input.etaFor(l.location_id, l.po_date)
    if (!eta || eta < input.today) continue
    const remaining = l.qty - (input.received.get(`${l.po_number}|${pkey(l.product_id)}`) ?? 0)
    if (remaining <= 1e-9) continue
    const key = `${l.location_id}|${l.product_id}`
    const cur = out.get(key)
    out.set(key, { units: (cur?.units ?? 0) + remaining, eta: cur && cur.eta > eta ? cur.eta : eta })
  }
  return out
}

/** Recent Valvoline order lines (bay boxes + drums) and the receipts Droptop shows for their POs. */
export async function fetchValvolineInboundSources(companyId: string, sinceDate: string): Promise<{ lines: InboundOrderLine[]; received: Map<string, number> }> {
  const rows: any[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb().schema('inventory').from('valvoline_order_lines')
      .select('id, location_id, product_id, uom, quantity, po_number, po_date').eq('company_id', companyId)
      .not('product_id', 'is', null).not('location_id', 'is', null).in('uom', ['BX', 'DR']).gte('po_date', sinceDate)
      .order('id').range(from, from + 999)
    if (error) throw error
    rows.push(...(data ?? []))
    if ((data ?? []).length < 1000) break
  }
  const lines: InboundOrderLine[] = rows.map((r) => ({
    location_id: r.location_id, product_id: `${pkey(String(r.product_id))}${r.uom === 'DR' ? 'D' : 'BB'}`,
    qty: Number(r.quantity) || 0, po_number: String(r.po_number), po_date: String(r.po_date).slice(0, 10),
  }))

  // Droptop POs carry our own PO number as custom_po_id (e.g. 3-20260924); their received quantity is per product.
  const received = new Map<string, number>()
  const poNumbers = [...new Set(lines.map((l) => l.po_number))]
  for (const c of chunked(poNumbers, 150)) {
    const { data: pos, error } = await sb().schema('inventory').from('droptop_purchase_orders').select('id, custom_po_id').eq('company_id', companyId).in('custom_po_id', c)
    if (error) throw error
    const byId = new Map<string, string>(((pos ?? []) as any[]).map((p) => [p.id, p.custom_po_id]))
    for (const ids of chunked([...byId.keys()], 100)) {
      const { data: items, error: e2 } = await sb().schema('inventory').from('droptop_purchase_order_items')
        .select('purchase_order_id, product_id, received_quantity').in('purchase_order_id', ids).gt('received_quantity', 0)
      if (e2) throw e2
      for (const it of (items ?? []) as any[]) {
        const po = byId.get(it.purchase_order_id)
        if (!po || !it.product_id) continue
        const k = `${po}|${pkey(String(it.product_id))}`
        received.set(k, (received.get(k) ?? 0) + (Number(it.received_quantity) || 0))
      }
    }
  }
  return { lines, received }
}
