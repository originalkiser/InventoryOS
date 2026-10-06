// Orders v2 Review's main lines table, built on this app's standard useTable/DataTable/useColumnPrefs/
// ColumnManagerModal stack (same pattern as ExceptionTable.tsx and OrdersV2FinalReview.tsx). This is now the
// DEFAULT table (2026-10-03); the original hand-rolled table still lives in OrdersV2Review.tsx behind a per-user
// "Use old table" setting (Order Settings).
//
// Deliberately a "dumb", fully prop-driven presentational component: every piece of business logic (live
// DOS/on-hand-after recompute, minimum checks, PO-decision handling, shop-expand candidate lists) stays owned by
// OrdersV2Review.tsx — this component only renders whatever it's handed. The Flags/Tags it shows are computed by the
// pure lineFlags.ts from each line's CURRENT values, so they update live as quantities are edited.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { AlertTriangle, ChevronDown, ChevronRight, Columns3, Flag, Pencil } from 'lucide-react'
import { DataTable } from '@/components/shared/DataTable'
import { HoverTip, SwatchTipBody } from '@/components/ui/HoverTip'
import { DosCell } from './DosCell'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import type { useLastOrderedInfo } from './useLastOrderedInfo'
import type { useProductExceptions } from './useProductExceptions'
import type { DraftLineRow, DraftRow } from './useOrdersV2'
import { PoDecisionButtons } from './OrdersV2Review'
import { ShopConfiguredProductsDataTable } from './ShopConfiguredProductsDataTable'
import { dos, money, num, dShort, OV2_DOS_STYLE_KEY, OV2_SHOWN_QUICK_KEY, OV2_HIDE_DOS_NOW_BUTTONS_KEY, DEFAULT_SHOWN_QUICK, DEFAULT_HIDE_DOS_NOW } from './shared'
import { uomDisplayLabel, } from './types'
import { matchesAnyQuick, quickCounts, tagKey, toneKey } from './quickFilters'
import type { LineTagMap } from './useLineTagMap'
import { QtyStepper, type ZeroReason } from './lineControls'
import {
  combinedSuffix, dosTone, DOS_TONE_COLOR, DOS_TONE_LABEL, ROW_TONE_META, TAG_DEFS,
  type DosThresholds, type RowTone, type TagDef,
} from './lineFlags'
import type { GenerationInput } from './types'

const TABLE_KEY = 'orders-v2.review-lines'
const DEFAULT_PINNED = ['shop']
const COMBINED_MODE_KEY = 'ov2_review_combined_mode'
const PAGE_SIZE_KEY = 'ov2_review_page_size'
const TONE_ORDER: RowTone[] = ['below_min', 'over_capacity_target', 'excluded']
// Row tones are drawn as translucent washes of their color over the plain cream row (alpha 0x2B ≈ 17%).
const toneWash = (t: RowTone) => `${ROW_TONE_META[t].color}2B`

// ── Small presentational pieces ─────────────────────────────────────────────

/** A tiny colored flag glyph with a styled hover tooltip — used inline above On Hand / On Hand After. */
function TagIcon({ tag, onClick, active }: { tag: TagDef; onClick?: () => void; active?: boolean }) {
  return (
    <HoverTip content={<SwatchTipBody color={tag.color} title={tag.label} description={`${tag.description} Click to filter to lines with this flag.`} />}>
      <button type="button" onClick={onClick} className={`inline-flex rounded-sm ${active ? 'ring-2 ring-navy/60' : ''}`}>
        <Flag className="w-3 h-3" style={{ color: tag.color, fill: tag.color }} strokeWidth={1.5} />
      </button>
    </HoverTip>
  )
}

/** A tag as an inline, never-stacked chip: color swatch + label. */
export function TagChip({ tag, onClick, active }: { tag: TagDef; onClick?: () => void; active?: boolean }) {
  return (
    <HoverTip content={<SwatchTipBody color={tag.color} title={tag.label} description={`${tag.description} Click to filter to lines with this flag.`} />}>
      <button type="button" onClick={onClick}
        className={`inline-flex items-center gap-1 rounded border px-1 text-[9px] leading-4 whitespace-nowrap text-navy ${active ? 'ring-2 ring-navy/60' : ''}`}
        style={{ borderColor: `${tag.color}99`, background: `${tag.color}26` }}>
        <span className="inline-block w-1.5 h-1.5 rounded-sm flex-shrink-0" style={{ background: tag.color }} />
        {tag.label}
      </button>
    </HoverTip>
  )
}

/** One line of reasoning, with a "more" toggle that slides the full text open/closed. */
function NoteLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex items-start gap-1 text-[10px] font-mono text-inky/70 italic leading-tight max-w-[22rem]">
      <div className="min-w-0 overflow-hidden transition-[max-height] duration-300 ease-in-out" style={{ maxHeight: open ? '8rem' : '0.9rem' }}>
        <div className={open ? 'whitespace-normal' : 'truncate'}>{text}</div>
      </div>
      {text.length > 38 && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="not-italic text-sky hover:underline flex-shrink-0">{open ? 'less' : 'more'}</button>
      )}
    </div>
  )
}

