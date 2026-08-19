import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, SbLoader, Select } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { useOrderSettings, useVendorRules } from './useOrdersV2'
import { useVendors } from './useLookups'
import { UOM_LABELS, UOM_OPTIONS, type OrderSettings } from './types'

const sb = () => supabase as any
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * The ordering module's own settings — deliberately not in SB Net's global
 * config, since every value here is specific to how orders are generated.
 */
export function OrdersV2Settings() {
  const navigate = useNavigate()
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
    <div className="flex flex-col gap-4 max-w-4xl">
      <div>
        <button onClick={() => navigate('/orders-v2')} className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline">← Orders v2</button>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Order Settings</h1>
        <p className="text-xs text-inky mt-0.5">Scoped to the ordering module. Changes apply to the next order generated, not to drafts already created.</p>
      </div>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Days of Supply</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {numField('days_of_supply_target', 'Target', 'Fill each product toward this')}
          {numField('days_of_supply_min_trigger', 'Min trigger', 'Below this, a product is due to order')}
          {numField('days_of_supply_max', 'Max', 'Never push a product past this')}
        </div>
        {numField('skip_order_if_dos_over', 'Skip if DOS over', 'Well-stocked products are left off entirely')}
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Order Minimums</h3>
        <p className="text-[11px] font-mono text-inky/60">
          Company defaults. Package and bulk are checked separately per shop; a vendor-specific value below overrides these.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {numField('order_minimum_dollars_package', 'Package minimum ($)', undefined, 5)}
          {numField('order_minimum_dollars_bulk', 'Bulk minimum ($)', 'Defaulted to match package — set the real figure', 5)}
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Flags</h3>
        <p className="text-[11px] font-mono text-inky/60">Informational only — flagged lines still order normally.</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {numField('flag_if_ordered_over_dos', 'Flag if ordered over DOS', 'x — days of supply at the time')}
          {numField('flag_if_ordered_within_days', '…within days', 'y — lookback window')}
          {numField('flag_if_last_order_usage_under', 'Flag if last order covered under', 'days of actual usage')}
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
    </div>
  )
}

function VendorRulesCard() {
  const vendors = useVendors()
  const { minimums, caseLimits, saveMinimum, saveCaseLimit, removeCaseLimit } = useVendorRules()
  const [vendorId, setVendorId] = useState('')
  const [pkg, setPkg] = useState('')
  const [bulk, setBulk] = useState('')
  const [caseType, setCaseType] = useState('bay_box')
  const [limit, setLimit] = useState('')

  useEffect(() => {
    setPkg(String(minimums.find((m) => m.vendor_id === vendorId && m.order_type === 'package')?.minimum_dollars ?? ''))
    setBulk(String(minimums.find((m) => m.vendor_id === vendorId && m.order_type === 'bulk')?.minimum_dollars ?? ''))
  }, [vendorId, minimums])

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Vendor Rules</h3>
      <div className="w-64">
        <Combobox label="Vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
      </div>

      {vendorId && (
        <>
          <div className="flex items-end gap-2 flex-wrap">
            <Input label="Package minimum ($)" type="number" step={5} value={pkg} onChange={(e) => setPkg(e.target.value)} className="w-40" />
            <Button size="sm" variant="secondary" onClick={() => saveMinimum(vendorId, 'package', Number(pkg) || 0)}>Save</Button>
            <Input label="Bulk minimum ($)" type="number" step={5} value={bulk} onChange={(e) => setBulk(e.target.value)} className="w-40" />
            <Button size="sm" variant="secondary" onClick={() => saveMinimum(vendorId, 'bulk', Number(bulk) || 0)}>Save</Button>
          </div>

          <div className="border-t border-navy/10 pt-3 flex flex-col gap-2">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Case type limits</span>
            <p className="text-[11px] font-mono text-inky/60">
              Caps how many of a case type can go on one order regardless of demand (e.g. Valvoline bay boxes).
            </p>
            <div className="flex items-end gap-2 flex-wrap">
              <div className="w-40">
                <Select label="Case type" value={caseType} onChange={(e) => setCaseType(e.target.value)}
                  options={UOM_OPTIONS.map((u) => ({ value: u, label: UOM_LABELS[u] ?? u }))} />
              </div>
              <Input label="Limit qty" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} className="w-28" />
              <Button size="sm" variant="secondary" disabled={!limit} onClick={() => { saveCaseLimit(vendorId, caseType, Number(limit) || 0); setLimit('') }}>Add limit</Button>
            </div>
            <div className="flex flex-col gap-1">
              {caseLimits.filter((c) => c.vendor_id === vendorId).map((c) => (
                <div key={c.id} className="flex items-center gap-2 text-xs font-mono text-navy">
                  <span className="w-32">{UOM_LABELS[c.case_type] ?? c.case_type}</span>
                  <span>max {c.limit_qty}</span>
                  <button onClick={() => removeCaseLimit(c.id)} className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              ))}
              {caseLimits.filter((c) => c.vendor_id === vendorId).length === 0 && (
                <span className="text-[11px] font-mono text-inky/40 italic">No limits — quantities are bounded only by capacity and DOS.</span>
              )}
            </div>
          </div>

        </>
      )}
    </CardBody></Card>
  )
}

