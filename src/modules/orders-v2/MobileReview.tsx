// Phone layout for the Review step (direct ask 2026-10-04): one shop at a time in a full-screen, compact panel with the
// shop name at the top left and a "Next shop" button pinned at the top right. Each product is a small card with the
// same numbers, conditional formatting, flags and quantity controls as the table. Shown automatically on a phone (with a
// short hint pointing at the spreadsheet button that goes back to the table) and reachable from the phone button next to
// Order Settings on a larger screen.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Table2 } from 'lucide-react'
import { Button } from '@/components/ui'
import { DosCell } from './DosCell'
import { TagChip } from './OrdersV2ReviewTable'
import { QtyStepper, type ZeroReason } from './lineControls'
import { dShort, num } from './shared'
import { uomDisplayLabel } from './types'
import { ROW_TONE_META, type DosThresholds } from './lineFlags'
import type { LineTagMap } from './useLineTagMap'
import type { DraftLineRow } from './useOrdersV2'

/** A phone: a mobile user agent, or a narrow touch screen. */
export function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  if (/Android|iPhone|iPod|Mobile|Windows Phone/i.test(navigator.userAgent)) return true
  try { return window.innerWidth < 768 && window.matchMedia('(pointer: coarse)').matches } catch { return false }
}

export function MobileReview({
  lines, shopLabel, tagMap, thresholds, dosStyle, ozProductIds, patchQty, onZeroReason, deliveryText,
  autoDetected, onTableView, onFinal, markSeen, vendorLine,
}: {
  lines: DraftLineRow[]
  shopLabel: (id: string | null) => string
  tagMap: LineTagMap
  thresholds: DosThresholds | null
  dosStyle: 'badge' | 'text'
  ozProductIds: Set<string>
  patchQty: (l: DraftLineRow, qty: number) => void
  onZeroReason: (l: DraftLineRow, reason: ZeroReason | null, note: string | null) => void
  /** "Thu Oct 8" for a shop, or null. */
  deliveryText: (locationId: string | null) => string | null
  /** Switched here automatically (not by tapping the phone button) — shows the 5-second hint. */
  autoDetected: boolean
  onTableView: () => void
  /** Last shop's button: continue to Final Review (the caller runs its own "all rows seen?" prompt). */
  onFinal: () => void
  /** Tell the Review page's "rows reviewed" tracker these lines were on screen. */
  markSeen: (keys: string[]) => void
  vendorLine: string
}) {
  const shops = useMemo(() => {
    const m = new Map<string, DraftLineRow[]>()
    for (const l of lines) {
      const k = l.location_id ?? ''
      const arr = m.get(k)
      if (arr) arr.push(l); else m.set(k, [l])
    }
    return [...m.entries()]
      .sort((a, b) => shopLabel(a[0]).localeCompare(shopLabel(b[0]), undefined, { numeric: true }))
      .map(([id, ls]) => ({ id, lines: ls.sort((x, y) => x.product_id.localeCompare(y.product_id)) }))
  }, [lines, shopLabel])

  const [idx, setIdx] = useState(0)
  const safeIdx = Math.min(idx, Math.max(0, shops.length - 1))
  const shop = shops[safeIdx]
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    if (shop) markSeen(shop.lines.map((l) => l.id))
  }, [safeIdx, shop?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The hint beside the spreadsheet button, shown for 5 seconds after an automatic switch.
  const [hint, setHint] = useState(autoDetected)
  useEffect(() => {
    if (!autoDetected) return
    const t = window.setTimeout(() => setHint(false), 5000)
    return () => window.clearTimeout(t)
  }, [autoDetected])

  const last = safeIdx >= shops.length - 1

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-cream dark:bg-[#0A1826]">
      {/* Pinned header: shop name left, Next shop right. */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-navy/20 bg-cream dark:bg-[#0A1826]">
        <div className="min-w-0 flex items-center gap-2">
          <div className="min-w-0">
            <div className="text-base font-heading font-bold text-navy truncate">{shop ? shopLabel(shop.id) : 'No shops'}</div>
            <div className="text-[10px] font-mono text-navy/75 truncate">
              {shops.length ? `Shop ${safeIdx + 1} of ${shops.length}` : ''}{shop && deliveryText(shop.id) ? ` · Delivers ${deliveryText(shop.id)}` : ''}
            </div>
          </div>
          <div className="relative flex-shrink-0">
            <button type="button" onClick={onTableView} title="Switch to the table view"
              className="inline-flex items-center justify-center w-8 h-8 rounded border border-navy/30 text-navy hover:border-navy">
              <Table2 className="w-4 h-4" />
            </button>
            {hint && (
              <div className="absolute left-0 top-full mt-1.5 z-10 w-52 rounded-lg border border-[#B7E0DE]/40 bg-[#002745] px-3 py-2 text-[11px] font-mono leading-snug text-[#F2F1E6] shadow-xl">
                Mobile detected, view switched, click here to go to table view.
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button type="button" disabled={safeIdx === 0} onClick={() => setIdx(safeIdx - 1)} aria-label="Previous shop"
            className="w-9 h-9 inline-flex items-center justify-center rounded border border-navy/30 text-navy disabled:opacity-30">
            <ChevronLeft className="w-4 h-4" />
          </button>
          {last
            ? <Button size="sm" className="!bg-sb-sky !text-sb-navy" onClick={onFinal}>Final Review →</Button>
            : <Button size="sm" className="!bg-sb-sky !text-sb-navy" onClick={() => setIdx(safeIdx + 1)}>Next shop <ChevronRight className="w-4 h-4 ml-0.5 inline" /></Button>}
        </div>
      </div>
      <div className="px-3 py-1 text-[10px] font-mono text-navy/75 border-b border-navy/10 truncate">{vendorLine}</div>

      <div ref={scroller} className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {!shop && <p className="text-xs font-mono text-navy/75 py-6">Nothing to review.</p>}
        {shop?.lines.map((l) => {
          const t = tagMap.get(l.id)
          const tone = t?.tone ? ROW_TONE_META[t.tone] : null
          const isOz = ozProductIds.has(l.product_id)
          const mult = isOz ? 32 : 1
          const onHandAfter = l.on_hand == null ? null : (Number(l.on_hand) + Number(l.qty) * Number(l.quarts_per_unit ?? 1)) * mult
          const out = Number(l.on_hand ?? 0) <= 0
          return (
            <div key={l.id} className="rounded-lg border border-navy/25 px-3 py-2 flex flex-col gap-1.5"
              style={tone ? { background: `${tone.color}22`, borderColor: `${tone.color}88` } : undefined}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-heading font-bold text-navy truncate">{l.product_id}</span>
                <span className="text-[10px] font-mono text-navy/75 flex-shrink-0">{uomDisplayLabel(l.uom)}{tone ? ` · ${tone.label}` : ''}</span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-[10px] font-mono text-navy/75">
                <div><div>On hand</div><div className={`text-sm ${out ? 'font-bold text-[#C0392B]' : 'text-navy'}`}>{l.on_hand == null ? '—' : num(Number(l.on_hand) * mult)}</div></div>
                <div><div>DOS now</div><div className="text-sm text-navy"><DosCell v={l.dos_before} thresholds={thresholds} style={dosStyle} /></div></div>
                <div><div>After</div><div className="text-sm text-navy">{onHandAfter == null ? '—' : num(onHandAfter)}</div></div>
                <div><div>DOS after</div><div className="text-sm text-navy"><DosCell v={l.dos_after} thresholds={thresholds} style={dosStyle} /></div></div>
              </div>
              <div className="flex items-center justify-between gap-2">
                <QtyStepper compact inputClassName="w-16" value={Number(l.qty)} bulk={l.uom === 'bulk'} align="text-right"
                  onChange={(n) => patchQty(l, n)} zeroReason={{ line: l, onChange: (r, n) => onZeroReason(l, r, n) }} />
                <span className="text-[11px] font-mono text-navy/75">
                  {l.quarts_per_unit != null ? (isOz ? `${num(Number(l.qty) * l.quarts_per_unit * 32, 0)} oz` : `${num(Number(l.qty) * l.quarts_per_unit, 1)} qt`) : ''}
                </span>
              </div>
              {t && (t.tags.before.length > 0 || t.tags.after.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {[...t.tags.before, ...t.tags.after].map((d) => <TagChip key={d.key} tag={d} />)}
                </div>
              )}
              {t?.tags.note && <div className="text-[10px] font-mono italic text-navy/75">{t.tags.note}</div>}
            </div>
          )
        })}
        {shop && (
          <div className="pt-2 pb-6 flex justify-end">
            {last
              ? <Button size="sm" className="!bg-sb-sky !text-sb-navy" onClick={onFinal}>Final Review →</Button>
              : <Button size="sm" className="!bg-sb-sky !text-sb-navy" onClick={() => setIdx(safeIdx + 1)}>Next shop →</Button>}
          </div>
        )}
      </div>
    </div>
  )
}

// A date helper kept local so this file has no dependency on the table module's internals.
export const shortDeliveryText = (dd: string | null): string | null => {
  if (!dd) return null
  const dow = new Date(`${dd}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short' })
  return `${dow} ${dShort(dd)}`
}