/** Rough pixel width of a row of tag chips, so a Flags/Tags column can be sized to fit them (no overlap into the next column). */
/**
 * Splits a button label over exactly two lines at the word break that makes the wider line as narrow as possible
 * (the count rides on the second line). A single word keeps line 1 and leaves line 2 for the count.
 */
function twoLines(label: string, count: number): [string, string] {
  const words = label.split(' ')
  if (words.length < 2) return [label, '']
  let best = 1, bestW = Infinity
  for (let i = 1; i < words.length; i++) {
    const w = Math.max(words.slice(0, i).join(' ').length, words.slice(i).join(' ').length + 1 + String(count).length)
    if (w < bestW) { bestW = w; best = i }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
}

/**
 * Column objects that never change identity: each accessor, custom cell and meta function delegates to whatever the
 * latest render's definition says (via the ref), so React keeps the same cell components mounted across edits.
 */
function stabilizeColumns(raw: any[], ref: { current: any[] }): any[] {
  const latest = (id: string) => ref.current.find((c) => c.id === id)
  return raw.map((def) => {
    const id = def.id as string
    const out: any = { ...def }
    if (def.accessorFn) out.accessorFn = (row: any, i: number) => latest(id)?.accessorFn?.(row, i)
    if (typeof def.cell === 'function') {
      const Cell = (props: any) => { const c = latest(id)?.cell; return typeof c === 'function' ? c(props) : null }
      out.cell = Cell
    }
    if (def.meta) {
      const meta: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(def.meta)) {
        meta[k] = typeof v === 'function' ? (...args: unknown[]) => (latest(id)?.meta?.[k] as any)?.(...args) : v
      }
      out.meta = meta
    }
    return out
  })
}

const chipsWidth = (tags: TagDef[]) => tags.reduce((s, t) => s + t.label.length * 5.4 + 28, 0)

// ── Table ───────────────────────────────────────────────────────────────────

