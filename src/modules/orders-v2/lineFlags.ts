// Flags (before the order) and Tags (after the order) for a Review line, plus the DOS color rules
// (direct ask 2026-10-03). Pure — no React — so it can be unit-tested.
//
//   Flags – Before: what was true of the shop/product BEFORE anything was ordered (out of stock, on an open
//                   PO, critical minimum, DOS already low ...).
//   Tags  – After:  what the order itself did or caused (over capacity, under the order minimum, qty raised for
//                   smoothing ...). These are recomputed live from the line's CURRENT qty, so they update the
//                   moment someone edits a quantity — setting a line to 0 drops its over-capacity tag.
//
// Every tag has its own color, all drawn from variations of the brand palette (navy/inky/sky plus the three
// allowed signal colors red/orange/green, with darker and lighter steps of each, and one gold for "yellow").
import type { LineFlag } from './types'

export type DosTone = 'orange' | 'green' | 'yellow' | 'red'

/** Conditional-formatting colors for DOS cells (and the swatches in the legends). */
export const DOS_TONE_COLOR: Record<DosTone, string> = {
  orange: '#E67E22',
  green: '#2ECC71',
  yellow: '#E0B63A', // gold — a warm "yellow" in the same family as the brand orange, readable on navy and cream
  red: '#C0392B',
}
export const DOS_TONE_LABEL: Record<DosTone, string> = {
  orange: 'Over DOS Max',
  green: 'At or above DOS Target',
  yellow: 'Below DOS Target, at or above DOS Min Trigger',
  red: 'Below DOS Min Trigger',
}

export interface DosThresholds { target: number; minTrigger: number; max: number }

/**
 * DOS cell color. Over max = orange; at/above target (within max) = green; below target but at/above the min
 * trigger = YELLOW; only below the min trigger is red (a less aggressive scale than red-for-anything-under-target).
 */
export function dosTone(v: number | null | undefined, t: DosThresholds): DosTone | null {
  if (v == null || !Number.isFinite(v)) return null
  if (v > t.max) return 'orange'
  if (v >= t.target) return 'green'
  if (v >= t.minTrigger) return 'yellow'
  return 'red'
}

export type TagKey =
  | LineFlag
  | 'dos_now_below_target' | 'dos_now_low'
  | 'dos_after_below_target' | 'dos_after_low'

export type TagGroup = 'before' | 'after'
export interface TagDef { key: TagKey; group: TagGroup; label: string; description: string; color: string }

const def = (key: TagKey, group: TagGroup, label: string, color: string, description: string): [TagKey, TagDef] =>
  [key, { key, group, label, color, description }]

