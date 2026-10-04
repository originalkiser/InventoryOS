// Phone layout for the Review step: one shop at a time in a full-screen panel. A pinned top bar (shop name and position,
// when it delivers, table-view / previous / Next shop) stays put while the cards scroll; under it the vendor line with the
// order total and the VMI toggle / add-product buttons. A shop shows what is being ordered first, then its other configured
// products to add if needed. "Skip to final review" floats bottom right with room left under it so no card is ever hidden.
// Shown automatically on a phone (with a short hint beside the table-view button) and from the phone button elsewhere.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Table2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { DosCell } from './DosCell'
import { TagChip } from './OrdersV2ReviewTable'
import { QtyStepper, type ZeroReason } from './lineControls'
import { ToggleButton } from './controls'
import { dShort, money, num } from './shared'
import { uomDisplayLabel } from './types'
import { ROW_TONE_META, type DosThresholds } from './lineFlags'
import { useLineTagMap } from './useLineTagMap'
import type { useLastOrderedInfo } from './useLastOrderedInfo'
import type { DraftLineRow } from './useOrdersV2'

/** A phone: a mobile user agent, or a narrow touch screen. */
export function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/Android|iPhone|iPod|Mobile|Windows Phone/i.test(navigator.userAgent)) return true
  try { return window.innerWidth < 768 && window.matchMedia('(pointer: coarse)').matches } catch { return false }
}

