// Mighty order review — Phase 2 of the Mighty manual-order feature (see
// mightyEngine.ts's own header comment for why this is a separate page
// rather than a branch inside OrdersV2Review.tsx: that page's rendering,
// not just its generation, is pervasively coupled to engine.ts concepts
// (capacity, bulk/package smoothing, delivery schedules, keep-fill) that
// don't apply to a Mighty order at all). Routed here by OrdersV2DraftPage,
// which checks the draft's vendor before choosing which review page to
// render.
//
// Phase 2 scope: generate + review + edit quantities, then hand off to the
// existing (generic, vendor-agnostic) Final Review/Export flow. The Order
// Efficiency scorecard and Most/Least Ordered bulk-edit panels are Phase 3;
// a durable UoM/prefix-suffix rules screen is Phase 4 — until that exists,
// every line resolves 1:1 (no named conversions or pack-size rules exist
// yet to apply), which is the correct, honest behavior for "nothing
// configured yet" rather than a placeholder guess.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { Button, Card, CardBody, Input, SbLoader } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useDraft, draftAdHocLocationIds, draftMightySettings, type DraftLineRow } from './useOrdersV2'
import { OrderStepper } from './OrderStepper'
import { getMightyUomConversion, calcMightyOrder, mightyDaysOfSupply } from './mightyEngine'
import { dosAfterForQty, money, dos, OVERRIDE_CELL } from './shared'
import type { GeneratedLine } from './types'

const sb = () => supabase as any

interface MightyUsageRow {
  location_id: string
  product_id: string
  category: string | null
  daily_usage: number | null
  on_hands: number | null
  cost_per_unit: number | null
}