/** Per shop x vendor order + delivery weekday. */
function OrderDaysCard() {
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()
  const [vendorId, setVendorId] = useState('')
  const [rows, setRows] = useState<any[]>([])
  const [locationId, setLocationId] = useState('')
  const [orderDow, setOrderDow] = useState('1')
  const [deliveryDow, setDeliveryDow] = useState('4')

  const load = async () => {
    if (!profile?.company_id || !vendorId) { setRows([]); return }
    const { data } = await sb().schema('inventory').from('ov2_location_vendor_days')
      .select('*').eq('company_id', profile.company_id).eq('vendor_id', vendorId)
    setRows((data ?? []) as any[])
  }
  useEffect(() => { void load() }, [profile?.company_id, vendorId])   // eslint-disable-line react-hooks/exhaustive-deps

  async function add() {
    if (!profile?.company_id || !vendorId || !locationId) return
    const { error } = await sb().schema('inventory').from('ov2_location_vendor_days').upsert({
      company_id: profile.company_id, location_id: locationId, vendor_id: vendorId,
      order_dow: Number(orderDow), delivery_dow: Number(deliveryDow),
      updated_by: profile.id ?? null, updated_at: new Date().toISOString(),
    }, { onConflict: 'company_id,location_id,vendor_id' })
    if (error) { toast.error(error.message); return }
    toast.success('Order day saved'); setLocationId(''); void load()
  }

  async function remove(id: string) {
    const { error } = await sb().schema('inventory').from('ov2_location_vendor_days').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    void load()
  }

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Order &amp; Delivery Days</h3>
      <p className="text-[11px] font-mono text-inky/60">
        Restricts a vendor's orders to each shop's designated day, and drives the "DOS at delivery" column. A shop
        with no row here can be ordered any day.
      </p>
      <div className="w-64">
        <Combobox label="Vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
      </div>

      {vendorId && (
        <>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="w-64"><Combobox label="Shop" options={loc.includedOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" /></div>
            <div className="w-36"><Select label="Order day" value={orderDow} onChange={(e) => setOrderDow(e.target.value)} options={DOW.map((d, i) => ({ value: String(i), label: d }))} /></div>
            <div className="w-36"><Select label="Delivery day" value={deliveryDow} onChange={(e) => setDeliveryDow(e.target.value)} options={DOW.map((d, i) => ({ value: String(i), label: d }))} /></div>
            <Button size="sm" variant="secondary" disabled={!locationId} onClick={add}>Save</Button>
          </div>
          <div className="overflow-auto max-h-72 rounded border border-navy/20">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Order Day</th><th className="text-left px-2 py-1">Delivery Day</th><th />
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-navy/10">
                    <td className="px-2 py-1 text-navy">{loc.fieldValue(r.location_id, 'shop_city') || loc.codeOf(r.location_id)}</td>
                    <td className="px-2 py-1 text-navy">{r.order_dow == null ? '—' : DOW[r.order_dow]}</td>
                    <td className="px-2 py-1 text-navy">{r.delivery_dow == null ? '—' : DOW[r.delivery_dow]}</td>
                    <td className="px-2 py-1 text-right">
                      <button onClick={() => remove(r.id)} className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={4} className="px-2 py-4 text-center text-inky/40">No order days set for this vendor.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </CardBody></Card>
  )
}
