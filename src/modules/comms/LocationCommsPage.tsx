import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Filter, RefreshCw } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { usePageRevisit } from '@/hooks/usePageActive'
import { Button, Card, CardBody, SbLoader, Tabs, TabsTrigger, TabsContent } from '@/components/ui'
import { EditDate, EditSelect, CappedTextarea, inputCls } from '@/components/shared/InlineCells'
import { LocationCommsModal } from './LocationCommsModal'
import { WrapUpCommModal, seedFor, type WrapUpCommSeed } from './WrapUpCommModal'
import { useCommsConfig } from './useCommsConfig'
import { LocationCommsConfigTab } from '@/modules/config/tabs/LocationCommsConfigTab'
import type { LocationComm, CommsConfig } from './comms'
import { resolutionNotes, isResolvedStatus } from './comms'
import { EXCEPTION_STATUSES } from '@/modules/exceptions/exceptions'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import { isStaleRecord, bumpedUntilISO, STALE_ROW_BG } from '@/lib/staleness'
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, subMonths, subDays } from 'date-fns'
import toast from 'react-hot-toast'

const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

interface ColDef { id: string; label: string; filter: boolean; sticky?: 'status' | 'shop' }
const COLS: ColDef[] = [
  { id: 'status', label: 'Status', filter: true, sticky: 'status' },
  { id: 'shop', label: 'Shop', filter: true, sticky: 'shop' },
  { id: 'date', label: 'Date', filter: true },
  { id: 'type', label: 'Type', filter: true },
  { id: 'method', label: 'Method', filter: true },
  { id: 'who', label: 'Who', filter: true },
  { id: 'products', label: 'Products', filter: true },
  { id: 'action', label: 'Action Taken', filter: true },
  { id: 'notes', label: 'Notes', filter: true },
  { id: 'resolution', label: 'Resolution Notes', filter: true },
]