export function MightyOrderReview() {
  const { draftId = '' } = useParams()
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const { draft, lines, loading, patchLine, removeLine, replaceLines, setStatus } = useDraft(draftId || null)

  const [generating, setGenerating] = useState(false)
  const [movingToFinal, setMovingToFinal] = useState(false)
  const mighty = draft ? draftMightySettings(draft) : { targetDays: 21, leadTimeDays: 3 }
  const [targetDays, setTargetDays] = useState(mighty.targetDays)
  const [leadTimeDays, setLeadTimeDays] = useState(mighty.leadTimeDays)
  useEffect(() => { if (draft) { const m = draftMightySettings(draft); setTargetDays(m.targetDays); setLeadTimeDays(m.leadTimeDays) } }, [draft?.id])

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  const runGeneration = useCallback(async (dTarget: number, dLead: number) => {
    if (!draft || !profile?.company_id) return
    const locationIds = draftAdHocLocationIds(draft) ?? []
    if (!locationIds.length) { toast.error('No shops on this order'); return }
    setGenerating(true)
    try {
      const { data, error } = await sb().schema('inventory').from('product_usage')
        .select('location_id, product_id, category, daily_usage, on_hands, cost_per_unit')
        .eq('company_id', profile.company_id).eq('supplier', 'Mighty').in('location_id', locationIds)
      if (error) { toast.error(error.message); return }
      const rows = (data ?? []) as MightyUsageRow[]
      if (!rows.length) {
        toast.error('No Mighty-supplied products with usage data found for the selected shop(s)')
        return
      }
      const generated: (GeneratedLine & { dos_after_delivery?: number | null })[] = rows.map((r) => {
        // No named UoM conversions or prefix/suffix pack-size rules exist
        // yet (Phase 4) — every line resolves 1:1 until that config exists.
        const conv = getMightyUomConversion(r.product_id, r.category, null, undefined, {}, [], [])
        const qty = calcMightyOrder(r.daily_usage, r.on_hands, dLead, dTarget, conv.onHandToOrderFactor) ?? 0
        const onHandAtDelivery = r.on_hands != null && r.daily_usage != null
          ? Math.max(0, r.on_hands - r.daily_usage * dLead) : null
        const onHandAfter = r.on_hands != null ? r.on_hands + qty * conv.orderToOnHandFactor : null
        return {
          location_id: r.location_id, product_id: r.product_id, order_type: 'package', uom: conv.orderUom || null,
          system_qty: qty, qty, unit_cost: r.cost_per_unit, on_hand: r.on_hands, daily_usage: r.daily_usage,
          dos_before: mightyDaysOfSupply(r.on_hands, r.daily_usage),
          dos_after: mightyDaysOfSupply(onHandAfter, r.daily_usage),
          max_capacity_gallons: null,
          // Reuses this field for the on-hand-units-per-order-unit factor
          // (same loose repurposing engine.ts's own quarts_per_unit already
          // documents) so dosAfterForQty below keeps working unchanged on a
          // hand-edited qty.
          quarts_per_unit: conv.orderToOnHandFactor,
          included: true, flags: [], added_by_smoothing: false, triggered_smoothing: false,
          note: conv.isPack ? `1 ${conv.orderUom || 'pack'} = ${conv.packSize} on-hand unit${conv.packSize === 1 ? '' : 's'}` : null,
          dos_after_delivery: mightyDaysOfSupply(onHandAtDelivery, r.daily_usage),
        }
      })
      await replaceLines(generated)
      await setStatus('review')
    } finally {
      setGenerating(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id, profile?.company_id])

  // First-ever generation for a brand-new draft — nothing to show yet, so
  // run automatically rather than making the user find a button. A draft
  // that already has lines (revisited later) never auto-regenerates —
  // that's an explicit action (below) so a hand-edited qty is never
  // silently overwritten just by reopening the page.
  const autoRanRef = useRef(false)
  useEffect(() => {
    if (loading || !draft || autoRanRef.current) return
    if (lines.length === 0) { autoRanRef.current = true; runGeneration(targetDays, leadTimeDays) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, draft?.id, lines.length])

  const patchQty = useCallback((l: DraftLineRow, qty: number) => {
    patchLine(l.id, { qty, dos_after: dosAfterForQty(l, qty) })
  }, [patchLine])

  if (loading || !draft) return <div className="py-12 flex justify-center"><SbLoader size={36} /></div>

  const totalCost = lines.reduce((s, l) => s + (l.unit_cost ?? 0) * l.qty, 0)

  return (
    <div className="flex flex-col gap-4">
      <OrderStepper draftId={draft.id} current="review" />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Button size="sm" variant="muted" onClick={() => navigate('/orders-v2')} className="mb-1">← Orders v2</Button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Mighty Order</h1>
          <p className="text-xs text-inky mt-0.5">
            {draft.order_date} · {new Set(lines.map((l) => l.location_id)).size} shop(s) · {lines.length} line{lines.length !== 1 ? 's' : ''}
          </p>
        </div>
        <Button size="sm" loading={movingToFinal} disabled={lines.length === 0} onClick={async () => {
          setMovingToFinal(true)
          await setStatus('final_review')
          navigate(`/orders-v2/draft/${draft.id}/final`)
        }}>
          Final Review →
        </Button>
      </div>

      <Card><CardBody className="flex items-end gap-4 flex-wrap py-3">
        <Input label="Target Days of Supply" type="number" min={1} max={365} value={targetDays}
          onChange={(e) => setTargetDays(Math.max(1, Number(e.target.value) || 1))} className="w-40" />
        <Input label="Lead Time (days)" type="number" min={0} max={90} value={leadTimeDays}
          onChange={(e) => setLeadTimeDays(Math.max(0, Number(e.target.value) || 0))} className="w-40" />
        <Button size="sm" variant="secondary" loading={generating} onClick={() => runGeneration(targetDays, leadTimeDays)}>
          <RefreshCw className="w-3.5 h-3.5 mr-1" /> Regenerate
        </Button>
        <span className="text-[11px] font-mono text-inky/60">
          Regenerating replaces every line with a fresh calculation — any hand-edited quantities are lost.
        </span>
      </CardBody></Card>

      {generating ? (
        <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
      ) : lines.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-8">
          No Mighty-supplied products with usage data for the selected shop(s). Add a Supplier value on Product
          Usage rows first, or click Regenerate after doing so.
        </p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="px-3 py-2 text-left">Shop</th>
              <th className="px-3 py-2 text-left">Product</th>
              <th className="px-3 py-2 text-right">On Hand</th>
              <th className="px-3 py-2 text-right">Daily Usage</th>
              <th className="px-3 py-2 text-right">DOS Before</th>
              <th className="px-3 py-2 text-right">Order Qty</th>
              <th className="px-3 py-2 text-right">DOS After</th>
              <th className="px-3 py-2 text-right">Cost</th>
              <th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-b border-navy/15">
                  <td className="px-3 py-1.5 text-navy">{shopLabel(l.location_id)}</td>
                  <td className="px-3 py-1.5 text-navy">
                    {l.product_id}
                    {l.note && <span className="ml-1.5 text-inky/50" title={l.note}>ⓘ</span>}
                  </td>
                  <td className="px-3 py-1.5 text-right text-navy">{l.on_hand ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-navy">{l.daily_usage ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right text-navy">{dos(l.dos_before)}</td>
                  <td className={`px-3 py-1.5 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                    <input type="number" min={0} value={l.qty}
                      onChange={(e) => patchQty(l, Math.max(0, Number(e.target.value) || 0))}
                      className="w-20 bg-transparent border border-navy/25 rounded px-1.5 py-0.5 text-xs font-mono text-navy text-right focus:outline-none focus:ring-1 focus:ring-sky" />
                  </td>
                  <td className="px-3 py-1.5 text-right text-navy">{dos(l.dos_after)}</td>
                  <td className="px-3 py-1.5 text-right text-navy">{l.unit_cost != null ? money(l.unit_cost * l.qty) : '—'}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button onClick={() => removeLine(l.id)} className="text-inky/40 hover:text-[#C0392B]" title="Remove line">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-navy/30 font-bold">
                <td className="px-3 py-2 text-navy" colSpan={7}>Total</td>
                <td className="px-3 py-2 text-right text-navy">{money(totalCost)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
