// Opens (or creates) today's "Possible VMI misses" order. One per day per company: the database has a unique index on
// (company, order kind, order date), so two people clicking the alert end up on the same order.
import { supabase } from '@/lib/supabase'
import type { OrderSettings } from './types'
import type { VmiMissSummary } from './useVmiMissCheck'

const sb = () => supabase as any
export const VMI_MISS_KIND = 'possible_vmi_miss'
/** Settings saved for an order kind (company-wide): only what has been changed from the regular defaults. */
export const ORDER_KIND_SETTINGS_KEY = 'ov2_order_kind_settings'

async function findExisting(companyId: string, date: string): Promise<string | null> {
  const { data } = await sb().schema('inventory').from('ov2_order_drafts').select('id')
    .eq('company_id', companyId).eq('order_kind', VMI_MISS_KIND).eq('order_date', date).is('deleted_at', null).neq('status', 'cancelled').limit(1)
  return (data?.[0]?.id as string | undefined) ?? null
}

export async function openVmiMissOrder(companyId: string, userId: string | null, summary: VmiMissSummary, settings: OrderSettings): Promise<{ id: string; created: boolean } | null> {
  const existing = await findExisting(companyId, summary.date)
  if (existing) return { id: existing, created: false }

  const { data: ov } = await sb().schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', ORDER_KIND_SETTINGS_KEY).maybeSingle()
  const overrides = (ov?.value?.[VMI_MISS_KIND] ?? {}) as Partial<OrderSettings>
  const { data, error } = await sb().schema('inventory').from('ov2_order_drafts').insert({
    company_id: companyId, vendor_id: summary.vendor_id, order_date: summary.date, status: 'generating', order_kind: VMI_MISS_KIND,
    settings_snapshot: {
      ...settings, ...overrides, __order_dow: null,
      __adhoc_location_ids: summary.shops.map((s) => s.location_id),
      __vmi_miss_items: summary.items,
    },
    created_by: userId, last_edited_by: userId,
  }).select('id').single()
  if (error) {
    // Someone else created it a moment ago (unique index) — go to theirs.
    const again = await findExisting(companyId, summary.date)
    if (again) return { id: again, created: false }
    throw new Error(error.message)
  }
  return { id: data.id as string, created: true }
}

// ── Lines for the Possible-VMI-misses order ─────────────────────────────────────────────────────────────────────────────
import { capsFor, daysOfSupply, gallonsPerUnit, resolvedOrderType, roundQty, unitsToTarget } from './engine'
import type { GeneratedLine, GenerationContext, GenerationInput } from './types'

/**
 * From the normal generation run, keep only the flagged shop/product pairs (included whenever they have a quantity — VMI
 * lines normally start excluded), and add a line for any flagged pair the engine didn't order (the tank may be above its usual
 * trigger yet still short of the delivery after next): sized to the DOS target, same caps as everywhere else.
 */
export function buildVmiMissLines(
  generated: GeneratedLine[], items: { location_id: string; product_id: string }[], inputs: GenerationInput[], ctx: GenerationContext,
): GeneratedLine[] {
  const k = (x: { location_id: string; product_id: string }) => `${x.location_id}|${x.product_id}`
  const wanted = new Set(items.map(k))
  const kept = generated.filter((l) => wanted.has(k(l))).map((l) => ({ ...l, included: Number(l.qty) > 0 }))
  const have = new Set(kept.map(k))
  const byKey = new Map(inputs.map((i) => [k(i), i]))
  const extra: GeneratedLine[] = []
  for (const it of items) {
    if (have.has(k(it))) continue
    const input = byKey.get(k(it))
    if (!input) continue
    const caps = capsFor(input, ctx, { respectDosMax: false })
    const want = unitsToTarget(input, ctx)
    const units = roundQty(Math.min(want, caps.maxUnits), input.rule.uom, ctx.settings.bulk_rounding_increment, want > caps.maxUnits ? 'down' : 'up')
    if (units <= 0) continue
    const per = gallonsPerUnit(input.rule)
    extra.push({
      location_id: input.location_id, product_id: input.product_id, order_type: resolvedOrderType(input.rule), uom: input.rule.uom,
      system_qty: units, qty: units, unit_cost: input.rule.unit_cost, quarts_per_unit: per,
      on_hand: input.on_hand, daily_usage: input.daily_usage,
      dos_before: daysOfSupply(input.on_hand, input.daily_usage), dos_after: daysOfSupply(Number(input.on_hand ?? 0) + units * per, input.daily_usage),
      max_capacity_gallons: input.rule.max_capacity_gallons, included: true, flags: ['vmi_keepfill'],
      added_by_smoothing: false, triggered_smoothing: false,
      note: 'Possible VMI miss — no bulk order in the system near this shop\'s usual timing',
    })
  }
  return [...kept, ...extra]
}