export function LocationCommsPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { config } = useCommsConfig()

  const [rowsAll, setRowsAll] = useState<LocationComm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('All')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<LocationComm> | null>(null)
  // Quick wrap-up prompt — opens when the inline status edit moves to
  // Tentatively Closed or Closed, so the closing details get captured in
  // one step without a full edit.
  const [wrapUp, setWrapUp] = useState<WrapUpCommSeed | null>(null)
  function openWrapUp(r: LocationComm, statusOverride: string | null) {
    setWrapUp(seedFor(r, statusOverride))
  }

  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    const { data, error: e } = await (supabase as any).schema('inventory').from('location_comms')
      .select('*').eq('company_id', companyId).order('comm_date', { ascending: false, nullsFirst: false })
    if (e) setError(e.message)
    else setRowsAll((data ?? []) as LocationComm[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  // Catch up on another user's comm/status change as soon as this page is
  // looked at again — the whole point of logging a comm here is that
  // someone else can see it happened, so this can't sit stale for minutes.
  usePageRevisit(load)

  // Optimistic local patch + silent direct write (no reload).
  function silentUpdate(id: string, patch: Partial<LocationComm>) {
    setRowsAll((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    ;(supabase as any).schema('inventory').from('location_comms')
      .update({ ...patch, updated_by: profile?.id ?? null, last_change_source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', id).then(({ error: e }: any) => { if (e) toast.error(e.message) })
    if ('status' in patch || 'metadata' in patch) refreshNavBadges()
  }
  const set = (r: LocationComm, patch: Partial<LocationComm>) => silentUpdate(r.id, patch)

  async function deleteComm(id: string) {
    const { error: e } = await (supabase as any).schema('inventory').from('location_comms').delete().eq('id', id)
    if (e) { toast.error('Failed to delete'); return }
    toast.success('Deleted'); load(); refreshNavBadges()
  }

  const statusChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rowsAll) { const s = r.status || 'No Status'; counts.set(s, (counts.get(s) ?? 0) + 1) }
    const present = [...counts.keys()].sort((a, b) => EXCEPTION_STATUSES.indexOf(a as any) - EXCEPTION_STATUSES.indexOf(b as any))
    return [{ key: 'All', count: rowsAll.length }, ...present.map((s) => ({ key: s, count: counts.get(s)! }))]
  }, [rowsAll])

  const cellText = (r: LocationComm, col: string): string => {
    switch (col) {
      case 'status': return r.status ?? ''
      case 'shop': return shopLabel(r.location_id)
      case 'date': return dShort(r.comm_date)
      case 'type': return r.comm_type ?? ''
      case 'method': return r.contact_method ?? ''
      case 'who': return r.who_contacted ?? ''
      case 'products': return (r.products ?? []).map((p) => p.product_id).join(' ')
      case 'action': return r.action_taken ?? ''
      case 'notes': return r.notes ?? ''
      case 'resolution': return resolutionNotes(r)
      default: return ''
    }
  }

  const rows = useMemo(() => {
    const byStatus = statusFilter === 'All' ? rowsAll : rowsAll.filter((r) => (r.status || 'No Status') === statusFilter)
    return byStatus
  }, [rowsAll, statusFilter])

  // Same predicate the nav badge counts (useNavBadges.ts), so the Alerts tab
  // and the sidebar number can never disagree.
  const alertRows = useMemo(
    () => rowsAll.filter((r) => isStaleRecord(r.status, r.comm_date, r.metadata, config.staleDays)),
    [rowsAll, config.staleDays],
  )

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col">
      <Tabs defaultValue="summary">
        <div className="sticky top-0 z-40 bg-cream pt-1 pb-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Location Comms</h1>
              <p className="text-xs text-inky mt-0.5 mb-2">Log of shop/AM communications — product requests, exception reporting, and more. Cells are editable inline.</p>
            </div>
            <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
          <div className="flex gap-1 border-b border-navy/30">
            <TabsTrigger value="alerts">Alerts{alertRows.length > 0 ? ` (${alertRows.length})` : ''}</TabsTrigger>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </div>
        </div>

        {/* Exactly the rows behind the sidebar badge: not resolved, old
            enough to be stale, and not currently bumped. */}
        <TabsContent value="alerts">
          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : alertRows.length === 0 ? (
            <p className="text-xs font-mono text-inky/60 py-8">
              Nothing needs action — no open communication is more than {config.staleDays} day{config.staleDays !== 1 ? 's' : ''} old.
            </p>
          ) : (
            <>
              <p className="text-xs font-body text-inky mb-3">
                Open communications at least {config.staleDays} day{config.staleDays !== 1 ? 's' : ''} old and not bumped —
                this is what the sidebar count reflects. Resolve or bump a row to clear it from here.
              </p>
              <LocationCommsTable rows={alertRows} config={config} shopLabel={shopLabel}
                onSet={set} onEdit={(r) => { setEditing(r); setModalOpen(true) }} onQuick={openWrapUp} />
            </>
          )}
        </TabsContent>

        <TabsContent value="summary">
          <CommsSummaryView data={rowsAll} config={config} />
        </TabsContent>

        <TabsContent value="reports">
          <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
            <div className="flex items-center gap-1 flex-wrap">
              {statusChips.map((c) => (
                <button key={c.key} onClick={() => setStatusFilter(c.key)}
                  className={['px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors',
                    statusFilter === c.key ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
                  {c.key} <span className="opacity-70">{c.count}</span>
                </button>
              ))}
            </div>
            <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true) }}>+ New Communication</Button>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : error ? (
            <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
          ) : (
            <LocationCommsTable rows={rows} config={config} shopLabel={shopLabel}
              onSet={set} onEdit={(r) => { setEditing(r); setModalOpen(true) }} onQuick={openWrapUp} />
          )}
        </TabsContent>

        {/* Same settings this page has always used (comms_config in
            platform.app_settings) — embedding the exact Config → Location
            Comms component here means edits in either place write to the
            same row, so the two are always in sync with no separate
            push/pull step. */}
        <TabsContent value="settings">
          <LocationCommsConfigTab />
        </TabsContent>
      </Tabs>

      <LocationCommsModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSaved={() => { load(); refreshNavBadges() }} onDelete={deleteComm} />

      <WrapUpCommModal seed={wrapUp} statuses={EXCEPTION_STATUSES as unknown as string[]}
        onCancel={() => { if (wrapUp) silentUpdate(wrapUp.row.id, { status: wrapUp.row.status ?? null }); setWrapUp(null) }}
        onSave={(patch) => { if (wrapUp) silentUpdate(wrapUp.row.id, patch); setWrapUp(null) }} />
    </div>
  )
}

