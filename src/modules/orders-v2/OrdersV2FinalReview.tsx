import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Card, CardBody, Input, Modal, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useDraft, useOrderSettings, useVendorRules, type DraftLineRow } from './useOrdersV2'
import { useVendors } from './useLookups'
import { Flags } from './OrdersV2Review'
import { OVERRIDE_CELL, dos, money, num } from './shared'
import type { LineFlag, OrderType } from './types'

/**
 * Step 3 — everything across all shops, plus the summaries that decide
 * whether the order is ready: which shops fell short of their minimum, the
 * biggest and smallest orders, and anything stocked out.
 */
export function OrdersV2FinalReview() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const loc = useLocations()
  const vendors = useVendors()
  const { settings } = useOrderSettings()
  const { rulesFor } = useVendorRules()
  const { draft, lines, loading, patchLine, removeLine, setStatus } = useDraft(draftId || null)

  const [filter, setFilter] = useState('')
  const [openShop, setOpenShop] = useState<{ locationId: string; orderType: OrderType } | null>(null)

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  const vendorRules = useMemo(() => rulesFor(draft?.vendor_id ?? null, settings), [rulesFor, draft?.vendor_id, settings])

  /** Per shop x order type: dollars, minimum, and whether it clears. */
  const groups = useMemo(() => {
    const m = new Map<string, { locationId: string; orderType: OrderType; lines: DraftLineRow[]; dollars: number; minimum: number }>()
    for (const l of lines) {
      if (!l.included) continue
      const key = `${l.location_id}|${l.order_type}`
      if (!m.has(key)) {
        m.set(key, {
          locationId: l.location_id ?? '', orderType: l.order_type, lines: [], dollars: 0,
          minimum: vendorRules.minimums[l.order_type]
            ?? (l.order_type === 'bulk' ? settings.order_minimum_dollars_bulk : settings.order_minimum_dollars_package),
        })
      }
      const g = m.get(key)!
      g.lines.push(l)
      g.dollars += Number(l.qty) * Number(l.unit_cost ?? 0)
    }
    return [...m.values()]
  }, [lines, vendorRules, settings])

  const fallouts = useMemo(() => groups.filter((g) => g.dollars < g.minimum), [groups])
  const ranked = useMemo(() => [...groups].sort((a, b) => b.dollars - a.dollars), [groups])
  const top3 = ranked.slice(0, 3)
  const bottom3 = ranked.slice(-3).reverse()
  const outOfStock = useMemo(
    () => lines.filter((l) => (l.flags ?? []).includes('stocked_out' as LineFlag)),
    [lines],
  )
  const total = useMemo(
    () => lines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0),
    [lines],
  )

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out = q ? lines.filter((l) => `${shopLabel(l.location_id)} ${l.product_id}`.toLowerCase().includes(q)) : lines
    return [...out].sort((a, b) =>
      shopLabel(a.location_id).localeCompare(shopLabel(b.location_id), undefined, { numeric: true })
      || Number(b.max_capacity_gallons ?? 0) - Number(a.max_capacity_gallons ?? 0))
  }, [lines, filter, shopLabel])

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found.</p>

  const modalLines = openShop
    ? lines.filter((l) => l.location_id === openShop.locationId && l.order_type === openShop.orderType)
    : []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate(`/orders-v2/draft/${draft.id}`)} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Review</button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Final Review</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendors.byId(draft.vendor_id)?.name ?? 'All vendors'} · {groups.length} order{groups.length !== 1 ? 's' : ''} · {money(total)}
          </p>
        </div>
        <Button size="sm" onClick={async () => { await setStatus('exported'); navigate(`/orders-v2/draft/${draft.id}/export`) }}>
          Continue to Export →
        </Button>
      </div>

      {/* Summaries */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Under minimum after smoothing</span>
          <span className={`text-2xl font-heading font-bold ${fallouts.length ? 'text-[#C0392B]' : 'text-navy'}`}>{fallouts.length}</span>
          {fallouts.length > 0 && (
            <div className="max-h-24 overflow-auto text-[11px] font-mono text-inky/70 mt-1">
              {fallouts.map((g) => (
                <button key={`${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
                  className="block text-left hover:text-navy hover:underline">
                  {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)} of {money(g.minimum)}
                </button>
              ))}
            </div>
          )}
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Largest orders</span>
          {top3.map((g) => (
            <button key={`t-${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
              className="text-left text-[11px] font-mono text-navy hover:underline">
              {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)}
            </button>
          ))}
          {top3.length === 0 && <span className="text-[11px] font-mono text-inky/40">—</span>}
        </CardBody></Card>

        <Card><CardBody className="flex flex-col gap-1 py-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Smallest orders</span>
          {bottom3.map((g) => (
            <button key={`b-${g.locationId}|${g.orderType}`} onClick={() => setOpenShop({ locationId: g.locationId, orderType: g.orderType })}
              className="text-left text-[11px] font-mono text-navy hover:underline">
              {shopLabel(g.locationId)} · {g.orderType} — {money(g.dollars)}
            </button>
          ))}
          {bottom3.length === 0 && <span className="text-[11px] font-mono text-inky/40">—</span>}
        </CardBody></Card>
      </div>

      {outOfStock.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Out of stock ({outOfStock.length})</span>
          <p className="text-[11px] font-mono text-inky/60">Nothing on hand at generation time — shown separately since these are the most urgent lines.</p>
          <div className="overflow-auto max-h-56 rounded border border-navy/20">
            <table className="w-full text-[11px] font-mono">
              <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">Usage/day</th><th className="text-right px-2 py-1">Qty</th>
                <th className="text-right px-2 py-1">DOS @ Delivery</th>
              </tr></thead>
              <tbody>
                {outOfStock.map((l) => (
                  <tr key={l.id} className="border-b border-navy/10">
                    <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{l.product_id}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.daily_usage)}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.qty)}</td>
                    <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after_delivery)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}

      <Input placeholder="Search shop or product…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" />

      <div className="overflow-auto rounded border border-navy/30 max-h-[calc(100vh-24rem)]">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="text-left px-2 py-2">Shop</th><th className="text-left px-2 py-2">Product</th>
            <th className="text-left px-2 py-2">UOM</th><th className="text-right px-2 py-2">Qty</th>
            <th className="text-right px-2 py-2">DOS After</th><th className="text-right px-2 py-2">DOS @ Delivery</th>
            <th className="text-right px-2 py-2">$</th><th className="text-left px-2 py-2">Flags</th>
          </tr></thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id} className={`border-b border-navy/15 ${l.included ? '' : 'opacity-45'}`}>
                <td className="px-2 py-1">
                  <button onClick={() => setOpenShop({ locationId: l.location_id ?? '', orderType: l.order_type })}
                    className="text-navy hover:underline">{shopLabel(l.location_id)}</button>
                </td>
                <td className="px-2 py-1 text-navy">{l.product_id}</td>
                <td className="px-2 py-1 text-navy">{l.uom ?? '—'}</td>
                <td className={`px-2 py-1 text-right text-navy ${l.is_override ? OVERRIDE_CELL : ''}`}>{num(l.qty)}</td>
                <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after)}</td>
                <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after_delivery)}</td>
                <td className="px-2 py-1 text-right text-navy">{money(Number(l.qty) * Number(l.unit_cost ?? 0))}</td>
                <td className="px-2 py-1"><Flags flags={(l.flags ?? []) as LineFlag[]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-shop editor */}
      <Modal open={!!openShop} onClose={() => setOpenShop(null)}
        title={openShop ? `${shopLabel(openShop.locationId)} — ${openShop.orderType}` : ''} size="lg">
        {openShop && (
          <div className="flex flex-col gap-3">
            <div className="overflow-auto max-h-80 rounded border border-navy/20">
              <table className="w-full text-xs font-mono">
                <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                  <th className="text-left px-2 py-1">Product</th><th className="text-right px-2 py-1">Qty</th>
                  <th className="text-right px-2 py-1">$</th><th className="text-right px-2 py-1">DOS After</th><th />
                </tr></thead>
                <tbody>
                  {modalLines.map((l) => (
                    <tr key={l.id} className={`border-b border-navy/10 ${l.included ? '' : 'opacity-45'}`}>
                      <td className="px-2 py-1 text-navy">{l.product_id}</td>
                      <td className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                        <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                          onChange={(e) => patchLine(l.id, { qty: Number(e.target.value) || 0 })}
                          className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                      </td>
                      <td className="px-2 py-1 text-right text-navy">{money(Number(l.qty) * Number(l.unit_cost ?? 0))}</td>
                      <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after)}</td>
                      <td className="px-2 py-1 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => patchLine(l.id, { included: !l.included })}
                            className="text-[10px] border border-navy/30 rounded px-1 py-0.5 text-inky hover:border-navy">
                            {l.included ? 'Exclude' : 'Include'}
                          </button>
                          <button onClick={() => removeLine(l.id)} className="text-inky/40 hover:text-[#C0392B]">✕</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between text-xs font-mono">
              <span className="text-inky">
                Order total {money(modalLines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0))}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setOpenShop(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
