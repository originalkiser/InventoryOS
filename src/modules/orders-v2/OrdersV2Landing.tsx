import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Droplet, Plus, Upload } from 'lucide-react'
import { createColumnHelper } from '@tanstack/react-table'
import { Button, Input, Modal, MultiSelectDropdown, SbLoader, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { FileUploadZone } from '@/components/upload/FileUploadZone'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { useDrafts, useDraftAggregates, useOrderSettings, useOrderDayCoverage, type DraftRow } from './useOrdersV2'
import { useRdReports } from './useRdReports'
import { RdReportsTab } from './RdReportsTab'
import { ValvolineOrderDatabaseTab } from './ValvolineOrderDatabaseTab'
import { ProductsOrderedTab } from './ProductsOrderedTab'
import { OrderStatsModal } from './OrderStatsModal'
import { useVendors, useUserNames } from './useLookups'
import { SegmentedSlider, AnimatedHeight } from './controls'
import { STATUS_LABEL, statusRoute, money, gallons, orderDayLabel, dShort, dTime } from './shared'
import type { DraftStatus } from './types'

// True when an ISO timestamp falls on today's calendar date (local time) —
// drives the upload buttons' "glow orange, needs a fresh upload" state.
function isToday(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Distinct color per status for the unified table's pill (direct ask
// 2026-09-29 — "one tab, color coded by status" replacing a tab per step).
// 'generating' folds into 'review' visually — it's the instant-transient
// state before the Review page's own load sets 'review', not a step
// anyone is ever really parked looking at.
const STATUS_COLOR: Record<DraftStatus, string> = {
  generating: 'bg-sky/25 text-navy',
  review: 'bg-sky/25 text-navy',
  final_review: 'bg-[#E67E22]/20 text-[#E67E22]',
  exported: 'bg-[#2ECC71]/20 text-[#2ECC71]',
  cancelled: 'bg-inky/15 text-inky',
}

/**
 * Module landing page. Not a wizard entry point — it's the home for every
 * draft regardless of status, in one sortable, color-coded table (see
 * STATUS_COLOR above) rather than a separate tab per step. Clicking any row
 * reopens it exactly where it was left — including a completed order, which
 * reopens on the Export step fully editable, same as before it was
 * completed (see statusRoute in shared.ts and useOrderHistory.ts's
 * markDraftComplete for why nothing about a draft ever locks).
 */
export function OrdersV2Landing() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const loc = useLocations()
  const { settings } = useOrderSettings()
  const { drafts, loading, createDraft, deleteDraft } = useDrafts()
  const vendors = useVendors()
  const names = useUserNames()
  const rd = useRdReports()
  const [statsDraft, setStatsDraft] = useState<DraftRow | null>(null)
  const [soOpen, setSoOpen] = useState(false)
  const [ioOpen, setIoOpen] = useState(false)

  const [startOpen, setStartOpen] = useState(false)
  const [vendorId, setVendorId] = useState('')
  // A SegmentedSlider always highlights SOME option (unlike a dropdown, it
  // has no blank/placeholder state) — defaults to the first vendor rather
  // than showing a slider with nothing selected. vendorId itself stays ''
  // until the user actually touches it; every read below goes through this
  // instead, same "sensible default, not blank" idea as orderDow already
  // defaulting to today's weekday.
  const effectiveVendorId = vendorId || vendors.orderableOptions[0]?.value || ''
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Which weekday's shops to pull in. Defaults to the order date's own
  // weekday, but can be pointed elsewhere without moving the order date.
  const [orderDow, setOrderDow] = useState<number>(() => new Date().getDay())
  const [starting, setStarting] = useState(false)
  const coverage = useOrderDayCoverage(vendors.byId(effectiveVendorId || null)?.name)
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
  const isMighty = vendors.isMighty(effectiveVendorId)
  const [mightyTargetDays, setMightyTargetDays] = useState(21)
  const [mightyLeadTimeDays, setMightyLeadTimeDays] = useState(3)

  // One aggregate query for every draft's products/gallons/cost, regardless
  // of status — completed drafts need this too now that they share the
  // same table as everything else.
  const draftIds = useMemo(() => drafts.map((d) => d.id), [drafts])
  const aggregates = useDraftAggregates(draftIds)

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
    const id = await createDraft(effectiveVendorId || null, orderDate, settings, orderDow, adHocIds, mightyOptions)
    setStarting(false)
    if (id) { setStartOpen(false); navigate(`/orders-v2/draft/${id}`) }
  }

  const col = useMemo(() => createColumnHelper<DraftRow>(), [])
  const columns = useMemo(() => [
    col.accessor((d) => vendorName(d.vendor_id), { id: 'vendor', header: 'Vendor' }),
    col.accessor('order_date', { id: 'order_date', header: 'Order Date', cell: (i) => dShort(i.getValue()) }),
    col.accessor('status', {
      id: 'status', header: 'Status',
      cell: (i) => <span className={`rounded-full px-2 py-0.5 text-[11px] font-heading uppercase tracking-wide ${STATUS_COLOR[i.getValue()]}`}>{STATUS_LABEL[i.getValue()]}</span>,
    }),
    col.display({
      id: 'shops', header: 'Shops', enableSorting: false,
      cell: (i) => (i.row.original.settings_snapshot as any)?.__shop_count ?? '—',
    }),
    col.accessor((d) => orderDayLabel(d.settings_snapshot), { id: 'order_day', header: 'Order Day' }),
    col.display({ id: 'products', header: 'Products', enableSorting: false, cell: (i) => aggregates[i.row.original.id]?.products ?? '—' }),
    col.display({ id: 'gallons', header: 'Gallons', enableSorting: false, cell: (i) => gallons(aggregates[i.row.original.id]?.gallons) }),
    col.display({ id: 'cost', header: 'Cost', enableSorting: false, cell: (i) => <span className="text-right block">{money(aggregates[i.row.original.id]?.cost)}</span> }),
    col.accessor('updated_at', { id: 'updated_at', header: 'Last Edited', cell: (i) => dTime(i.getValue()) }),
    col.accessor((d) => names.nameOf(d.last_edited_by ?? d.created_by), { id: 'by', header: 'By' }),
  ], [col, vendors, aggregates, names])

  const ORDERS_V2_LANDING_TABLE_KEY = 'orders-v2.landing'
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } = useTable(drafts, columns, {
    persistKey: ORDERS_V2_LANDING_TABLE_KEY,
    initialSorting: [{ id: 'updated_at', desc: true }],
    initialPageSize: 50,
  })
  // Found live 2026-09-30: column widths (and order/visibility/pinning)
  // reset on every reload — this table called useTable but never actually
  // wired useColumnPrefs, the hook that persists that state to localStorage
  // + platform.user_profiles.column_prefs. Every other DataTable in this
  // app (Orders v2 Review, Exception Reporting, etc.) calls both together;
  // this one only ever had the first half.
  useColumnPrefs(ORDERS_V2_LANDING_TABLE_KEY, table, columnVisibility, columnOrder, setColumnOrder)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Orders v2</h1>
          <p className="text-xs text-inky mt-0.5">
            Generate proposed orders from on-hand and usage, review and adjust, then export per vendor.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => navigate('/orders-v2/settings')}>Order Settings</Button>
      </div>

      {/* Direct ask 2026-09-29, redone 2026-09-30 (three times): a single
          SVG rounded-rect stroke sharing the button's own corner radius,
          offset outside it — hover-gated again per the latest follow-up
          (a continuous ambient loop was tried in between and reverted; see
          ov2-start-order-trace in index.css for the actual .group:hover
          animation trigger). The glow was getting clipped square at the
          SVG's own edge (an SVG's default overflow is hidden, unlike a
          plain HTML element) — overflow-visible plus a bigger margin
          around the rect fixes that regardless of blur radius, rather than
          removing the glow. */}
      <div className="group relative inline-block self-start">
        <Button size="sm" onClick={() => setStartOpen(true)} className="relative z-10 rounded-lg">
          {/* Drop the "+" overlaid inside the droplet — it's a small
              superscript badge poking out past its top-right edge instead. */}
          <span className="relative inline-flex w-5 h-5 mr-0.5 flex-shrink-0">
            <Droplet className="w-5 h-5" />
            <Plus className="w-2.5 h-2.5 absolute -top-1 -right-1" strokeWidth={3.5} />
          </span>
          Start New Order
        </Button>
        <svg className="pointer-events-none absolute -inset-3.5 w-[calc(100%+28px)] h-[calc(100%+28px)] overflow-visible" aria-hidden="true">
          <rect
            x="12" y="12" rx="11"
            style={{ width: 'calc(100% - 24px)', height: 'calc(100% - 24px)' }}
            fill="none" stroke="#2ECC71" strokeWidth="3" pathLength={100}
            className="ov2-start-order-trace drop-shadow-[0_0_4px_rgba(46,204,113,0.7)]"
          />
        </svg>
      </div>

      <Tabs defaultValue="orders">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <TabsList>
            <TabsTrigger value="orders">Orders ({drafts.length})</TabsTrigger>
            <TabsTrigger value="products_ordered">Products Ordered</TabsTrigger>
            <TabsTrigger value="rd_reports">RD Reports</TabsTrigger>
            <TabsTrigger value="valvoline_db">Valvoline Order Database</TabsTrigger>
          </TabsList>
          {/* Direct ask 2026-09-29: the RD report upload buttons move onto
              this same row instead of living inside the RD Reports tab. */}
          <div className="flex items-start gap-2">
            <RdReportButton label="Open Sales Order Report" lastUploadedAt={rd.lastOpenOrdersAt} onClick={() => setSoOpen(true)} />
            <RdReportButton label="Open Invoice Report" lastUploadedAt={rd.lastOpenInvoicesAt} onClick={() => setIoOpen(true)} />
          </div>
        </div>

        <TabsContent value="orders">
          {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : drafts.length === 0 ? (
              <p className="text-xs font-mono text-inky/60 py-8">
                No orders yet. "Start New Order" creates one immediately — it's saved server-side, so you can leave
                and pick it back up here.
              </p>
            ) : (
              <DataTable
                table={table}
                globalFilter={globalFilter}
                onGlobalFilterChange={setGlobalFilter}
                onRowClick={(d) => setStatsDraft(d)}
              />
            )}
        </TabsContent>

        <TabsContent value="products_ordered">
          <ProductsOrderedTab />
        </TabsContent>

        <TabsContent value="rd_reports">
          <RdReportsTab />
        </TabsContent>

        <TabsContent value="valvoline_db">
          <ValvolineOrderDatabaseTab />
        </TabsContent>
      </Tabs>

      <Modal open={startOpen} onClose={() => setStartOpen(false)} title="Start New Order" size="lg">
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-0.5">
            <span className="text-[11px] font-mono text-inky/60">Vendor</span>
            <SegmentedSlider
              value={effectiveVendorId}
              onChange={setVendorId}
              options={vendors.orderableOptions.map((o) => ({ value: o.value, label: o.label }))}
            />
          </label>
          <Input label="Order Date" type="date" value={orderDate} onChange={(e) => pickDate(e.target.value)} />

          {/* Direct ask 2026-09-30: everything below Order Date pops in
              abruptly as the vendor toggle changes which fields/text
              render — AnimatedHeight smooths the resize into a calm slide
              instead of an instant layout jump, and reacts to ANY height
              change here (not just a vendor switch), so the shop-count
              message swapping length etc. is smoothed too. */}
          <AnimatedHeight className="flex flex-col gap-3">
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
              {/* Mon-Fri sliding picker, same component/animation as the DOS
                  Targets box's own order-day slider (Review page) — direct
                  ask 2026-09-29. Business orders don't run Sun/Sat. */}
              <label className="flex flex-col gap-0.5">
                <span className="text-[11px] font-mono text-inky/60">Order day (which shops to include)</span>
                <SegmentedSlider
                  value={String(orderDow >= 1 && orderDow <= 5 ? orderDow : 1)}
                  onChange={(v) => setOrderDow(Number(v))}
                  options={[1, 2, 3, 4, 5].map((i) => ({ value: String(i), label: `${DOW[i].slice(0, 3)} (${coverage.counts[i]})` }))}
                />
              </label>
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
          </AnimatedHeight>

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

      {statsDraft && (
        <OrderStatsModal
          draftId={statsDraft.id}
          vendorId={statsDraft.vendor_id}
          settingsSnapshot={statsDraft.settings_snapshot}
          open={!!statsDraft}
          onClose={() => setStatsDraft(null)}
          editPath={statusRoute(statsDraft)}
          onDelete={statsDraft.status !== 'exported' ? () => {
            if (confirm('Delete this draft order? Its lines are removed too.')) { deleteDraft(statsDraft.id); setStatsDraft(null) }
          } : undefined}
        />
      )}
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
