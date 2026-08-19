import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Lock, Unlock } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Button, Card, CardBody, Input, Modal, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useHistoryOrder, useAuditTrail, type HistoryLine } from './useOrderHistory'
import { useVendors, useUserNames } from './useLookups'
import { Flags } from './OrdersV2Review'
import { OVERRIDE_CELL, dShort, dTime, dos, money, num } from './shared'
import type { LineFlag } from './types'
import toast from 'react-hot-toast'

/**
 * A finalized order, read-only by default. Editing is possible but gated on
 * an explicit confirmation, visually flagged afterwards, and written to the
 * audit trail with who and when.
 */
export function OrdersV2History() {
  const { orderId = '' } = useParams()
  const navigate = useNavigate()
  const loc = useLocations()
  const vendors = useVendors()
  const names = useUserNames()
  const { order, lines, loading, editLine, noteReExport } = useHistoryOrder(orderId || null)
  const audit = useAuditTrail(orderId || null)

  const [unlocked, setUnlocked] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [showAudit, setShowAudit] = useState(false)

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
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order History</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendors.byId(order.vendor_id)?.name ?? '—'} · {dShort(order.order_date)} · {order.location_count} shop
            {order.location_count !== 1 ? 's' : ''} · {order.line_count} lines · {money(order.total_dollars)}
          </p>
          <p className="text-[10px] font-mono text-inky/50 mt-0.5">
            Finalized {dTime(order.finalized_at)} by {names.nameOf(order.finalized_by)}
            {order.export_count > 1 && ` · exported ${order.export_count}×`}
            {order.edited_after_finalize && ' · edited after finalizing'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="secondary" onClick={reExport}>Re-export</Button>
          {unlocked ? (
            <Button size="sm" variant="secondary" onClick={() => setUnlocked(false)}><Lock className="w-3.5 h-3.5 mr-1" /> Lock</Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => setConfirmOpen(true)}><Unlock className="w-3.5 h-3.5 mr-1" /> Edit order</Button>
          )}
        </div>
      </div>

      {unlocked && (
        <div className="rounded border border-[#E67E22]/40 bg-[#E67E22]/10 px-3 py-2">
          <p className="text-xs font-body text-navy">
            Editing a finalized order. Every change is highlighted, recorded against your name, and kept in the audit
            trail below — it does not silently rewrite history.
          </p>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <Input placeholder="Search shop, product or PO…" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" />
        {audit.length > 0 && (
          <button onClick={() => setShowAudit((o) => !o)} className="text-[11px] font-mono text-inky hover:text-navy hover:underline">
            {audit.length} post-finalize change{audit.length !== 1 ? 's' : ''} {showAudit ? '▾' : '▸'}
          </button>
        )}
      </div>

      {showAudit && (
        <Card><CardBody className="flex flex-col gap-1 max-h-56 overflow-auto">
          {audit.map((a) => (
            <div key={a.id} className="text-[11px] font-mono text-inky/70">
              {dTime(a.changed_at)} · {names.nameOf(a.changed_by)} · {a.field}: {a.old_value || '—'} → {a.new_value || '—'}
            </div>
          ))}
        </CardBody></Card>
      )}

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
              <tr key={l.id} className={`border-b border-navy/15 ${l.edited_after_finalize ? 'bg-[#E67E22]/[0.07]' : ''}`}>
                <td className="px-2 py-1 text-navy">{l.po_number ?? '—'}</td>
                <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                <td className="px-2 py-1 text-navy">{l.product_id}</td>
                <td className="px-2 py-1 text-navy">{l.uom ?? '—'}</td>
                <td className={`px-2 py-1 text-right text-navy ${l.edited_after_finalize ? OVERRIDE_CELL : ''}`}>
                  {unlocked ? (
                    <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} defaultValue={l.qty}
                      onBlur={(e) => {
                        const v = Number(e.target.value) || 0
                        if (v === Number(l.qty)) return
                        void editLine(l, { qty: v, line_total: v * Number(l.unit_cost ?? 0) })
                      }}
                      className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                  ) : num(l.qty)}
                </td>
                <td className="px-2 py-1 text-right text-navy">{money(l.unit_cost)}</td>
                <td className="px-2 py-1 text-right text-navy">{money(l.line_total)}</td>
                <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after)}</td>
                <td className="px-2 py-1"><Flags flags={(l.flags ?? []) as LineFlag[]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)} title="Edit a Finalized Order" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-sm font-body text-navy">
            This order has already been finalized and exported. Editing it changes the historical record.
          </p>
          <p className="text-xs font-body text-inky">
            Any change is highlighted on the line, stamped with your name and the time, and listed in the audit trail.
            The vendor won't see the change unless you re-export and resend.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="danger" size="sm" onClick={() => { setUnlocked(true); setConfirmOpen(false) }}>Enable editing</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
