import { useEffect, useMemo, useState } from 'react'
import { Button, Combobox, Input, Modal } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { supabase } from '@/lib/supabase'
import toast from 'react-hot-toast'
import { daysOfSupply, roundQty } from './engine'
import { normalizeConfigUom, isBulkUom, type OrderType } from './types'
import { num, dos } from './shared'
import type { OrderSettings } from './types'
import type { DraftLineRow } from './useOrdersV2'

const sb = () => supabase as any
const pkey = (v: unknown) => String(v ?? '').toLowerCase().trim()

interface VendorPartOpt {
  our_part_number: string | null
  part_number: string | null
  description: string | null
  unit_of_measure: string | null
  unit_cost: number | null
}

// A product queued up to add, not yet written — direct ask 2026-09-30:
// "Add Product" used to insert straight into the order immediately; now it
// only stages a row here (shown in a list below the picker), and every
// staged row gets added together in one pass when "Done" is clicked. The
// row carries the exact same fields addLine() needs, since it's really
// just the deferred addLine() payload plus a couple of display-only labels.
interface PendingRow {
  key: string
  locationId: string
  locationLabel: string
  productId: string
  orderType: OrderType
  uom: string | null
  qty: number
  unitCost: number | null
  onHand: number | null
  dailyUsage: number | null
  quartsPerUnit: number
  dosBefore: number | null
  dosAfter: number | null
}

/**
 * "Add Non-Configured Product" — direct ask 2026-09-30: a shop/product pair
 * with NO location_order_config row at all (unlike ShopConfiguredProductsTable's
 * own "add" flow, which only ever offers products already configured for
 * that shop but not currently on the order). Picks any active location and
 * any product this vendor carries (vendor_parts), pulls the same on-hand/
 * usage/DOS preview the main table shows, and stays open after each add so
 * a shop needing several unconfigured products doesn't mean reopening this
 * modal repeatedly.
 */
