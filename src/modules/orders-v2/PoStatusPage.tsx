// Purchase Order status — reads inventory.droptop_purchase_orders /
// droptop_purchase_order_items (see supabase/functions/droptop-sync-
// purchase-orders). Deliberately its own page, not folded into Orders v2's
// own routes — "on PO" is operational information people need to check
// regardless of whether they're mid-way through building a new order.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, ChevronDown, ChevronRight } from 'lucide-react'
import { Button, Card, CardBody, Combobox, Input, Select, SbLoader, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { runDroptopPurchaseOrderSync } from '@/services/droptopService'
import { useSyncTasksStore, DROPTOP_PO_SYNC_TASK_ID } from '@/stores/syncTasksStore'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

interface PoItemRow {
  id: string
  purchase_order_item_type: string | null
  inventory_id: string | null
  product_id: string | null
  name: string | null
  quantity: number | null
  unit_cost: number | null
  received_quantity: number | null
  back_ordered_quantity: number | null
  remaining_quantity: number | null
  total_cost: number | null
  purchase_uom: string | null
  sell_uom: string | null
}
interface PoRow {
  id: string
  location_id: string | null
  po_id: string
  custom_po_id: string | null
  supplier_name: string | null
  po_status: string | null
  approved_status: string | null
  delivery_status: string | null
  delivery_status_updated_timestamp: string | null
  pay_status: string | null
  total_cost: number | null
  note: string | null
  last_updated_user_name: string | null
  created_timestamp: string | null
  closed_timestamp: string | null
  last_updated_timestamp: string | null
  to_receive_timestamp: string | null
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'closed', label: 'Closed' },
  { value: 'cancelled', label: 'Cancelled' },
]

const dShort = (iso: string | null) => { if (!iso) return '—'; try { return format(new Date(iso), 'MMM d, yyyy') } catch { return '—' } }
const dTime = (iso: string | null) => { if (!iso) return '—'; try { return format(new Date(iso), 'MMM d · h:mm a') } catch { return '—' } }
const money = (v: number | null) => (v == null ? '—' : v.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }))
const num = (v: number | null) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }))

