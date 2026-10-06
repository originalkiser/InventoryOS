// A configured product with no draft line yet, shown as a qty-0 row so the "Shops With No Orders" table can use the
// exact same columns as the Review table. Its id is `cand:<location>|<product>`; setting a quantity on it adds a real
// draft line (see OrdersV2Review's patchQtyOrAdd) instead of patching one.
import { daysOfSupply, dosAfterDelivery, gallonsPerUnit, resolvedOrderType } from './engine'
import type { DraftLineRow } from './useOrdersV2'
import type { GenerationInput } from './types'

export const CANDIDATE_PREFIX = 'cand:'
export const isCandidateLine = (l: Pick<DraftLineRow, 'id'>) => l.id.startsWith(CANDIDATE_PREFIX)

export function candidateLine(input: GenerationInput, draftId: string, orderDate: string, deliveryDate: string | null, projectDosAfter = false): DraftLineRow {
  const { rule } = input
  const dos = daysOfSupply(input.on_hand, input.daily_usage)
  return {
    id: `${CANDIDATE_PREFIX}${input.location_id}|${input.product_id}`,
    draft_id: draftId,
    location_id: input.location_id,
    product_id: input.product_id,
    order_type: resolvedOrderType(rule),
    uom: rule.uom,
    system_qty: 0,
    qty: 0,
    unit_cost: rule.unit_cost,
    quarts_per_unit: gallonsPerUnit(rule),
    on_hand: input.on_hand,
    daily_usage: input.daily_usage,
    dos_before: dos,
    // Valvoline: with nothing ordered, DOS After is what's left once the truck would land (= DOS @ Delivery).
    dos_after: projectDosAfter ? dosAfterDelivery(input.on_hand, input.daily_usage, orderDate, deliveryDate) : dos,
    dos_after_delivery: dosAfterDelivery(input.on_hand, input.daily_usage, orderDate, deliveryDate),
    max_capacity_gallons: rule.max_capacity_gallons,
    included: false,
    flags: rule.vmi_keepfill_enabled ? ['vmi_keepfill'] : [],
    added_by_smoothing: false,
    triggered_smoothing: false,
    note: null,
    is_override: false,
  }
}
