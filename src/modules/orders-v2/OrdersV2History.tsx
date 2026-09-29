import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import * as XLSX from 'xlsx'
import { Button, Input, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useHistoryOrder } from './useOrderHistory'
import { useVendors, useUserNames } from './useLookups'
import { Flags } from './OrdersV2Review'
import { dShort, dTime, dos, money, num } from './shared'
import type { LineFlag } from './types'
import toast from 'react-hot-toast'

/**
 * Order Summary — a plain read-only recap of a completed order ("the
 * summary table" from the direct 2026-09-29 ask). Editing no longer happens
 * here: killing the "finalize" lock means there's only ever ONE editable
 * surface for a draft (its own Review/Final Review/Export pages, reachable
 * below via "Open in Steps"), not a second lock/unlock edit mode bolted
 * onto a separate snapshot page. markDraftComplete (useOrderHistory.ts)
 * keeps this snapshot refreshed on every re-export, so what's shown here
 * always matches the draft's current state.
 */
export function OrdersV2History() {
  const { orderId = '' } = useParams()
  const navigate = useNavigate()
  const loc = useLocations()
  const vendors = useVendors()
  const names = useUserNames()
  const { order, lines, loading, noteReExport } = useHistoryOrder(orderId || null)

  const [filter, setFilter] = useState('')

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const out = q ? lines.filter((l) => `${shopLabel(l.location_id)} ${l.product_id} ${l.po_number ?? ''}`.toLowerCase().includes(q)) : lines
    return [...out].sort((a, b) => shopLabel(a.location_id).localeCompare(shopLabel(b.location_id), undefined, { numeric: true }))
  }, [lines, filter, shopLabel])

  /** Re-export uses whatever columns the vendor default has now; it never
   *  changes that default, and it's recorded as another export on the order. */
  function reExport() {
    if (!lines.length) return
    const headers = ['PO Number', 'Shop', 'Product', 'UOM', 'Qty', 'Unit Cost', 'Line Total']
    const rows = lines.map((l) => [
      l.po_number ?? '', shopLabel(l.location_id), l.product_id, l.uom ?? '',
      Number(l.qty), Number(l.unit_cost ?? 0), Number(l.line_total ?? 0),
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([headers, ...rows]), 'Order')
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
    const a = document.createElement('a')
    a.href = url; a.download = `order-${order?.order_date ?? ''}-reexport.xlsx`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
    void noteReExport()
    toast.success('Re-exported')
  }

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
  if (!order) return <p className="text-xs font-mono text-inky/60 py-8">Order not found.</p>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order Summary</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendors.byId(order.vendor_id)?.name ?? '—'} · {dShort(order.order_date)} · {order.location_count} shop
            {order.location_count !== 1 ? 's' : ''} · {order.line_count} lines · {money(order.total_dollars)}
          </p>
          <p className="text-[10px] font-mono text-inky/50 mt-0.5">
            Completed {dTime(order.finalized_at)} by {names.nameOf(order.finalized_by)}
            {order.export_count > 1 && ` · exported ${order.export_count}×`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* A completed draft (Review/Final Review/Export lines) is never
              deleted or cleared by markDraftComplete — only its status flips
              to 'exported' — so it's still fully there to revisit. This is
              the ONLY place edits happen now (no separate lock/unlock mode
              on this page); re-downloading from Export keeps this summary
              refreshed to match. Only shown when the draft really is still
              around (a very old order might predate this, or the draft
              could since have been deleted separately). */}
          {order.draft_id && (
            <Button size="sm" onClick={() => navigate(`/orders-v2/draft/${order.draft_id}`)}>
              Open in Steps
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={reExport}>Re-export</Button>
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <Input placeholder="Search shop, product or PO…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" />
      </div>

      <div className="overflow-auto rounded border border-navy/30 max-h-[calc(100vh-20rem)]">
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="text-left px-2 py-2">PO</th><th className="text-left px-2 py-2">Shop</th>
            <th className="text-left px-2 py-2">Product</th><th className="text-left px-2 py-2">UOM</th>
            <th className="text-right px-2 py-2">Qty</th><th className="text-right px-2 py-2">Unit</th>
            <th className="text-right px-2 py-2">Total</th><th className="text-right px-2 py-2">DOS After</th>
            <th className="text-left px-2 py-2">Flags</th>
          </tr></thead>
          <tbody>
            {visible.map((l) => (
              <tr key={l.id} className="border-b border-navy/15">
                <td className="px-2 py-1 text-navy">{l.po_number ?? '—'}</td>
                <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                <td className="px-2 py-1 text-navy">{l.product_id}</td>
                <td className="px-2 py-1 text-navy">{l.uom ?? '—'}</td>
                <td className="px-2 py-1 text-right text-navy">
                  {num(l.qty)}
                  {l.quarts_per_unit != null && <span className="text-inky/50"> ({num(Number(l.qty) * l.quarts_per_unit, 1)} qt)</span>}
                </td>
                <td className="px-2 py-1 text-right text-navy">{money(l.unit_cost)}</td>
                <td className="px-2 py-1 text-right text-navy">{money(l.line_total)}</td>
                <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after)}</td>
                <td className="px-2 py-1">
                  <Flags flags={(l.flags ?? []) as LineFlag[]} />
                  {l.note && <div className="text-[10px] font-mono text-inky/60 italic mt-0.5">{l.note}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