export function MobileReview({
  lines, shopLabel, shopLinesFor, thresholds, dosStyle, ozProductIds, patchQty, onZeroReason, deliveryText, lastInfoFor,
  onHandAfterAtDelivery, groupMinimumStatus, showVmi, onShowVmi, onAddNonConfigured, onShopChange,
  autoDetected, onTableView, onFinal, markSeen, vendorLine, orderTotal,
}: {
  /** The order's real lines (decides which shops are listed). */
  lines: DraftLineRow[]
  shopLabel: (id: string | null) => string
  /** Every configured product for a shop (real lines plus qty-0 candidates), VMI included. */
  shopLinesFor: (locId: string) => DraftLineRow[]
  thresholds: DosThresholds | null
  dosStyle: 'badge' | 'text'
  ozProductIds: Set<string>
  patchQty: (l: DraftLineRow, qty: number) => void
  onZeroReason: (l: DraftLineRow, reason: ZeroReason | null, note: string | null) => void
  /** "Thu Oct 8, 2026" for a shop, or null. */
  deliveryText: (locationId: string | null) => string | null
  lastInfoFor: ReturnType<typeof useLastOrderedInfo>['infoFor']
  onHandAfterAtDelivery: (l: DraftLineRow) => number
  groupMinimumStatus: Map<string, boolean>
  showVmi: boolean
  onShowVmi: (v: boolean) => void
  onAddNonConfigured: (locId: string) => void
  onShopChange: (locId: string | null) => void
  autoDetected: boolean
  onTableView: () => void
  onFinal: () => void
  markSeen: (keys: string[]) => void
  vendorLine: string
  orderTotal: number
}) {
  const shops = useMemo(() => {
    const ids = [...new Set(lines.map((l) => l.location_id ?? ''))]
    return ids.sort((a, b) => shopLabel(a).localeCompare(shopLabel(b), undefined, { numeric: true }))
  }, [lines, shopLabel])

  const [idx, setIdx] = useState(0)
  const safeIdx = Math.min(idx, Math.max(0, shops.length - 1))
  const shopId = shops[safeIdx] as string | undefined
  const scroller = useRef<HTMLDivElement>(null)

  const all = shopId ? shopLinesFor(shopId) : []
  const tagMap = useLineTagMap(all, thresholds, onHandAfterAtDelivery, groupMinimumStatus)
  const visible = all.filter((l) => showVmi || !(l.flags ?? []).includes('vmi_keepfill'))
  const sortP = (a: DraftLineRow, b: DraftLineRow) => a.product_id.localeCompare(b.product_id)
  const ordered = visible.filter((l) => Number(l.qty) > 0).sort(sortP)
  const others = visible.filter((l) => !(Number(l.qty) > 0)).sort(sortP)

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    onShopChange(shopId ?? null)
    markSeen(lines.filter((l) => (l.location_id ?? '') === shopId).map((l) => l.id))
  }, [safeIdx, shopId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The hint beside the table-view button, shown for 5 seconds after an automatic switch.
  const [hint, setHint] = useState(autoDetected)
  useEffect(() => {
    if (!autoDetected) return
    const t = window.setTimeout(() => setHint(false), 5000)
    return () => window.clearTimeout(t)
  }, [autoDetected])

  const last = safeIdx >= shops.length - 1
  const delivers = shopId ? deliveryText(shopId) : null

  // A plain render function (not a component), so a card's quantity box keeps its focus while you type.
  const renderCard = (l: DraftLineRow, muted?: boolean) => {
    const t = tagMap.get(l.id)
    const tone = t?.tone ? ROW_TONE_META[t.tone] : null
    const isOz = ozProductIds.has(l.product_id)
    const mult = isOz ? 32 : 1
    // Same projection as the table's On Hand After: what's left on the shelf when the delivery lands (usage runs it down over
    // the lead time), plus what's ordered. DOS after is that figure over daily usage.
    const afterQts = l.on_hand == null ? null : onHandAfterAtDelivery(l)
    const onHandAfter = afterQts == null ? null : afterQts * mult
    const usageQts = Number(l.daily_usage ?? 0)
    const dosAfter = afterQts == null ? null : usageQts > 0 ? afterQts / usageQts : null
    const out = Number(l.on_hand ?? 0) <= 0
    const cost = Number(l.qty) * Number(l.unit_cost ?? 0)
    const info = lastInfoFor(l.location_id ?? '', l.product_id, l.on_hand, l.daily_usage)
    const orange = l.is_override
    return (
      <div key={l.id} className={`rounded-lg border px-3 py-2.5 flex flex-col gap-2 ${muted ? 'opacity-90' : ''} ${orange ? 'border-[#E67E22]/70 shadow-[inset_4px_0_0_#E67E22]' : 'border-navy/25'}`}
        style={tone ? { background: `${tone.color}22`, borderColor: orange ? undefined : `${tone.color}88` } : undefined}>
        <div className="flex items-start justify-between gap-2">
          <span className="text-base font-heading font-bold text-navy break-all leading-tight">{l.product_id}</span>
          <span className="text-[11px] font-mono text-navy/75 flex-shrink-0 pt-0.5">{uomDisplayLabel(l.uom)}</span>
        </div>
        {tone && <div className="text-[11px] font-mono text-navy/75 -mt-1">{tone.label}</div>}
        <div className="grid grid-cols-3 gap-x-2 gap-y-1.5 text-left">
          {[
            { label: 'On hand', node: <span className={out ? 'font-bold text-[#C0392B]' : ''}>{l.on_hand == null ? '—' : num(Number(l.on_hand) * mult)}</span> },
            { label: 'Usage/day', node: <span>{l.daily_usage == null ? '—' : num(Number(l.daily_usage) * mult)}</span> },
            { label: 'DOS now', node: <DosCell v={l.dos_before} thresholds={thresholds} style={dosStyle} align="left" /> },
            { label: 'After', node: <span>{onHandAfter == null ? '—' : num(onHandAfter)}</span> },
            { label: 'DOS @ delivery', node: <DosCell v={l.dos_after_delivery} thresholds={thresholds} style={dosStyle} align="left" /> },
            { label: 'DOS after', node: <DosCell v={dosAfter} thresholds={thresholds} style={dosStyle} align="left" /> },
          ].map((c) => (
            <div key={c.label} className="min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-wide text-navy/75 leading-4">{c.label}</div>
              <div className="text-sm font-mono text-navy leading-5 h-5 flex items-center">{c.node}</div>
            </div>
          ))}
        </div>
        <div className="flex items-end justify-between gap-2">
          <QtyStepper compact inputClassName="w-16" value={Number(l.qty)} bulk={l.uom === 'bulk'} align="text-right"
            onChange={(n) => patchQty(l, n)} zeroReason={{ line: l, onChange: (r, n) => onZeroReason(l, r, n) }} />
          <div className="text-right leading-tight">
            <div className="text-[11px] font-mono text-navy/75">
              {l.quarts_per_unit != null ? (isOz ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)} oz` : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`) : ''}
            </div>
            <div className="text-sm font-mono font-bold text-navy">{money(cost)}</div>
          </div>
        </div>
        <div className="text-[10px] font-mono text-navy/75 leading-snug">
          <div>Last ordered: {info.lastOrderDate ? `${dShort(info.lastOrderDate)} · ${num(info.lastOrderQty, 1)} ${uomDisplayLabel(info.lastOrderUom)}${info.eta ? ` · ETA ${dShort(info.eta)}` : ''}` : '—'}</div>
          <div>Last delivered: {info.lastDeliveredDate ? `${dShort(info.lastDeliveredDate)} · ${num(info.lastDeliveredAmount, 1)} ${info.lastDeliveredUnit === 'gal' ? 'gal' : uomDisplayLabel(info.lastOrderUom)}` : '—'}</div>
        </div>
        {t && (t.tags.before.length > 0 || t.tags.after.length > 0) && (
          <div className="flex flex-wrap gap-1">{[...t.tags.before, ...t.tags.after].map((d) => <TagChip key={d.key} tag={d} />)}</div>
        )}
        {t?.tags.note && <div className="text-[10px] font-mono italic text-navy/75">{t.tags.note}</div>}
      </div>
    )
  }

  return (
    <div className="fixed inset-x-0 top-0 z-[60] h-[100dvh] flex flex-col bg-cream dark:bg-[#0A1826]">
      {/* Pinned top bar — never scrolls away. */}
      <div className="flex-shrink-0 border-b border-navy/20 bg-cream dark:bg-[#0A1826]">
        <div className="flex items-start justify-between gap-2 px-3 pt-2 pb-1.5">
          <div className="min-w-0">
            <div className="text-lg font-heading font-bold text-navy truncate leading-tight">{shopId ? shopLabel(shopId) : 'No shops'}</div>
            <div className="text-[11px] font-mono text-navy/75 leading-snug">{shops.length ? `Shop ${safeIdx + 1} of ${shops.length}` : ''}</div>
            <div className="text-[11px] font-mono text-navy/75 leading-snug">{delivers ? `Delivers ${delivers}` : ''}</div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="relative">
              <button type="button" onClick={onTableView} title="Switch to the table view"
                className="inline-flex items-center justify-center w-10 h-10 rounded border border-navy/30 text-navy hover:border-navy">
                <Table2 className="w-4 h-4" />
              </button>
              {hint && (
                <div className="absolute right-0 top-full mt-2 z-10 w-56 rounded-lg border border-[#B7E0DE]/40 bg-[#002745] px-3 py-2 text-[11px] font-mono leading-snug text-[#F2F1E6] shadow-xl">
                  Mobile detected, view switched, click here to go to table view.
                </div>
              )}
            </div>
            <button type="button" disabled={safeIdx === 0} onClick={() => setIdx(safeIdx - 1)} aria-label="Previous shop"
              className="w-10 h-10 inline-flex items-center justify-center rounded border border-navy/30 text-navy disabled:opacity-30"><ChevronLeft className="w-4 h-4" /></button>
            <Button size="sm" className="!bg-sb-sky !text-sb-navy !h-10" disabled={last} onClick={() => setIdx(safeIdx + 1)}>
              Next shop <ChevronRight className="w-4 h-4 ml-0.5 inline" />
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 py-1 border-t border-navy/10 text-[11px] font-mono text-navy/75">
          <span className="truncate">{vendorLine}</span>
          <span className="flex-shrink-0 font-bold text-navy">Order total {money(orderTotal)}</span>
        </div>
        <div className="flex items-center justify-between gap-2 px-3 pb-2">
          <ToggleButton checked={showVmi} onChange={onShowVmi} onLabel="VMI Shown" offLabel="VMI Hidden"
            onTooltip="Tap to hide VMI/keep-fill products" offTooltip="Tap to also show VMI/keep-fill products" />
          <Button size="sm" variant="secondary" disabled={!shopId} onClick={() => shopId && onAddNonConfigured(shopId)}>
            <Plus className="w-3.5 h-3.5 mr-0.5" /> Add product
          </Button>
        </div>
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-2 flex flex-col gap-2 pb-24">
        {!shopId && <p className="text-xs font-mono text-navy/75 py-6">Nothing to review.</p>}
        {shopId && (
          <>
            <div className="text-[11px] font-mono uppercase tracking-widest text-navy font-bold">Ordered ({ordered.length})</div>
            {ordered.length === 0 && <p className="text-xs font-mono text-navy/75">Nothing ordered for this shop.</p>}
            {ordered.map((l) => renderCard(l))}
            {others.length > 0 && (
              <>
                <div className="text-[11px] font-mono uppercase tracking-widest text-navy/75 font-bold mt-2">Other configured products ({others.length}) — add if needed</div>
                {others.map((l) => renderCard(l, true))}
              </>
            )}
          </>
        )}
      </div>

      {/* Always in the bottom-right of the visible screen; the list above leaves room under it. */}
      <div className="fixed bottom-4 right-4 z-[65] pb-[env(safe-area-inset-bottom)]">
        <Button size="sm" className="!bg-sb-sky !text-sb-navy shadow-xl" onClick={onFinal}>Skip to final review →</Button>
      </div>
    </div>
  )
}

// A date helper kept local so this file has no dependency on the table module's internals.
export const shortDeliveryText = (dd: string | null): string | null => {
  if (!dd) return null
  const dow = new Date(`${dd}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' })
  return `${dow} ${new Date(`${dd}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
}
