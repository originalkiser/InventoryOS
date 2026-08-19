import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Select } from '@/components/ui'
import { useVendorRules } from './useOrdersV2'
import { useVendors } from './useLookups'
import { MINIMUM_TYPE_LABELS, UOM_LABELS, UOM_OPTIONS, type MinimumType, type OrderType } from './types'

interface MinRow { minimum_type?: MinimumType; minimum_dollars?: number; minimum_qty?: number | null }

/** One-line summary of a vendor's minimum, for the always-visible list. */
function describeMin(row: MinRow | undefined): string {
  if (!row) return 'company default'
  const t = row.minimum_type ?? 'dollars'
  if (t === 'dollars') return `$${Number(row.minimum_dollars ?? 0).toLocaleString()} per order`
  const unit = t === 'gallons_per_product' ? 'gallons' : 'units'
  return `${row.minimum_qty ?? 0} ${unit} per product`
}

/**
 * Per-vendor overrides of the company defaults. Everything configured is
 * listed up front — you shouldn't have to cycle the vendor dropdown to find
 * out which vendors have rules.
 */
export function VendorRulesCard() {
  const vendors = useVendors()
  const { minimums, caseLimits, saveMinimum, saveCaseLimit, removeCaseLimit } = useVendorRules()
  const [vendorId, setVendorId] = useState('')
  const [caseType, setCaseType] = useState('bay_box')
  const [limit, setLimit] = useState('')

  const rowFor = (vId: string, type: OrderType) => minimums.find((m) => m.vendor_id === vId && m.order_type === type)
  const vendorName = (id: string) => vendors.byId(id)?.name ?? id

  const configured = [...new Set([
    ...minimums.map((m) => m.vendor_id),
    ...caseLimits.map((c) => c.vendor_id),
  ])].sort((a, b) => vendorName(a).localeCompare(vendorName(b)))

  const vendorLimits = caseLimits.filter((c) => c.vendor_id === vendorId)

  return (
    <Card><CardBody className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Vendor Rules</h3>
        <p className="text-[11px] font-mono text-inky/60 mt-0.5">
          Overrides the company defaults above for a single vendor. Everything configured is listed below.
        </p>
      </div>

      {configured.length > 0 ? (
        <div className="flex flex-col gap-2">
          {configured.map((vId) => {
            const limits = caseLimits.filter((c) => c.vendor_id === vId)
            return (
              <div key={vId} className="rounded border border-navy/20 px-3 py-2 flex flex-col gap-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono font-bold text-navy">{vendorName(vId)}</span>
                  <button onClick={() => setVendorId(vId)} className="text-[10px] font-mono text-inky hover:text-navy hover:underline">edit</button>
                </div>
                <div className="text-[11px] font-mono text-inky/70 flex flex-col gap-0.5">
                  <span>Package: {describeMin(rowFor(vId, 'package'))}</span>
                  <span>Bulk: {describeMin(rowFor(vId, 'bulk'))}</span>
                  {limits.length > 0 && (
                    <span>
                      Case minimums: {limits.map((c) => `${UOM_LABELS[c.case_type] ?? c.case_type} at least ${c.minimum_qty}`).join(', ')}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-[11px] font-mono text-inky/40 italic">No vendor overrides — every vendor uses the company defaults.</p>
      )}

      <div className="border-t border-navy/10 pt-3 flex flex-col gap-3">
        <div className="w-64">
          <Combobox label="Configure vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
        </div>

        {vendorId && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <VendorMinimumEditor key={`${vendorId}-package`} vendorId={vendorId} orderType="package" row={rowFor(vendorId, 'package')} onSave={saveMinimum} />
              <VendorMinimumEditor key={`${vendorId}-bulk`} vendorId={vendorId} orderType="bulk" row={rowFor(vendorId, 'bulk')} onSave={saveMinimum} />
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Case type minimums</span>
              <p className="text-[11px] font-mono text-inky/60">
                If an order includes this case type at all, it must total at least this many — e.g. bay boxes ship in
                sixes. A floor on the order, not a multiple each product has to be ordered in.
              </p>
              <div className="flex items-end gap-2 flex-wrap">
                <div className="w-40">
                  <Select label="Case type" value={caseType} onChange={(e) => setCaseType(e.target.value)}
                    options={UOM_OPTIONS.map((u) => ({ value: u, label: UOM_LABELS[u] ?? u }))} />
                </div>
                <Input label="Minimum qty" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} className="w-28" />
                <Button size="sm" variant="secondary" disabled={!limit}
                  onClick={() => { saveCaseLimit(vendorId, caseType, Number(limit) || 0); setLimit('') }}>Add minimum</Button>
              </div>
              <div className="flex flex-col gap-1">
                {vendorLimits.map((c) => (
                  <div key={c.id} className="flex items-center gap-2 text-xs font-mono text-navy">
                    <span className="w-32">{UOM_LABELS[c.case_type] ?? c.case_type}</span>
                    <span>at least {c.minimum_qty} per order</span>
                    <button onClick={() => removeCaseLimit(c.id)} className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
                {vendorLimits.length === 0 && (
                  <span className="text-[11px] font-mono text-inky/40 italic">No case-type minimums for this vendor.</span>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </CardBody></Card>
  )
}

/** One vendor's minimum for one order type — dollars, or a per-product floor. */
function VendorMinimumEditor({ vendorId, orderType, row, onSave }: {
  vendorId: string
  orderType: OrderType
  row?: MinRow
  onSave: (vendorId: string, orderType: OrderType, dollars: number, type: MinimumType, qty: number | null) => void
}) {
  const [type, setType] = useState<MinimumType>(row?.minimum_type ?? 'dollars')
  const [dollars, setDollars] = useState(String(row?.minimum_dollars ?? ''))
  const [qty, setQty] = useState(row?.minimum_qty == null ? '' : String(row.minimum_qty))

  useEffect(() => {
    setType(row?.minimum_type ?? 'dollars')
    setDollars(String(row?.minimum_dollars ?? ''))
    setQty(row?.minimum_qty == null ? '' : String(row.minimum_qty))
  }, [row])

  return (
    <div className="flex flex-col gap-2 rounded border border-navy/20 p-3">
      <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{orderType} minimum</span>
      <Select value={type} onChange={(e) => setType(e.target.value as MinimumType)}
        options={(Object.keys(MINIMUM_TYPE_LABELS) as MinimumType[]).map((t) => ({ value: t, label: MINIMUM_TYPE_LABELS[t] }))} />
      {type === 'dollars' ? (
        <Input label="Dollars" type="number" step={5} value={dollars} onChange={(e) => setDollars(e.target.value)} />
      ) : (
        <Input label={type === 'gallons_per_product' ? 'Gallons per product' : 'Units per product'}
          type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
      )}
      <Button size="sm" variant="secondary"
        onClick={() => onSave(vendorId, orderType, Number(dollars) || 0, type, qty === '' ? null : Number(qty))}>
        Save {orderType}
      </Button>
    </div>
  )
}
