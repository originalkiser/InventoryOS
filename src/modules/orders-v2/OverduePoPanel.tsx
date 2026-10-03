// "Should have delivered by now" on the RD Reports tab (direct ask 2026-10-03): overdue open RelaDyne POs, one
// row per PO (click to see its items), with multi-select, shop + order-date + status filters, a persisted
// per-PO status (ignored / emailed / skipped — see rdPoCheck.ts, useRdPoCheckStatus.ts), bulk "set status" for
// mass clean-up ("everything ordered before <date> -> ignored"), and the PO Delivery Check-In email flow.
import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Mail } from 'lucide-react'
import { Button, Modal, MultiSelectDropdown, SbLoader } from '@/components/ui'
import { dShort, num } from './shared'
import { useRdPoCheckStatus } from './useRdPoCheckStatus'
import { PoCheckInEmailModal, type PoEmailTarget } from './PoCheckInEmailModal'
import { emailQueue, queueByShop, localIsoDaysAgo, type OverduePoGroup, type PoCheckStatus } from './rdPoCheck'

const PAGE_SIZE = 50
const todayIso = () => localIsoDaysAgo(0)

type StatusFilter = 'active' | 'ignored' | 'emailed' | 'skipped' | 'all'
type BulkAction = '' | 'ignored' | 'emailed' | 'skipped' | 'clear'

const FIELD = 'bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky'

