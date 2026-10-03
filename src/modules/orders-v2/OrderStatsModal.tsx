import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react'
import { Button, Modal, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { MINIMUM_TYPE_LABELS, type MinimumType } from './types'
import { OrderFullSummaryModal } from './OrderFullSummaryModal'
import { unchangedStreak, type StreakDraft } from './settingsStreak'
import { dShort } from './shared'

const sb = () => supabase as any
const PAGE = 1000

interface StatLine { id: string; location_id: string | null; product_id: string; system_qty: number; qty: number; included: boolean }

// Curated subset of settings_snapshot worth showing — the full blob also
// carries internal bookkeeping keys (__order_dow, __adhoc_location_ids,
// __shop_count, __keepfill_alerts) that mean nothing to a reader trying to
// understand "what was this order generated with."
const SETTING_ROWS: { key: string; label: string; fmt?: (v: unknown) => string }[] = [
  { key: 'days_of_supply_target', label: 'DOS Target' },
  { key: 'days_of_supply_min_trigger', label: 'DOS Min Trigger' },
  { key: 'days_of_supply_max', label: 'DOS Max' },
  { key: 'bulk_rounding_increment', label: 'Bulk Rounding Increment (gal)' },
  { key: 'order_minimum_dollars_package', label: 'Package Minimum ($)', fmt: (v) => `$${Number(v ?? 0).toLocaleString()}` },
  { key: 'package_minimum_type', label: 'Package Minimum Type', fmt: (v) => MINIMUM_TYPE_LABELS[v as MinimumType] ?? String(v ?? '—') },
  { key: 'order_minimum_dollars_bulk', label: 'Bulk Minimum ($)', fmt: (v) => `$${Number(v ?? 0).toLocaleString()}` },
  { key: 'bulk_minimum_type', label: 'Bulk Minimum Type', fmt: (v) => MINIMUM_TYPE_LABELS[v as MinimumType] ?? String(v ?? '—') },
  { key: 'bulk_round_up_threshold_gal', label: 'Bulk Round-Up Threshold (gal)' },
  { key: 'bulk_urgent_dos_threshold', label: 'Bulk Urgent DOS Threshold' },
  { key: 'skip_order_if_dos_over', label: 'Skip Order If DOS Over' },
]

/**
 * "Settings summary" — direct ask 2026-09-30: what this order was generated
 * WITH (settings_snapshot, already stored per draft), and how far the final
 * lines actually drifted from what the engine originally suggested —
 * adjusted up/down, removed, added. All four categories are derived from
 * fields the engine already computes (system_qty vs qty vs included), no
 * new schema — the point is surfacing decisions that are already there but
 * were never summarized anywhere, to help tune settings/logic over time.
 */
export function OrderStatsModal({ draftId, vendorId, settingsSnapshot, open, onClose, editPath, onDelete, details }: {
  /** Orders tab: vendor / dates / order type for the header, plus every draft (to show "unchanged in N orders"). */
  details?: { vendorName: string; orderDate: string; createdAt: string; orderType: string; orderDay: string | null; current: StreakDraft; allDrafts: StreakDraft[] }
  draftId: string
  vendorId?: string | null
  settingsSnapshot: Record<string, unknown> | null | undefined
  open: boolean
  onClose: () => void
  // Direct ask 2026-09-30: clicking an order row now opens this modal
  // instead of navigating straight to the order — editPath/onDelete move
  // those actions in here instead of a table "actions" column.
  editPath?: string
  onDelete?: () => void
}) {
  const navigate = useNavigate()
  const loc = useLocations()
  const [lines, setLines] = useState<StatLine[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [fullSummaryOpen, setFullSummaryOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setExpanded(null)
    ;(async () => {
      const out: StatLine[] = []
      let from = 0
      for (;;) {
        const { data, error } = await sb().schema('inventory').from('ov2_order_draft_lines')
          .select('id, location_id, product_id, system_qty, qty, included').eq('draft_id', draftId)
          .order('id', { ascending: true }).range(from, from + PAGE - 1)
        if (error || cancelled) break
        const batch = (data ?? []) as StatLine[]
        out.push(...batch)
        if (batch.length === 0) break
        from += batch.length
      }
      if (!cancelled) { setLines(out); setLoading(false) }
    })()
    return () => { cancelled = true }
  }, [open, draftId])

  const shopLabel = (id: string | null) => (id ? (loc.fieldValue(id, 'shop_city') || loc.codeOf(id)) : null) ?? '—'

  // Epsilon guards against a line's own qty being rounded to something
  // technically off from system_qty by a fraction of a unit (bulk's own
  // fractional-gallon rounding) without that reading as a real adjustment.
  const buckets = useMemo(() => {
    const EPS = 0.001
    const up = lines.filter((l) => l.included && l.qty > l.system_qty + EPS)
    const down = lines.filter((l) => l.included && l.qty < l.system_qty - EPS)
    const removed = lines.filter((l) => !l.included && l.system_qty > EPS)
    const added = lines.filter((l) => l.included && l.system_qty <= EPS && l.qty > EPS)
    return { up, down, removed, added }
  }, [lines])

  const TILES: { key: keyof typeof buckets; label: string; color: string }[] = [
    { key: 'up', label: 'Adjusted Up', color: 'text-[#2ECC71]' },
    { key: 'down', label: 'Adjusted Down', color: 'text-[#E67E22]' },
    { key: 'removed', label: 'Removed', color: 'text-[#C0392B]' },
    { key: 'added', label: 'Added', color: 'text-sky' },
  ]

  return (
    <Modal open={open} onClose={onClose} title="Order Settings & Adjustments" size="lg">
      <div className="flex flex-col gap-4">
        {details && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {[
              { label: 'Vendor', value: details.vendorName },
              { label: 'Order Date', value: dShort(details.orderDate) },
              { label: 'Order Type', value: details.orderType },
              { label: 'Created', value: dShort(details.createdAt.slice(0, 10)) },
            ].map((c) => (
              <div key={c.label} className="rounded border border-navy/25 px-2 py-1.5">
                <div className="text-[9px] font-mono uppercase tracking-wide text-navy/75">{c.label}</div>
                <div className="text-xs font-mono text-navy font-bold">{c.value}</div>
              </div>
            ))}
          </div>
        )}
        {settingsSnapshot && (
          <div>
            <h3 className="text-[11px] font-mono uppercase tracking-wide text-navy/75 mb-1.5">Settings used</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {SETTING_ROWS.filter((r) => settingsSnapshot[r.key] !== undefined).map((r) => {
                const streak = details ? unchangedStreak(r.key, details.current, details.allDrafts) : 1
                return (
                  <div key={r.key} className="rounded border border-navy/25 px-2 py-1.5">
                    <div className="text-[9px] font-mono uppercase tracking-wide text-navy/75">{r.label}</div>
                    <div className="text-xs font-mono text-navy font-bold">
                      {r.fmt ? r.fmt(settingsSnapshot[r.key]) : String(settingsSnapshot[r.key])}
                    </div>
                    {streak >= 2 && <div className="text-[9px] font-mono text-[#2ECC71] font-bold mt-0.5">unchanged in {streak} orders</div>}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {loading ? (
          <div className="py-8 flex justify-center"><SbLoader size={28} /></div>
        ) : (
          <div>
            <h3 className="text-[11px] font-mono uppercase tracking-wide text-navy/75 mb-1.5">
              How the final order differs from what was originally suggested
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {TILES.map((t) => {
                const rows = buckets[t.key]
                const isOpen = expanded === t.key
                return (
                  <div key={t.key} className="rounded border border-navy/25">
                    <button
                      onClick={() => setExpanded(isOpen ? null : t.key)}
                      disabled={rows.length === 0}
                      className="w-full flex items-center justify-between gap-1 px-2 py-2 text-left disabled:cursor-default"
                    >
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-navy/75">{t.label}</div>
                        <div className={`text-xl font-heading font-bold ${t.color}`}>{rows.length}</div>
                      </div>
                      {rows.length > 0 && (isOpen ? <ChevronDown className="w-3.5 h-3.5 text-inky/50" /> : <ChevronRight className="w-3.5 h-3.5 text-inky/50" />)}
                    </button>
                    {isOpen && (
                      <div className="border-t border-navy/15 max-h-40 overflow-auto">
                        <table className="w-full text-[10px] font-mono">
                          <thead><tr className="bg-cream text-inky uppercase border-b border-navy/10">
                            <th className="text-left px-1.5 py-1">Shop</th><th className="text-left px-1.5 py-1">Product</th>
                            <th className="text-right px-1.5 py-1">Suggested</th><th className="text-right px-1.5 py-1">Actual</th>
                          </tr></thead>
                          <tbody>
                            {rows.map((l) => (
                              <tr key={l.id} className="border-b border-navy/5">
                                <td className="px-1.5 py-1 text-navy">{shopLabel(l.location_id)}</td>
                                <td className="px-1.5 py-1 text-navy">{l.product_id}</td>
                                <td className="px-1.5 py-1 text-right text-inky/60">{l.system_qty}</td>
                                <td className="px-1.5 py-1 text-right text-navy">{l.qty}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-navy/10">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setFullSummaryOpen(true)}>View Full Summary</Button>
            {onDelete && (
              <button onClick={onDelete} title="Delete draft" className="text-inky/40 hover:text-[#C0392B]">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
          {editPath && (
            // Simplified from the always-animating chase outline down to a
            // permanent green glow (direct ask 2026-09-30), now with a slow
            // pulse (direct ask 2026-10-01, .ov2-glow-pulse in index.css) —
            // draws the eye to this button's existence even without
            // hovering, since it's now the only way to actually open the
            // order from this table. The trace SVG is preserved in a
            // comment in case the chase animation is wanted back later:
            //
            // <svg className="pointer-events-none absolute -inset-3.5 w-[calc(100%+28px)] h-[calc(100%+28px)] overflow-visible" aria-hidden="true">
            //   <rect
            //     x="12" y="12" rx="11"
            //     style={{ width: 'calc(100% - 24px)', height: 'calc(100% - 24px)' }}
            //     fill="none" stroke="#2ECC71" strokeWidth="3" pathLength={100}
            //     className="ov2-edit-order-trace drop-shadow-[0_0_4px_rgba(46,204,113,0.7)]"
            //   />
            // </svg>
            <div className="relative inline-block">
              <Button size="sm" onClick={() => navigate(editPath)}
                className="relative z-10 rounded-lg ov2-glow-pulse">
                Edit Order →
              </Button>
            </div>
          )}
        </div>
      </div>

      <OrderFullSummaryModal draftId={draftId} vendorId={vendorId ?? null} open={fullSummaryOpen} onClose={() => setFullSummaryOpen(false)} />
    </Modal>
  )
}
