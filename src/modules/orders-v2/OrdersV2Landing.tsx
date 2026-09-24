import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2, Upload } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Modal, MultiSelectDropdown, SbLoader, Select, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { useDrafts, useDraftAggregates, useOrderSettings, useOrderDayCoverage, type DraftRow, type DraftAggregate } from './useOrdersV2'
import { useOrderHistory } from './useOrderHistory'
import { useRdReports } from './useRdReports'
import { RdReportsTab } from './RdReportsTab'
import { ValvolineOrderDatabaseTab } from './ValvolineOrderDatabaseTab'
import { useVendors, useUserNames } from './useLookups'
import { STATUS_LABEL, statusRoute, money, gallons, orderDayLabel, dShort, dTime } from './shared'

// True when an ISO timestamp falls on today's calendar date (local time) —
// drives the upload buttons' "glow orange, needs a fresh upload" state.
function isToday(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Module landing page. Not a wizard entry point — it's the home for both
 * in-progress drafts (visible to everyone, resumable at whatever step they
 * were left on) and completed orders.
 */
export function OrdersV2Landing() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const { settings } = useOrderSettings()
  const { drafts, loading, createDraft, deleteDraft } = useDrafts()
  const { orders, loading: histLoading } = useOrderHistory()
  const vendors = useVendors()
  const names = useUserNames()
  const rd = useRdReports()
  const [soOpen, setSoOpen] = useState(false)
  const [ioOpen, setIoOpen] = useState(false)

  const [startOpen, setStartOpen] = useState(false)
  const [vendorId, setVendorId] = useState('')
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Which weekday's shops to pull in. Defaults to the order date's own
  // weekday, but can be pointed elsewhere without moving the order date.
  const [orderDow, setOrderDow] = useState<number>(() => new Date().getDay())
  const [starting, setStarting] = useState(false)
  const coverage = useOrderDayCoverage(vendors.byId(vendorId || null)?.name)
  // Ad hoc: order a vendor for an explicit, manually-picked set of shops
  // instead of the vendor's regular order-day schedule (or "every shop" for
  // a vendor with no schedule at all) — for a one-off run limited to
  // specific shops, e.g. a shop that needs a rush order outside its normal
  // cadence. Works for any vendor, not just RelaDyne.
  const [adHoc, setAdHoc] = useState(false)
  const [adHocShops, setAdHocShops] = useState<string[]>([]) // shop LABELS, same shape as MultiSelectDropdown elsewhere
  const shopOptions = useMemo(() => loc.includedOptions.map((o) => ({ value: o.label })), [loc.includedOptions])
  const shopLabelToId = useMemo(() => new Map(loc.includedOptions.map((o) => [o.label, o.value])), [loc.includedOptions])
  // Mighty has no regular order-day schedule at all (see mightyEngine.ts) —
  // every Mighty order is inherently the ad hoc case, so the checkbox is
  // hidden and the shop picker always shows once this vendor is selected.
  // Target Days of Supply / Lead Time replace the per-shop config Mighty
  // shops don't have — set once for the whole order, editable later from
  // the draft itself.
  const isMighty = vendors.isMighty(vendorId)
  const [mightyTargetDays, setMightyTargetDays] = useState(21)
  const [mightyLeadTimeDays, setMightyLeadTimeDays] = useState(3)

  // Shared filters across both lists.
  const [fVendor, setFVendor] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')
  const [fUser, setFUser] = useState('')

  // One tab per DraftStatus value (generating folds into Review — it's the
  // instant-transient state before the Review page's own load sets 'review',
  // not a step anyone should be parked on) — every non-exported draft has to
  // land in exactly one of these tabs by construction, so a status this
  // grouping doesn't know about can't go silently missing the way a draft
  // whose status got flipped to 'exported' too early just did.
  const reviewDrafts = useMemo(() => drafts.filter((d) => d.status === 'generating' || d.status === 'review'), [drafts])
  const finalReviewDrafts = useMemo(() => drafts.filter((d) => d.status === 'final_review'), [drafts])
  const cancelledDrafts = useMemo(() => drafts.filter((d) => d.status === 'cancelled'), [drafts])

  const matches = (vendor: string | null, date: string, users: (string | null)[]) =>
    (!fVendor || vendor === fVendor) &&
    (!fFrom || date >= fFrom) &&
    (!fTo || date <= fTo) &&
    (!fUser || users.includes(fUser))

  const filterDrafts = (rows: DraftRow[]) => rows.filter((d) => matches(d.vendor_id, d.order_date, [d.created_by, d.last_edited_by]))
  const visibleReview = filterDrafts(reviewDrafts)
  const visibleFinalReview = filterDrafts(finalReviewDrafts)
  const visibleCancelled = filterDrafts(cancelledDrafts)
  const visibleOrders = orders.filter((o) => matches(o.vendor_id, o.order_date, [o.finalized_by]))

  // One aggregate query for every visible draft's products/gallons/cost,
  // instead of each status tab loading its own lines.
  const visibleDraftIds = useMemo(
    () => [...visibleReview, ...visibleFinalReview, ...visibleCancelled].map((d) => d.id),
    [visibleReview, visibleFinalReview, visibleCancelled],
  )
  const aggregates = useDraftAggregates(visibleDraftIds)

  const vendorName = (id: string | null) => vendors.byId(id)?.name ?? '—'

  function pickDate(v: string) {
    setOrderDate(v)
    if (v) setOrderDow(new Date(v + 'T00:00:00').getDay())
  }

  async function start() {
    setStarting(true)
    const useAdHoc = adHoc || isMighty
    const adHocIds = useAdHoc ? adHocShops.map((l) => shopLabelToId.get(l)).filter((v): v is string => !!v) : null
    const mightyOptions = isMighty ? { targetDays: mightyTargetDays, leadTimeDays: mightyLeadTimeDays } : null
    const id = await createDraft(vendorId || null, orderDate, settings, orderDow, adHocIds, mightyOptions)
    setStarting(false)
    if (id) { setStartOpen(false); navigate(`/orders-v2/draft/${id}`) }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Orders v2</h1>
          <p className="text-xs text-inky mt-0.5">
            Generate proposed orders from on-hand and usage, review and adjust, then export per vendor.
          </p>
        </div>
        <div className="flex items-start gap-2">
          <RdReportButton label="Open Sales Order Report" lastUploadedAt={rd.lastOpenOrdersAt} onClick={() => setSoOpen(true)} />
          <RdReportButton label="Open Invoice Report" lastUploadedAt={rd.lastOpenInvoicesAt} onClick={() => setIoOpen(true)} />
          <Button size="sm" variant="secondary" onClick={() => navigate('/orders-v2/exceptions')}>Product Exceptions</Button>
          <Button size="sm" variant="secondary" onClick={() => navigate('/orders-v2/settings')}>Order Settings</Button>
          <Button size="sm" onClick={() => setStartOpen(true)}><Plus className="w-3.5 h-3.5 mr-1" /> Start New Order</Button>
        </div>
      </div>

      {/* Filters apply to both lists */}
      <Card><CardBody className="flex items-end gap-3 flex-wrap py-3">
        <div className="w-56">
          <Combobox label="Vendor" options={[{ value: '', label: 'All vendors' }, ...vendors.options]} value={fVendor} onChange={setFVendor} />
        </div>
        <Input label="From" type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} />
        <Input label="To" type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} />
        <div className="w-56">
          <Combobox label="User" options={[{ value: '', label: 'Anyone' }, ...names.options]} value={fUser} onChange={setFUser} />
        </div>
        {(fVendor || fFrom || fTo || fUser) && (
          <button onClick={() => { setFVendor(''); setFFrom(''); setFTo(''); setFUser('') }}
            className="text-[11px] font-mono text-inky/60 hover:text-navy hover:underline pb-2">reset</button>
        )}
      </CardBody></Card>

      <Tabs defaultValue="review">
        <TabsList>
          <TabsTrigger value="review">Review ({visibleReview.length})</TabsTrigger>
          <TabsTrigger value="final_review">Final Review ({visibleFinalReview.length})</TabsTrigger>
          <TabsTrigger value="cancelled">Cancelled ({visibleCancelled.length})</TabsTrigger>
          <TabsTrigger value="done">Completed ({visibleOrders.length})</TabsTrigger>
          <TabsTrigger value="rd_reports">RD Reports</TabsTrigger>
          <TabsTrigger value="valvoline_db">Valvoline Order Database</TabsTrigger>
        </TabsList>

        <TabsContent value="review">
          <DraftTable
            rows={visibleReview} loading={loading}
            emptyMessage={'No orders in progress. "Start New Order" creates one immediately — it\'s saved server-side, so you can leave and pick it back up here.'}
            navigate={navigate} vendorName={vendorName} loc={loc} names={names} deleteDraft={deleteDraft} aggregates={aggregates}
          />
        </TabsContent>

        <TabsContent value="final_review">
          <DraftTable
            rows={visibleFinalReview} loading={loading}
            emptyMessage="Nothing at the final review step right now."
            navigate={navigate} vendorName={vendorName} loc={loc} names={names} deleteDraft={deleteDraft} aggregates={aggregates}
          />
        </TabsContent>

        <TabsContent value="cancelled">
          <DraftTable
            rows={visibleCancelled} loading={loading}
            emptyMessage="No cancelled drafts."
            navigate={navigate} vendorName={vendorName} loc={loc} names={names} deleteDraft={deleteDraft} aggregates={aggregates}
          />
        </TabsContent>

        <TabsContent value="done">
          {histLoading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : visibleOrders.length === 0 ? <p className="text-xs font-mono text-inky/60 py-8">No completed orders yet.</p>
            : (
              <div className="overflow-auto rounded border border-navy/30">
                <table className="w-full text-xs font-mono">
                  <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                    <Th>Vendor</Th><Th>Order Date</Th><Th>Shops</Th><Th>Order Day</Th><Th>Products</Th><Th>Gallons</Th><Th align="right">Cost</Th><Th>Export</Th><Th>Finalized</Th><Th>By</Th><Th />
                  </tr></thead>
                  <tbody>
                    {visibleOrders.map((o) => (
                      <tr key={o.id} className="border-b border-navy/15 hover:bg-sky/10 cursor-pointer"
                        onClick={() => navigate(`/orders-v2/history/${o.id}`)}>
                        <Td>{vendorName(o.vendor_id)}</Td>
                        <Td>{dShort(o.order_date)}</Td>
                        <Td>{o.location_count}</Td>
                        <Td>{orderDayLabel(o.settings_snapshot)}</Td>
                        <Td>{o.line_count}</Td>
                        <Td>{gallons(o.total_gallons)}</Td>
                        <Td align="right">{money(o.total_dollars)}</Td>
                        <Td>
                          {o.export_status}
                          {o.export_count > 1 && <span className="text-inky/50"> ×{o.export_count}</span>}
                          {o.edited_after_finalize && <span className="ml-1 text-[#E67E22]" title="Edited after finalizing">✎</span>}
                        </Td>
                        <Td>{dTime(o.finalized_at)}</Td>
                        <Td>{names.nameOf(o.finalized_by)}</Td>
                        <Td>
                          {/* The draft behind a completed order is never
                              deleted at finalize (see finalizeDraft) — this
                              jumps straight into its Review/Final/Export
                              steps (e.g. to reformat and re-download the
                              export file) instead of only the read-only
                              history table. stopPropagation so it doesn't
                              also trigger the row's own history-page click. */}
                          {o.draft_id && (
                            <button
                              onClick={(e) => { e.stopPropagation(); navigate(`/orders-v2/draft/${o.draft_id}`) }}
                              className="text-[11px] font-mono text-inky hover:text-navy hover:underline whitespace-nowrap">
                              Open in Steps
                            </button>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </TabsContent>

        <TabsContent value="rd_reports">
          <RdReportsTab />
        </TabsContent>

        <TabsContent value="valvoline_db">
          <ValvolineOrderDatabaseTab />
        </TabsContent>
      </Tabs>

      <Modal open={startOpen} onClose={() => setStartOpen(false)} title="Start New Order" size="sm">
        <div className="flex flex-col gap-3">
          <Combobox label="Vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
          <Input label="Order Date" type="date" value={orderDate} onChange={(e) => pickDate(e.target.value)} />

          {!isMighty && (
            <label className="flex items-center gap-2 text-xs font-mono text-navy cursor-pointer">
              <input type="checkbox" checked={adHoc} onChange={(e) => setAdHoc(e.target.checked)} className="accent-inky" />
              Ad hoc — order specific shop(s) only, instead of the regular schedule
            </label>
          )}

          {isMighty && (
            <div className="grid grid-cols-2 gap-3">
              <Input label="Target Days of Supply" type="number" min={1} max={365} value={mightyTargetDays}
                onChange={(e) => setMightyTargetDays(Math.max(1, Number(e.target.value) || 1))} />
              <Input label="Lead Time (days)" type="number" min={0} max={90} value={mightyLeadTimeDays}
                onChange={(e) => setMightyLeadTimeDays(Math.max(0, Number(e.target.value) || 0))} />
            </div>
          )}

          {adHoc || isMighty ? (
            <>
              <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-mono text-inky/60">Shop(s)</span>
                <MultiSelectDropdown options={shopOptions} selected={adHocShops} onChange={setAdHocShops}
                  placeholder="Select shops…" countNoun="shops" searchable showAllOption={false} />
              </div>
              {adHocShops.length === 0 ? (
                <p className="text-[11px] font-mono text-[#C0392B]">Pick at least one shop to run {isMighty ? 'a Mighty' : 'an ad hoc'} order.</p>
              ) : isMighty ? (
                <p className="text-[11px] font-mono text-inky/60">
                  Orders every Mighty-supplied product at {adHocShops.length} selected shop{adHocShops.length !== 1 ? 's' : ''}
                  {' '}up to {mightyTargetDays} days of supply, {mightyLeadTimeDays}d lead time.
                </p>
              ) : (
                <p className="text-[11px] font-mono text-inky/60">
                  Generates the same way as a regular order — DOS targets, minimums, smoothing — limited to
                  {' '}{adHocShops.length} selected shop{adHocShops.length !== 1 ? 's' : ''}.
                </p>
              )}
            </>
          ) : coverage.applies ? (
            <>
              <Select label="Order day (which shops to include)" value={String(orderDow)}
                onChange={(e) => setOrderDow(Number(e.target.value))}
                options={DOW.map((d, i) => ({ value: String(i), label: `${d} — ${coverage.counts[i]} shop${coverage.counts[i] !== 1 ? 's' : ''}` }))} />
              {coverage.counts[orderDow] === 0 ? (
                <p className="text-[11px] font-mono text-[#C0392B]">
                  No shops order on {DOW[orderDow]}. Pick a day with shops on it, or check the Reladyne Delivery Day
                  column on the location list — the order day is derived from it (delivery minus three business days).
                </p>
              ) : (
                <p className="text-[11px] font-mono text-inky/60">
                  {coverage.counts[orderDow]} shop{coverage.counts[orderDow] !== 1 ? 's' : ''} order on {DOW[orderDow]}.
                  Defaults to the order date&apos;s weekday — change it to run a different day&apos;s shops.
                </p>
              )}
            </>
          ) : (
            <p className="text-[11px] font-mono text-inky/60">
              This vendor has no order-day restriction, so every shop with configured products is considered.
            </p>
          )}

          <p className="text-[11px] font-mono text-inky/60">
            The draft is saved immediately, so you can leave and resume it from this page.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => setStartOpen(false)}>Cancel</Button>
            <Button size="sm" loading={starting} disabled={!profile?.company_id || ((adHoc || isMighty) && adHocShops.length === 0)} onClick={start}>Create Draft</Button>
          </div>
        </div>
      </Modal>

      <Modal open={soOpen} onClose={() => setSoOpen(false)} title="Upload Open Sales Order Report" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            RelaDyne's own "Open SO" export — every order still pending delivery. Replaces whatever was uploaded
            before; this is a snapshot of what's open right now, not a running history. Runs a check against Droptop
            receiving data as soon as it's uploaded — see the Test - AutoExceptions tab on Exception Reporting.
          </p>
          <FileUploadZone label="Drop the Open Sales Order .xlsx here" onParsed={(r) => { rd.uploadOpenOrders(r.rows); setSoOpen(false) }} />
          {rd.uploading === 'orders' && <div className="flex justify-center py-2"><SbLoader size={24} /></div>}
        </div>
      </Modal>

      <Modal open={ioOpen} onClose={() => setIoOpen(false)} title="Upload Open Invoice Report" size="sm">
        <div className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            RelaDyne's own "Open Invoice (IO)" export — recently shipped/invoiced orders. Replaces whatever was
            uploaded before. Runs a check against Droptop receiving data as soon as it's uploaded, flagging any
            variance between what was invoiced and what was actually received.
          </p>
          <FileUploadZone label="Drop the Open Invoice .xlsx here" onParsed={(r) => { rd.uploadOpenInvoices(r.rows); setIoOpen(false) }} />
          {rd.uploading === 'invoices' && <div className="flex justify-center py-2"><SbLoader size={24} /></div>}
        </div>
      </Modal>
    </div>
  )
}

// Glows orange (with "last updated" text underneath) whenever today's
// report hasn't been uploaded yet — the explicit visual cue asked for, so
// nobody has to remember to check whether today's file already went in.
function RdReportButton({ label, lastUploadedAt, onClick }: { label: string; lastUploadedAt: string | null; onClick: () => void }) {
  const stale = !isToday(lastUploadedAt)
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        onClick={onClick}
        className={[
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border text-[11px] font-heading uppercase tracking-wide bg-transparent transition-all',
          stale
            ? 'border-[#E67E22] text-[#E67E22] shadow-[0_0_10px_2px_rgba(230,126,34,0.45)] animate-pulse'
            : 'border-navy text-navy hover:bg-navy hover:text-cream',
        ].join(' ')}
      >
        <Upload className="w-3.5 h-3.5" /> {label}
      </button>
      <span className={`text-[10px] font-mono ${stale ? 'text-[#E67E22]' : 'text-inky/60'}`}>
        {lastUploadedAt ? `Last updated ${dShort(lastUploadedAt)}` : 'Never uploaded'}
      </span>
    </div>
  )
}

// Shared by every status tab — a draft's status determines both which tab
// it's in and where clicking it navigates (statusRoute), so there's exactly
// one place per draft it can be found, by construction.
function DraftTable({ rows, loading, emptyMessage, navigate, vendorName, loc, names, deleteDraft, aggregates }: {
  rows: DraftRow[]
  loading: boolean
  emptyMessage: string
  navigate: ReturnType<typeof useNavigate>
  vendorName: (id: string | null) => string
  loc: ReturnType<typeof useLocations>
  names: ReturnType<typeof useUserNames>
  deleteDraft: (id: string) => void | Promise<void>
  aggregates: Record<string, DraftAggregate>
}) {
  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
  if (rows.length === 0) return <p className="text-xs font-mono text-inky/60 py-8">{emptyMessage}</p>
  return (
    <div className="overflow-auto rounded border border-navy/30">
      <table className="w-full text-xs font-mono">
        <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
          <Th>Vendor</Th><Th>Order Date</Th><Th>Shops</Th><Th>Step</Th><Th>Order Day</Th><Th>Products</Th><Th>Gallons</Th>
          <Th align="right">Cost</Th><Th>Last Edited</Th><Th>By</Th><Th />
        </tr></thead>
        <tbody>
          {rows.map((d) => {
            const agg = aggregates[d.id]
            return (
              <tr key={d.id} className="border-b border-navy/15 hover:bg-sky/10 cursor-pointer"
                onClick={() => navigate(statusRoute(d))}>
                <Td>{vendorName(d.vendor_id)}</Td>
                <Td>{dShort(d.order_date)}</Td>
                <Td><ShopCount draft={d} loc={loc} /></Td>
                <Td><span className="rounded-full bg-sky/25 text-navy px-2 py-0.5">{STATUS_LABEL[d.status]}</span></Td>
                <Td>{orderDayLabel(d.settings_snapshot)}</Td>
                <Td>{agg ? agg.products : '—'}</Td>
                <Td>{agg ? gallons(agg.gallons) : '—'}</Td>
                <Td align="right">{agg ? money(agg.cost) : '—'}</Td>
                <Td>{dTime(d.updated_at)}</Td>
                <Td>{names.nameOf(d.last_edited_by ?? d.created_by)}</Td>
                <Td>
                  <button title="Delete draft"
                    onClick={(e) => { e.stopPropagation(); if (confirm('Delete this draft order? Its lines are removed too.')) deleteDraft(d.id) }}
                    className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <th className={`px-3 py-2 ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>
}
function Td({ children, align }: { children?: React.ReactNode; align?: 'right' }) {
  return <td className={`px-3 py-1.5 text-navy ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</td>
}

// Shop count comes from the draft's lines; kept cheap by reading the count
// the header caches rather than loading every line on the landing page.
function ShopCount({ draft }: { draft: DraftRow; loc: ReturnType<typeof useLocations> }) {
  const meta = draft.settings_snapshot as any
  const n = meta?.__shop_count
  return <>{n == null ? '—' : n}</>
}
