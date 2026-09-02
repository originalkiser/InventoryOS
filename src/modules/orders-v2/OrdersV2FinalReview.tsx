import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Copy, Download } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Input, Modal } from '@/components/ui'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import { useLocations } from '@/hooks/useLocations'
import { parseWeekday, orderDayFromDelivery } from '@/lib/orderDay'
import { useDraft, useOrderSettings, useVendorRules, type DraftLineRow } from './useOrdersV2'
import { useVendors } from './useLookups'
import { Flags } from './OrdersV2Review'
import { OrderStepper } from './OrderStepper'
import { daysOfSupply, daysBetween, nextDeliveryDate } from './engine'
import { OVERRIDE_CELL, dos, dShort, money, num, copyTableToClipboard, exportTableCsv, dosAfterForQty, type TableCol } from './shared'
import type { LineFlag, OrderType } from './types'

const shopSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

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
  const { draft, lines, loading, patchLine, removeLine } = useDraft(draftId || null)

  const [filter, setFilter] = useState('')
  const [openShop, setOpenShop] = useState<{ locationId: string; orderType: OrderType } | null>(null)

  const shopLabel = useCallback(
    (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—',
    [loc],
  )

  // A hand-edited qty updates DOS After the same way generation would have
  // computed it for that qty — was previously frozen at whatever
  // generation produced, silently going stale the moment someone typed a
  // different number. DOS @ Delivery is unaffected — it's existing on-hand
  // only, independent of qty (see dosAfterForQty's own comment).
  const patchQty = useCallback((l: DraftLineRow, qty: number) => {
    patchLine(l.id, { qty, dos_after: dosAfterForQty(l, qty) })
  }, [patchLine])

  const vendorRules = useMemo(() => rulesFor(draft?.vendor_id ?? null, settings, vendors.byId(draft?.vendor_id ?? null)?.name),
    [rulesFor, draft?.vendor_id, settings, vendors])

  /** Per shop x order type: dollars, minimum, and whether it clears. */
  const groups = useMemo(() => {
    const m = new Map<string, { locationId: string; orderType: OrderType; lines: DraftLineRow[]; dollars: number; minimum: number }>()
    for (const l of lines) {
      if (!l.included) continue
      const key = `${l.location_id}|${l.order_type}`
      if (!m.has(key)) {
        m.set(key, {
          locationId: l.location_id ?? '', orderType: l.order_type, lines: [], dollars: 0,
          minimum: vendorRules.minimums[l.order_type]?.dollars
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

  // RelaDyne-only (see OrdersV2Settings.tsx) — a shop with no delivery day
  // set, or a non-RelaDyne vendor with a real per-shop schedule instead,
  // has neither an order day nor a computable delivery date here; both
  // show as '—' rather than a guess. loc.byId already has this — no new
  // fetch needed, both tables below just weren't reading it yet.
  const deliveryDowOf = useCallback((id: string | null) => parseWeekday(loc.byId(id ?? '')?.reladyne_delivery_day as string | undefined), [loc])
  const orderDayOf = useCallback((id: string | null) => orderDayFromDelivery(loc.byId(id ?? '')?.reladyne_delivery_day as string | undefined) || '—', [loc])

  const outOfStock = useMemo(() => {
    const rows = lines.filter((l) => (l.flags ?? []).includes('stocked_out' as LineFlag)).map((l) => {
      const deliver = draft ? nextDeliveryDate(draft.order_date, deliveryDowOf(l.location_id)) : null
      const daysToDelivery = draft && deliver ? daysBetween(draft.order_date, deliver) : null
      // How many quarts would it take to bridge this shop to its upcoming
      // delivery on current on-hand/usage — on-hand is already ~0 here (the
      // whole point of "out of stock"), so this is essentially the usage
      // expected between now and delivery, less whatever's still on hand.
      const quartsNeeded = daysToDelivery != null
        ? Math.max(0, Number(l.daily_usage ?? 0) * daysToDelivery - Number(l.on_hand ?? 0))
        : null
      return { line: l, orderDay: orderDayOf(l.location_id), quartsNeeded }
    })
    return rows.sort((a, b) => shopSort(shopLabel(a.line.location_id), shopLabel(b.line.location_id)))
  }, [lines, draft, deliveryDowOf, orderDayOf, shopLabel])

  // Cached at generation time (OrdersV2Review.tsx) from the tank monitor's
  // on-hand — a keep-fill product needing attention regardless of whether
  // it cleared the standard reorder trigger and became a line at all.
  const keepfillAlertsRaw = useMemo(() => ((draft?.settings_snapshot as any)?.__keepfill_alerts ?? []) as {
    location_id: string; product_id: string; on_hand: number | null; daily_usage: number | null
    runway_days: number | null; next_delivery: string | null; delivery_after_next: string | null
    no_tank_data: boolean; will_run_out: boolean
  }[], [draft?.settings_snapshot])
  // Red: will run dry before the UPCOMING delivery — the most urgent case,
  // nothing but a keep-fill order today prevents a real stockout. Orange:
  // covered until the upcoming delivery, but won't last to the one after
  // it — still needs a keep-fill order placed soon, just not today.
  // Every row here already cleared the generation-time filter (will_run_out
  // vs the FURTHER of the two dates, or no tank data at all), so every one
  // lands in exactly one of these tiers — see the comment on that filter in
  // OrdersV2Review.tsx for why next_delivery <= delivery_after_next makes
  // that guarantee hold.
  const keepfillAlerts = useMemo(() => {
    const rows = keepfillAlertsRaw
      .filter((a) => !!a.location_id)
      .map((a) => {
        const daysToNext = draft && a.next_delivery ? daysBetween(draft.order_date, a.next_delivery) : null
        const daysToAfterNext = draft && a.delivery_after_next ? daysBetween(draft.order_date, a.delivery_after_next) : null
        const tier: 'red' | 'orange' | 'unknown' = a.no_tank_data
          ? 'unknown'
          : a.runway_days != null && daysToNext != null && a.runway_days < daysToNext
            ? 'red'
            : 'orange'
        return { alert: a, tier, orderDay: orderDayOf(a.location_id) }
      })
    return rows.sort((a, b) => shopSort(shopLabel(a.alert.location_id), shopLabel(b.alert.location_id)))
  }, [keepfillAlertsRaw, draft, orderDayOf, shopLabel])

  const outOfStockCols: TableCol<(typeof outOfStock)[number]>[] = [
    { label: 'Shop', get: (r) => shopLabel(r.line.location_id) },
    { label: 'Order Day', get: (r) => r.orderDay },
    { label: 'Product', get: (r) => r.line.product_id },
    { label: 'Usage/day', get: (r) => num(r.line.daily_usage), align: 'right' },
    { label: 'Order Qty', get: (r) => num(r.line.qty), align: 'right' },
    { label: 'DOS After Delivery', get: (r) => dos(r.line.dos_after_delivery), align: 'right' },
    { label: 'Qt Needed to Bridge', get: (r) => (r.quartsNeeded != null ? num(r.quartsNeeded, 1) : '—'), align: 'right' },
  ]
  const copyOutOfStock = async () => {
    const ok = await copyTableToClipboard(`Out of Stock — ${vendors.byId(draft?.vendor_id ?? null)?.name ?? ''} ${draft?.order_date ?? ''}`, outOfStockCols, outOfStock)
    ok ? toast.success('Copied to clipboard') : toast.error('Copy failed')
  }
  const exportOutOfStock = () => exportTableCsv(`out-of-stock-${draft?.order_date ?? ''}`, outOfStockCols, outOfStock)

  const keepfillCols: TableCol<(typeof keepfillAlerts)[number]>[] = [
    { label: 'Shop', get: (r) => shopLabel(r.alert.location_id) },
    { label: 'Order Day', get: (r) => r.orderDay },
    { label: 'Product', get: (r) => r.alert.product_id },
    { label: 'On Hand', get: (r) => (r.alert.on_hand != null ? num(r.alert.on_hand) : '—'), align: 'right' },
    { label: 'Usage/day', get: (r) => num(r.alert.daily_usage), align: 'right' },
    { label: 'Runway (days)', get: (r) => (r.alert.runway_days != null ? num(r.alert.runway_days, 1) : '—'), align: 'right' },
    { label: 'Next Delivery', get: (r) => (r.alert.next_delivery ? dShort(r.alert.next_delivery) : '—') },
    { label: 'Issue', get: (r) => (r.alert.no_tank_data ? 'No tank monitor data' : r.tier === 'red' ? 'Will run dry before upcoming delivery' : 'Will run dry before next delivery after that') },
  ]
  const copyKeepfill = async () => {
    const ok = await copyTableToClipboard(`Keep-fill / VMI Needs Attention — ${vendors.byId(draft?.vendor_id ?? null)?.name ?? ''} ${draft?.order_date ?? ''}`, keepfillCols, keepfillAlerts)
    ok ? toast.success('Copied to clipboard') : toast.error('Copy failed')
  }
  const exportKeepfill = () => exportTableCsv(`keepfill-needs-attention-${draft?.order_date ?? ''}`, keepfillCols, keepfillAlerts)

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

  // Alternates per shop (not per row) — see OrdersV2Review.tsx for why.
  const bandOf = useMemo(() => {
    const m = new Map<string, boolean>()
    let prevShop: string | null = null
    let band = false
    for (const l of visible) {
      if (l.location_id !== prevShop) { band = !band; prevShop = l.location_id }
      m.set(l.id, band)
    }
    return m
  }, [visible])

  if (loading) {
    return (
      <LoadingProgress
        fraction={null}
        countText="Loading final review…"
        messages={['Checking order minimums…', 'Rounding up fallouts…', 'Sorting shops…']}
      />
    )
  }
  if (!draft) return <p className="text-xs font-mono text-inky/60 py-8">Draft not found.</p>

  const modalLines = openShop
    ? lines.filter((l) => l.location_id === openShop.locationId && l.order_type === openShop.orderType)
    : []
  const openMinimum = openShop
    ? (vendorRules.minimums[openShop.orderType]?.dollars
      ?? (openShop.orderType === 'bulk' ? settings.order_minimum_dollars_bulk : settings.order_minimum_dollars_package))
    : 0
  const modalTotal = modalLines.filter((l) => l.included).reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost ?? 0), 0)
  const modalBelowMin = openMinimum > 0 && modalTotal < openMinimum

  return (
    <div className="flex flex-col gap-4">
      <OrderStepper draftId={draft.id} current="final" />

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Button size="sm" variant="muted" onClick={() => navigate(`/orders-v2/draft/${draft.id}`)} className="mb-1">← Review</Button>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Final Review</h1>
          <p className="text-xs text-inky mt-0.5">
            {vendors.byId(draft.vendor_id)?.name ?? 'All vendors'} · {groups.length} order{groups.length !== 1 ? 's' : ''} · {money(total)}
          </p>
        </div>
        <Button size="sm" onClick={() => navigate(`/orders-v2/draft/${draft.id}/export`)}>
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
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Out of stock ({outOfStock.length})</span>
            <div className="flex gap-1.5">
              <button onClick={() => copyOutOfStock()} title="Copy table"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button onClick={() => exportOutOfStock()} title="Export CSV"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
          <p className="text-[11px] font-mono text-inky/60">Nothing on hand at generation time — shown separately since these are the most urgent lines.</p>
          <div className="overflow-auto max-h-56 rounded border border-navy/20">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Order Day</th>
                <th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">Usage/day</th><th className="text-right px-2 py-1">Order Qty</th>
                <th className="text-right px-2 py-1">DOS After Delivery</th>
                <th className="text-right px-2 py-1">Qt Needed to Bridge</th>
              </tr></thead>
              <tbody>
                {outOfStock.map(({ line: l, orderDay, quartsNeeded }) => (
                  <tr key={l.id} className="border-b border-navy/10">
                    <td className="px-2 py-1 text-navy">{shopLabel(l.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{orderDay}</td>
                    <td className="px-2 py-1 text-navy">{l.product_id}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.daily_usage)}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(l.qty)}</td>
                    <td className="px-2 py-1 text-right text-navy">{dos(l.dos_after_delivery)}</td>
                    <td className="px-2 py-1 text-right text-navy">{quartsNeeded != null ? num(quartsNeeded, 1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}

      {keepfillAlerts.length > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">Keep-fill / VMI needs attention ({keepfillAlerts.length})</span>
            <div className="flex gap-1.5">
              <button onClick={() => copyKeepfill()} title="Copy table"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button onClick={() => exportKeepfill()} title="Export CSV"
                className="flex items-center gap-1 text-[10px] font-mono text-inky/60 hover:text-navy border border-navy/20 rounded px-1.5 py-0.5">
                <Download className="w-3 h-3" /> Export
              </button>
            </div>
          </div>
          <p className="text-[11px] font-mono text-inky/60">
            Vendor-managed inventory, tracked by tank monitor — not included in this order's total by default.
            <span className="text-[#C0392B] font-bold"> Red</span> won&apos;t last to the UPCOMING delivery —
            needs a keep-fill order now. <span className="text-[#E67E22] font-bold">Orange</span> makes it to the
            upcoming delivery but not the one after — plan a keep-fill order soon. Consider a keep-fill order to
            RelaDyne before then.
          </p>
          <div className="overflow-auto max-h-56 rounded border border-[#C0392B]/30">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Order Day</th>
                <th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">On Hand</th><th className="text-right px-2 py-1">Usage/day</th>
                <th className="text-right px-2 py-1">Runway (days)</th><th className="text-left px-2 py-1">Next Delivery</th>
                <th className="text-left px-2 py-1">Issue</th>
              </tr></thead>
              <tbody>
                {keepfillAlerts.map(({ alert: a, tier, orderDay }, i) => (
                  <tr key={`${a.location_id}|${a.product_id}|${i}`}
                    className={`border-b border-navy/10 ${tier === 'red' ? 'bg-[#C0392B]/10' : tier === 'orange' ? 'bg-[#E67E22]/10' : ''}`}>
                    <td className="px-2 py-1 text-navy">{shopLabel(a.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{orderDay}</td>
                    <td className="px-2 py-1 text-navy">{a.product_id}</td>
                    <td className="px-2 py-1 text-right text-navy">{a.on_hand != null ? num(a.on_hand) : '—'}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(a.daily_usage)}</td>
                    <td className="px-2 py-1 text-right text-navy">{a.runway_days != null ? num(a.runway_days, 1) : '—'}</td>
                    <td className="px-2 py-1 text-navy">{a.next_delivery ? dShort(a.next_delivery) : '—'}</td>
                    <td className={`px-2 py-1 font-bold ${tier === 'red' ? 'text-[#C0392B]' : tier === 'orange' ? 'text-[#E67E22]' : 'text-inky'}`}>
                      {a.no_tank_data ? 'No tank monitor data' : tier === 'red' ? 'Will run dry before upcoming delivery' : 'Will run dry before next delivery after that'}
                    </td>
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
              <tr key={l.id} className={`border-b border-navy/15 ${l.included ? '' : 'opacity-45'} ${bandOf.get(l.id) ? 'bg-navy/[0.035]' : ''}`}>
                <td className="px-2 py-1">
                  <button onClick={() => setOpenShop({ locationId: l.location_id ?? '', orderType: l.order_type })}
                    className="text-navy hover:underline">{shopLabel(l.location_id)}</button>
                </td>
                <td className="px-2 py-1 text-navy">{l.product_id}</td>
                <td className="px-2 py-1 text-navy">{l.uom ?? '—'}</td>
                <td className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                  <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                    onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
                    className="w-16 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                  {l.quarts_per_unit != null && (
                    <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(l.qty) * l.quarts_per_unit, 1)} qt</div>
                  )}
                </td>
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
                  <th className="text-right px-2 py-1">Daily Usage</th>
                  <th className="text-right px-2 py-1">$</th><th className="text-right px-2 py-1">DOS After</th><th />
                </tr></thead>
                <tbody>
                  {modalLines.map((l) => (
                    <tr key={l.id} className={`border-b border-navy/10 ${l.included ? '' : 'opacity-45'}`}>
                      <td className="px-2 py-1 text-navy">{l.product_id}</td>
                      <td className={`px-2 py-1 text-right ${l.is_override ? OVERRIDE_CELL : ''}`}>
                        <input type="number" min={0} step={l.uom === 'bulk' ? 0.1 : 1} value={l.qty}
                          onChange={(e) => patchQty(l, Number(e.target.value) || 0)}
                          className="w-20 bg-transparent border border-navy/25 rounded px-1 py-0.5 text-right text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
                        {l.quarts_per_unit != null && (
                          <div className="text-[10px] text-inky/50 mt-0.5">{num(Number(l.qty) * l.quarts_per_unit, 1)} qt</div>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right text-navy">{num(l.daily_usage)}</td>
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
              <span
                className={modalBelowMin ? 'text-[#C0392B] font-bold' : 'text-inky'}
                title={modalBelowMin ? `Order Total: ${money(modalTotal)}, -${money(openMinimum - modalTotal)} from minimum` : undefined}
              >
                Order total {money(modalTotal)}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setOpenShop(null)}>Done</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