export const TAG_DEFS: Record<TagKey, TagDef> = Object.fromEntries([
  // ── Flags – Before ───────────────────────────────────────────────────────
  def('dos_now_low', 'before', 'DOS Now: low', '#E04B3C', 'Days of supply right now is below the DOS Min Trigger.'),
  def('dos_now_below_target', 'before', 'DOS Now: below target', '#E0B63A', 'Days of supply right now is below the DOS Target but at or above the DOS Min Trigger.'),
  def('combined_on_hand', 'before', 'Combined on hands', '#4DB6E8', 'On Hand is the combined total of this product and its equivalent case types at this shop (e.g. 0W30BB plus 0W30C) — hover the On Hand number for the math.'),
  def('critical_minimum', 'before', 'Critical min', '#E67E22', 'On-hand fell to this product\'s critical minimum (e.g. enough for one oil change), not the usual days-of-supply trigger.'),
  def('repeat_ordering', 'before', 'Repeat ordering', '#9E3326', 'A lot of supply was already ordered recently and it still reads low — on-hand may not be reflecting deliveries.'),
  def('keepfill_will_run_out', 'before', 'Will run dry', '#B5651D', 'Tank on-hand and usage won\'t last until this shop\'s delivery after next — may need a keep-fill order first.'),
  def('covered_by_open_po', 'before', 'On open PO', '#C9A227', 'Already has outstanding quantity on a still-open purchase order — decide whether to order anyway, exclude, or combine it.'),
  def('vmi_keepfill', 'before', 'VMI / Keep-fill', '#4F7489', 'Vendor-managed inventory tracked by tank monitor — left out of the order total by default since the vendor refills it.'),
  // ── Tags – After ─────────────────────────────────────────────────────────
  def('below_minimum', 'after', 'Under order min', '#D2574A', 'The shop is still under its order minimum after this order.'),
  def('capacity_capped', 'after', 'Over capacity', '#6E3B1F', 'This quantity puts on-hand past the shop\'s configured capacity for this product.'),
  def('exceeded_capacity_for_dos_target', 'after', 'Over capacity: DOS target', '#A8456B', 'Ordered past configured capacity on purpose to reach the DOS Target — see the note for the numbers.'),
  def('over_dos_max', 'after', 'Over DOS max', '#E67E22', 'DOS After is above the DOS Max.'),
  def('dos_after_low', 'after', 'DOS After: low', '#E04B3C', 'Days of supply after this order is still below the DOS Min Trigger.'),
  def('dos_after_below_target', 'after', 'DOS After: below target', '#E0B63A', 'Days of supply after this order is below the DOS Target but at or above the DOS Min Trigger.'),
  def('recently_ordered', 'after', 'Ordered recently', '#3E8E9B', 'Ordered in the last 8 days and the on hand plus that order still covers usage — kept on the order at 0. Add a quantity if it should go on anyway.'),
  def('drum_capped', 'after', 'Drum capped', '#8C6E3F', 'Drums are ordered one per product. More are needed to reach the DOS target — see the note for how many.'),
  def('no_products_to_meet_min', 'after', 'No products to add', '#6A6AA8', 'The order is still under its minimum and smoothing found no other product to add to meet it.'),
  def('drum_alone', 'after', 'Drum alone', '#9B6BC2', 'A drum ordered on its own (Valvoline) — allowed without the bay-box order minimum, so this is not an under-minimum order.'),
  def('hm0806_solo_min', 'after', 'HM0806 Solo Min', '#8E5BB5', 'HM0806 was the only product due at this shop, so it was ordered at its 2-unit minimum and the order minimum was ignored.'),
  def('case_minimum_topup', 'after', 'Case min', '#B7E0DE', 'Raised to meet the vendor\'s case-type order minimum.'),
  def('alone_default_qty', 'after', 'Alone qty', '#6FB7B2', 'Only line on the order — used its configured "alone" quantity.'),
  def('added_for_smoothing', 'after', 'Added: smoothing', '#8FB8D0', 'Pulled onto this order from the shop\'s other products to help it reach its order minimum.'),
  def('smoothing_topped_up', 'after', 'Qty raised: smoothing', '#5E93AC', 'Quantity raised above what usage alone called for, to help the shop reach its order minimum.'),
  def('rounded_to_bulk_minimum', 'after', 'Rounded: bulk min', '#A9CCE0', 'Raised to the bulk per-product minimum (a full drum) — see the note for the real calculated amount.'),
  def('po_decision_override', 'after', 'PO: order anyway', '#2ECC71', 'Decided to order the full suggested quantity regardless of the open PO.'),
  def('po_decision_exclude', 'after', 'PO: excluded', '#27A860', 'Decided the open PO already covers this — excluded from the order.'),
  def('po_decision_combine', 'after', 'PO: combined', '#7FDBA6', 'Decided to count the open PO\'s outstanding quantity as on-hand and re-target the order quantity.'),
] as [TagKey, TagDef][]) as Record<TagKey, TagDef>

const BEFORE_STORED: LineFlag[] = ['combined_on_hand', 'critical_minimum', 'repeat_ordering', 'keepfill_will_run_out', 'covered_by_open_po', 'vmi_keepfill']
const PO_DECISIONS: LineFlag[] = ['po_decision_override', 'po_decision_exclude', 'po_decision_combine']
// Tags the engine stamped because of the quantity IT chose — meaningless once someone edits the qty, or sets it to 0.
const ENGINE_QTY_TAGS: LineFlag[] = ['drum_alone', 'no_products_to_meet_min', 'drum_capped', 'hm0806_solo_min', 'case_minimum_topup', 'alone_default_qty', 'added_for_smoothing', 'smoothing_topped_up', 'rounded_to_bulk_minimum']

