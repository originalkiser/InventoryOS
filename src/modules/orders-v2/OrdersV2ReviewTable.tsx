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
import { AlertTriangle, ChevronDown, ChevronRight, Flag } from 'lucide-react'
import { DataTable } from '@/components/shared/DataTable'
import { HoverTip, SwatchTipBody } from '@/components/ui/HoverTip'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import type { useLastOrderedInfo } from './useLastOrderedInfo'
import type { useProductExceptions } from './useProductExceptions'
import type { DraftLineRow, DraftRow } from './useOrdersV2'
import { PoDecisionButtons } from './OrdersV2Review'
import { ShopConfiguredProductsDataTable } from './ShopConfiguredProductsDataTable'
import { ToggleButton } from './controls'
import { dos, money, num, dShort, OV2_DOS_STYLE_KEY } from './shared'
import { uomDisplayLabel } from './types'
import { QtyStepper, type ZeroReason } from './lineControls'
import {
  computeLineTags, combinedSuffix, dosTone, rowToneOf, DOS_TONE_COLOR, DOS_TONE_LABEL, ROW_TONE_META,
  type DosThresholds, type LineTags, type RowTone, type TagDef,
} from './lineFlags'
import type { GenerationInput } from './types'

const TABLE_KEY = 'orders-v2.review-lines'
const DEFAULT_PINNED = ['shop']
const COMBINED_MODE_KEY = 'ov2_review_combined_mode'
const NO_THRESHOLDS: DosThresholds = { target: 0, minTrigger: 0, max: Number.POSITIVE_INFINITY }
const TONE_ORDER: RowTone[] = ['below_min', 'over_capacity_target', 'excluded']
// Row tones are drawn as translucent washes of their color over the plain cream row (alpha 0x2B ≈ 17%).
const toneWash = (t: RowTone) => `${ROW_TONE_META[t].color}2B`

// ── Small presentational pieces ─────────────────────────────────────────────

/** A tiny colored flag glyph with a styled hover tooltip — used inline above On Hand / On Hand After. */
function TagIcon({ tag }: { tag: TagDef }) {
  return (
    <HoverTip content={<SwatchTipBody color={tag.color} title={tag.label} description={tag.description} />}>
      <Flag className="w-3 h-3" style={{ color: tag.color, fill: tag.color }} strokeWidth={1.5} />
    </HoverTip>
  )
}