// ── Inline-editable table (shared by Alerts and Reports) ───────────────────
function LocationCommsTable({ rows, config, shopLabel, onSet, onEdit, onQuick }: {
  rows: LocationComm[]
  config: CommsConfig
  shopLabel: (id: string | null) => string
  onSet: (r: LocationComm, patch: Partial<LocationComm>) => void
  onEdit: (r: LocationComm) => void
  onQuick: (r: LocationComm, statusOverride: string | null) => void
}) {
  const [filtersOn, setFiltersOn] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})

  const cellText = (r: LocationComm, col: string): string => {
    switch (col) {
      case 'status': return r.status ?? ''
      case 'shop': return shopLabel(r.location_id)
      case 'date': return dShort(r.comm_date)
      case 'type': return r.comm_type ?? ''
      case 'method': return r.contact_method ?? ''
      case 'who': return r.who_contacted ?? ''
      case 'products': return (r.products ?? []).map((p) => p.product_id).join(' ')
      case 'action': return r.action_taken ?? ''
      case 'notes': return r.notes ?? ''
      case 'resolution': return resolutionNotes(r)
      default: return ''
    }
  }

  const filtered = useMemo(() => rows.filter((r) =>
    Object.entries(filters).every(([c, val]) => !val || cellText(r, c).toLowerCase().includes(val.toLowerCase()))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, filters, shopLabel])

  const thBase = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky top-0 z-20'
  const tdBase = 'px-2 py-1 align-top border-b border-navy/15 whitespace-nowrap'
  const thClass = (c: ColDef) => c.sticky === 'status' ? `${thBase} left-0 z-30 w-[200px] min-w-[200px]` : c.sticky === 'shop' ? `${thBase} left-[200px] z-30` : thBase

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No communications for this filter.</p>

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button onClick={() => setFiltersOn((o) => !o)}
          className={['inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors', filtersOn ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
          <Filter className="w-3 h-3" /> {filtersOn ? 'Hide Filters' : 'Filter Columns'}
        </button>
      </div>
      <div className="overflow-auto max-h-[calc(100vh-16rem)] rounded border border-navy/30">
        <table className="text-xs font-mono border-collapse">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th key={c.id} className={thClass(c)}>
                  <div className="flex flex-col gap-1">
                    <span>{c.label}</span>
                    {filtersOn && c.filter && (
                      <input value={filters[c.id] ?? ''} onChange={(e) => setFilters((f) => ({ ...f, [c.id]: e.target.value }))} placeholder="filter…"
                        className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-[10px] font-mono text-navy font-normal normal-case tracking-normal w-full focus:outline-none focus:ring-1 focus:ring-sky" />
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={COLS.length} className="px-2 py-6 text-center text-inky/50">No rows match the filters.</td></tr>
            ) : filtered.map((r, idx) => {
              // Stale (needs-action, unbumped) rows override the band with a
              // light red flag — this is what drives the nav badge count.
              const stale = isStaleRecord(r.status, r.comm_date, r.metadata, config.staleDays)
              const band = stale ? STALE_ROW_BG : idx % 2 ? 'bg-navy/[0.04]' : 'bg-cream'
              return (
                <tr key={r.id} className={band}>
                  <td className={`${tdBase} sticky left-0 z-10 ${band} w-[200px] min-w-[200px]`}>
                    <div className="flex items-center gap-1">
                      <button onClick={() => onEdit(r)} title="Full edit" className="text-inky hover:text-navy flex-shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
                      <EditSelect value={r.status} options={EXCEPTION_STATUSES as unknown as string[]} placeholder="—"
                        onSave={(v) => { onSet(r, { status: v }); if (isResolvedStatus(v)) onQuick(r, v) }} className="min-w-[150px]" />
                      {stale && (
                        <button onClick={() => onSet(r, { metadata: { ...(r.metadata ?? {}), bumped_until: bumpedUntilISO(config.bumpDays) } })}
                          title={`Defer ${config.bumpDays} more day(s)`}
                          className="flex-shrink-0 text-[10px] font-mono text-[#C0392B] border border-[#C0392B]/40 rounded px-1 py-0.5 hover:bg-[#C0392B]/10">
                          Bump
                        </button>
                      )}
                    </div>
                  </td>
                  <td className={`${tdBase} sticky left-[200px] z-10 ${band} text-navy`} title={shopLabel(r.location_id)}>{shopLabel(r.location_id)}</td>
                  <td className={tdBase}><EditDate value={r.comm_date} onSave={(v) => onSet(r, { comm_date: v })} /></td>
                  <td className={tdBase}><EditSelect value={r.comm_type} options={config.commTypes} placeholder="—" allowCurrent onSave={(v) => onSet(r, { comm_type: v })} /></td>
                  <td className={tdBase}><EditSelect value={r.contact_method} options={config.contactMethods} placeholder="—" allowCurrent onSave={(v) => onSet(r, { contact_method: v })} /></td>
                  <td className={tdBase}><EditSelect value={r.who_contacted} options={config.whoContacted} placeholder="—" allowCurrent onSave={(v) => onSet(r, { who_contacted: v })} /></td>
                  <td className={`${tdBase} max-w-[16rem] truncate text-navy`} title={(r.products ?? []).map((p) => p.product_id).join(', ')}>
                    {(r.products ?? []).length ? (r.products ?? []).map((p) => p.product_id).join(', ') : '—'}
                  </td>
                  <td className={tdBase}><EditSelect value={r.action_taken} options={config.actionTaken} placeholder="—" allowCurrent onSave={(v) => onSet(r, { action_taken: v })} /></td>
                  <td className={`${tdBase} whitespace-normal`}><CappedTextarea value={r.notes ?? ''} onSave={(v) => onSet(r, { notes: v })} /></td>
                  <td className={`${tdBase} whitespace-normal`}>
                    <CappedTextarea value={resolutionNotes(r)}
                      onSave={(v) => onSet(r, { metadata: { ...(r.metadata ?? {}), resolution_notes: v } })} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Summary ──────────────────────────────────────────────────────────────────
function mode(arr: string[]): string | null {
  if (!arr.length) return null
  const m = new Map<string, number>(); let best = '', bc = 0
  for (const a of arr) { const c = (m.get(a) ?? 0) + 1; m.set(a, c); if (c > bc) { bc = c; best = a } }
  return best
}
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 0)
// Brand + flag palette (all existing hex) cycled for chart action segments.
const CHART_COLORS = ['#002745', '#4F7489', '#B7E0DE', '#2ECC71', '#E67E22', '#C0392B']

type RangeKey = 'current_month' | 'current_week' | 'last_7' | 'last_month' | 'custom'
const RANGE_KEY = 'comms-summary-range'
const RANGE_LABELS: Record<RangeKey, string> = { current_month: 'This Month', current_week: 'This Week', last_7: 'Last 7 Days', last_month: 'Last Month', custom: 'Custom' }

function rangeDates(r: { key: RangeKey; from: string; to: string }): [Date, Date] {
  const now = new Date(); now.setHours(0, 0, 0, 0)
  switch (r.key) {
    case 'current_week': return [startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 })]
    case 'last_7': return [subDays(now, 6), now]
    case 'last_month': { const p = subMonths(now, 1); return [startOfMonth(p), endOfMonth(p)] }
    case 'custom': return [r.from ? new Date(r.from + 'T00:00:00') : startOfMonth(now), r.to ? new Date(r.to + 'T00:00:00') : now]
    default: return [startOfMonth(now), endOfMonth(now)]
  }
}

function CommsSummaryView({ data, config }: { data: LocationComm[]; config: CommsConfig }) {
  const [range, setRange] = useState<{ key: RangeKey; from: string; to: string }>(() => {
    try { const p = JSON.parse(localStorage.getItem(RANGE_KEY) || ''); if (p?.key) return p } catch { /* ignore */ }
    return { key: 'current_month', from: '', to: '' }
  })
  useEffect(() => { try { localStorage.setItem(RANGE_KEY, JSON.stringify(range)) } catch { /* ignore */ } }, [range])

  const [from, to] = rangeDates(range)
  const inRange = useMemo(() => data.filter((r) => {
    if (!r.comm_date) return false
    const d = new Date(r.comm_date + 'T00:00:00')
    return d >= from && d <= to
  }), [data, from, to])

  const s = useMemo(() => {
    const resolved = inRange.filter((r) => isResolvedStatus(r.status))
    const needsAction = inRange.filter((r) => isStaleRecord(r.status, r.comm_date, r.metadata, config.staleDays))
    const perType = config.commTypes.map((t) => {
      const typeRows = inRange.filter((r) => r.comm_type === t)
      const counts = new Map<string, number>()
      for (const r of typeRows) { const k = r.action_taken || 'No action yet'; counts.set(k, (counts.get(k) ?? 0) + 1) }
      return { type: t, count: typeRows.length, topAction: mode(typeRows.filter((r) => r.action_taken).map((r) => r.action_taken!)), segments: [...counts.entries()].sort((a, b) => b[1] - a[1]) }
    })
    return {
      total: inRange.length,
      shopsContacted: new Set(inRange.map((r) => r.location_id)).size,
      resolved: resolved.length,
      resolvedRate: pct(resolved.length, inRange.length),
      needsAction: needsAction.length,
      perType,
    }
  }, [inRange, config])

  const Tile = ({ label, value, sub }: { label: string; value: string | number; sub?: string }) => (
    <Card><CardBody className="py-3">
      <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60">{label}</div>
      <div className="text-2xl font-heading font-bold text-navy">{value}</div>
      {sub && <div className="text-[10px] font-mono text-inky/60 mt-0.5">{sub}</div>}
    </CardBody></Card>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-1.5 flex-wrap">
        {(['current_month', 'current_week', 'last_7', 'last_month', 'custom'] as RangeKey[]).map((k) => (
          <button key={k} onClick={() => setRange((p) => ({ ...p, key: k }))}
            className={['px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors', range.key === k ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
            {RANGE_LABELS[k]}
          </button>
        ))}
        {range.key === 'custom' && (
          <div className="flex items-center gap-1">
            <input type="date" value={range.from} onChange={(e) => setRange((p) => ({ ...p, from: e.target.value }))} className={inputCls} />
            <span className="text-inky/50 text-xs">–</span>
            <input type="date" value={range.to} onChange={(e) => setRange((p) => ({ ...p, to: e.target.value }))} className={inputCls} />
          </div>
        )}
        <span className="text-[10px] font-mono text-inky/50 ml-1">{format(from, 'MMM d')} – {format(to, 'MMM d, yyyy')}</span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Total Communications" value={s.total} />
        <Tile label="Shops Contacted" value={s.shopsContacted} />
        <Tile label="Resolved" value={`${s.resolvedRate}%`} sub={`${s.resolved} of ${s.total}`} />
        <Tile label="Needs Action" value={s.needsAction} sub={`> ${config.staleDays}d, not bumped`} />
      </div>

      <div className="flex flex-wrap gap-3 items-start">
        <Card className="w-fit"><CardBody>
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2">By Type</div>
          <table className="text-xs font-mono w-auto">
            <thead><tr className="text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="text-left px-2 py-0.5">Type</th><th className="text-right px-2 py-0.5">Count</th><th className="text-left px-2 py-0.5 pl-4">Most Common Action</th>
            </tr></thead>
            <tbody>
              {s.perType.map((t) => (
                <tr key={t.type} className="border-b border-navy/10">
                  <td className="px-2 py-0.5 text-navy whitespace-nowrap">{t.type}</td>
                  <td className="px-2 py-0.5 text-right text-navy">{t.count}</td>
                  <td className="px-2 py-0.5 pl-4 text-navy whitespace-nowrap">{t.topAction ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody></Card>

        <Card className="flex-1 min-w-[280px]"><CardBody>
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-3">Actions Taken by Type</div>
          <CommsByTypeChart perType={s.perType} />
        </CardBody></Card>
      </div>
    </div>
  )
}

// Horizontal stacked bars — one per comm type, segmented by action taken. Bar
// length is comparable across types; segments show each action's share.
function CommsByTypeChart({ perType }: { perType: { type: string; count: number; segments: [string, number][] }[] }) {
  const maxCount = Math.max(1, ...perType.map((t) => t.count))
  const actions = [...new Set(perType.flatMap((t) => t.segments.map(([a]) => a)))]
  const colorOf = (action: string) => CHART_COLORS[actions.indexOf(action) % CHART_COLORS.length]
  if (!perType.some((t) => t.count)) return <p className="text-xs font-mono text-inky/50">No data in range.</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {perType.map((t) => (
          <div key={t.type}>
            <div className="flex justify-between text-[10px] font-mono text-inky/70 mb-0.5"><span className="uppercase tracking-wide">{t.type}</span><span>{t.count}</span></div>
            <div className="h-5 w-full rounded bg-navy/5 overflow-hidden flex">
              {t.segments.map(([action, cnt]) => (
                <div key={action} title={`${action}: ${cnt}`} className="h-full" style={{ width: `${(cnt / maxCount) * 100}%`, background: colorOf(action) }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {actions.map((action) => (
          <span key={action} className="inline-flex items-center gap-1 text-[10px] font-mono text-inky/70">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(action) }} />{action}
          </span>
        ))}
      </div>
    </div>
  )
}