function StatusBadge({ status, skipCount }: { status: PoCheckStatus | undefined; skipCount: number }) {
  if (!status) return <span className="text-inky/30">—</span>
  const cls = status === 'ignored' ? 'border-inky/40 text-inky/70'
    : status === 'emailed' ? 'border-[#2ECC71]/60 text-[#2ECC71]'
    : 'border-[#E67E22]/60 text-[#E67E22]'
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide whitespace-nowrap ${cls}`}>
      {status === 'skipped' ? `skipped${skipCount > 1 ? ` ×${skipCount}` : ''}` : status}
    </span>
  )
}

export function OverduePoPanel({ groups, shopLabel }: { groups: OverduePoGroup[]; shopLabel: (id: string | null) => string }) {
  const { byKey: statusByKey, loading: statusLoading, setStatus } = useRdPoCheckStatus()
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [shops, setShops] = useState<string[]>([])
  const [orderedFrom, setOrderedFrom] = useState('')
  const [orderedTo, setOrderedTo] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [bulk, setBulk] = useState<BulkAction>('')
  const [applying, setApplying] = useState(false)

  // Email setup (date window defaults to the last 7 days and re-computes every day it's opened).
  const [emailSetupOpen, setEmailSetupOpen] = useState(false)
  const [mailFrom, setMailFrom] = useState(() => localIsoDaysAgo(7))
  const [mailTo, setMailTo] = useState(todayIso)
  const [onlySelected, setOnlySelected] = useState(false)
  const [emailTargets, setEmailTargets] = useState<PoEmailTarget[] | null>(null)

  const shopOptions = useMemo(
    () => [...new Set(groups.map((g) => shopLabel(g.locationId)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map((value) => ({ value })),
    [groups, shopLabel],
  )

  const counts = useMemo(() => {
    const c = { active: 0, ignored: 0, emailed: 0, skipped: 0 }
    for (const g of groups) {
      const st = statusByKey.get(g.key)?.status
      if (st === 'ignored') c.ignored++
      else { c.active++; if (st === 'emailed') c.emailed++; if (st === 'skipped') c.skipped++ }
    }
    return c
  }, [groups, statusByKey])

  const filtered = useMemo(() => groups.filter((g) => {
    const st = statusByKey.get(g.key)?.status
    if (statusFilter === 'active' && st === 'ignored') return false
    if (statusFilter === 'ignored' && st !== 'ignored') return false
    if (statusFilter === 'emailed' && st !== 'emailed') return false
    if (statusFilter === 'skipped' && st !== 'skipped') return false
    if (shops.length && !shops.includes(shopLabel(g.locationId))) return false
    if (orderedFrom && (g.orderDate ?? '') < orderedFrom) return false
    if (orderedTo && (g.orderDate ?? '') > orderedTo) return false
    return true
  }), [groups, statusByKey, statusFilter, shops, orderedFrom, orderedTo, shopLabel])

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE)

  const selectedFilteredCount = filtered.filter((g) => selected.has(g.key)).length
  const allFilteredSelected = filtered.length > 0 && selectedFilteredCount === filtered.length
  const toggleAllFiltered = () => setSelected((prev) => {
    const n = new Set(prev)
    if (allFilteredSelected) for (const g of filtered) n.delete(g.key)
    else for (const g of filtered) n.add(g.key)
    return n
  })
  const toggleOne = (key: string) => setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const toggleExpand = (key: string) => setExpanded((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const clearFilters = () => { setShops([]); setOrderedFrom(''); setOrderedTo(''); setStatusFilter('active'); setPage(0) }
  const filtersActive = shops.length > 0 || orderedFrom !== '' || orderedTo !== '' || statusFilter !== 'active'

  async function applyBulk() {
    if (!bulk) return
    const targets = groups.filter((g) => selected.has(g.key)).map((g) => ({ key: g.key, locationId: g.locationId, orderDate: g.orderDate }))
    if (!targets.length) return
    setApplying(true)
    const ok = await setStatus(targets, bulk === 'clear' ? null : bulk, { incrementSkip: bulk === 'skipped' })
    setApplying(false)
    if (ok) { setSelected(new Set()); setBulk('') }
  }

  // The email queue: POs ordered in the window that aren't ignored/already emailed; limited to the shop filter
  // and, optionally, the selected rows.
  const queue = useMemo(() => {
    const shopScoped = shops.length ? groups.filter((g) => shops.includes(shopLabel(g.locationId))) : groups
    return emailQueue(shopScoped, statusByKey, mailFrom, mailTo, onlySelected && selected.size ? selected : null)
  }, [groups, statusByKey, shops, shopLabel, mailFrom, mailTo, onlySelected, selected])
  const queueShops = useMemo(() => queueByShop(queue, shopLabel), [queue, shopLabel])

  function openEmailSetup() {
    setMailFrom(localIsoDaysAgo(7)); setMailTo(todayIso()); setOnlySelected(selected.size > 0)
    setEmailSetupOpen(true)
  }

  if (groups.length === 0) return null

  return (
    <div className="rounded border border-[#C0392B]/40 bg-[#C0392B]/5 flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-[#C0392B]">
          Should have delivered by now — {counts.active} PO{counts.active === 1 ? '' : 's'}
          {counts.ignored > 0 && <span className="text-inky/60 normal-case tracking-normal"> · {counts.ignored} ignored</span>}
        </span>
        <Button size="sm" onClick={openEmailSetup}><Mail className="w-3.5 h-3.5 mr-1" /> Start email communication</Button>
      </div>
      <p className="text-[11px] font-mono text-inky/60">
        Still open on RelaDyne's own report, but past the shop's expected delivery date. Click a PO to see its items.
        Ignored POs stay hidden until you restore them (choose the Ignored view).
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-inky/60">
          View
          <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value as StatusFilter); setPage(0) }} className={FIELD}>
            <option value="active">Open ({counts.active})</option>
            <option value="emailed">Emailed</option>
            <option value="skipped">Skipped</option>
            <option value="ignored">Ignored ({counts.ignored})</option>
            <option value="all">All</option>
          </select>
        </label>
        <div className="flex flex-col gap-1 w-48">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Shops</span>
          <MultiSelectDropdown options={shopOptions} selected={shops} onChange={(v) => { setShops(v); setPage(0) }} placeholder="All shops" countNoun="shops" searchable />
        </div>
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-inky/60">
          Ordered from
          <input type="date" value={orderedFrom} onChange={(e) => { setOrderedFrom(e.target.value); setPage(0) }} className={FIELD} />
        </label>
        <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-inky/60">
          Ordered through
          <input type="date" value={orderedTo} onChange={(e) => { setOrderedTo(e.target.value); setPage(0) }} className={FIELD} />
        </label>
        {filtersActive && <button onClick={clearFilters} className="text-[11px] font-mono text-inky underline pb-1">Clear filters</button>}
      </div>

      <div className="flex items-center gap-3 flex-wrap rounded border border-navy/15 bg-navy/[0.03] px-2 py-1.5">
        <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy cursor-pointer">
          <input type="checkbox" checked={allFilteredSelected} onChange={toggleAllFiltered} className="accent-sky" />
          Select all {filtered.length} shown
        </label>
        <span className="text-[11px] font-mono text-inky/70">{selected.size} selected</span>
        <select value={bulk} onChange={(e) => setBulk(e.target.value as BulkAction)} disabled={selected.size === 0} className={`${FIELD} disabled:opacity-40`}>
          <option value="">Set status of selected…</option>
          <option value="ignored">Ignored (hide forever)</option>
          <option value="emailed">Emailed</option>
          <option value="skipped">Skipped</option>
          <option value="clear">Clear status (put back in the list)</option>
        </select>
        <Button size="sm" variant="secondary" disabled={!bulk || selected.size === 0} loading={applying} onClick={applyBulk}>Apply</Button>
        {selected.size > 0 && <button onClick={() => setSelected(new Set())} className="text-[11px] font-mono text-inky underline">Clear selection</button>}
      </div>

      {statusLoading ? (
        <div className="py-4 flex justify-center"><SbLoader size={22} /></div>
      ) : (
        <div className="overflow-auto max-h-[28rem] rounded border border-[#C0392B]/30 bg-cream">
          <table className="w-full text-[11px] font-mono">
            <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
              <th className="px-2 py-1 w-8" />
              <th className="px-1 py-1 w-6" />
              <th className="text-left px-2 py-1">PO #</th>
              <th className="text-left px-2 py-1">Shop</th>
              <th className="text-left px-2 py-1">Order Date</th>
              <th className="text-left px-2 py-1">Expected Delivery</th>
              <th className="text-right px-2 py-1">Lines</th>
              <th className="text-right px-2 py-1">Qty</th>
              <th className="text-left px-2 py-1">Status</th>
            </tr></thead>
            <tbody>
              {pageRows.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-6 text-center text-inky/60">Nothing matches these filters.</td></tr>
              ) : pageRows.map((g) => {
                const st = statusByKey.get(g.key)
                const open = expanded.has(g.key)
                return (
                  <Fragment key={g.key}>
                    <tr onClick={() => toggleExpand(g.key)} className={`border-b border-navy/10 cursor-pointer hover:bg-navy/5 ${selected.has(g.key) ? 'bg-sky/10' : ''}`}>
                      <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(g.key)} onChange={() => toggleOne(g.key)} className="accent-sky" aria-label={`Select ${g.key}`} />
                      </td>
                      <td className="px-1 py-1 text-inky/60">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
                      <td className="px-2 py-1 text-navy">{g.poNo ?? <span className="text-inky/60">SO {g.salesOrderNos.join(', ')}</span>}</td>
                      <td className="px-2 py-1 text-navy">{shopLabel(g.locationId)}</td>
                      <td className="px-2 py-1 text-navy">{g.orderDate ? dShort(g.orderDate) : '—'}</td>
                      <td className="px-2 py-1 text-[#C0392B] font-bold">{g.expected ? dShort(g.expected) : '—'}</td>
                      <td className="px-2 py-1 text-right text-navy">{g.lines.length}</td>
                      <td className="px-2 py-1 text-right text-navy">{num(g.totalQty, 1)}</td>
                      <td className="px-2 py-1"><StatusBadge status={st?.status} skipCount={st?.skip_count ?? 0} /></td>
                    </tr>
                    {open && (
                      <tr className="border-b border-navy/10 bg-navy/[0.03]">
                        <td colSpan={9} className="px-6 py-2">
                          <table className="w-full text-[11px] font-mono">
                            <thead><tr className="text-inky/60 uppercase">
                              <th className="text-left py-0.5">Product Code</th><th className="text-left">Description</th>
                              <th className="text-right">Qty Ordered</th><th className="text-left pl-4">Sales Order #</th>
                            </tr></thead>
                            <tbody>
                              {g.lines.map((l) => (
                                <tr key={l.id} className="border-t border-navy/10">
                                  <td className="py-0.5 text-navy">{l.product_code}</td>
                                  <td className="text-inky/80">{l.product_desc ?? '—'}</td>
                                  <td className="text-right text-navy">{l.qty_ordered ?? '—'}</td>
                                  <td className="pl-4 text-inky/80">{l.sales_order_no}</td>
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

      {pageCount > 1 && (
        <div className="flex items-center justify-between text-[11px] font-mono text-inky">
          <span>{filtered.length} POs</span>
          <span className="flex items-center gap-2">
            <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="px-2 py-0.5 border border-navy/30 rounded disabled:opacity-30">Prev</button>
            Page {safePage + 1} of {pageCount}
            <button disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)} className="px-2 py-0.5 border border-navy/30 rounded disabled:opacity-30">Next</button>
          </span>
        </div>
      )}

      <Modal open={emailSetupOpen} onClose={() => setEmailSetupOpen(false)} title="PO Delivery Check-In — who to email" size="md">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-mono text-inky">
            Emails the shops whose POs were ordered in this window and are still overdue. Ignored POs and POs already
            emailed are left out; skipped ones stay in. The window defaults to the last 7 days and rolls forward each day.
          </p>
          <div className="flex items-end gap-3 flex-wrap">
            <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-inky/60">
              POs ordered from
              <input type="date" value={mailFrom} onChange={(e) => setMailFrom(e.target.value)} className={FIELD} />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-mono uppercase tracking-widest text-inky/60">
              through
              <input type="date" value={mailTo} onChange={(e) => setMailTo(e.target.value)} className={FIELD} />
            </label>
            <button onClick={() => { setMailFrom(localIsoDaysAgo(7)); setMailTo(todayIso()) }} className="text-[11px] font-mono text-inky underline pb-1">Last 7 days</button>
          </div>
          {selected.size > 0 && (
            <label className="flex items-center gap-2 text-xs font-mono text-navy cursor-pointer">
              <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} className="accent-sky" />
              Only the {selected.size} selected PO{selected.size === 1 ? '' : 's'}
            </label>
          )}
          {shops.length > 0 && <p className="text-[11px] font-mono text-inky/60">Limited to the {shops.length} shop{shops.length === 1 ? '' : 's'} chosen in the filter.</p>}
          <p className="text-sm font-heading font-bold text-navy">
            {queue.length} PO{queue.length === 1 ? '' : 's'} across {queueShops.length} shop{queueShops.length === 1 ? '' : 's'}
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEmailSetupOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={queueShops.length === 0} onClick={() => { setEmailTargets(queueShops); setEmailSetupOpen(false) }}>Start</Button>
          </div>
        </div>
      </Modal>

      <PoCheckInEmailModal open={!!emailTargets} onClose={() => setEmailTargets(null)} targets={emailTargets ?? []} setStatus={setStatus} />
    </div>
  )
}
