// "View Full Summary" — direct ask 2026-09-30, reachable from the Order
// Stats modal's own new button: a bigger modal showing every line item on
// the order plus the aggregate breakdowns that were never surfaced
// anywhere before (total products, average DOS at 3 different points,
// top/bottom-N breakdowns, and configured-but-not-ordered products for
// this order's own shops). Works for a draft at ANY status — reads
// straight off ov2_order_draft_lines, which stays populated regardless of
// whether the draft has since been exported (the existing Stats modal
// already relies on this same assumption).
import { useEffect, useMemo, useState } from 'react'
import { Modal, Select, Input, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { dos, money, num } from './shared'

const sb = () => supabase as any
const PAGE = 1000

interface FullLine {
  id: string
  location_id: string | null
  product_id: string
  qty: number
  unit_cost: number | null
  included: boolean
  dos_before: number | null
  dos_after: number | null
  dos_after_delivery: number | null
}

// Same Top-N preset shape as Month End's own outlier callouts
// (OverviewTab.tsx's OUTLIER_N_PRESETS) — 3/5/10 plus a free-entry Custom,
// persisted per-user so it's a one-time choice, not a per-visit reset.
const TOP_N_PRESETS = [3, 5, 10]

export function OrderFullSummaryModal({ draftId, vendorId, open, onClose }: {
  draftId: string
  vendorId: string | null
  open: boolean
  onClose: () => void
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [lines, setLines] = useState<FullLine[]>([])
  const [notOrderedByProduct, setNotOrderedByProduct] = useState<Map<string, Set<string>>>(new Map())
  const [loading, setLoading] = useState(true)

  const [topN, setTopN] = useProfilePref<number>('orders-v2:summary-top-n', 5)
  const [showCustomN, setShowCustomN] = useState(!TOP_N_PRESETS.includes(topN))
  const topNIsCustom = showCustomN || !TOP_N_PRESETS.includes(topN)

  useEffect(() => {
    if (!open || !companyId) return
    let cancelled = false
    setLoading(true)
    ;(async () => {
      const out: FullLine[] = []
      let from = 0
      for (;;) {
        const { data, error } = await sb().schema('inventory').from('ov2_order_draft_lines')
          .select('id, location_id, product_id, qty, unit_cost, included, dos_before, dos_after, dos_after_delivery')
          .eq('draft_id', draftId).order('id', { ascending: true }).range(from, from + PAGE - 1)
        if (error || cancelled) break
        const batch = (data ?? []) as FullLine[]
        out.push(...batch)
        if (batch.length === 0) break
        from += batch.length
      }
      if (cancelled) return
      setLines(out)

      // Products configured for this order's own shops (this vendor only)
      // that never made it onto the order at all — same "not on order"
      // concept ShopConfiguredProductsTable already shows per-shop, here
      // summarized across every shop this order touched.
      const locationIds = [...new Set(out.map((l) => l.location_id).filter((id): id is string => !!id))]
      if (locationIds.length && vendorId) {
        const configured: { location_id: string; product_id: string }[] = []
        for (let i = 0; i < locationIds.length; i += 200) {
          const chunk = locationIds.slice(i, i + 200)
          const { data } = await sb().schema('inventory').from('location_order_config')
            .select('location_id, product_id').eq('company_id', companyId).eq('vendor_id', vendorId)
            .eq('active', true).in('location_id', chunk)
          configured.push(...((data ?? []) as { location_id: string; product_id: string }[]))
        }
        if (cancelled) return
        const orderedKeys = new Set(out.filter((l) => l.included).map((l) => `${l.location_id}|${l.product_id}`))
        const notOrdered = new Map<string, Set<string>>()
        for (const c of configured) {
          if (orderedKeys.has(`${c.location_id}|${c.product_id}`)) continue
          const shops = notOrdered.get(c.product_id) ?? new Set<string>()
          shops.add(c.location_id)
          notOrdered.set(c.product_id, shops)
        }
        setNotOrderedByProduct(notOrdered)
      } else {
        setNotOrderedByProduct(new Map())
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [open, draftId, vendorId, companyId])

  const shopLabel = (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : null) ?? '—'

  const included = useMemo(() => lines.filter((l) => l.included), [lines])

  const stats = useMemo(() => {
    const avg = (vals: number[]) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null)
    const distinctProducts = new Set(included.map((l) => l.product_id)).size
    const dosNowVals = included.map((l) => l.dos_before).filter((v): v is number => v != null)
    const dosDeliveryVals = included.map((l) => l.dos_after_delivery).filter((v): v is number => v != null)
    const dosAfterVals = included.map((l) => l.dos_after).filter((v): v is number => v != null)

    const qtyByProduct = new Map<string, number>()
    for (const l of included) qtyByProduct.set(l.product_id, (qtyByProduct.get(l.product_id) ?? 0) + Number(l.qty))
    const topQty = [...qtyByProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)

    const bottomDosAfter = [...included]
      .filter((l) => l.dos_after != null)
      .sort((a, b) => (a.dos_after ?? 0) - (b.dos_after ?? 0))
      .slice(0, topN)

    const notOrderedTop = [...notOrderedByProduct.entries()]
      .map(([product_id, shops]) => ({ product_id, shopCount: shops.size }))
      .sort((a, b) => b.shopCount - a.shopCount)
      .slice(0, topN)

    return {
      totalProducts: distinctProducts,
      avgDosNow: avg(dosNowVals),
      avgDosAtDelivery: avg(dosDeliveryVals),
      avgDosAfter: avg(dosAfterVals),
      topQty,
      bottomDosAfter,
      notOrderedTop,
      notOrderedCount: notOrderedByProduct.size,
    }
  }, [included, notOrderedByProduct, topN])

  return (
    <Modal open={open} onClose={onClose} title="Order Summary" size="2xl">
      {loading ? (
        <div className="py-10 flex justify-center"><SbLoader size={28} /></div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatTile label="Total Products Ordered" value={String(stats.totalProducts)} />
            <StatTile label="Avg DOS Now" value={dos(stats.avgDosNow)} />
            <StatTile label="Avg DOS @ Delivery (before)" value={dos(stats.avgDosAtDelivery)} />
            <StatTile label="Avg DOS After" value={dos(stats.avgDosAfter)} />
          </div>

          <div className="flex items-center justify-end gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Show</span>
            <div className="w-28">
              <Select
                value={topNIsCustom ? 'custom' : String(topN)}
                onChange={(e) => {
                  if (e.target.value === 'custom') { setShowCustomN(true); return }
                  setShowCustomN(false)
                  setTopN(Number(e.target.value))
                }}
                options={[...TOP_N_PRESETS.map((n) => ({ value: String(n), label: `Top ${n}` })), { value: 'custom', label: 'Custom…' }]}
              />
            </div>
            {topNIsCustom && (
              <Input type="number" min={1} step={1} value={topN}
                onChange={(e) => setTopN(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                className="w-16" />
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <RankedCard title={`Top ${topN} — Qty Ordered`}
              rows={stats.topQty.map(([productId, qty]) => ({ label: productId, value: num(qty, 0) }))} />
            <RankedCard title={`Bottom ${topN} — DOS After`}
              rows={stats.bottomDosAfter.map((l) => ({ label: `${shopLabel(l.location_id)} · ${l.product_id}`, value: dos(l.dos_after) }))} />
            <RankedCard title={`Top ${topN} — Configured, Not Ordered (${stats.notOrderedCount} total)`}
              rows={stats.notOrderedTop.map((r) => ({ label: r.product_id, value: `${r.shopCount} shop${r.shopCount !== 1 ? 's' : ''}` }))} />
          </div>

          <div>
            <h3 className="text-[11px] font-mono uppercase tracking-wide text-inky/60 mb-1.5">
              All Line Items ({included.length.toLocaleString()})
            </h3>
            <div className="max-h-80 overflow-auto rounded border border-navy/15">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-cream">
                  <tr className="text-inky/60 uppercase border-b border-navy/15">
                    <th className="text-left px-2 py-1">Shop</th>
                    <th className="text-left px-2 py-1">Product</th>
                    <th className="text-right px-2 py-1">Qty</th>
                    <th className="text-right px-2 py-1">DOS Now</th>
                    <th className="text-right px-2 py-1">DOS After</th>
                    <th className="text-right px-2 py-1">DOS @ Delivery</th>
                    <th className="text-right px-2 py-1">$</th>
                  </tr>
                </thead>
                <tbody>
                  {included.map((l) => (
                    <tr key={l.id} className="border-b border-navy/5">
                      <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                      <td className="px-2 py-1 text-navy">{l.product_id}</td>
                      <td className="px-2 py-1 text-right text-navy">{num(l.qty)}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{dos(l.dos_before)}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{dos(l.dos_after)}</td>
                      <td className="px-2 py-1 text-right text-inky/70">{dos(l.dos_after_delivery)}</td>
                      <td className="px-2 py-1 text-right text-navy">{money(Number(l.qty) * Number(l.unit_cost ?? 0))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-navy/15 px-2 py-1.5">
      <div className="text-[9px] font-mono uppercase tracking-wide text-inky/50">{label}</div>
      <div className="text-lg font-heading font-bold text-navy">{value}</div>
    </div>
  )
}

function RankedCard({ title, rows }: { title: string; rows: { label: string; value: string }[] }) {
  return (
    <div className="rounded border border-navy/15 px-2 py-2">
      <div className="text-[9px] font-mono uppercase tracking-widest text-inky/50 mb-1">{title}</div>
      {rows.length === 0 ? (
        <span className="text-[11px] font-mono text-inky/40">—</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="text-navy truncate">{r.label}</span>
              <span className="text-inky/70 flex-shrink-0">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
