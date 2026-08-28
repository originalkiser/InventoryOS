import { useEffect, useMemo, useState, type ReactNode, type CSSProperties } from 'react'
import { Pencil, Filter, GripVertical, ChevronUp, ChevronDown } from 'lucide-react'
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, horizontalListSortingStrategy, arrayMove, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useConfigTab, type ImportMode } from '@/modules/config/useConfigTab'
import { useLocations } from '@/hooks/useLocations'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { ClearTableButton } from '@/components/config/ClearTableButton'
import { EditText, EditDate, EditSelect, AutoTextarea, inputCls } from '@/components/shared/InlineCells'
import { Button, Input, Card, CardBody, Tabs, TabsTrigger, TabsContent, SbLoader } from '@/components/ui'
import { mappedValue } from '@/lib/columnTransform'
import { applyTransforms } from '@/lib/transforms'
import type { ColumnMapping } from '@/types'
import {
  RESPONSE_YES, RESPONSE_YES_RD, RESPONSE_NO,
  parseContacted, isYesResponse, isRdAdded, rdCell, impactedProducts, followUpDate, isExceptionStale,
  type ExceptionReport, type ExceptionConfig,
} from './exceptions'
import { useExceptionConfig } from './useExceptionConfig'
import { ImpactedProductsPicker } from './ImpactedProductsPicker'
import { QuickResponseModal, type QuickResponseSeed } from './QuickResponseModal'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import { bumpedUntilISO, STALE_ROW_BG } from '@/lib/staleness'
import { ExceptionReportModal } from './ExceptionReportModal'
import { AutomatedChecksPanel } from './AutomatedChecksPanel'
import { format, startOfMonth, endOfMonth, startOfWeek, endOfWeek, subMonths, subDays } from 'date-fns'
import toast from 'react-hot-toast'

const toDate = (v: string) => applyTransforms(v, [{ kind: 'date' }]) || null
const stripHtml = (s: string | null) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '')
const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

const UPLOAD_FIELDS = [
  { name: 'shop', label: 'Shop', required: true },
  { name: 'date_of_finding', label: 'Date of Finding' },
  { name: 'date_of_shop_action', label: 'Response Date' },
  { name: 'area_manager', label: 'Area Manager' },
  { name: 'report_type', label: 'Exception Report (Type)' },
  { name: 'issue', label: 'Issue' },
  { name: 'details', label: 'Details' },
  { name: 'contacted', label: 'Contacted?' },
  { name: 'response', label: 'Response?' },
  { name: 'rd_if_no', label: 'RD if No' },
  { name: 'response_notes', label: 'Response Notes' },
  { name: 'status', label: 'Status' },
]

