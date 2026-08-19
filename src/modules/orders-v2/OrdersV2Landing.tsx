import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Trash2 } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Modal, SbLoader, Select, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { useLocations } from '@/hooks/useLocations'
import { useAuthStore } from '@/stores/authStore'
import { useDrafts, useOrderSettings, useOrderDayCoverage, type DraftRow } from './useOrdersV2'
import { useOrderHistory } from './useOrderHistory'
import { useVendors, useUserNames } from './useLookups'
import { STATUS_LABEL, statusRoute, money, dShort, dTime } from './shared'

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

  const [startOpen, setStartOpen] = useState(false)
  const [vendorId, setVendorId] = useState('')
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10))
  // Which weekday's shops to pull in. Defaults to the order date's own
  // weekday, but can be pointed elsewhere without moving the order date.
  const [orderDow, setOrderDow] = useState<number>(() => new Date().getDay())
  const [starting, setStarting] = useState(false)
  const coverage = useOrderDayCoverage(vendors.byId(vendorId || null)?.name)

  // Shared filters across both lists.
  const [fVendor, setFVendor] = useState('')
  const [fFrom, setFFrom] = useState('')
  const [fTo, setFTo] = useState('')
  const [fUser, setFUser] = useState('')

  const inProgress = useMemo(
    () => drafts.filter((d) => d.status !== 'exported' && d.status !== 'cancelled'),
    [drafts],
  )

  const matches = (vendor: string | null, date: string, users: (string | null)[]) =>
    (!fVendor || vendor === fVendor) &&
    (!fFrom || date >= fFrom) &&
    (!fTo || date <= fTo) &&
    (!fUser || users.includes(fUser))

  const visibleDrafts = inProgress.filter((d) => matches(d.vendor_id, d.order_date, [d.created_by, d.last_edited_by]))
  const visibleOrders = orders.filter((o) => matches(o.vendor_id, o.order_date, [o.finalized_by]))

  const vendorName = (id: string | null) => vendors.byId(id)?.name ?? '—'

  function pickDate(v: string) {
    setOrderDate(v)
    if (v) setOrderDow(new Date(v + 'T00:00:00').getDay())
  }

  async function start() {
    setStarting(true)
    const id = await createDraft(vendorId || null, orderDate, settings, orderDow)
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
        <div className="flex items-center gap-2">
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

      <Tabs defaultValue="drafts">
        <TabsList>
          <TabsTrigger value="drafts">In Progress ({visibleDrafts.length})</TabsTrigger>
          <TabsTrigger value="done">Completed ({visibleOrders.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="drafts">
          {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : visibleDrafts.length === 0 ? (
              <p className="text-xs font-mono text-inky/60 py-8">
                No orders in progress. "Start New Order" creates one immediately — it's saved server-side, so you can
                leave and pick it back up here.
              </p>
            ) : (
              <div className="overflow-auto rounded border border-navy/30">
                <table className="w-full text-xs font-mono">
                  <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                    <Th>Vendor</Th><Th>Order Date</Th><Th>Shops</Th><Th>Step</Th><Th>Last Edited</Th><Th>By</Th><Th />
                  </tr></thead>
                  <tbody>
                    {visibleDrafts.map((d) => (
                      <tr key={d.id} className="border-b border-navy/15 hover:bg-sky/10 cursor-pointer"
                        onClick={() => navigate(statusRoute(d))}>
                        <Td>{vendorName(d.vendor_id)}</Td>
                        <Td>{dShort(d.order_date)}</Td>
                        <Td><ShopCount draft={d} loc={loc} /></Td>
                        <Td><span className="rounded-full bg-sky/25 text-navy px-2 py-0.5">{STATUS_LABEL[d.status]}</span></Td>
                        <Td>{dTime(d.updated_at)}</Td>
                        <Td>{names.nameOf(d.last_edited_by ?? d.created_by)}</Td>
                        <Td>
                          <button title="Delete draft"
                            onClick={(e) => { e.stopPropagation(); if (confirm('Delete this draft order? Its lines are removed too.')) deleteDraft(d.id) }}
                            className="text-inky/40 hover:text-[#C0392B]"><Trash2 className="w-3.5 h-3.5" /></button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </TabsContent>

        <TabsContent value="done">
          {histLoading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
            : visibleOrders.length === 0 ? <p className="text-xs font-mono text-inky/60 py-8">No completed orders yet.</p>
            : (
              <div className="overflow-auto rounded border border-navy/30">
                <table className="w-full text-xs font-mono">
                  <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                    <Th>Vendor</Th><Th>Order Date</Th><Th>Shops</Th><Th>Lines</Th><Th align="right">Total</Th><Th>Export</Th><Th>Finalized</Th><Th>By</Th>
                  </tr></thead>
                  <tbody>
                    {visibleOrders.map((o) => (
                      <tr key={o.id} className="border-b border-navy/15 hover:bg-sky/10 cursor-pointer"
                        onClick={() => navigate(`/orders-v2/history/${o.id}`)}>
                        <Td>{vendorName(o.vendor_id)}</Td>
                        <Td>{dShort(o.order_date)}</Td>
                        <Td>{o.location_count}</Td>
                        <Td>{o.line_count}</Td>
                        <Td align="right">{money(o.total_dollars)}</Td>
                        <Td>
                          {o.export_status}
                          {o.export_count > 1 && <span className="text-inky/50"> ×{o.export_count}</span>}
                          {o.edited_after_finalize && <span className="ml-1 text-[#E67E22]" title="Edited after finalizing">✎</span>}
                        </Td>
                        <Td>{dTime(o.finalized_at)}</Td>
                        <Td>{names.nameOf(o.finalized_by)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </TabsContent>
      </Tabs>

      <Modal open={startOpen} onClose={() => setStartOpen(false)} title="Start New Order" size="sm">
        <div className="flex flex-col gap-3">
          <Combobox label="Vendor" options={vendors.options} value={vendorId} onChange={setVendorId} placeholder="Select vendor…" />
          <Input label="Order Date" type="date" value={orderDate} onChange={(e) => pickDate(e.target.value)} />

          {coverage.applies ? (
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
            <Button size="sm" loading={starting} disabled={!profile?.company_id} onClick={start}>Create Draft</Button>
          </div>
        </div>
      </Modal>
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