/** A tag as an inline, never-stacked chip: color swatch + label. */
function TagChip({ tag }: { tag: TagDef }) {
  return (
    <HoverTip content={<SwatchTipBody color={tag.color} title={tag.label} description={tag.description} />}>
      <span className="inline-flex items-center gap-1 rounded border px-1 text-[9px] leading-4 whitespace-nowrap text-navy"
        style={{ borderColor: `${tag.color}99`, background: `${tag.color}26` }}>
        <span className="inline-block w-1.5 h-1.5 rounded-sm flex-shrink-0" style={{ background: tag.color }} />
        {tag.label}
      </span>
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

/** A DOS value with the yellow/red-scale conditional formatting and a hover explanation. */
function DosCell({ v, thresholds, style }: { v: number | null | undefined; thresholds: DosThresholds | null; style: 'badge' | 'text' }) {
  const tone = thresholds ? dosTone(v ?? null, thresholds) : null
  if (!tone) return <span className="block text-right">{dos(v)}</span>
  const color = DOS_TONE_COLOR[tone]
  return (
    <span className="block text-right">
      <HoverTip content={<SwatchTipBody color={color} title={DOS_TONE_LABEL[tone]} />}>
        {style === 'text'
          ? <span className="font-bold" style={{ color }}>{dos(v)}</span>
          : <span className="inline-block rounded px-1 font-bold text-navy" style={{ background: `${color}40`, boxShadow: `inset 0 -2px 0 ${color}` }}>{dos(v)}</span>}
      </HoverTip>
    </span>
  )
}

/** Rough pixel width of a row of tag chips, so a Flags/Tags column can be sized to fit them (no overlap into the next column). */
const chipsWidth = (tags: TagDef[]) => tags.reduce((s, t) => s + t.label.length * 5.4 + 28, 0)

// ── Table ───────────────────────────────────────────────────────────────────

export function OrdersV2ReviewTable({
  lines, draft, shopLabel, ozProductIds, lastOrderedInfo, deliveryFor, describeSchedule,
  thresholds, onHandAfterAtDelivery, groupMinimumStatus, patchQty,
  decidePoOverride, decidePoExclude, decidePoCombine, onZeroReason,
  expanded, onToggleExpand, shopRows, onAddConfiguredProduct, showConfigVmi, leadDaysFor,
  inputByLineKey, toolbarExtra, onRowRef, onLastRowKey, isSeen, jumpNonce, variant = 'order',
}: {
  /** 'noOrders' = the second table of every product for shops that ended up with no order: no shop expand, no tone filters. */
  variant?: 'order' | 'noOrders'
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
  const tableKey = isOrderTable ? TABLE_KEY : `${TABLE_KEY}-noorders`
  const [toneFilter, setToneFilter] = useState<Set<RowTone>>(new Set())

  // Live Flags/Tags per line — recomputed whenever any line or the thresholds change.
  const th = thresholds ?? NO_THRESHOLDS
  const tagMap = useMemo(() => {
    const ctx = {
      thresholds: th,
      onHandAfter: (l: DraftLineRow) => onHandAfterAtDelivery(l),
      belowMinimum: (l: DraftLineRow) => groupMinimumStatus.get(`${l.location_id}|${l.order_type}`) === false,
    }
    const m = new Map<string, { tags: LineTags; tone: RowTone | null }>()
    for (const l of lines) {
      const tags = computeLineTags(l as any, ctx)
      m.set(l.id, { tags, tone: rowToneOf(l, tags) })
    }
    return m
  }, [lines, th, onHandAfterAtDelivery, groupMinimumStatus])
  const tagsOf = useCallback((l: DraftLineRow) => tagMap.get(l.id)?.tags ?? { before: [], after: [], note: null }, [tagMap])
  const toneOf = useCallback((l: DraftLineRow) => tagMap.get(l.id)?.tone ?? null, [tagMap])

  const toneCounts = useMemo(() => {
    const c: Record<RowTone, number> = { below_min: 0, over_capacity_target: 0, excluded: 0 }
    for (const l of lines) { const t = tagMap.get(l.id)?.tone; if (t) c[t]++ }
    return c
  }, [lines, tagMap])
  const shownLines = useMemo(
    () => (toneFilter.size ? lines.filter((l) => { const t = tagMap.get(l.id)?.tone; return !!t && toneFilter.has(t) }) : lines),
    [lines, tagMap, toneFilter],
  )

  const col = useMemo(() => createColumnHelper<DraftLineRow>(), [])
  const columns = useMemo(() => {
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
    const lastOrderedText = (l: DraftLineRow) => {
      const info = infoOf(l)
      return info.lastOrderDate ? `${dShort(info.lastOrderDate)} · ${num(info.lastOrderQty, 1)}${info.lastOrderUom ? ` ${info.lastOrderUom}` : ''}` : '—'
    }
    const lastDeliveredText = (l: DraftLineRow) => {
      const info = infoOf(l)
      return info.lastDeliveredDate ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)}${info.lastDeliveredUnit === 'gal' ? ' gal' : ''}` : '—'
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

    // Tiny colored flags sit in the cell's top margin, inline (never stacked), each with a styled hover tooltip.
    const iconStrip = (tags: TagDef[], extra?: React.ReactNode) =>
      (tags.length > 0 || extra) ? (
        <span className="absolute -top-1.5 -right-1.5 inline-flex items-center gap-0.5 leading-none">{extra}{tags.map((t) => <TagIcon key={t.key} tag={t} />)}</span>
      ) : null

    return [
      col.accessor((l) => shopLabel(l.location_id), {
        id: 'shop', header: 'Shop',
        cell: (i) => {
          const l = i.row.original
          const locId = l.location_id ?? ''
          const open = expanded.has(locId)
          if (!isOrderTable) return <span>{i.getValue()}</span>
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
          const numEl = <span className={`${outOfStock || critical ? 'font-bold text-[#C0392B]' : ''}${combined.length > 0 && !combinedListed ? ' underline decoration-dotted decoration-sky underline-offset-2' : ''}`}>{num(onHandOf(l))}</span>
          return (
            <div className="relative pt-2 text-right">
              {iconStrip(before, off && (
                <HoverTip content={<SwatchTipBody color="#C0392B" title="On hand may be off"
                  description={`Based on the last delivery, on hand was expected to be roughly ${num(off.expected)} (${num(off.low)}–${num(off.high)}).`} />}>
                  <AlertTriangle className="w-3 h-3 text-[#C0392B]" />
                </HoverTip>
              ))}
              {reasons.length > 0
                ? <HoverTip placement="bottom" content={<div className="flex flex-col gap-2">{reasons}</div>}>{numEl}</HoverTip>
                : numEl}
              {combined.length > 0 && combinedListed && (
                <div className="text-[9px] text-inky/60 leading-tight font-normal whitespace-nowrap">
                  <span title={l.product_id}>{combinedSuffix(l.product_id)}</span> {num(toOz(input?.own_on_hand ?? 0))}
                  {combined.map((e) => <span key={e.product_id} title={e.product_id}> · {combinedSuffix(e.product_id)} {num(toOz(e.on_hand))}</span>)}
                </div>
              )}
            </div>
          )
        },
      }),
      col.accessor((l) => (ozProductIds.has(l.product_id) ? (l.daily_usage ?? 0) * 32 : l.daily_usage), {
        id: 'usage_day', header: 'Usage/day', enableSorting: false, meta: numericMeta, cell: (i) => <span className="block text-right">{num(i.getValue())}</span>,
      }),
      col.accessor('dos_before', {
        id: 'dos_now', header: 'DOS Now', enableSorting: false, meta: dosMeta((l) => l.dos_before ?? null),
        cell: (i) => <DosCell v={i.getValue()} thresholds={thresholds} style={dosStyle} />,
      }),
      col.accessor((l) => lastOrderedText(l), {
        id: 'last_ordered', header: 'Last Ordered', enableSorting: false, meta: { noClip: true },
        cell: (i) => {
          const info = infoOf(i.row.original)
          return info.lastOrderDate ? (
            <>
              <div>{i.getValue()}</div>
              {info.eta && <div className="text-[9px] text-inky/50 leading-tight">ETA {dShort(info.eta)}</div>}
            </>
          ) : '—'
        },
      }),
      col.accessor((l) => lastDeliveredText(l), { id: 'last_delivered', header: 'Last Delivered', enableSorting: false, meta: { noClip: true } }),
      col.accessor((l) => deliveryText(l), {
        id: 'delivery_date', header: 'Delivery', enableSorting: false, meta: { noClip: true },
        // Just the date and weekday — no "(RelaDyne delivery day)" schedule text.
        cell: (i) => <div>{i.getValue()}</div>,
      }),
      col.accessor((l) => Number(l.qty), {
        id: 'qty', header: 'Order Qty', enableSorting: false, size: 190, minSize: 96,
        meta: {
          numeric: true,
          // The orange "edited by hand" bar runs the full height of the cell, not just the content.
          cellClassName: (l: DraftLineRow) => (l.is_override ? 'shadow-[inset_3px_0_0_#E67E22] pl-3' : ''),
        },
        cell: (i) => {
          const l = i.row.original
          const isOz = ozProductIds.has(l.product_id)
          return (
            <div className="flex items-center gap-1.5 min-w-0 flex-nowrap">
              <div className="flex-1 min-w-0">
                <QtyStepper fluid value={Number(l.qty)} bulk={l.uom === 'bulk'} align="text-right"
                  onChange={(n) => patchQty(l, n)} zeroReason={{ line: l, onChange: (r, n) => onZeroReason(l, r, n) }} />
              </div>
              {l.quarts_per_unit != null && (
                <span className="text-[10px] text-inky/50 whitespace-nowrap flex-shrink-[4] min-w-0 truncate text-left">
                  {isOz ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)}oz` : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`}
                </span>
              )}
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
            <div className="relative pt-2 text-right">
              {iconStrip(capTags)}
              {num(i.getValue())}
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
              {before.length === 0 ? <span className="text-inky/25">—</span> : before.map((t) => <TagChip key={t.key} tag={t} />)}
              {(l.flags ?? []).includes('covered_by_open_po') && (
                <PoDecisionButtons line={l} onOverride={decidePoOverride} onExclude={decidePoExclude} onCombine={decidePoCombine} />
              )}
            </div>
          )
        },
      }),
      col.accessor((l) => tagsOf(l).after.map((t) => t.label).join(', '), {
        id: 'tags_after', header: 'Tags – After', enableSorting: false, minSize: 90, size: tagsAfterSize,
        meta: { multiValue: (l: DraftLineRow) => tagsOf(l).after.map((t) => t.label) },
        cell: (i) => {
          const { after, note } = tagsOf(i.row.original)
          return (
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-1 whitespace-nowrap">
                {after.length === 0 ? <span className="text-inky/25">—</span> : after.map((t) => <TagChip key={t.key} tag={t} />)}
              </div>
              {note && <NoteLine text={note} />}
            </div>
          )
        },
      }),
    ]
  }, [col, shopLabel, ozProductIds, inputByLineKey, lastOrderedInfo, deliveryFor, describeSchedule, draft.order_date,
      patchQty, thresholds, tagsOf, onHandAfterAtDelivery, combinedListed, decidePoOverride, decidePoExclude,
      decidePoCombine, onZeroReason, expanded, onToggleExpand, dosStyle, isOrderTable, lines, tagMap])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(shownLines, columns, {
    persistKey: tableKey,
    initialPageSize: 50,
    initialSorting: [{ id: 'shop', desc: false }],
    initialColumnPinning: { left: DEFAULT_PINNED, right: [] },
  })
  useColumnPrefs(tableKey, table, columnVisibility, columnOrder, setColumnOrder)

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
    setColumnPinning({ left: DEFAULT_PINNED, right: [] })
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
        exportOnlyWhenSelected
        leadingActions={<button onClick={() => setColumnManagerOpen(true)} className="text-xs font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">Manage Columns</button>}
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
            </div>
          )
        }}
        actions={
          <>
            {isOrderTable && TONE_ORDER.map((t) => {
              const active = toneFilter.has(t)
              return (
                <HoverTip key={t} content={<SwatchTipBody color={ROW_TONE_META[t].color} title={ROW_TONE_META[t].label}
                  description={active ? 'Click to stop filtering to these rows.' : 'Click to show only rows with this color.'} />}>
                  <button type="button"
                    onClick={() => setToneFilter((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })}
                    className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono ${active ? 'border-navy bg-navy/10 text-navy font-bold' : 'border-navy/30 text-inky hover:border-navy'}`}>
                    <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: ROW_TONE_META[t].color }} />
                    {ROW_TONE_META[t].label}
                    <span className="text-inky/60">{toneCounts[t]}</span>
                  </button>
                </HoverTip>
              )
            })}
            <ToggleButton checked={combinedListed} onChange={(v) => setCombinedModePref(v ? 'listed' : 'hidden')}
              onLabel="Combined – Listed" offLabel="Combined – Hidden"
              onTooltip="Click to hide the per-product breakdown of combined on hands (shown on hover instead)"
              offTooltip="Click to list each combined product's on hand in the cell" />
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
