import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, CardBody, Input, SbLoader, Select } from '@/components/ui'
import { useOrderSettings } from './useOrdersV2'
import { VendorRulesCard } from './VendorRulesCard'
import { DeliverySchedulesCard } from './DeliverySchedulesCard'
import { MINIMUM_TYPE_LABELS, type MinimumType, type OrderSettings } from './types'


/**
 * The ordering module's own settings — deliberately not in SB Net's global
 * config, since every value here is specific to how orders are generated.
 */
export function OrdersV2Settings() {
  const navigate = useNavigate()
  return (
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order Settings</h1>
        <p className="text-xs text-inky mt-0.5">Scoped to the ordering module. Changes apply to the next order generated, not to drafts already created.</p>
      </div>
      <OrdersV2SettingsBody />
    </div>
  )
}

/**
 * The settings form itself, with no page chrome — shared by the standalone
 * page above and the "Order Settings" modal opened from Review Order, so
 * the two never drift apart.
 */
export function OrdersV2SettingsBody() {
  const { settings, loading, save } = useOrderSettings()
  const [draft, setDraft] = useState<OrderSettings>(settings)
  useEffect(() => { setDraft(settings) }, [settings])

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const numField = (key: keyof OrderSettings, label: string, hint?: string, step = 1) => (
    <div className="flex flex-col gap-0.5">
      <Input label={label} type="number" step={step} value={String(draft[key] ?? '')}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) || 0 }))} />
      {hint && <span className="text-[10px] font-mono text-inky/50">{hint}</span>}
    </div>
  )

  if (loading) return <div className="py-16 flex justify-center"><SbLoader size={40} /></div>

  return (
    <div className="flex flex-col gap-4">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Days of Supply</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {numField('days_of_supply_target', 'Target', 'Fill each product toward this')}
          {numField('days_of_supply_min_trigger', 'Min trigger', 'Below this, a product is due to order')}
          {numField('days_of_supply_max', 'Max', 'Never push a product past this')}
        </div>
        <p className="text-[11px] font-mono text-inky/60">
          Max is a <strong>soft</strong> ceiling — an order may exceed it when a minimum or the shop's usage demands
          it, and those lines are flagged rather than blocked. A product's max capacity is the only hard limit.
        </p>
        {numField('skip_order_if_dos_over', 'Only smooth in products under this DOS',
          'Smoothing guard only — a product above this is never pulled onto an order just to hit a minimum. It never stops a product that is genuinely due.')}
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Order Minimums</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Company defaults. Package and bulk are checked separately per shop; a vendor-specific value below overrides these.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <MinimumEditor label="Package" type={draft.package_minimum_type} qty={draft.package_minimum_qty}
            dollars={draft.order_minimum_dollars_package}
            onChange={(t, d, q) => setDraft((x) => ({ ...x, package_minimum_type: t, order_minimum_dollars_package: d, package_minimum_qty: q }))} />
          <MinimumEditor label="Bulk" type={draft.bulk_minimum_type} qty={draft.bulk_minimum_qty}
            dollars={draft.order_minimum_dollars_bulk}
            onChange={(t, d, q) => setDraft((x) => ({ ...x, bulk_minimum_type: t, order_minimum_dollars_bulk: d, bulk_minimum_qty: q }))} />
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Repeat Ordering Check</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Catches a product being ordered again and again while its on-hand never rises — usually the shop not
          updating inventory after a delivery, or deliveries not arriving. It sums the days of supply ordered across
          <strong> every</strong> order in the window, so a run of ordinary orders is caught, not just one big one.
          Informational: flagged lines still order normally.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {numField('flag_cumulative_days', 'Look back (days)', 'how far back to add orders up')}
          {numField('flag_cumulative_dos_over', 'Flag if total days of supply ordered exceeds',
            'across all orders in that window')}
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Rounding</h3>
        {numField('bulk_rounding_decimals', 'Bulk decimal places', 'Cases, drums and bay boxes always order in whole units')}
      </CardBody></Card>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="secondary" disabled={!dirty} onClick={() => setDraft(settings)}>Discard</Button>
        <Button size="sm" disabled={!dirty} onClick={() => save(draft)}>Save Settings</Button>
      </div>

      <VendorRulesCard />
      <OrderDaysCard />
      <DeliverySchedulesCard />
    </div>
  )
}

/**
 * An order minimum is either a dollar floor on the whole order, or a
 * per-product floor (units or gallons). The two are genuinely different
 * rules, so the editor swaps the input rather than showing both.
 */
function MinimumEditor({ label, type, dollars, qty, onChange }: {
  label: string
  type: MinimumType
  dollars: number
  qty: number | null
  onChange: (type: MinimumType, dollars: number, qty: number | null) => void
}) {
  return (
    <div className="flex flex-col gap-2 rounded border border-navy/20 p-3">
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label} minimum</span>
      <Select value={type} onChange={(e) => onChange(e.target.value as MinimumType, dollars, qty)}
        options={(Object.keys(MINIMUM_TYPE_LABELS) as MinimumType[]).map((t) => ({ value: t, label: MINIMUM_TYPE_LABELS[t] }))} />
      {type === 'dollars' ? (
        <Input label="Dollars" type="number" step={5} value={String(dollars ?? '')}
          onChange={(e) => onChange(type, Number(e.target.value) || 0, qty)} />
      ) : (
        <>
          <Input label={type === 'gallons_per_product' ? 'Gallons per product' : 'Units per product'}
            type="number" step={1} value={qty == null ? '' : String(qty)}
            onChange={(e) => onChange(type, dollars, e.target.value === '' ? null : Number(e.target.value))} />
          <span className="text-[10px] font-mono text-inky/50">
            Applies to each product ordered, not to the order total.
          </span>
        </>
      )}
    </div>
  )
}

/**
 * Order/delivery days are a RelaDyne arrangement and already live on the
 * location list (reladyne_delivery_day, with the order day derived from it),
 * so this module reads them rather than keeping a second copy.
 */
function OrderDaysCard() {
  const navigate = useNavigate()
  return (
    <Card><CardBody className="flex flex-col gap-2">
      <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Order &amp; Delivery Days</h3>
      <p className="text-[11px] font-mono text-inky/60">
        Read from each shop&apos;s <strong>Reladyne Delivery Day</strong> on the location list. The order day is
        derived from it (delivery minus three business days), and the delivery day drives the &quot;DOS at
        delivery&quot; column.
      </p>
      <p className="text-[11px] font-mono text-inky/60">
        This restriction applies to <strong>RelaDyne only</strong> — other vendors can be ordered any day. A shop with
        no delivery day set is skipped on a RelaDyne run.
      </p>
      <div>
        <Button size="sm" variant="secondary" onClick={() => navigate('/config?tab=locations')}>Edit on the location list</Button>
      </div>
    </CardBody></Card>
  )
}