export function ExceptionReportingPage() {
  const { profile } = useAuthStore()
  const { data, loading, insert, remove, importRows, clearAll } = useConfigTab<ExceptionReport>('exception_reports', 'inventory')
  const loc = useLocations()
  const { config, save: saveConfig } = useExceptionConfig()

  // Local mirror so inline edits apply instantly without waiting on a reload.
  const [rowsAll, setRowsAll] = useState<ExceptionReport[]>([])
  useEffect(() => { setRowsAll(data) }, [data])

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<ExceptionReport> | null>(null)
  const [importing, setImporting] = useState(false)
  const [statusFilter, setStatusFilter] = useState('All')

  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'
  const regionalDirector = (id: string | null) => loc.fieldValue(id, 'regional_director') || loc.fieldValue(id, 'director')

  // Optimistic local patch + direct silent write (no reload → no focus loss / wait).
  function silentUpdate(id: string, patch: Partial<ExceptionReport>) {
    setRowsAll((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    ;(supabase as any).schema('inventory').from('exception_reports')
      .update({ ...patch, updated_by: profile?.id ?? null, last_change_source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', id).then(({ error }: any) => { if (error) toast.error(error.message) })
    // A status change may add/remove this report from the "pending" badge count.
    if ('status' in patch) refreshNavBadges()
  }
  const set = (r: ExceptionReport, patch: Partial<ExceptionReport>) => silentUpdate(r.id, patch)

  // Quick wrap-up prompt — opens when a response date is entered or the status
  // moves to a closed state, so the closing details get captured in one step.
  const [quick, setQuick] = useState<QuickResponseSeed | null>(null)
  const closedStatus = useMemo(() => {
    const exact = config.statuses.find((x) => x.trim().toLowerCase() === 'closed')
    return exact ?? config.statuses.find((x) => x.toLowerCase().includes('closed')) ?? ''
  }, [config.statuses])
  function openQuick(r: ExceptionReport, opts: { responseDate?: string | null; status?: string | null }) {
    setQuick({
      row: r,
      status: opts.status ?? closedStatus ?? (r.status ?? ''),
      responseDate: opts.responseDate ?? r.date_of_shop_action ?? '',
      notes: stripHtml(r.response_notes),
    })
  }

  function openAdd() { setEditing(null); setModalOpen(true) }
  function openEdit(r: ExceptionReport) { setEditing(r); setModalOpen(true) }

  const statusChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rowsAll) { const s = r.status || 'No Status'; counts.set(s, (counts.get(s) ?? 0) + 1) }
    const idx = (s: string) => { const i = config.statuses.indexOf(s); return i === -1 ? 999 : i }
    const present = [...counts.keys()].sort((a, b) => idx(a) - idx(b))
    return [{ key: 'All', count: rowsAll.length }, ...present.map((s) => ({ key: s, count: counts.get(s)! }))]
  }, [rowsAll, config.statuses])

  const rows = useMemo(() => (statusFilter === 'All' ? rowsAll : rowsAll.filter((r) => (r.status || 'No Status') === statusFilter)), [rowsAll, statusFilter])

  // System-generated flags from run-automated-checks — same table, marked by
  // metadata.source, kept in their own tab rather than mixed into Reports.
  const automatedRows = useMemo(() => rowsAll.filter((r) => (r.metadata as any)?.source === 'automated'), [rowsAll])
  const automatedOpenCount = useMemo(
    () => automatedRows.filter((r) => !(r.status ?? '').toLowerCase().includes('closed')).length,
    [automatedRows],
  )

  // Same predicate the nav badge counts, so the Alerts tab and the sidebar
  // number can never disagree.
  const alertRows = useMemo(
    () => rowsAll.filter((r) => isExceptionStale(r, config.staleDays, config.responseDays)),
    [rowsAll, config.staleDays, config.responseDays],
  )

  async function handleImport(inRows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) {
    setImporting(true)
    const payload = inRows.map((row) => {
      let location_id: string | null = null, area_manager: string | null = null
      let date_of_finding: string | null = null, date_of_shop_action: string | null = null
      let report_type: string | null = null, issue: string | null = null, details: string | null = null
      let contactedRaw = '', response: string | null = null, rd_if_no: string | null = null, response_notes: string | null = null
      let status: string | null = null
      for (const m of maps) {
        const v = mappedValue(row, m, maps)
        switch (m.fieldName) {
          case 'shop': location_id = loc.resolveId(v); break
          case 'area_manager': area_manager = v.trim() || null; break
          case 'date_of_finding': date_of_finding = toDate(v); break
          case 'date_of_shop_action': date_of_shop_action = toDate(v); break
          case 'report_type': report_type = v.trim() || null; break
          case 'issue': issue = v.trim() || null; break
          case 'details': details = v.trim() || null; break
          case 'contacted': contactedRaw = v; break
          case 'response': response = v.trim() || null; break
          case 'rd_if_no': rd_if_no = v.trim() || null; break
          case 'response_notes': response_notes = v.trim() || null; break
          case 'status': status = v.trim() || null; break
        }
      }
      const yr = date_of_finding ? Number(date_of_finding.slice(0, 4)) : new Date().getFullYear()
      const { contacted, contacted_date } = parseContacted(contactedRaw, yr)
      // Default new rows to the first configured status when the file omits one.
      if (!status) status = config.statuses[0] ?? null
      return { location_id, area_manager, date_of_finding, date_of_shop_action, report_type, issue, details, contacted, contacted_date, response, rd_if_no, response_notes, status } as Partial<ExceptionReport>
    }).filter((r) => r.location_id)
    await importRows(payload, { mode, source: 'upload', keyOf: (r: any) => `${r.location_id ?? ''}|${r.date_of_finding ?? ''}|${r.report_type ?? ''}|${r.issue ?? ''}|${r.details ?? ''}` })
    setImporting(false)
    refreshNavBadges()
  }

  return (
    <div className="flex flex-col">
      <Tabs defaultValue="summary">
        {/* Pinned header + tabs */}
        <div className="sticky top-0 z-40 bg-cream pt-1 pb-2">
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Exception Reporting</h1>
          <p className="text-xs text-inky mt-0.5 mb-2">Inventory findings (PO match, activity, on-hand). Every cell is editable inline; the pencil opens full detail.</p>
          <div className="flex gap-1 border-b border-navy/30">
            <TabsTrigger value="alerts">Alerts{alertRows.length > 0 ? ` (${alertRows.length})` : ''}</TabsTrigger>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="automated">Automated Checks{automatedOpenCount > 0 ? ` (${automatedOpenCount})` : ''}</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </div>
        </div>

        {/* Exactly the rows behind the sidebar badge: open, old enough to be
            stale, and not currently bumped. */}
        <TabsContent value="alerts">
          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : alertRows.length === 0 ? (
            <p className="text-xs font-mono text-inky/60 py-8">
              Nothing needs action — no open report is more than {config.staleDays} day{config.staleDays !== 1 ? 's' : ''} old.
            </p>
          ) : (
            <>
              <p className="text-xs font-body text-inky mb-3">
                Open reports at least {config.staleDays} day{config.staleDays !== 1 ? 's' : ''} old and not bumped — this is
                what the sidebar count reflects. Close or bump a report to clear it from here.
              </p>
              <ExceptionTable rows={alertRows} config={config} shopLabel={shopLabel} regionalDirector={regionalDirector}
                companyId={profile?.company_id ?? null} onSet={set} onEdit={openEdit} onQuick={openQuick} />
            </>
          )}
        </TabsContent>

        <TabsContent value="summary">
          <SummaryView data={rowsAll} config={config} />
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
            <Button size="sm" onClick={openAdd}>+ New Exception</Button>
          </div>

          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : (
            <ExceptionTable rows={rows} config={config} shopLabel={shopLabel} regionalDirector={regionalDirector}
              companyId={profile?.company_id ?? null} onSet={set} onEdit={openEdit} onQuick={openQuick} />
          )}
        </TabsContent>

        <TabsContent value="automated">
          {loading ? (
            <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
          ) : (
            <AutomatedChecksPanel
              rows={automatedRows} config={config} shopLabel={shopLabel} regionalDirector={regionalDirector}
              companyId={profile?.company_id ?? null} onSet={set} onEdit={openEdit} onQuick={openQuick}
            />
          )}
        </TabsContent>

        <TabsContent value="settings">
          <SettingsView config={config} saveConfig={saveConfig} onImport={handleImport} importing={importing} clearAll={clearAll} />
        </TabsContent>
      </Tabs>

      <QuickResponseModal seed={quick} statuses={config.statuses}
        onCancel={() => { if (quick) silentUpdate(quick.row.id, { status: quick.row.status ?? null }); setQuick(null) }}
        onSave={(patch) => { if (quick) silentUpdate(quick.row.id, patch); setQuick(null) }} />

      <ExceptionReportModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSubmit={async (fields, id) => { if (id) silentUpdate(id, fields); else await insert(fields); refreshNavBadges() }}
        onDelete={(id) => { remove(id); refreshNavBadges() }} />
    </div>
  )
}