export interface TagLine {
  flags: string[] | null
  qty: number | string
  is_override: boolean
  included: boolean
  dos_before: number | null
  dos_after: number | null
  max_capacity_gallons: number | null
  note?: string | null
}

export interface TagContext {
  thresholds: DosThresholds
  /** On-hand after delivery + this order, in the same unit as max_capacity_gallons (quarts). */
  onHandAfter: (l: any) => number
  /** True when this line's shop/order-type group is under its order minimum. */
  belowMinimum: (l: any) => boolean
}

export interface LineTags {
  before: TagDef[]
  after: TagDef[]
  /** The engine's explanatory note, only while a tag it explains is still on the line. */
  note: string | null
}

export function computeLineTags<L extends TagLine>(l: L, ctx: TagContext): LineTags {
  const stored = new Set((l.flags ?? []) as string[])
  const qty = Number(l.qty)
  const qty0 = qty === 0
  const t = ctx.thresholds
  const before: TagKey[] = []
  const after: TagKey[] = []

  for (const f of BEFORE_STORED) if (stored.has(f)) before.push(f)
  if (l.dos_before != null) {
    if (l.dos_before < t.minTrigger) before.push('dos_now_low')
    else if (l.dos_before < t.target) before.push('dos_now_below_target')
  }

  const overCapacity = !qty0 && l.max_capacity_gallons != null && ctx.onHandAfter(l) > l.max_capacity_gallons
  if (l.included && ctx.belowMinimum(l)) after.push('below_minimum')
  if (overCapacity) {
    // "Over capacity: DOS target" already says it's over capacity, and why — never show both.
    if (stored.has('exceeded_capacity_for_dos_target') && !l.is_override) after.push('exceeded_capacity_for_dos_target')
    else after.push('capacity_capped')
  }
  if (stored.has('recently_ordered')) after.push('recently_ordered')
  if (!qty0 && l.dos_after != null && l.dos_after > t.max) after.push('over_dos_max')
  if (l.dos_after != null) {
    if (l.dos_after < t.minTrigger) after.push('dos_after_low')
    else if (l.dos_after < t.target) after.push('dos_after_below_target')
  }
  if (!qty0 && !l.is_override) for (const f of ENGINE_QTY_TAGS) if (stored.has(f)) after.push(f)
  for (const f of PO_DECISIONS) if (stored.has(f)) after.push(f)

  const noteStillApplies = stored.has('recently_ordered')
    || (!l.is_override && !qty0 && (stored.has('rounded_to_bulk_minimum') || stored.has('drum_capped') || stored.has('no_products_to_meet_min') || after.includes('exceeded_capacity_for_dos_target')))
  return {
    before: before.map((k) => TAG_DEFS[k]),
    after: after.map((k) => TAG_DEFS[k]),
    note: noteStillApplies ? (l.note ?? null) : null,
  }
}

/** The "full row" color a line gets, if any — mutually exclusive, in priority order. */
export type RowTone = 'excluded' | 'below_min' | 'over_capacity_target'
export const ROW_TONE_META: Record<RowTone, { label: string; color: string }> = {
  excluded: { label: 'Excluded from order', color: '#7C8B96' },
  below_min: { label: 'Under order minimum', color: '#C0392B' },
  over_capacity_target: { label: 'Over capacity to reach DOS target', color: '#E67E22' },
}

export function rowToneOf(l: Pick<TagLine, 'included'>, tags: LineTags): RowTone | null {
  if (!l.included) return 'excluded'
  if (tags.after.some((t) => t.key === 'below_minimum')) return 'below_min'
  if (tags.after.some((t) => t.key === 'exceeded_capacity_for_dos_target')) return 'over_capacity_target'
  return null
}

/** Short suffix after the last hyphen — "EURO-SYN-0W20D" -> "…0W20D"; no hyphen -> the whole id. */
export function combinedSuffix(productId: string): string {
  const i = productId.lastIndexOf('-')
  return i < 0 ? productId : `…${productId.slice(i + 1)}`
}
