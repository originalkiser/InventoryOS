import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Combobox, Input, Modal, MultiSelectDropdown } from '@/components/ui'
import { LoadingProgress } from '@/components/shared/LoadingProgress'
import {
  useDrafts, useGenerationData, useOrderSettings, useVendorRules, buildGenerationInputs,
  insertGeneratedLines, type OrderConfigRow,
} from '@/modules/orders-v2/useOrdersV2'
import { useVendors } from '@/modules/orders-v2/useLookups'
import {
  generateOrder, gallonsPerUnit, resolvedOrderType, daysOfSupply, unitsToTarget, capsFor, roundQty,
} from '@/modules/orders-v2/engine'
import { dosAfterForQty, dos, money, num, FLAG_CLASS, FLAG_META } from '@/modules/orders-v2/shared'
import type { GeneratedLine, OrderSettings } from '@/modules/orders-v2/types'

const lineKey = (l: { location_id: string; product_id: string }) => `${l.location_id}|${l.product_id}`

/**
 * "Start Ad Hoc Order" — a fast path into Orders v2 from the Order Config
 * tab: pick a vendor + specific shop(s), set a days-of-supply target, and
 * get suggested quantities for whatever's currently configured — computed
 * by the SAME engine (generateOrder/buildGenerationInputs) Orders v2's own
 * Review page uses, not a simplified reimplementation. Editing/adding
 * products happens right here in the modal; nothing is written to the
 * database until "Finalize", which creates a real ov2_order_drafts row
 * (ad hoc — see __adhoc_location_ids) and inserts these exact lines, so the
 * result is a normal draft that goes through Final Review → Export like
 * any other order, vendor export formats included.
 *
 * Simplifications vs. a full Review-page generation run (documented in the
 * caller's final response, not hidden):
 *   - No delivery-schedule lookup, so DOS @ Delivery / the Delivery column
 *     aren't computed here (dos_after_delivery is stored null, same as any
 *     other manually-added line — see OrdersV2Review's addConfiguredProduct).
 *     Regenerating from the real Review page fills this in.
 *   - No open-PO decision buttons (override/exclude/combine) — a
 *     covered_by_open_po flag still shows, but the decision is deferred to
 *     the real Review page.
 *   - Keep-fill/VMI runway alerts aren't computed; VMI lines still show
 *     (excluded from the order total by default, per the app's keep-fill
 *     rule) so they're never silently dropped.
 *   - Mighty is excluded from the vendor picker — it uses a separate
 *     engine (mightyEngine.ts) this modal doesn't call.
 */