export function OrdersV2ReviewTable({
  lines, draft, shopLabel, ozProductIds, lastOrderedInfo, deliveryFor, describeSchedule,
  thresholds, onHandAfterAtDelivery, groupMinimumStatus, patchQty,
  decidePoOverride, decidePoExclude, decidePoCombine, onZeroReason,
  expanded, onToggleExpand, shopRows, onAddConfiguredProduct, showConfigVmi, leadDaysFor,
  inputByLineKey, toolbarExtra, onRowRef, onLastRowKey, isSeen, jumpNonce, variant = 'order',
  tagMap, quickFilters, onQuickFiltersChange, renderShopProducts, showSchedule,
}: {
  /** Valvoline: show each shop's order/delivery schedule written out, so the delivery dates make sense at a glance. */
  showSchedule?: boolean
  /**
   * 'order' = the main Review table. 'noOrders' = every product for shops that ended up with no order (no shop
   * button). 'overrides' = the lines edited by hand, in a modal; the shop button opens the shop-products popup.
   */
  variant?: 'order' | 'noOrders' | 'overrides' | 'shop'
  /** Renders a shop's "every configured product" table under its row (the inline expand). */
  renderShopProducts?: (locId: string) => React.ReactNode
  /** Live Flags/Tags for these lines (see useLineTagMap). */
  tagMap: LineTagMap
  /** Selected quick filters (flag/tag buttons, DOS legend). Controlled when onQuickFiltersChange is given. */
  quickFilters?: Set<string>
  onQuickFiltersChange?: (next: Set<string>) => void
  /** Has this row key been on screen (see rowSeen.ts)? With jumpNonce, lets the table page/scroll to the first unseen row. */
  isSeen?: (key: string) => boolean
  jumpNonce?: number
  onRowRef?: (el: HTMLTableRowElement | null, rowKey: string) => void
  onLastRowKey?: (key: string | null) => void
  lines: DraftLineRow[]
  draft: DraftRow
  shopLabel: (id: string | null) => string
  ozProductIds: Set<string>
  lastOrderedInfo: ReturnType<typeof useLastOrderedInfo>
  deliveryFor: (locationId: string | null, fromDate: string) => string | null
  describeSchedule: (locationId: string | null) => string | null
  /** This order's own DOS target / min trigger / max (the card above the table), or null until seeded. */
  thresholds: DosThresholds | null
  /** On hand projected to the shop's delivery date plus this line's order, in quarts. */
  onHandAfterAtDelivery: (l: DraftLineRow) => number
  groupMinimumStatus: Map<string, boolean>
  patchQty: (l: DraftLineRow, qty: number) => void
  exceptionFor: (locationId: string, productId: string) => ReturnType<typeof useProductExceptions>['rows'][number] | null
  onOpenException: (locationId: string, productId: string) => void
  decidePoOverride: (l: DraftLineRow) => void
  decidePoExclude: (l: DraftLineRow) => void
  decidePoCombine: (l: DraftLineRow) => void
  // Optional "why zero?" tag on a line adjusted to 0 (see lineControls.tsx).
  onZeroReason: (l: DraftLineRow, reason: ZeroReason | null, note: string | null) => void
  expanded: Set<string>
  onToggleExpand: (locId: string) => void
  shopRows: (locId: string) => { input?: GenerationInput; line?: DraftLineRow }[]
  onAddConfiguredProduct: (input: GenerationInput, qty: number) => void
  showConfigVmi: boolean
  leadDaysFor: (locId: string) => number
  inputByLineKey: Map<string, GenerationInput>
  // The VMI/over-capacity/Dropdown-Popup toggles + Add Non-Configured Product button render right next to Manage
  // Columns (this component's own DataTable toolbar), not in OrdersV2Review.tsx's separate row above.
  toolbarExtra?: React.ReactNode
}) {
  const [columnManagerOpen, setColumnManagerOpen] = useState(false)
  // "Combined – Hidden" shows just the combined total with the math on hover; "Combined – Listed" writes each
  // combined product's on-hand out in the cell.
  const [combinedModePref, setCombinedModePref] = useProfilePref<string>(COMBINED_MODE_KEY, 'hidden')
  const combinedListed = combinedModePref === 'listed'
  const [dosStylePref] = useProfilePref<string>(OV2_DOS_STYLE_KEY, 'badge')
  const dosStyle = dosStylePref === 'text' ? 'text' : 'badge'
  const isOrderTable = variant === 'order'
  const defaultPinned = variant === 'shop' ? [] : DEFAULT_PINNED
  const tableKey = variant === 'order' ? TABLE_KEY : `${TABLE_KEY}-${variant}`
  const [shownQuick] = useProfilePref<string[]>(OV2_SHOWN_QUICK_KEY, DEFAULT_SHOWN_QUICK)
  const [hideDosNow] = useProfilePref<boolean | number>(OV2_HIDE_DOS_NOW_BUTTONS_KEY, DEFAULT_HIDE_DOS_NOW)
  const [ownQuick, setOwnQuick] = useState<Set<string>>(new Set())
  const quick = quickFilters ?? ownQuick
  const setQuick = onQuickFiltersChange ?? setOwnQuick
  const toggleQuick = (k: string) => { const n = new Set(quick); if (n.has(k)) n.delete(k); else n.add(k); setQuick(n) }

  const tagsOf = useCallback((l: DraftLineRow) => tagMap.get(l.id)?.tags ?? { before: [], after: [], note: null }, [tagMap])
  const toneOf = useCallback((l: DraftLineRow) => tagMap.get(l.id)?.tone ?? null, [tagMap])

  // One button per flag/tag that is actually present somewhere in this table (plus the three row tones) — click to
  // show only those lines; several selected show any of them. A button whose filter is ACTIVE stays listed even when its
  // count has dropped to 0 (everything got fixed), so the filter can still be switched off instead of leaving a blank table
  // with no way back; it disappears once the filter is off.
  const counts = useMemo(() => quickCounts(lines, tagMap, thresholds), [lines, tagMap, thresholds])
  const quickButtons = useMemo(() => {
    const out: { key: string; label: string; color: string; description: string; count: number }[] = []
    for (const t of TONE_ORDER) {
      const c = counts.get(toneKey(t)) ?? 0
      if (c > 0 || quick.has(toneKey(t))) out.push({ key: toneKey(t), label: ROW_TONE_META[t].label, color: ROW_TONE_META[t].color, description: `Rows colored "${ROW_TONE_META[t].label}".`, count: c })
    }
    for (const group of ['before', 'after'] as const) {
      for (const def of Object.values(TAG_DEFS)) {
        if (def.group !== group) continue
        const c = counts.get(tagKey(def.key)) ?? 0
        if (c > 0 || quick.has(tagKey(def.key))) out.push({ key: tagKey(def.key), label: def.label, color: def.color, description: def.description, count: c })
      }
    }
    // User settings: only the chosen buttons, and optionally never a "DOS Now" one (only the after-order ones remain).
    const shown = new Set(Array.isArray(shownQuick) ? shownQuick : DEFAULT_SHOWN_QUICK)
    return out.filter((b) => quick.has(b.key) || (shown.has(b.key) && !(hideDosNow && (b.key === tagKey('dos_now_low') || b.key === tagKey('dos_now_below_target')))))
  }, [counts, shownQuick, hideDosNow, quick])
  const shownLines = useMemo(
    () => (quick.size ? lines.filter((l) => matchesAnyQuick(quick, l, tagMap.get(l.id), thresholds)) : lines),
    [lines, tagMap, quick, thresholds],
  )

  const col = useMemo(() => createColumnHelper<DraftLineRow>(), [])
  const rawColumns = useMemo(() => {
    const numericMeta = { numeric: true }
    const dosMeta = (pick: (l: DraftLineRow) => number | null) => ({
      numeric: true,
      colorOf: (l: DraftLineRow) => (thresholds ? dosTone(pick(l), thresholds) : null),
      colorLabels: DOS_TONE_LABEL as Record<string, string>,
      colorSwatch: DOS_TONE_COLOR as Record<string, string>,
    })
    const onHandOf = (l: DraftLineRow) => (ozProductIds.has(l.product_id) ? Number(l.on_hand ?? 0) * 32 : l.on_hand)
    const onHandAfterOf = (l: DraftLineRow) => {
      const v = onHandAfterAtDelivery(l)
      return ozProductIds.has(l.product_id) ? v * 32 : v
    }
    const infoOf = (l: DraftLineRow) => lastOrderedInfo.infoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
    // Date on the first line; quantity + unit on the second, with the unit named the same way as the UOM column
    // ("Bulk", not "large_tanks").
    const lastOrderedQty = (l: DraftLineRow) => {
      const info = infoOf(l)
      return info.lastOrderDate ? `${num(info.lastOrderQty, 1)} ${uomDisplayLabel(info.lastOrderUom)}` : ''
    }
    const lastOrderedText = (l: DraftLineRow) => {
      const info = infoOf(l)
      return info.lastOrderDate ? `${dShort(info.lastOrderDate)} · ${lastOrderedQty(l)}` : '—'
    }
    const lastDeliveredQty = (l: DraftLineRow) => {
      const info = infoOf(l)
      if (!info.lastDeliveredDate) return ''
      return `${num(info.lastDeliveredAmount, 1)} ${info.lastDeliveredUnit === 'gal' ? 'gal' : uomDisplayLabel(info.lastOrderUom)}`
    }
    const lastDeliveredText = (l: DraftLineRow) => {
      const info = infoOf(l)
      return info.lastDeliveredDate ? `${dShort(info.lastDeliveredDate)} · ${lastDeliveredQty(l)}` : '—'
    }
    const deliveryText = (l: DraftLineRow) => {
      const dd = deliveryFor(l.location_id, draft.order_date)
      if (!dd) return '—'
      const dow = new Date(`${dd}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long' })
      return `${dShort(dd)} ${dow}`
    }

    // Flags/Tags columns start wide enough for the widest set of chips on any line, so chips never spill into the
    // neighboring column; they still clip (instead of overlapping) if someone narrows the column by hand.
    let flagsBeforeSize = 110, tagsAfterSize = 110
    for (const l of lines) {
      const t = tagMap.get(l.id)?.tags
      if (!t) continue
      flagsBeforeSize = Math.max(flagsBeforeSize, chipsWidth(t.before) + ((l.flags ?? []).includes('covered_by_open_po') ? 190 : 0) + 24)
      tagsAfterSize = Math.max(tagsAfterSize, chipsWidth(t.after) + 24)
    }
    flagsBeforeSize = Math.min(flagsBeforeSize, 640); tagsAfterSize = Math.min(tagsAfterSize, 640)

    // Tiny colored flags sit to the LEFT of the number, inline (never stacked), each with a styled hover tooltip.
    const iconStrip = (tags: TagDef[], extra?: React.ReactNode) =>
      (tags.length > 0 || extra) ? (
        <span className="inline-flex items-center gap-0.5 leading-none flex-shrink-0">{extra}{tags.map((t) => <TagIcon key={t.key} tag={t} onClick={() => toggleQuick(tagKey(t.key))} active={quick.has(tagKey(t.key))} />)}</span>
      ) : null

    return [
      col.accessor((l) => shopLabel(l.location_id), {
        id: 'shop', header: 'Shop',
        cell: (i) => {
          const l = i.row.original
          const locId = l.location_id ?? ''
          const open = expanded.has(locId)
          if (variant === 'noOrders') return <span>{i.getValue()}</span>
          return (
            <button onClick={() => onToggleExpand(locId)} title="Show every product configured for this shop"
              className="inline-flex items-center gap-1 hover:underline hover:text-sky">
              {open ? <ChevronDown className="w-3 h-3 flex-shrink-0" /> : <ChevronRight className="w-3 h-3 flex-shrink-0" />}
              {i.getValue()}
            </button>
          )
        },
      }),
      col.accessor('product_id', { id: 'product', header: 'Product' }),
      col.accessor((l) => uomDisplayLabel(l.uom), { id: 'uom', header: 'UOM', enableSorting: false }),
      col.accessor((l) => (ozProductIds.has(l.product_id) ? (l.max_capacity_gallons ?? 0) * 32 : l.max_capacity_gallons), {
        id: 'capacity', header: 'Capacity', meta: numericMeta, cell: (i) => <span className="block text-right">{num(i.getValue(), 0)}</span>,
      }),
      col.accessor((l) => onHandOf(l), {
        id: 'on_hand', header: 'On Hand', enableSorting: false, meta: { noClip: true, numeric: true },
        cell: (i) => {
          const l = i.row.original
          const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
          const info = infoOf(l)
          const isOz = ozProductIds.has(l.product_id)
          const toOz = (v: number) => (isOz ? v * 32 : v)
          const unit = isOz ? 'oz' : 'qt'
          const combined = input?.equivalent_products ?? []
          const { before } = tagsOf(l)
          const off = info.onHandCheck && !info.onHandCheck.withinRange ? info.onHandCheck : null
          // Out of stock / at-or-below the critical minimum read as RED TEXT on the number (with the reason on hover)
          // rather than as a flag.
          const storedFlags = (l.flags ?? []) as string[]
          const outOfStock = storedFlags.includes('stocked_out') || Number(l.on_hand ?? 0) <= 0
          const critical = storedFlags.includes('critical_minimum')
          const reasons: React.ReactNode[] = []
          if (outOfStock) reasons.push(<SwatchTipBody key="oos" color="#C0392B" title="Out of stock" description="No on hand recorded for this product." />)
          if (critical) reasons.push(<SwatchTipBody key="crit" color="#C0392B" title="At or below the critical minimum" description="On hand dropped to this product's critical minimum (e.g. enough for one oil change), so it was ordered even though days of supply looked fine." />)
          if (combined.length > 0 && !combinedListed) {
            reasons.push(
              <div key="comb" className="flex flex-col gap-0.5 text-[11px] font-mono">
                <span className="text-[10px] uppercase tracking-wide text-[#B7E0DE]">Combined on hand</span>
                <span>{l.product_id} {num(toOz(input?.own_on_hand ?? 0))}{unit} +</span>
                {combined.map((e, idx) => <span key={e.product_id}>{e.product_id} {num(toOz(e.on_hand))}{unit} {idx === combined.length - 1 ? '=' : '+'}</span>)}
                <span className="font-bold">Total {num(onHandOf(l))}{unit}</span>
              </div>,
            )
          }
          const numEl = <span className={`ml-auto ${outOfStock || critical ? 'font-bold text-[#C0392B]' : ''}${combined.length > 0 && !combinedListed ? ' underline decoration-dotted decoration-sky underline-offset-2' : ''}`}>{num(onHandOf(l))}</span>
          return (
            <div>
             <div className="flex items-center gap-1.5">
              {iconStrip(before, off && (
                <HoverTip content={<SwatchTipBody color="#C0392B" title="On hand may be off"
                  description={`Based on the last delivery, on hand was expected to be roughly ${num(off.expected)} (${num(off.low)}–${num(off.high)}).`} />}>
                  <AlertTriangle className="w-3 h-3 text-[#C0392B]" />
                </HoverTip>
              ))}
              {reasons.length > 0
                ? <HoverTip className="ml-auto" placement="bottom" content={<div className="flex flex-col gap-2">{reasons}</div>}>{numEl}</HoverTip>
                : numEl}
             </div>
              {combined.length > 0 && combinedListed && (
                <div className="text-[9px] text-navy/75 leading-tight font-normal whitespace-nowrap text-right">
                  <span title={l.product_id}>{combinedSuffix(l.product_id)}</span> {num(toOz(input?.own_on_hand ?? 0))}
                  {combined.map((e) => <span key={e.product_id} title={e.product_id}> · {combinedSuffix(e.product_id)} {num(toOz(e.on_hand))}</span>)}
                </div>
              )}
            </div>
          )
        },
      }),
      col.accessor((l) => (ozProductIds.has(l.product_id) ? (l.daily_usage ?? 0) * 32 : l.daily_usage), {
        id: 'usage_day', header: 'Usage/day', enableSorting: false, meta: numericMeta,
        cell: (i) => {
          const l = i.row.original
          const input = inputByLineKey.get(`${l.location_id}|${l.product_id}`)
          const eq = input?.equivalent_usage ?? []
          if (eq.length === 0) return <span className="block text-right">{num(i.getValue())}</span>
          // Same hover as "Combined on hand": this product's own usage plus each sibling's, then the total.
          const isOz = ozProductIds.has(l.product_id)
          const toOz = (v: number) => (isOz ? v * 32 : v)
          const unit = isOz ? 'oz' : 'qt'
          const total = Number(l.daily_usage ?? 0)
          const own = Math.max(0, total - eq.reduce((s, e) => s + e.daily_usage, 0))
          return (
            <div className="flex">
            <HoverTip className="ml-auto" placement="bottom" content={
              <div className="flex flex-col gap-0.5 text-[11px] font-mono">
                <span className="text-[10px] uppercase tracking-wide text-[#B7E0DE]">Combined usage per day</span>
                <span>{l.product_id} {num(toOz(own))} {unit} +</span>
                {eq.map((e, idx) => <span key={e.product_id}>{e.product_id} {num(toOz(e.daily_usage))} {unit} {idx === eq.length - 1 ? '=' : '+'}</span>)}
                <span className="font-bold">Total {num(i.getValue() as number)} {unit}/day</span>
              </div>
            }>
              <span className="ml-auto underline decoration-dotted decoration-sky underline-offset-2">{num(i.getValue())}</span>
            </HoverTip>
            </div>
          )
        },
      }),
      col.accessor('dos_before', {
        id: 'dos_now', header: 'DOS Now', enableSorting: false, meta: dosMeta((l) => l.dos_before ?? null),
        cell: (i) => <DosCell v={i.getValue()} thresholds={thresholds} style={dosStyle} />,
      }),
      col.accessor((l) => lastOrderedText(l), {
        id: 'last_ordered', header: 'Last Ordered', enableSorting: false, meta: { noClip: true },
        cell: (i) => {
          const l = i.row.original
          const info = infoOf(l)
          return info.lastOrderDate ? (
            <div className="leading-tight">
              <div>{dShort(info.lastOrderDate)}</div>
              <div className="text-[10px] text-navy/75">{lastOrderedQty(l)}</div>
              {info.eta && <div className="text-[9px] text-navy/75">ETA {dShort(info.eta)}</div>}
            </div>
          ) : '—'
        },
      }),
      col.accessor((l) => lastDeliveredText(l), {
        id: 'last_delivered', header: 'Last Delivered', enableSorting: false, meta: { noClip: true },
        cell: (i) => {
          const l = i.row.original
          const info = infoOf(l)
          return info.lastDeliveredDate ? (
            <div className="leading-tight">
              <div>{dShort(info.lastDeliveredDate)}</div>
              <div className="text-[10px] text-navy/75">{lastDeliveredQty(l)}</div>
            </div>
          ) : '—'
        },
      }),
      col.accessor((l) => deliveryText(l), {
        id: 'delivery_date', header: 'Delivery', enableSorting: false, meta: { noClip: true },
        // Just the date and weekday — no "(RelaDyne delivery day)" schedule text.
        cell: (i) => <div>{i.getValue()}</div>,
      }),
      ...(showSchedule ? [col.accessor((l) => describeSchedule(l.location_id) ?? '', {
        id: 'delivery_schedule', header: 'Delivery Schedule', enableSorting: false, meta: { noClip: true },
        cell: (i) => <div className="text-[11px] leading-tight text-navy/85 min-w-[11rem]">{i.getValue() || '—'}</div>,
      })] : []),
      col.accessor((l) => Number(l.qty), {
        id: 'qty', header: 'Order Qty', enableSorting: false, size: 196, minSize: 196,
        meta: {
          numeric: true,
          // The orange "edited by hand" bar runs the full height of the cell, not just the content.
          cellClassName: (l: DraftLineRow) => (l.is_override ? 'shadow-[inset_3px_0_0_#E67E22]' : ''),
        },
        cell: (i) => {
          const l = i.row.original
          const isOz = ozProductIds.has(l.product_id)
          return (
            // Fixed layout so every row lines up: the quarts figure in a fixed-width slot, then the stepper with a box
            // sized for 4+ digits, the whole group pushed to the right edge of the cell.
            <div className="flex items-center justify-between gap-2 flex-nowrap">
              <QtyStepper compact inputClassName="w-14" value={Number(l.qty)} bulk={l.uom === 'bulk'} align="text-right"
                onChange={(n) => patchQty(l, n)} zeroReason={{ line: l, onChange: (r, n) => onZeroReason(l, r, n) }} />
              <span className="text-[10px] text-navy/75 whitespace-nowrap w-[3.2rem] text-right flex-shrink-0">
                {l.quarts_per_unit != null ? (isOz ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)} oz` : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`) : ''}
              </span>
            </div>
          )
        },
      }),
      col.accessor((l) => onHandAfterOf(l), {
        id: 'on_hand_after', header: 'On Hand After', enableSorting: false, meta: { noClip: true, numeric: true },
        cell: (i) => {
          const { after } = tagsOf(i.row.original)
          // Only the capacity-related tags belong above this number; the rest read in the Tags column.
          const capTags = after.filter((t) => t.key === 'capacity_capped' || t.key === 'exceeded_capacity_for_dos_target')
          return (
            <div className="flex items-center gap-1.5">
              {iconStrip(capTags)}
              <span className="ml-auto">{num(i.getValue())}</span>
            </div>
          )
        },
      }),
      col.accessor('dos_after', {
        id: 'dos_after', header: 'DOS After', meta: dosMeta((l) => l.dos_after ?? null),
        cell: (i) => <DosCell v={i.getValue()} thresholds={thresholds} style={dosStyle} />,
      }),
      col.accessor('dos_after_delivery', {
        id: 'dos_at_delivery', header: 'DOS @ Delivery', enableSorting: false, meta: numericMeta,
        cell: (i) => <span className="block text-right">{dos(i.getValue())}</span>,
      }),
      col.accessor((l) => Number(l.qty) * Number(l.unit_cost ?? 0), {
        id: 'dollars', header: 'Ordered Cost', meta: numericMeta, cell: (i) => <span className="block text-right">{money(i.getValue())}</span>,
      }),
      col.accessor((l) => tagsOf(l).before.map((t) => t.label).join(', '), {
        id: 'flags_before', header: 'Flags – Before', enableSorting: false, minSize: 90, size: flagsBeforeSize,
        meta: { multiValue: (l: DraftLineRow) => tagsOf(l).before.map((t) => t.label) },
        cell: (i) => {
          const l = i.row.original
          const { before } = tagsOf(l)
          return (
            <div className="flex items-center gap-1 whitespace-nowrap">
              {before.length === 0 ? <span className="text-inky/25">—</span> : before.map((t) => <TagChip key={t.key} tag={t} onClick={() => toggleQuick(tagKey(t.key))} active={quick.has(tagKey(t.key))} />)}
              {(l.flags ?? []).includes('covered_by_open_po') && (
                <PoDecisionButtons line={l} onOverride={decidePoOverride} onExclude={decidePoExclude} onCombine={decidePoCombine} />
              )}
            </div>
          )
        },
      }),
      col.accessor((l) => tagsOf(l).after.map((t) => t.label).join(', '), {
        id: 'tags_after', header: 'Flags – After', enableSorting: false, minSize: 90, size: tagsAfterSize,
        meta: { multiValue: (l: DraftLineRow) => tagsOf(l).after.map((t) => t.label) },
        cell: (i) => {
          const { after, note } = tagsOf(i.row.original)
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1 whitespace-nowrap">
                {after.length === 0 ? <span className="text-inky/25">—</span> : after.map((t) => <TagChip key={t.key} tag={t} onClick={() => toggleQuick(tagKey(t.key))} active={quick.has(tagKey(t.key))} />)}
              </div>
              {note && <NoteLine text={note} />}
            </div>
          )
        },
      }),
    ].filter((c: any) => !(variant === 'shop' && c.id === 'shop'))
  }, [col, shopLabel, ozProductIds, inputByLineKey, lastOrderedInfo, deliveryFor, describeSchedule, showSchedule, draft.order_date,
      patchQty, thresholds, tagsOf, onHandAfterAtDelivery, combinedListed, decidePoOverride, decidePoExclude,
      decidePoCombine, onZeroReason, expanded, onToggleExpand, dosStyle, variant, lines, tagMap, quick])

  // The column definitions above are rebuilt whenever anything they read changes, which used to (a) re-create every
  // cell component on each quantity edit — remounting the quantity box and dropping its focus and any floating +1 —
  // and (b) leave TanStack's per-row value cache stale when only the inputs changed (e.g. the Delivery column staying
  // blank until a quantity was edited). So: hand the table STABLE column objects whose accessors / cells / meta
  // functions just delegate to the latest definitions, and give it a fresh data array whenever they change.
  const rawRef = useRef(rawColumns)
  rawRef.current = rawColumns
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const columns = useMemo(() => stabilizeColumns(rawColumns, rawRef), [variant])
  // Only the things the accessors actually read (not every function prop) trigger a rebuild, so ordinary re-renders stay cheap.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tableData = useMemo(() => shownLines.slice(), [shownLines, tagMap, thresholds, deliveryFor, lastOrderedInfo.infoFor, ozProductIds, inputByLineKey, onHandAfterAtDelivery, combinedListed, dosStyle])

  // Under 200 rows everything shows on one page; with more, the page size the user last picked (default 50).
  const initialPageSize = useRef<number>(0)
  if (!initialPageSize.current) {
    let saved = 0
    try { saved = Number(localStorage.getItem(`${PAGE_SIZE_KEY}:${variant}`)) || 0 } catch { /* ignore */ }
    initialPageSize.current = lines.length < 200 ? 999999 : (saved || 50)
  }
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(tableData, columns, {
    persistKey: tableKey,
    initialPageSize: initialPageSize.current,
    initialSorting: [{ id: variant === 'shop' ? 'product' : 'shop', desc: false }],
    initialColumnPinning: { left: defaultPinned, right: [] },
  })
  useColumnPrefs(tableKey, table, columnVisibility, columnOrder, setColumnOrder)
  const pageSizeNow = table.getState().pagination.pageSize
  useEffect(() => {
    if (pageSizeNow === initialPageSize.current) return
    try { localStorage.setItem(`${PAGE_SIZE_KEY}:${variant}`, String(pageSizeNow)) } catch { /* ignore */ }
  }, [pageSizeNow, variant])

  const allColItems: ColItem[] = useMemo(
    () => table.getAllLeafColumns().map((c) => ({ id: c.id, label: String(c.columnDef.header ?? c.id) })),
    [table],
  )
  const shownOrder = useMemo(() => {
    const ids = table.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return ids
    const known = columnOrder.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !known.includes(id))]
  }, [table, columnOrder])
  function applyShownColumns(shown: string[]) {
    setColumnOrder(shown)
    const vis: Record<string, boolean> = {}
    for (const c of allColItems) vis[c.id] = shown.includes(c.id)
    table.setColumnVisibility(vis)
  }
  function resetColumns() {
    setColumnOrder([])
    table.setColumnVisibility({})
    table.setColumnSizing({})
    setColumnPinning({ left: defaultPinned, right: [] })
  }

  // Same-band-per-shop grouping, computed off the live sorted/filtered row order DataTable is about to render.
  // "Expand after the LAST row" of a shop group — a re-sort by another column moves which row is "last".
  const pageRows = table.getRowModel().rows
  const bandOf = new Map<string, boolean>()
  const isLastOfShop = new Map<string, boolean>()
  {
    let prevShop: string | null = null
    let band = false
    for (let i = 0; i < pageRows.length; i++) {
      const r = pageRows[i]
      const shopId = r.original.location_id
      if (shopId !== prevShop) { band = !band; prevShop = shopId }
      bandOf.set(r.original.id, band)
      const next = pageRows[i + 1]
      isLastOfShop.set(r.original.id, !next || next.original.location_id !== shopId)
    }
  }

  // "Go back to review": page to, and scroll to, the first row (in the table's current order) not yet on screen.
  const lastJump = useRef(jumpNonce ?? 0)
  useEffect(() => {
    if (jumpNonce == null || jumpNonce === lastJump.current || !isSeen) return
    lastJump.current = jumpNonce
    const rows = table.getPrePaginationRowModel().rows
    const idx = rows.findIndex((r) => !isSeen(r.original.id))
    if (idx < 0) return
    const size = table.getState().pagination.pageSize
    if (size > 0) table.setPageIndex(Math.floor(idx / size))
    const key = rows[idx].original.id
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>(`[data-seen-key="${CSS.escape(key)}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
  }, [jumpNonce, isSeen, table])

  if (!lines.length) return <p className="text-xs font-mono text-inky/50 py-8">Nothing to show for this filter.</p>

  return (
    <>
      <DataTable
        table={table}
        density="compact"
        rowMinHeight={46}
        exportOnlyWhenSelected
        // 30% narrower than the default search box, so the flag filter buttons and Add non-configured fit on one line.
        searchClassName="w-full sm:w-36"
        leadingActions={
          <HoverTip content={<span className="text-xs font-mono">Manage Columns</span>}>
            <button onClick={() => setColumnManagerOpen(true)} aria-label="Manage Columns"
              className="inline-flex items-center gap-0.5 h-[38px] px-2 text-navy border border-navy/30 rounded hover:border-navy">
              <Pencil className="w-3 h-3" /><Columns3 className="w-4 h-4" />
            </button>
          </HoverTip>
        }
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename={`Order Review - ${draft.order_date}`}
        onRowRef={onRowRef}
        onLastRowKey={onLastRowKey}
        hideColumnControl
        // A toned row (excluded / under order minimum / over capacity to reach the DOS target) drops the zebra and
        // shop banding entirely and shows its one tone color across the whole row; every other row is banded per shop.
        getRowTone={(l) => { const t = toneOf(l); return t ? toneWash(t) : null }}
        getRowClassName={(l) => (bandOf.get(l.id) ? 'bg-[#EAEBDF] dark:bg-[#15283C]' : 'bg-cream')}
        expandedRowRender={(l) => {
          const locId = l.location_id ?? ''
          if (!isOrderTable || !expanded.has(locId) || !isLastOfShop.get(l.id)) return null
          return (
            <div className="px-3 py-2">
              <p className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-1">
                Every product configured for {shopLabel(l.location_id)}
                {(() => {
                  const dd = deliveryFor(l.location_id, draft.order_date)
                  const sd = describeSchedule(l.location_id)
                  return dd ? <span className="normal-case text-inky/50"> · Delivers {dShort(dd)}{sd ? ` (${sd})` : ''}</span> : null
                })()}
              </p>
              {renderShopProducts ? renderShopProducts(locId) : (
                <ShopConfiguredProductsDataTable
                  rows={shopRows(locId)}
                  onPatch={patchQty}
                  onAdd={onAddConfiguredProduct}
                  showVmi={showConfigVmi}
                  ozProductIds={ozProductIds}
                  leadDays={leadDaysFor(locId)}
                  lastInfoFor={lastOrderedInfo.infoFor}
                  onZeroReason={onZeroReason}
                />
              )}
            </div>
          )
        }}
        actions={
          <>
            {quickButtons.map((b) => {
              const active = quick.has(b.key)
              return (
                <HoverTip key={b.key} content={<SwatchTipBody color={b.color} title={b.label}
                  description={`${b.description} ${active ? 'Click to stop filtering to these lines.' : 'Click to show only these lines.'}`} />}>
                  <button type="button" onClick={() => toggleQuick(b.key)}
                    className={`h-[38px] inline-flex items-center gap-1.5 rounded border px-2 text-[10px] font-mono leading-tight text-left ${active ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-navy hover:border-navy'}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: b.color }} />
                    <span className="flex flex-col whitespace-nowrap leading-tight">
                      {(() => { const [l1, l2] = twoLines(b.label, b.count); return (<><span>{l1}</span><span>{l2} <span className="text-navy/75">{b.count}</span></span></>) })()}
                    </span>
                  </button>
                </HoverTip>
              )
            })}
            {toolbarExtra}
          </>
        }
      />
      <ColumnManagerModal
        open={columnManagerOpen}
        onClose={() => setColumnManagerOpen(false)}
        all={allColItems.filter((c) => c.id !== 'select')}
        shown={shownOrder.filter((id) => id !== 'select')}
        onChange={applyShownColumns}
        onReset={resetColumns}
        pinned={columnPinning.left ?? []}
        onPinChange={(left) => setColumnPinning({ left, right: [] })}
      />
    </>
  )
}