export function AddNonConfiguredProductModal({ open, onClose, vendorId, settings, addLine, initialLocationId }: {
  open: boolean
  onClose: () => void
  vendorId: string | null
  settings: OrderSettings
  addLine: (row: Partial<DraftLineRow> & { location_id: string; product_id: string; order_type: OrderType }) => Promise<void>
  // Pre-selects the shop combobox when opened from a specific shop's own
  // context (direct ask 2026-09-30, the "popup" shop-expand view's own
  // "Add Non-Configured Product" button) — still a plain Combobox, not
  // locked, so it can be changed if needed.
  initialLocationId?: string
}) {
  const loc = useLocations()
  const [locationId, setLocationId] = useState('')
  const [vendorParts, setVendorParts] = useState<VendorPartOpt[]>([])
  const [uomMappings, setUomMappings] = useState<{ from_unit: string; to_unit: string; factor: number; order_type: OrderType | null }[]>([])
  const [productMappings, setProductMappings] = useState<{ old_product_id: string; new_product_id: string }[]>([])
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('1')
  const [usage, setUsage] = useState<{ on_hand: number; daily_usage: number } | null>(null)
  const [loadingUsage, setLoadingUsage] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pendingRows, setPendingRows] = useState<PendingRow[]>([])

  // Loaded once per open, scoped to this vendor — small tables (a
  // company's own product catalog + its UOM conversions), same shape as
  // buildGenerationInputs' own fetch, just without everything else that
  // function pulls in for a FULL generation run.
  useEffect(() => {
    if (!open || !vendorId) return
    let cancelled = false
    Promise.all([
      sb().schema('inventory').from('vendor_parts')
        // Bug found live 2026-09-30: this used to also select a literal
        // "unit_cost" column, which vendor_parts has never had (cost is
        // only ever derived from metadata.package_qty_gallons *
        // price_per_gallon, same as everywhere else this table is read) —
        // PostgREST errors out a select referencing an unknown column, so
        // this whole query silently came back empty and the product picker
        // always showed "No results" regardless of the vendor.
        .select('our_part_number, part_number, description, unit_of_measure, metadata')
        .eq('vendor_id', vendorId),
      sb().schema('inventory').from('uom_mappings').select('vendor_id, from_unit, to_unit, factor, order_type').eq('vendor_id', vendorId),
      sb().schema('inventory').from('product_id_mappings').select('old_product_id, new_product_id'),
    ]).then(([vp, uom, pm]: any[]) => {
      if (cancelled) return
      setVendorParts(((vp.data ?? []) as any[]).map((r) => ({
        our_part_number: r.our_part_number, part_number: r.part_number, description: r.description,
        unit_of_measure: r.unit_of_measure,
        unit_cost: Number(r.metadata?.package_qty_gallons) > 0 && Number(r.metadata?.price_per_gallon) > 0
          ? Number(r.metadata.package_qty_gallons) * Number(r.metadata.price_per_gallon) : null,
      })))
      setUomMappings((uom.data ?? []) as any[])
      setProductMappings((pm.data ?? []) as any[])
    })
    return () => { cancelled = true }
  }, [open, vendorId])

  // Reset everything when the modal is reopened fresh (not on every
  // location/product change within a session — see resetProductOnly below
  // for the "stay open, add another" path).
  useEffect(() => {
    if (!open) return
    setLocationId(initialLocationId ?? ''); setProductId(''); setQty('1'); setUsage(null); setPendingRows([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const productOptions = useMemo(
    () => vendorParts
      .filter((v) => v.our_part_number)
      .map((v) => ({ value: v.our_part_number as string, label: `${v.our_part_number}${v.description ? ` — ${v.description}` : ''}` }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [vendorParts],
  )
  const selectedPart = useMemo(() => vendorParts.find((v) => v.our_part_number === productId) ?? null, [vendorParts, productId])

  const quartsPerUnit = useMemo(() => {
    if (!selectedPart) return 1
    const u = pkey(selectedPart.unit_of_measure)
    const mapped = uomMappings.find((m) => pkey(m.from_unit) === u && m.factor > 0)
    return mapped ? Number(mapped.factor) : 1
  }, [selectedPart, uomMappings])
  const orderType: OrderType = useMemo(() => {
    if (!selectedPart) return 'package'
    const u = pkey(selectedPart.unit_of_measure)
    const override = uomMappings.find((m) => pkey(m.from_unit) === u && m.order_type)?.order_type
    return override ?? (isBulkUom(normalizeConfigUom(selectedPart.unit_of_measure ?? '')) ? 'bulk' : 'package')
  }, [selectedPart, uomMappings])
  const resolvedUom = useMemo(() => normalizeConfigUom(selectedPart?.unit_of_measure ?? '') || null, [selectedPart])

  // On-hand/usage preview, fetched fresh whenever the shop+product pair
  // changes — same source (inventory.product_usage) the main table reads,
  // summed across this product id and any OLD id that maps forward to it
  // (product_id_mappings), matching how the main pipeline combines usage
  // recorded under a retired id.
  useEffect(() => {
    if (!locationId || !productId) { setUsage(null); return }
    let cancelled = false
    setLoadingUsage(true)
    const family = [productId, ...productMappings.filter((m) => m.new_product_id === productId).map((m) => m.old_product_id)]
    sb().schema('inventory').from('product_usage').select('on_hands, daily_usage')
      .eq('location_id', locationId).in('product_id', family)
      .then(({ data }: any) => {
        if (cancelled) return
        const rows = (data ?? []) as { on_hands: number | null; daily_usage: number | null }[]
        const on_hand = rows.reduce((s, r) => s + Number(r.on_hands ?? 0), 0)
        const daily_usage = rows.reduce((s, r) => s + Number(r.daily_usage ?? 0), 0)
        setUsage({ on_hand, daily_usage })
        setLoadingUsage(false)
      })
    return () => { cancelled = true }
  }, [locationId, productId, productMappings])

  const dosBefore = usage ? daysOfSupply(usage.on_hand, usage.daily_usage) : null
  const qtyNum = Number(qty) || 0
  const dosAfter = usage
    ? daysOfSupply(usage.on_hand + qtyNum * quartsPerUnit, usage.daily_usage)
    : null

  // Stages a row instead of writing it — direct ask 2026-09-30: nothing
  // actually hits the order until "Done" (handleDone below). Still resets
  // just the product picker afterward, keeping the shop selected, so
  // several products for the same shop don't mean re-picking it each time.
  function handleAddToList() {
    if (!locationId || !productId || qtyNum <= 0) return
    const rounded = roundQty(qtyNum, resolvedUom, settings.bulk_rounding_increment, 'nearest') || qtyNum
    const locationLabel = loc.includedOptions.find((o) => o.value === locationId)?.label ?? locationId
    setPendingRows((rows) => [...rows, {
      key: `${locationId}|${productId}|${rows.length}`,
      locationId, locationLabel, productId, orderType: orderType,
      uom: resolvedUom, qty: rounded,
      unitCost: selectedPart?.unit_cost ?? null,
      onHand: usage?.on_hand ?? null, dailyUsage: usage?.daily_usage ?? null,
      quartsPerUnit, dosBefore, dosAfter,
    }])
    setProductId(''); setQty('1'); setUsage(null)
  }

  function removePendingRow(key: string) {
    setPendingRows((rows) => rows.filter((r) => r.key !== key))
  }

  // Everything staged actually gets written here, all at once, then the
  // modal closes — direct ask 2026-09-30 ("add to the table when we click
  // on Done instead"). A Done with nothing staged just closes, same as
  // Cancel always did.
  async function handleDone() {
    if (pendingRows.length === 0) { onClose(); return }
    setSaving(true)
    for (const r of pendingRows) {
      await addLine({
        location_id: r.locationId, product_id: r.productId, order_type: r.orderType,
        uom: r.uom, qty: r.qty, system_qty: 0,
        unit_cost: r.unitCost,
        on_hand: r.onHand, daily_usage: r.dailyUsage,
        quarts_per_unit: r.quartsPerUnit,
        dos_before: r.dosBefore, dos_after: r.dosAfter,
        note: 'Added as a non-configured product',
      })
    }
    setSaving(false)
    toast.success(`Added ${pendingRows.length} product${pendingRows.length !== 1 ? 's' : ''}`)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Add Non-Configured Product" size="md">
      <div className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          For a product this shop doesn't have a configured order rule for at all. Pick a shop and product, review
          on-hand/days of supply, then "Add to List" — nothing is added to the order until you click Done, so you
          can queue up several products (for one shop or different ones) and commit them all at once.
        </p>

        <Combobox label="Shop" options={loc.includedOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" />
        <Combobox label="Product" options={productOptions} value={productId} onChange={setProductId} placeholder="Select product…" />

        {productId && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded border border-navy/15 px-2 py-1.5">
              <div className="text-[9px] font-mono uppercase tracking-wide text-inky/50">On Hand</div>
              <div className="text-sm font-mono text-navy font-bold">{loadingUsage ? '…' : usage ? num(usage.on_hand) : '—'}</div>
            </div>
            <div className="rounded border border-navy/15 px-2 py-1.5">
              <div className="text-[9px] font-mono uppercase tracking-wide text-inky/50">Days of Supply</div>
              <div className="text-sm font-mono text-navy font-bold">{loadingUsage ? '…' : dos(dosBefore)}</div>
            </div>
            <div className="rounded border border-navy/15 px-2 py-1.5">
              <div className="text-[9px] font-mono uppercase tracking-wide text-inky/50">DOS After</div>
              <div className="text-sm font-mono text-[#2ECC71] font-bold">{loadingUsage ? '…' : dos(dosAfter)}</div>
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <div className="flex-1">
            <Input label="Qty" type="number" min={0} step={orderType === 'bulk' ? 0.1 : 1} value={qty} onChange={(e) => setQty(e.target.value)} />
          </div>
          <Button size="sm" disabled={!locationId || !productId || qtyNum <= 0} onClick={handleAddToList}>Add to List</Button>
        </div>

        {pendingRows.length > 0 && (
          <div className="rounded border border-navy/15 max-h-40 overflow-auto">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-cream">
                <tr className="text-inky/60 uppercase border-b border-navy/10">
                  <th className="text-left px-2 py-1">Shop</th>
                  <th className="text-left px-2 py-1">Product</th>
                  <th className="text-right px-2 py-1">Qty</th>
                  <th className="px-2 py-1" />
                </tr>
              </thead>
              <tbody>
                {pendingRows.map((r) => (
                  <tr key={r.key} className="border-b border-navy/5">
                    <td className="px-2 py-1 text-navy">{r.locationLabel}</td>
                    <td className="px-2 py-1 text-navy">{r.productId}</td>
                    <td className="px-2 py-1 text-right text-navy">{num(r.qty)}</td>
                    <td className="px-2 py-1 text-right">
                      <button onClick={() => removePendingRow(r.key)} title="Remove from list" className="text-inky/40 hover:text-[#C0392B]">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-[10px] font-mono text-inky/50">
            {pendingRows.length > 0 ? `${pendingRows.length} queued — added on Done` : ''}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button size="sm" loading={saving} onClick={handleDone}>
              {pendingRows.length > 0 ? `Done — Add ${pendingRows.length}` : 'Done'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