export function StartAdHocOrderModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const vendors = useVendors()
  const { settings, loading: settingsLoading } = useOrderSettings()
  const { rulesFor } = useVendorRules()
  const { fetchInputs } = useGenerationData()
  const { createDraft } = useDrafts()
  const [tankProductMap] = useAppSetting<Record<string, string>>('tank_product_map', {})

  const [vendorId, setVendorId] = useState('')
  const [shopLabels, setShopLabels] = useState<string[]>([])
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [targetDos, setTargetDos] = useState(21)
  const targetSeeded = useRef(false)
  useEffect(() => {
    if (targetSeeded.current || settingsLoading) return
    targetSeeded.current = true
    setTargetDos(settings.days_of_supply_target)
  }, [settings, settingsLoading])

  const [phase, setPhase] = useState<'setup' | 'review'>('setup')
  const [generating, setGenerating] = useState(false)
  const [genProgress, setGenProgress] = useState<{ loaded: number; total: number }>({ loaded: 0, total: 0 })
  const [modalLines, setModalLines] = useState<GeneratedLine[]>([])
  const [skipped, setSkipped] = useState<{ location_id: string; product_id: string; reason: string }[]>([])
  const [rawData, setRawData] = useState<Awaited<ReturnType<ReturnType<typeof useGenerationData>['fetchInputs']>> | null>(null)
  const [addShopId, setAddShopId] = useState('')
  const [addProductId, setAddProductId] = useState('')
  const [finalizing, setFinalizing] = useState(false)

  const vendorOptions = useMemo(() => vendors.options.filter((o) => !vendors.isMighty(o.value)), [vendors])
  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const shopLabelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  const selectedShopIds = useMemo(
    () => shopLabels.map((l) => shopLabelToId.get(l)).filter((v): v is string => !!v),
    [shopLabels, shopLabelToId],
  )

  function reset() {
    setPhase('setup'); setVendorId(''); setShopLabels([]); setModalLines([]); setSkipped([])
    setRawData(null); setAddShopId(''); setAddProductId(''); targetSeeded.current = false
  }
  function close() { reset(); onClose() }

  // Same shape ov2_product_rules' resolution already uses everywhere else in
  // this module — target/trigger/max collapsed to one number so a currently
  // under-target product becomes eligible and pass 1 stops right at the
  // target, rather than requiring a separate trigger to already be tripped
  // under the company's normal settings (see this file's own header note).
  function dosOverrideSettings(base: OrderSettings): OrderSettings {
    return { ...base, days_of_supply_target: targetDos, days_of_supply_min_trigger: targetDos, days_of_supply_max: targetDos }
  }

  async function generate() {
    if (!vendorId || selectedShopIds.length === 0) return
    setGenerating(true)
    setGenProgress({ loaded: 0, total: 0 })
    try {
      const raw = await fetchInputs(vendorId, settings.flag_cumulative_days, (loadedCount, total) => setGenProgress({ loaded: loadedCount, total }))
      const inputs = buildGenerationInputs(
        raw.configs, raw.rules, raw.usage, raw.productMappings, raw.vendorParts, raw.uomMappings,
        raw.globalProducts, raw.tankOnHand, raw.openPurchaseOrders, raw.poItems, tankProductMap, raw.exceptions,
      )
      const vendorName = vendors.byId(vendorId)?.name ?? null
      const result = generateOrder(inputs, {
        settings: dosOverrideSettings(settings),
        vendor: rulesFor(vendorId, settings, vendorName),
        orderDate,
        eligibleLocationIds: new Set(selectedShopIds),
        history: raw.history,
        includeVmi: true,
      })
      setRawData(raw)
      setModalLines(result.lines)
      setSkipped(result.skipped)
      setPhase('review')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to generate suggestions')
    } finally {
      setGenerating(false)
    }
  }

  function patchQty(target: GeneratedLine, qty: number) {
    const isVmi = target.flags.includes('vmi_keepfill')
    setModalLines((prev) => prev.map((l) => (l !== target ? l : {
      ...l, qty, dos_after: dosAfterForQty(l, qty), included: isVmi ? l.included : qty > 0,
    })))
  }

  function removeLine(target: GeneratedLine) {
    setModalLines((prev) => prev.filter((l) => l !== target))
  }

  // Product options for the "Add Product" combobox — every vendor part this
  // vendor has, minus whatever the currently-selected shop already has a
  // line for. allowCreate lets a product with no vendor_parts row yet still
  // be typed in directly (resolved through buildGenerationInputs below the
  // same as a configured one, just with less to resolve from).
  const addProductOptions = useMemo(() => {
    if (!rawData || !addShopId) return []
    const already = new Set(modalLines.filter((l) => l.location_id === addShopId).map((l) => l.product_id))
    const seen = new Set<string>()
    const opts: { value: string; label: string }[] = []
    for (const vp of rawData.vendorParts) {
      const id = vp.our_part_number
      if (!id || already.has(id) || seen.has(id)) continue
      seen.add(id)
      opts.push({ value: id, label: id })
    }
    return opts.sort((a, b) => a.label.localeCompare(b.label))
  }, [rawData, addShopId, modalLines])

  // Resolves a product the same way real configured products are resolved —
  // via buildGenerationInputs itself (uom/cost/package size, tank/keep-fill
  // on-hand, sibling case-type combining) — rather than a simplified
  // one-off calculation that could drift from how the real engine reads
  // the same data.
  function addProduct() {
    if (!addShopId || !addProductId.trim() || !rawData) return
    const productId = addProductId.trim()
    if (modalLines.some((l) => l.location_id === addShopId && l.product_id === productId)) {
      toast.error('This product is already on the order for that shop'); return
    }
    const synthetic: OrderConfigRow = { location_id: addShopId, product_id: productId, vendor_id: vendorId || null, capacity: null, order_limit: null, metadata: {} }
    const inputs = buildGenerationInputs(
      [...rawData.configs, synthetic], rawData.rules, rawData.usage, rawData.productMappings, rawData.vendorParts,
      rawData.uomMappings, rawData.globalProducts, rawData.tankOnHand, rawData.openPurchaseOrders, rawData.poItems,
      tankProductMap, rawData.exceptions,
    )
    const input = inputs.find((i) => i.location_id === addShopId && i.product_id === productId)
    if (!input) { toast.error('Could not resolve this product'); return }
    const ctx = { settings: dosOverrideSettings(settings) } as unknown as Parameters<typeof unitsToTarget>[1]
    const caps = capsFor(input, ctx)
    const want = unitsToTarget(input, ctx)
    const quartsPerUnit = gallonsPerUnit(input.rule)
    const qty = want > 0
      ? roundQty(Math.min(want, caps.maxUnits), input.rule.uom, settings.bulk_rounding_increment, want > caps.maxUnits ? 'down' : 'up')
      : 1
    const newLine: GeneratedLine = {
      location_id: input.location_id, product_id: input.product_id, order_type: resolvedOrderType(input.rule),
      uom: input.rule.uom, system_qty: 0, qty,
      unit_cost: input.rule.unit_cost, on_hand: input.on_hand, daily_usage: input.daily_usage,
      dos_before: daysOfSupply(input.on_hand, input.daily_usage),
      dos_after: dosAfterForQty({ on_hand: input.on_hand, daily_usage: input.daily_usage, quarts_per_unit: quartsPerUnit }, qty),
      max_capacity_gallons: input.rule.max_capacity_gallons, quarts_per_unit: quartsPerUnit,
      included: input.rule.vmi_keepfill_enabled ? false : qty > 0,
      flags: input.rule.vmi_keepfill_enabled ? ['vmi_keepfill'] : [],
      added_by_smoothing: false, triggered_smoothing: false, note: null,
    }
    setModalLines((prev) => [...prev, newLine])
    setAddProductId('')
  }

  const includedCount = modalLines.filter((l) => l.included && l.qty > 0).length
  const totalDollars = modalLines.reduce((sum, l) => (l.included ? sum + l.qty * Number(l.unit_cost ?? 0) : sum), 0)

  async function finalize() {
    if (!profile?.company_id || includedCount === 0) return
    setFinalizing(true)
    try {
      const draftId = await createDraft(vendorId, orderDate, settings, null, selectedShopIds, null)
      if (!draftId) return
      const err = await insertGeneratedLines(profile.company_id, draftId, modalLines)
      if (err) { toast.error(err); return }
      const shopCount = new Set(modalLines.map((l) => l.location_id)).size
      await (supabase as any).schema('inventory').from('ov2_order_drafts').update({
        status: 'review',
        // Rebuilt explicitly (not spread from the draft's own snapshot) —
        // __adhoc_location_ids has to be carried forward by hand here or a
        // later Regenerate on the real Review page would silently revert
        // this back to a schedule-based order (see runGeneration's own
        // comment on this exact gotcha in OrdersV2Review.tsx).
        settings_snapshot: { ...dosOverrideSettings(settings), __shop_count: shopCount, __adhoc_location_ids: selectedShopIds },
      }).eq('id', draftId)
      toast.success(`Ad hoc order created — ${includedCount} line${includedCount !== 1 ? 's' : ''} across ${shopCount} shop${shopCount !== 1 ? 's' : ''}`)
      close()
      navigate(`/orders-v2/draft/${draftId}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create the draft')
    } finally {
      setFinalizing(false)
    }
  }

  return (
    <Modal open={open} onClose={close} title="Start Ad Hoc Order" size="xl">
      {generating ? (
        <LoadingProgress
          fraction={genProgress.total > 0 ? genProgress.loaded / genProgress.total : null}
          countText={genProgress.total > 0 ? `Loading order data — ${genProgress.loaded} of ${genProgress.total}` : 'Loading order data…'}
          messages={['Computing suggested quantities…']}
        />
      ) : phase === 'setup' ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs font-mono text-inky/60">
            Order specific shop(s) outside the regular schedule. Suggested quantities are computed by the same
            engine Orders v2 uses for a normal order, just aimed at the days-of-supply target below instead of the
            company's usual reorder trigger.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Combobox label="Vendor" options={vendorOptions} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
            <Input label="Order Date" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-mono text-inky/60">Shop(s)</span>
            <MultiSelectDropdown options={shopOptions} selected={shopLabels} onChange={setShopLabels}
              placeholder="Select shops…" countNoun="shops" searchable showAllOption={false} />
          </div>
          <Input label="Days of Supply Target" type="number" min={1} max={365} value={targetDos}
            onChange={(e) => setTargetDos(Math.max(1, Number(e.target.value) || 1))} />
          <p className="text-[11px] font-mono text-inky/60">
            Computes suggested quantities to bring every currently-configured product at the selected shop(s) up to
            this many days of supply. You can add more products and edit any quantity on the next screen before
            anything is saved.
          </p>
          {!vendorId || selectedShopIds.length === 0 ? (
            <p className="text-[11px] font-mono text-[#C0392B]">Pick a vendor and at least one shop to continue.</p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={close}>Cancel</Button>
            <Button size="sm" loading={generating} disabled={!vendorId || selectedShopIds.length === 0} onClick={generate}>
              Generate Suggestions
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs font-mono text-inky/60">
              {vendors.byId(vendorId)?.name ?? 'Vendor'} · {orderDate} · Ad hoc · {selectedShopIds.length} shop{selectedShopIds.length !== 1 ? 's' : ''}
              {' · target '}{targetDos}d
            </p>
            <Button size="sm" variant="secondary" onClick={() => setPhase('setup')}>← Adjust target / shops</Button>
          </div>

          {modalLines.length === 0 ? (
            <p className="text-xs font-mono text-inky/60 py-4">
              Nothing is currently due at the selected shop(s) for this target. Use "Add Product" below to add
              specific products, or lower the target and adjust above.
            </p>
          ) : (
            <div className="overflow-auto rounded border border-navy/30 max-h-96">
              <table className="w-full text-xs font-mono">
                <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30 sticky top-0">
                  <Th>Shop</Th><Th>Product</Th><Th>On Hand</Th><Th>Usage/day</Th><Th>DOS Now</Th>
                  <Th>Qty</Th><Th>DOS After</Th><Th align="right">$</Th><Th>Flags</Th><Th />
                </tr></thead>
                <tbody>
                  {modalLines.map((l) => (
                    <tr key={lineKey(l)} className={`border-b border-navy/15 ${l.included ? '' : 'opacity-50'}`}>
                      <Td>{loc.fieldValue(l.location_id, 'shop_city') || loc.codeOf(l.location_id) || '—'}</Td>
                      <Td>{l.product_id}</Td>
                      <Td>{num(l.on_hand, 1)}</Td>
                      <Td>{num(l.daily_usage, 2)}</Td>
                      <Td>{dos(l.dos_before)}</Td>
                      <Td>
                        <input type="number" min={0} value={l.qty}
                          onChange={(e) => patchQty(l, Math.max(0, Number(e.target.value) || 0))}
                          className="w-20 bg-cream border border-navy/30 rounded px-1.5 py-0.5 text-navy" />
                      </Td>
                      <Td>{dos(l.dos_after)}</Td>
                      <Td align="right">{money(l.qty * Number(l.unit_cost ?? 0))}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          {l.flags.map((f) => (
                            <span key={f} title={FLAG_META[f].title} className={`px-1.5 py-0.5 rounded border text-[10px] ${FLAG_CLASS[FLAG_META[f].tone]}`}>
                              {FLAG_META[f].label}
                            </span>
                          ))}
                        </div>
                      </Td>
                      <Td>
                        <button onClick={() => removeLine(l)} className="text-inky/40 hover:text-[#C0392B] text-[11px]">Remove</button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {skipped.length > 0 && (
            <p className="text-[11px] font-mono text-inky/50">
              {skipped.length} configured product{skipped.length !== 1 ? 's' : ''} already at/above the {targetDos}-day target and left off the order — add manually below if one of them still needs to go out.
            </p>
          )}

          <div className="rounded border border-navy/20 p-3 flex flex-col gap-2">
            <span className="text-[11px] font-mono uppercase tracking-wide text-inky/60">Add Product</span>
            <div className="grid grid-cols-3 gap-2 items-end">
              <Combobox label="Shop" options={selectedShopIds.map((id) => ({ value: id, label: loc.labelOf(id) }))}
                value={addShopId} onChange={setAddShopId} placeholder="Select shop…" />
              <Combobox label="Product ID" options={addProductOptions} value={addProductId}
                onChange={setAddProductId} placeholder="Pick or type a product ID…"
                allowCreate onCreateOption={(label) => ({ value: label, label })} />
              <Button size="sm" variant="secondary" disabled={!addShopId || !addProductId.trim()} onClick={addProduct}>
                + Add
              </Button>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t border-navy/15">
            <span className="text-xs font-mono text-navy">
              {includedCount} line{includedCount !== 1 ? 's' : ''} on the order · {money(totalDollars)}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={close}>Cancel</Button>
              <Button size="sm" loading={finalizing} disabled={includedCount === 0} onClick={finalize}>
                Finalize — Create Draft
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <th className={`px-2 py-1.5 ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>
}
function Td({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <td className={`px-2 py-1 text-navy ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>
}