// ── Inline-editable table ────────────────────────────────────────────────────
// Status + Shop stay pinned-left; the rest are reorderable.
const COL_META: Record<string, { label: string; filter: boolean; wrap?: boolean }> = {
  finding: { label: 'Finding', filter: true },
  area_manager: { label: 'Area Manager', filter: true },
  type: { label: 'Type', filter: true },
  issue: { label: 'Issue', filter: true },
  products: { label: 'Impacted Products', filter: false },
  details: { label: 'Details', filter: true, wrap: true },
  contacted: { label: 'Contacted', filter: false },
  follow_up: { label: 'Follow-Up Sent', filter: false },
  response: { label: 'Response', filter: true },
  response_date: { label: 'Response Date', filter: false },
  rd: { label: 'Regional Director', filter: false },
  response_notes: { label: 'Response Notes', filter: true, wrap: true },
}
const DEFAULT_ORDER = Object.keys(COL_META)
const COL_ORDER_KEY = 'exc:colorder'

function SortableHeaderCell({ id, thBase, children }: { id: string; thBase: string; children: ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  const style: CSSProperties = { transform: CSS.Translate.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <th ref={setNodeRef} style={style} className={thBase}>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <button {...attributes} {...listeners} title="Drag to reorder" className="cursor-grab active:cursor-grabbing text-inky/40 hover:text-navy flex-shrink-0"><GripVertical className="w-3 h-3" /></button>
          <span>{COL_META[id].label}</span>
        </div>
        {children}
      </div>
    </th>
  )
}

export function ExceptionTable({ rows, config, shopLabel, regionalDirector, companyId, onSet, onEdit, onQuick }: {
  rows: ExceptionReport[]
  config: ExceptionConfig
  shopLabel: (id: string | null) => string
  regionalDirector: (id: string | null) => string
  companyId: string | null
  onSet: (r: ExceptionReport, patch: Partial<ExceptionReport>) => void
  onEdit: (r: ExceptionReport) => void
  // Fired when an edit suggests the report is wrapping up (response date
  // entered, or status moved to closed) so the parent can prompt for the rest.
  onQuick: (r: ExceptionReport, opts: { responseDate?: string | null; status?: string | null }) => void
}) {
  const [filtersOn, setFiltersOn] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [order, setOrder] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COL_ORDER_KEY) || 'null')
      if (Array.isArray(saved)) {
        const known = saved.filter((id: string) => DEFAULT_ORDER.includes(id))
        return [...known, ...DEFAULT_ORDER.filter((id) => !known.includes(id))]
      }
    } catch { /* ignore */ }
    return DEFAULT_ORDER
  })
  useEffect(() => { localStorage.setItem(COL_ORDER_KEY, JSON.stringify(order)) }, [order])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e
    if (!over || active.id === over.id) return
    setOrder((o) => arrayMove(o, o.indexOf(String(active.id)), o.indexOf(String(over.id))))
  }

  const thBase = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky top-0 z-20'
  const tdBase = 'px-2 py-1 align-top border-b border-navy/15 whitespace-nowrap'

  const cellText = (r: ExceptionReport, col: string): string => {
    switch (col) {
      case 'status': return r.status ?? ''
      case 'shop': return shopLabel(r.location_id)
      case 'finding': return dShort(r.date_of_finding)
      case 'area_manager': return r.area_manager ?? ''
      case 'type': return r.report_type ?? ''
      case 'issue': return r.issue ?? ''
      case 'details': return stripHtml(r.details)
      case 'response': return r.response ?? ''
      case 'response_notes': return stripHtml(r.response_notes)
      default: return ''
    }
  }
  const filtered = useMemo(() => rows.filter((r) =>
    Object.entries(filters).every(([c, val]) => !val || cellText(r, c).toLowerCase().includes(val.toLowerCase()))),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [rows, filters, shopLabel])

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No exception reports for this filter.</p>

  const filterInput = (id: string) => (
    <input value={filters[id] ?? ''} onChange={(e) => setFilters((f) => ({ ...f, [id]: e.target.value }))} placeholder="filter…"
      className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-[10px] font-mono text-navy font-normal normal-case tracking-normal w-full focus:outline-none focus:ring-1 focus:ring-sky" />
  )

  function renderCell(id: string, r: ExceptionReport): ReactNode {
    const info = id === 'rd' ? rdCell(r, config.responseDays) : null
    switch (id) {
      case 'finding': return <EditDate bare value={r.date_of_finding} onSave={(v) => onSet(r, { date_of_finding: v })} />
      case 'area_manager': return <EditText value={r.area_manager} onSave={(v) => onSet(r, { area_manager: v })} />
      case 'type': return <EditSelect bare value={r.report_type} options={config.types} placeholder="—" onSave={(v) => onSet(r, { report_type: v })} />
      case 'issue': return <EditSelect bare value={r.issue} options={config.issues[r.report_type ?? ''] ?? []} placeholder="—" allowCurrent onSave={(v) => onSet(r, { issue: v })} />
      case 'products': return <ImpactedProductsPicker compact companyId={companyId} locationId={r.location_id} selected={impactedProducts(r)}
        onChange={(ids) => onSet(r, { metadata: { ...(r.metadata ?? {}), impacted_products: ids } })} />
      case 'details': return <AutoTextarea value={stripHtml(r.details)} onSave={(v) => onSet(r, { details: v })} />
      case 'contacted': return (
        <div className="flex items-center gap-1">
          <input type="checkbox" checked={r.contacted} onChange={(e) => onSet(r, { contacted: e.target.checked })} className="accent-sky" />
          {r.contacted && <EditDate bare value={r.contacted_date} onSave={(v) => onSet(r, { contacted_date: v })} />}
        </div>
      )
      // Date a follow-up was sent. Setting it restarts the response window
      // (see responseWindowStart), which is what the Regional Director
      // column counts down from.
      case 'follow_up': return <EditDate bare value={followUpDate(r)}
        title="Date a follow-up was sent — restarts the response window"
        onSave={(v) => onSet(r, { metadata: { ...(r.metadata ?? {}), follow_up_date: v } })} />
      case 'response': return <ResponseCell value={r.response} onSet={(v) => onSet(r, { response: v })} />
      case 'response_date': return isYesResponse(r.response)
        ? <EditDate bare value={r.date_of_shop_action}
            onSave={(v) => { onSet(r, { date_of_shop_action: v }); if (v) onQuick(r, { responseDate: v }) }} />
        : <span className="text-inky/30">—</span>
      case 'rd': return info!.mode === 'left' ? <span className="text-[10px] font-mono text-inky/70">{info!.daysLeft}d left</span>
        : info!.mode === 'rd' ? <span className="text-navy">{regionalDirector(r.location_id) || '—'}</span>
        : <span className="text-inky/40">—</span>
      case 'response_notes': return <AutoTextarea value={stripHtml(r.response_notes)} onSave={(v) => onSet(r, { response_notes: v })} />
      default: return null
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button onClick={() => setFiltersOn((o) => !o)}
          className={['inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors', filtersOn ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
          <Filter className="w-3 h-3" /> {filtersOn ? 'Hide Filters' : 'Filter Columns'}
        </button>
      </div>
      <div className="overflow-auto max-h-[calc(100vh-16rem)] rounded border border-navy/30">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <table className="text-xs font-mono border-collapse">
            <thead>
              <tr>
                <th className={`${thBase} left-0 z-30 w-[230px] min-w-[230px]`}>
                  <div className="flex flex-col gap-1"><span>Status</span>{filtersOn && filterInput('status')}</div>
                </th>
                <th className={`${thBase} left-[230px] z-30`}>
                  <div className="flex flex-col gap-1"><span>Shop</span>{filtersOn && filterInput('shop')}</div>
                </th>
                <SortableContext items={order} strategy={horizontalListSortingStrategy}>
                  {order.map((id) => (
                    <SortableHeaderCell key={id} id={id} thBase={thBase}>
                      {filtersOn && COL_META[id].filter ? filterInput(id) : null}
                    </SortableHeaderCell>
                  ))}
                </SortableContext>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={order.length + 2} className="px-2 py-6 text-center text-inky/50">No rows match the filters.</td></tr>
              ) : filtered.map((r, idx) => {
                // Opaque bands so the sticky Status/Shop columns share them
                // (a translucent band lets scrolled columns bleed through).
                // Stale (needs-action, unbumped) rows override the band with
                // a light red flag — this is what drives the nav badge count.
                const stale = isExceptionStale(r, config.staleDays, config.responseDays)
                const band = stale ? STALE_ROW_BG : idx % 2 ? 'bg-[#ECEBD8] dark:bg-[#0D2035]' : 'bg-cream'
                return (
                  <tr key={r.id} className={band}>
                    <td className={`${tdBase} sticky left-0 z-10 ${band} w-[230px] min-w-[230px]`}>
                      {/* Bump stacks under the select (rather than beside it) so the
                          combined width never exceeds this sticky column's own width —
                          content that overflowed the column used to get covered by the
                          next sticky column (Shop) once the row scrolled under it. */}
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-1">
                          <button onClick={() => onEdit(r)} title="Full edit" className="text-inky hover:text-navy flex-shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
                          <EditSelect bare value={r.status} options={config.statuses} placeholder="—" allowCurrent className="min-w-[180px]"
                            onSave={(v) => { onSet(r, { status: v }); if ((v ?? '').toLowerCase().includes('closed')) onQuick(r, { status: v }) }} />
                        </div>
                        {stale && (
                          <button onClick={() => onSet(r, { metadata: { ...(r.metadata ?? {}), bumped_until: bumpedUntilISO(config.bumpDays) } })}
                            title={`Defer ${config.bumpDays} more day(s)`}
                            className="self-start flex-shrink-0 text-[10px] font-mono text-[#C0392B] border border-[#C0392B]/40 rounded px-1 py-0.5 hover:bg-[#C0392B]/10">
                            Bump
                          </button>
                        )}
                      </div>
                    </td>
                    <td className={`${tdBase} sticky left-[230px] z-10 ${band} text-navy`} title={shopLabel(r.location_id)}>{shopLabel(r.location_id)}</td>
                    {order.map((id) => (
                      <td key={id} className={COL_META[id].wrap ? `${tdBase} whitespace-normal` : tdBase}>
                        {/* Cap wrap-column content to roughly the Status column's own
                            height (1 line + Bump) so a long note doesn't blow the whole
                            row out — it scrolls internally instead. */}
                        {COL_META[id].wrap ? <div className="max-h-11 overflow-y-auto">{renderCell(id, r)}</div> : renderCell(id, r)}
                      </td>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </DndContext>
      </div>
    </div>
  )
}

function ResponseCell({ value, onSet }: { value: string | null; onSet: (v: string | null) => void }) {
  const opts: [string, string][] = [['Yes', RESPONSE_YES], ['+RD', RESPONSE_YES_RD], ['No', RESPONSE_NO]]
  return (
    <div className="inline-flex rounded overflow-hidden border border-navy/30">
      {opts.map(([label, val]) => {
        const on = value === val
        const active = val === RESPONSE_NO ? 'bg-[#C0392B] text-cream' : 'bg-[#2ECC71] text-navy'
        return (
          <button key={val} title={val} onClick={() => onSet(on ? null : val)}
            className={['px-1.5 py-0.5 text-[10px] font-mono border-r border-navy/20 last:border-r-0', on ? active : 'bg-transparent text-inky hover:bg-navy/10'].join(' ')}>
            {label}
          </button>
        )
      })}
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
// Brand + flag palette (all existing hex) cycled for chart issue segments.
const CHART_COLORS = ['#002745', '#4F7489', '#B7E0DE', '#2ECC71', '#E67E22', '#C0392B']

type RangeKey = 'current_month' | 'current_week' | 'last_7' | 'last_month' | 'custom'
const RANGE_KEY = 'exception-summary-range'
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

function SummaryView({ data, config }: { data: ExceptionReport[]; config: ExceptionConfig }) {
  const [range, setRange] = useState<{ key: RangeKey; from: string; to: string }>(() => {
    try { const p = JSON.parse(localStorage.getItem(RANGE_KEY) || ''); if (p?.key) return p } catch { /* ignore */ }
    return { key: 'current_month', from: '', to: '' }
  })
  useEffect(() => { try { localStorage.setItem(RANGE_KEY, JSON.stringify(range)) } catch { /* ignore */ } }, [range])

  const [from, to] = rangeDates(range)
  const inRange = useMemo(() => data.filter((r) => {
    if (!r.date_of_finding) return false
    const d = new Date(r.date_of_finding + 'T00:00:00')
    return d >= from && d <= to
  }), [data, from, to])

  const s = useMemo(() => {
    const contactedRows = inRange.filter((r) => r.contacted)
    const yesOf = (rs: ExceptionReport[]) => rs.filter((r) => isYesResponse(r.response)).length
    const noRD = contactedRows.filter((r) => !isRdAdded(r, config.responseDays))
    const withRD = contactedRows.filter((r) => isRdAdded(r, config.responseDays))
    const perType = config.types.map((t) => {
      const typeRows = inRange.filter((r) => r.report_type === t)
      const counts = new Map<string, number>()
      for (const r of typeRows) { const k = r.issue || 'Unspecified'; counts.set(k, (counts.get(k) ?? 0) + 1) }
      return { type: t, count: typeRows.length, topIssue: mode(typeRows.filter((r) => r.issue).map((r) => r.issue!)), segments: [...counts.entries()].sort((a, b) => b[1] - a[1]) }
    })
    const times = inRange
      .filter((r) => r.date_of_finding && r.date_of_shop_action && isYesResponse(r.response))
      .map((r) => (new Date(r.date_of_shop_action! + 'T00:00:00').getTime() - new Date(r.date_of_finding! + 'T00:00:00').getTime()) / 86400000)
      .filter((d) => d >= 0)
    const overdue = inRange.filter((r) => !isYesResponse(r.response) && rdCell(r, config.responseDays).mode === 'rd').length
    return {
      total: inRange.length,
      shopsContacted: new Set(contactedRows.map((r) => r.location_id)).size,
      perType, overdue,
      rateOverall: pct(yesOf(contactedRows), contactedRows.length),
      rateNoRD: pct(yesOf(noRD), noRD.length),
      rateRD: pct(yesOf(withRD), withRD.length),
      avgTime: times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : '—',
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
        <Tile label="Total Exceptions" value={s.total} />
        <Tile label="Shops Contacted" value={s.shopsContacted} />
        <Tile label="Response Rate" value={`${s.rateOverall}%`} sub="of contacted" />
        <Tile label="Avg Response Time" value={s.avgTime === '—' ? '—' : `${s.avgTime}d`} sub="finding → response" />
        <Tile label="Response Rate — No RD Added" value={`${s.rateNoRD}%`} />
        <Tile label="Response Rate — After RD Added" value={`${s.rateRD}%`} />
        <Tile label="Overdue (no response)" value={s.overdue} sub={`> ${config.responseDays} business days`} />
      </div>

      <div className="flex flex-wrap gap-3 items-start">
        <Card className="w-fit"><CardBody>
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2">By Type</div>
          <table className="text-xs font-mono w-auto">
            <thead><tr className="text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="text-left px-2 py-0.5">Type</th><th className="text-right px-2 py-0.5">Count</th><th className="text-left px-2 py-0.5 pl-4">Most Common Issue</th>
            </tr></thead>
            <tbody>
              {s.perType.map((t) => (
                <tr key={t.type} className="border-b border-navy/10">
                  <td className="px-2 py-0.5 text-navy whitespace-nowrap">{t.type}</td>
                  <td className="px-2 py-0.5 text-right text-navy">{t.count}</td>
                  <td className="px-2 py-0.5 pl-4 text-navy whitespace-nowrap">{t.topIssue ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody></Card>

        <Card className="flex-1 min-w-[280px]"><CardBody>
          <div className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-3">Issues by Type</div>
          <IssuesByTypeChart perType={s.perType} />
        </CardBody></Card>
      </div>
    </div>
  )
}

// Horizontal stacked bars — one per report type, segmented by issue. Bar length
// is comparable across types; segments show each issue's share.
function IssuesByTypeChart({ perType }: { perType: { type: string; count: number; segments: [string, number][] }[] }) {
  const maxCount = Math.max(1, ...perType.map((t) => t.count))
  const issues = [...new Set(perType.flatMap((t) => t.segments.map(([i]) => i)))]
  const colorOf = (issue: string) => CHART_COLORS[issues.indexOf(issue) % CHART_COLORS.length]
  if (!perType.some((t) => t.count)) return <p className="text-xs font-mono text-inky/50">No data in range.</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {perType.map((t) => (
          <div key={t.type}>
            <div className="flex justify-between text-[10px] font-mono text-inky/70 mb-0.5"><span className="uppercase tracking-wide">{t.type}</span><span>{t.count}</span></div>
            <div className="h-5 w-full rounded bg-navy/5 overflow-hidden flex">
              {t.segments.map(([issue, cnt]) => (
                <div key={issue} title={`${issue}: ${cnt}`} className="h-full" style={{ width: `${(cnt / maxCount) * 100}%`, background: colorOf(issue) }} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {issues.map((issue) => (
          <span key={issue} className="inline-flex items-center gap-1 text-[10px] font-mono text-inky/70">
            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(issue) }} />{issue}
          </span>
        ))}
      </div>
    </div>
  )
}

// ── Settings ─────────────────────────────────────────────────────────────────
function SettingsView({ config, saveConfig, onImport, importing, clearAll }: {
  config: ExceptionConfig
  saveConfig: (c: ExceptionConfig) => void
  onImport: (rows: Record<string, string>[], maps: ColumnMapping[], mode: ImportMode) => Promise<void>
  importing: boolean
  clearAll: () => Promise<void>
}) {
  const [newType, setNewType] = useState('')
  const [newIssue, setNewIssue] = useState<Record<string, string>>({})
  const [newStatus, setNewStatus] = useState('')

  const addType = () => { const t = newType.trim(); if (!t || config.types.includes(t)) return; saveConfig({ ...config, types: [...config.types, t], issues: { ...config.issues, [t]: config.issues[t] ?? [] } }); setNewType('') }
  const removeType = (t: string) => saveConfig({ ...config, types: config.types.filter((x) => x !== t) })
  const addIssue = (t: string) => { const v = (newIssue[t] ?? '').trim(); if (!v) return; const cur = config.issues[t] ?? []; if (cur.includes(v)) return; saveConfig({ ...config, issues: { ...config.issues, [t]: [...cur, v] } }); setNewIssue((p) => ({ ...p, [t]: '' })) }
  const removeIssue = (t: string, v: string) => saveConfig({ ...config, issues: { ...config.issues, [t]: (config.issues[t] ?? []).filter((x) => x !== v) } })

  const addStatus = () => { const s = newStatus.trim(); if (!s || config.statuses.includes(s)) return; saveConfig({ ...config, statuses: [...config.statuses, s] }); setNewStatus('') }
  const removeStatus = (s: string) => { if (config.statuses.length <= 1) { toast.error('Keep at least one status'); return } saveConfig({ ...config, statuses: config.statuses.filter((x) => x !== s) }) }
  const moveStatus = (i: number, dir: -1 | 1) => { const j = i + dir; if (j < 0 || j >= config.statuses.length) return; const next = [...config.statuses]; [next[i], next[j]] = [next[j], next[i]]; saveConfig({ ...config, statuses: next }) }

  return (
    <div className="flex flex-col gap-6 max-w-3xl">
      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Response Window</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs font-body text-inky">Auto-flag "no response" after</span>
          <input type="number" min={1} value={config.responseDays}
            onChange={(e) => saveConfig({ ...config, responseDays: Math.max(1, Number(e.target.value) || 1) })}
            className={`${inputCls} w-16`} />
          <span className="text-xs font-body text-inky">business days (Mon–Fri) without a yes response.</span>
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Needs Action Highlighting</h3>
        <p className="text-[11px] font-mono text-inky/60">Drives the red row highlight and the nav badge count. Closed reports never count, regardless of age. Recording a Follow-Up Sent clears the highlight and restarts the Response Window above — it returns once that window lapses.</p>
        <div className="flex items-center gap-2">
          <span className="text-xs font-body text-inky">Highlight red after</span>
          <input type="number" min={1} value={config.staleDays}
            onChange={(e) => saveConfig({ ...config, staleDays: Math.max(1, Number(e.target.value) || 1) })}
            className={`${inputCls} w-16`} />
          <span className="text-xs font-body text-inky">day(s) old with no response.</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs font-body text-inky">"Bump" defers a red report for</span>
          <input type="number" min={1} value={config.bumpDays}
            onChange={(e) => saveConfig({ ...config, bumpDays: Math.max(1, Number(e.target.value) || 1) })}
            className={`${inputCls} w-16`} />
          <span className="text-xs font-body text-inky">day(s), then it highlights again.</span>
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Statuses</h3>
        <p className="text-[11px] font-mono text-inky/60">These drive the status dropdown and filter chips. Order is the workflow order (first = default for new/imported rows).</p>
        <div className="flex items-center gap-2">
          <Input value={newStatus} onChange={(e) => setNewStatus(e.target.value)} placeholder="New status" className="max-w-xs"
            onKeyDown={(e) => { if (e.key === 'Enter') addStatus() }} />
          <Button size="sm" onClick={addStatus}>Add Status</Button>
        </div>
        <div className="flex flex-col gap-1.5">
          {config.statuses.map((s, i) => (
            <div key={s} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1">
              <span className="flex-1 text-xs font-mono text-navy">{s}</span>
              <div className="flex items-center gap-0.5">
                <button onClick={() => moveStatus(i, -1)} disabled={i === 0} title="Move up"
                  className="text-inky/50 hover:text-navy disabled:opacity-25 disabled:hover:text-inky/50"><ChevronUp className="w-3.5 h-3.5" /></button>
                <button onClick={() => moveStatus(i, 1)} disabled={i === config.statuses.length - 1} title="Move down"
                  className="text-inky/50 hover:text-navy disabled:opacity-25 disabled:hover:text-inky/50"><ChevronDown className="w-3.5 h-3.5" /></button>
                <button onClick={() => removeStatus(s)} title="Remove status" className="text-inky/50 hover:text-red-500 ml-1 text-sm leading-none">×</button>
              </div>
            </div>
          ))}
        </div>
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Report Types & Issues</h3>
        <div className="flex items-center gap-2">
          <Input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="New report type" className="max-w-xs" />
          <Button size="sm" onClick={addType}>Add Type</Button>
        </div>
        {config.types.map((t) => (
          <div key={t} className="rounded border border-navy/20 p-3 flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono font-bold text-navy uppercase tracking-wide">{t}</span>
              <button onClick={() => removeType(t)} className="text-[11px] font-mono text-red-400 hover:underline">Remove type</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(config.issues[t] ?? []).map((v) => (
                <span key={v} className="inline-flex items-center gap-1 rounded-full bg-navy/[0.06] border border-navy/15 px-2 py-0.5 text-[11px] font-mono text-navy">
                  {v}<button onClick={() => removeIssue(t, v)} className="text-inky/50 hover:text-red-500">×</button>
                </span>
              ))}
              {(config.issues[t] ?? []).length === 0 && <span className="text-[11px] font-mono text-inky/40 italic">No issues yet</span>}
            </div>
            <div className="flex items-center gap-2">
              <input value={newIssue[t] ?? ''} onChange={(e) => setNewIssue((p) => ({ ...p, [t]: e.target.value }))} placeholder="Add issue…" className={`${inputCls} flex-1 max-w-xs`} />
              <Button size="sm" variant="secondary" onClick={() => addIssue(t)}>Add</Button>
            </div>
          </div>
        ))}
      </CardBody></Card>

      <Card><CardBody className="flex flex-col gap-3">
        <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Upload Exception Report File</h3>
        <p className="text-[11px] font-mono text-inky/60">Columns: Shop, Date of Finding, Exception Report (type), Issue, Details, Contacted?, Response?, RD if No, Response Notes, Status (optional — defaults to "{config.statuses[0]}").</p>
        <ConfigUpload requiredFields={UPLOAD_FIELDS} onImport={onImport} importing={importing} />
      </CardBody></Card>

      <Card><CardBody className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Danger Zone</h3>
          <p className="text-[11px] font-mono text-inky/60">Remove all exception report rows for this company.</p>
        </div>
        <ClearTableButton clearAll={clearAll} />
      </CardBody></Card>
    </div>
  )
}