// Known values from Droptop; anything else still renders (title-cased, not
// swallowed) rather than falling back to a raw/blank value.
const DELIVERY_STATUS_LABELS: Record<string, string> = {
  fully_received: 'Fully Received',
  partially_received: 'Partially Received',
  backordered: 'Backordered',
}
function deliveryStatusLabel(v: string | null): string {
  if (!v) return 'None'
  const key = v.toLowerCase().trim().replace(/[\s-]+/g, '_')
  return DELIVERY_STATUS_LABELS[key] ?? v.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

// Still outstanding on this line — Droptop's own remaining_quantity when
// it's provided; otherwise quantity minus whatever's been received so far.
// A line with no received_quantity at all (null, not 0) hasn't been touched
// yet, so its full quantity counts as outstanding.
function outstandingQty(it: PoItemRow): number {
  if (it.remaining_quantity != null) return Number(it.remaining_quantity)
  return Math.max(0, Number(it.quantity ?? 0) - Number(it.received_quantity ?? 0))
}

const OPEN_STATUSES = new Set(['draft', 'sent', 'accepted'])

export function PoStatusPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()

  const [pos, setPos] = useState<PoRow[]>([])
  const [itemsByPo, setItemsByPo] = useState<Record<string, PoItemRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [inspecting, setInspecting] = useState(false)
  // Multi-select on purpose — comparing several POs' line items side by
  // side is the actual use case. The real bug behind "items look wrong"
  // wasn't multiple rows being open (see load()'s fetchAllRows fix above),
  // so there's no need to trade away that comparison workflow for it.
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // Derived from the global sync tracker (not local state) so the button
  // correctly reflects "is my sync still running" even if this page got
  // evicted from the Recent Pages cache and remounted while it was going —
  // see syncTasksStore.ts.
  const syncing = useSyncTasksStore((s) => s.tasks.find((t) => t.id === DROPTOP_PO_SYNC_TASK_ID)?.status === 'running')

  const [fLocation, setFLocation] = useState('')
  const [fStatus, setFStatus] = useState('')
  const [fSearch, setFSearch] = useState('')
  const [hideClosed, setHideClosed] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    // PostgREST caps an un-ranged select at 1000 rows by default — silently,
    // no error. Applied to both queries here: the PO count alone might fit
    // under that, but ~3 items/PO puts the item rows well past it, so most
    // POs' items were getting silently dropped (the exact same bug already
    // root-caused once this session, in LocationLookupPage.tsx — same fix).
    const fetchAllRows = async <T,>(table: string, apply: (q: any) => any): Promise<T[]> => {
      const out: T[] = []
      const PAGE = 1000
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await apply(sb.schema('inventory').from(table).select('*')).range(from, from + PAGE - 1)
        if (error) throw error
        const batch = (data ?? []) as T[]
        out.push(...batch)
        if (batch.length < PAGE) break
      }
      return out
    }

    let poRows: PoRow[]
    try {
      poRows = await fetchAllRows<PoRow>('droptop_purchase_orders', (q) =>
        q.eq('company_id', companyId).order('created_timestamp', { ascending: false }))
    } catch (error: any) {
      toast.error(error.message?.includes('does not exist') ? 'Purchase order tables not found — apply migration 20260829_droptop_purchase_orders.sql' : error.message)
      setLoading(false)
      return
    }
    setPos(poRows)
    if (poRows.length) {
      // Filtered by company_id directly (a single value, not an .in() list
      // of every PO id) — avoids also risking a URL-length limit once the
      // PO count grows past a couple hundred.
      const itemRows = await fetchAllRows<PoItemRow & { purchase_order_id: string }>(
        'droptop_purchase_order_items', (q) => q.eq('company_id', companyId),
      )
      const grouped: Record<string, PoItemRow[]> = {}
      for (const it of itemRows) (grouped[it.purchase_order_id] ??= []).push(it)
      setItemsByPo(grouped)
    } else {
      setItemsByPo({})
    }
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])
  // Deliberately no usePageRevisit here (unlike Comms/Alerts/Exceptions) —
  // this data only changes when a sync runs, not from other users clicking
  // around, so an automatic refetch every time you switch back to this
  // browser tab was just a disruptive reload with nothing new to show for
  // it. Sync Now (and its own load() afterward) is the actual refresh path.

  async function syncNow() {
    if (syncing) return
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_PO_SYNC_TASK_ID, 'Droptop — Purchase Orders')
    try {
      const r = await runDroptopPurchaseOrderSync(
        { daysBack: 180 }, companyId ?? undefined,
        (p) => store.setProgress(DROPTOP_PO_SYNC_TASK_ID, p.batch, p.totalBatches),
      )
      const summary = `${r.locations_synced} shop${r.locations_synced !== 1 ? 's' : ''}, ${r.pos_upserted} PO${r.pos_upserted !== 1 ? 's' : ''}, ${r.items_written} line item${r.items_written !== 1 ? 's' : ''}`
      store.finish(DROPTOP_PO_SYNC_TASK_ID, r.warnings?.length ? 'error' : 'success', r.warnings?.length ? r.warnings[0] : summary)
      if (r.warnings?.length) toast.error(r.warnings[0], { duration: 12000 })
      else toast.success(summary)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Sync failed'
      store.finish(DROPTOP_PO_SYNC_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    }
  }

  // Read-only single-location peek at Droptop's raw get-purchase-orders
  // response — for diagnosing a real sync that completes but writes nothing
  // (a response-shape mismatch) without waiting through another full,
  // multi-minute company-wide sync to find out. Logs to the console, writes
  // nothing.
  async function inspectOne() {
    setInspecting(true)
    try {
      const { data, error } = await supabase.functions.invoke('droptop-sync-purchase-orders', { body: { mode: 'inspect' } })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      // eslint-disable-next-line no-console
      console.log('Droptop PO inspect result:', data)
      toast.success(`Inspect complete — logged to the browser console (F12). ${data.parsed_sample?.length ?? 0} PO(s) parsed.`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Inspect failed')
    } finally {
      setInspecting(false)
    }
  }

  const shopLabel = useCallback((id: string | null) => (id ? (loc.codeOf(id) || loc.labelOf(id)) : '—') || '—', [loc])

  const visible = useMemo(() => {
    const q = fSearch.trim().toLowerCase()
    return pos.filter((p) => {
      if (fLocation && p.location_id !== fLocation) return false
      if (fStatus) { if (p.po_status !== fStatus) return false }
      else if (hideClosed && (p.po_status === 'closed' || p.po_status === 'cancelled')) return false
      if (q) {
        const items = itemsByPo[p.id] ?? []
        const hay = `${p.po_id} ${p.custom_po_id ?? ''} ${p.supplier_name ?? ''} ${shopLabel(p.location_id)} ${items.map((i) => `${i.product_id ?? ''} ${i.name ?? ''}`).join(' ')}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  }, [pos, itemsByPo, fLocation, fStatus, fSearch, hideClosed, shopLabel])

  // Every product still outstanding on an open PO, grouped by shop — the
  // "what's already on order" view, independent of which specific PO it
  // came from.
  const onOrderByShop = useMemo(() => {
    const m = new Map<string, { product_id: string; qty: number; poIds: Set<string> }[]>()
    for (const p of pos) {
      if (!OPEN_STATUSES.has(p.po_status ?? '')) continue
      const items = itemsByPo[p.id] ?? []
      for (const it of items) {
        if (!it.product_id) continue
        const qty = outstandingQty(it)
        if (qty <= 0) continue
        const key = p.location_id ?? ''
        const list = m.get(key) ?? []
        const existing = list.find((r) => r.product_id === it.product_id)
        if (existing) { existing.qty += qty; existing.poIds.add(p.po_id) }
        else list.push({ product_id: it.product_id, qty, poIds: new Set([p.po_id]) })
        m.set(key, list)
      }
    }
    return m
  }, [pos, itemsByPo])

  const locationOptions = [{ value: '', label: 'All shops' }, ...loc.options]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">PO Status</h1>
          <p className="text-xs text-inky mt-0.5">
            Purchase orders pulled from Droptop — status, line items, and what's still outstanding by shop.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={inspectOne} disabled={inspecting || syncing} loading={inspecting}
            title="Read-only peek at one location's raw Droptop response, logged to the browser console — writes nothing">
            Inspect
          </Button>
          <Button size="sm" variant="secondary" onClick={syncNow} disabled={syncing}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing… (see status ↑ in top bar)' : 'Sync Now'}
          </Button>
        </div>
      </div>

      <Card><CardBody className="flex items-end gap-3 flex-wrap py-3">
        <div className="w-56"><Combobox label="Shop" options={locationOptions} value={fLocation} onChange={setFLocation} /></div>
        <div className="w-44">
          <Select label="Status" value={fStatus} onChange={(e) => setFStatus(e.target.value)} options={STATUS_OPTIONS} />
        </div>
        <Input label="Search" placeholder="PO #, product, supplier…" value={fSearch} onChange={(e) => setFSearch(e.target.value)} className="w-56" />
        {!fStatus && (
          <label className="flex items-center gap-2 text-xs font-mono text-inky pb-2">
            <Toggle checked={hideClosed} onChange={setHideClosed} size="sm" color="cyan" />
            Hide closed/cancelled
          </label>
        )}
        <span className="text-[11px] font-mono text-inky/50 pb-2 ml-auto">{visible.length} of {pos.length} PO{pos.length !== 1 ? 's' : ''}</span>
      </CardBody></Card>

      {loading ? (
        <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
      ) : visible.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-8">
          No purchase orders {pos.length === 0 ? '— run Sync Now, or check Data Connections → Droptop — Purchase Orders is configured.' : 'match these filters.'}
        </p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="text-left px-2 py-2">PO #</th>
              <th className="text-left px-2 py-2">Shop</th>
              <th className="text-left px-2 py-2">Supplier</th>
              <th className="text-left px-2 py-2">Status</th>
              <th className="text-left px-2 py-2">Delivery Status</th>
              <th className="text-left px-2 py-2">Delivery Updated</th>
              <th className="text-left px-2 py-2">Closed</th>
              <th className="text-left px-2 py-2">Created</th>
              <th className="text-left px-2 py-2">Last Updated</th>
              <th className="text-right px-2 py-2">Total</th>
              <th />
            </tr></thead>
            <tbody>
              {visible.map((p) => {
                const items = itemsByPo[p.id] ?? []
                const open = expanded.has(p.id)
                return (
                  <Fragment key={p.id}>
                    <tr className={`border-b border-navy/15 hover:bg-sky/10 cursor-pointer ${open ? 'bg-sky/[0.08]' : ''}`}
                      onClick={() => setExpanded((prev) => { const n = new Set(prev); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })}>
                      <td className="px-2 py-1.5 text-navy whitespace-nowrap">
                        <span className="inline-flex items-center gap-1">
                          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                          {p.custom_po_id || p.po_id}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-navy">{shopLabel(p.location_id)}</td>
                      <td className="px-2 py-1.5 text-navy">{p.supplier_name ?? '—'}</td>
                      <td className="px-2 py-1.5">
                        <span className="rounded-full bg-sky/25 text-navy px-2 py-0.5 capitalize">{p.po_status ?? '—'}</span>
                      </td>
                      <td className="px-2 py-1.5 text-navy whitespace-nowrap">{deliveryStatusLabel(p.delivery_status)}</td>
                      <td className="px-2 py-1.5 text-navy">{dShort(p.delivery_status_updated_timestamp)}</td>
                      <td className="px-2 py-1.5 text-navy">{dShort(p.closed_timestamp)}</td>
                      <td className="px-2 py-1.5 text-navy">{dShort(p.created_timestamp)}</td>
                      <td className="px-2 py-1.5 text-navy">{dTime(p.last_updated_timestamp)}{p.last_updated_user_name ? ` · ${p.last_updated_user_name}` : ''}</td>
                      <td className="px-2 py-1.5 text-right text-navy">{money(p.total_cost)}</td>
                      <td />
                    </tr>
                    {open && (
                      <tr className="border-b border-navy/15 bg-navy/[0.02]">
                        <td colSpan={11} className="px-3 py-2 border-l-2 border-sky">
                          <p className="text-[10px] font-mono uppercase tracking-widest text-inky/50 mb-1">
                            Line items — {p.custom_po_id || p.po_id}
                          </p>
                          {p.note && <p className="text-[11px] font-mono text-inky/60 mb-2">Note: {p.note}</p>}
                          <table className="w-full text-[11px] font-mono">
                            <thead><tr className="text-inky/60 uppercase">
                              <td className="py-1">Product</td><td>UOM</td>
                              <td className="text-right">Qty</td><td className="text-right">Received</td>
                              <td className="text-right">Outstanding</td><td className="text-right">Unit Cost</td><td className="text-right">Total</td>
                            </tr></thead>
                            <tbody>
                              {items.map((it) => (
                                <tr key={it.id} className="border-t border-navy/10">
                                  <td className="py-1 text-navy">{it.product_id ?? it.name ?? '—'}</td>
                                  <td className="text-inky/70">{it.purchase_uom ?? '—'}</td>
                                  <td className="text-right text-inky/70">{num(it.quantity)}</td>
                                  <td className="text-right text-inky/70">{num(it.received_quantity)}</td>
                                  <td className="text-right text-navy">{num(outstandingQty(it))}</td>
                                  <td className="text-right text-inky/70">{money(it.unit_cost)}</td>
                                  <td className="text-right text-navy">{money(it.total_cost)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Product-level rollup — what's on order per shop, regardless of
          which PO it's spread across. This is the same figure Orders v2's
          "already covered" exclusion will read once that's wired up. */}
      {onOrderByShop.size > 0 && (
        <Card><CardBody className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Products currently on order, by shop</span>
          <div className="overflow-auto max-h-72 rounded border border-navy/20">
            <table className="w-full text-[11px] font-mono">
              <thead><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">Product</th>
                <th className="text-right px-2 py-1">Outstanding Qty</th><th className="text-left px-2 py-1">PO #</th>
              </tr></thead>
              <tbody>
                {[...onOrderByShop.entries()].flatMap(([locId, rows]) =>
                  rows.map((r) => (
                    <tr key={`${locId}|${r.product_id}`} className="border-b border-navy/10">
                      <td className="px-2 py-1 text-navy">{shopLabel(locId || null)}</td>
                      <td className="px-2 py-1 text-navy">{r.product_id}</td>
                      <td className="px-2 py-1 text-right text-navy">{num(r.qty)}</td>
                      <td className="px-2 py-1 text-inky/60">{[...r.poIds].join(', ')}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}
    </div>
  )
}
