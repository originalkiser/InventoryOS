// Shared inline-editable table for Exception Reporting's Alerts/Reports/
// Automated Checks/Test-AutoExceptions tabs — full rewrite 2026-09-25 (was
// a fully hand-rolled <table> with no sort/filter/pagination/column
// manager/resize/pin at all) onto this app's standard useTable/DataTable
// infrastructure, matching the same TanStack-based approach
// PoReceiptAlertsTab.tsx already uses. Column resizing and left-pinning
// were ALREADY built into useTable/DataTable (just missing persistence and
// a pin UI, both added alongside this file — see useColumnPrefs.ts and
// ColumnManagerModal.tsx's own updated header comments) — this is the
// first table in the app to actually turn all of that on.
//
// Direct feedback 2026-09-25, all addressed here:
//   - color-coded status (pending-on-someone-else orange, pending-
//     procurement yellow, closed/tentatively-closed two shades of green)
//   - click anywhere in a row that isn't a data-entry field opens full
//     edit, not just the pencil (DataTable's own onRowClick guard was
//     extended to also exclude select/textarea/label, not just
//     input/button/a — see that file's own comment)
//   - Area Manager is now a creatable combobox seeded from the location
//     list's own real area_manager values, not a bare text box
//   - dropdown/select outlines are always visible, not hover-only
//   - Details/Response Notes get a collapsed 2-line preview + "More" +, once
//     expanded, a genuinely resize-y textarea (a plain textarea's own
//     native corner-drag handle — the old table's max-h-11 overflow-y-auto
//     wrapper was clipping this even though AutoTextarea already supported
//     resizing underneath it)
//   - Manage Columns (reusing Locations' own ColumnManagerModal, extended
//     with a pin toggle), pagination defaulting to 25/page, and Excel-style
//     per-column filters all come for free from DataTable/useTable once a
//     table actually uses them
//
// Status + Shop are still the first two columns by default, but are no
// longer hardcoded/un-reorderable — they're just left-pinned via the same
// mechanism every other column can now opt into.
import { useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import { Pencil } from 'lucide-react'
import { Combobox } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { ColumnManagerModal, type ColItem } from '@/modules/locations/ColumnManagerModal'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { useLocations } from '@/hooks/useLocations'
import { EditText, EditDate, EditSelect, inputCls } from '@/components/shared/InlineCells'
import { ImpactedProductsPicker } from './ImpactedProductsPicker'
import {
  RESPONSE_YES, RESPONSE_YES_RD, RESPONSE_NO,
  isYesResponse, rdCell, impactedProducts, followUpDate, isExceptionStale,
  type ExceptionReport, type ExceptionConfig,
} from './exceptions'
import { bumpedUntilISO, STALE_ROW_BG } from '@/lib/staleness'
import { format } from 'date-fns'

const stripHtml = (s: string | null) => (s ? s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : '')
const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

// Direct feedback 2026-09-25: pending-on-someone-else orange, pending-
// procurement yellow, closed/tentatively-closed two shades of green.
// Yellow is a genuinely NEW off-palette color (#F1C40F) — this app's
// existing 3 off-palette exceptions (red/green/orange, see CLAUDE.md's
// Brand section) don't cover 3 distinct semantic buckets without reusing
// orange for two different meanings, so this adds one. Flagged to the
// user rather than silently decided — swap this hex if a different
// yellow (or an existing token instead) is preferred.
function statusRowClass(status: string | null): string {
  const s = (status ?? '').toLowerCase()
  if (s.includes('procurement')) return 'bg-[#F1C40F]/[0.18]'
  if (s.includes('tentatively closed')) return 'bg-[#2ECC71]/[0.14]'
  if (s.includes('closed')) return 'bg-[#2ECC71]/[0.28]'
  if (s) return 'bg-[#E67E22]/[0.14]' // any other non-empty status = pending on someone else
  return ''
}

// Collapsed 2-line preview + "More" — expands into a genuinely resize-y
// textarea (native corner-drag), replacing the old max-h-11 overflow-y-auto
// wrapper that was clipping AutoTextarea's own resize support entirely.
function ExpandableTextCell({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  const isLong = value.length > 50 || value.includes('\n')
  if (!expanded) {
    return (
      <div className="flex items-start gap-1.5 max-w-[240px]">
        <span className="line-clamp-2 text-xs font-mono text-navy">{value || <span className="text-inky/40 italic">—</span>}</span>
        {isLong && <button onClick={() => setExpanded(true)} className="text-[10px] font-mono text-sky hover:underline flex-shrink-0 mt-0.5">More</button>}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1">
      <textarea value={v} onChange={(e) => setV(e.target.value)} autoFocus rows={3}
        onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
        className={`${inputCls} w-60 resize-y min-h-[4rem]`} />
      <button onClick={() => setExpanded(false)} className="self-start text-[10px] font-mono text-inky/60 hover:underline">Collapse</button>
    </div>
  )
}

// Prefilled from the location's own configured area_manager, editable via a
// creatable combobox seeded from every distinct AM name already on the
// location list — direct feedback 2026-09-25 ("instead of a text box, have
// it be a dropdown... with the option to type in a name that may be
// missing"). The row's own current value is always included as an option
// even if it's not one of the "real" AM names on file (a departed AM, a
// typo, etc.) — otherwise Combobox would show blank for it, since it only
// ever displays the label of a value it recognizes.
function AreaManagerCell({ value, options, onSave }: { value: string | null; options: string[]; onSave: (v: string | null) => void }) {
  const opts = useMemo(() => {
    const names = value && !options.includes(value) ? [value, ...options] : options
    return names.map((n) => ({ value: n, label: n }))
  }, [value, options])
  return (
    <Combobox
      value={value ?? ''}
      options={opts}
      onChange={(v) => onSave(v || null)}
      allowCreate
      onCreateOption={(label) => ({ value: label, label })}
      placeholder="—"
    />
  )
}

function ResponseCell({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const opts: [string, string][] = [['Yes', RESPONSE_YES], ['+RD', RESPONSE_YES_RD], ['No', RESPONSE_NO]]
  return (
    <div className="inline-flex rounded border border-navy/30 overflow-hidden text-[10px] font-mono">
      {opts.map(([label, v]) => (
        <button key={v} onClick={() => onSave(value === v ? null : v)}
          className={['px-1.5 py-0.5 transition-colors', value === v ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
          {label}
        </button>
      ))}
    </div>
  )
}

const TABLE_KEY = 'exceptions.exception_reports'
const DEFAULT_SHOWN = [
  'status', 'shop', 'finding', 'area_manager', 'type', 'issue', 'products', 'details',
  'contacted', 'follow_up', 'response', 'response_date', 'rd', 'response_notes',
]
const DEFAULT_PINNED = ['status', 'shop']

export function ExceptionTable({ rows, config, shopLabel, regionalDirector, companyId, onSet, onEdit, onQuick, tableKey }: {
  rows: ExceptionReport[]
  config: ExceptionConfig
  shopLabel: (id: string | null) => string
  regionalDirector: (id: string | null) => string
  companyId: string | null
  onSet: (r: ExceptionReport, patch: Partial<ExceptionReport>) => void
  onEdit: (r: ExceptionReport) => void
  onQuick: (r: ExceptionReport, opts: { responseDate?: string | null; status?: string | null }) => void
  // Alerts/Reports/Automated/Test-AutoExceptions each get their own
  // persisted layout (column order/width/pins/page size) rather than
  // sharing one — they're meaningfully different views (Test-Auto rarely
  // needs Response/Response Notes visible the same way Reports does).
  tableKey?: string
}) {
  const loc = useLocations()
  const [columnManagerOpen, setColumnManagerOpen] = useState(false)

  const amOptions = useMemo(
    () => [...new Set(loc.locations.map((l) => loc.fieldValue(l.id, 'area_manager')).filter(Boolean))].sort(),
    [loc],
  )

  const col = useMemo(() => createColumnHelper<ExceptionReport>(), [])
  const columns = useMemo(() => [
    col.accessor('status', {
      header: 'Status',
      cell: (i) => {
        const r = i.row.original
        const stale = isExceptionStale(r, config.staleDays, config.responseDays)
        return (
          <div className="flex flex-col gap-1 min-w-[190px]">
            <div className="flex items-center gap-1">
              <button onClick={(e) => { e.stopPropagation(); onEdit(r) }} title="Full edit" className="text-inky hover:text-navy flex-shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
              <EditSelect value={r.status} options={config.statuses} placeholder="—" allowCurrent
                onSave={(v) => { onSet(r, { status: v }); if ((v ?? '').toLowerCase().includes('closed')) onQuick(r, { status: v }) }} />
            </div>
            {stale && (
              <button onClick={(e) => { e.stopPropagation(); onSet(r, { metadata: { ...(r.metadata ?? {}), bumped_until: bumpedUntilISO(config.bumpDays) } }) }}
                title={`Defer ${config.bumpDays} more day(s)`}
                className="self-start flex-shrink-0 text-[10px] font-mono text-[#C0392B] border border-[#C0392B]/40 rounded px-1 py-0.5 hover:bg-[#C0392B]/10">
                Bump
              </button>
            )}
          </div>
        )
      },
    }),
    col.accessor((r) => shopLabel(r.location_id), { id: 'shop', header: 'Shop' }),
    col.accessor('date_of_finding', { id: 'finding', header: 'Finding', cell: (i) => <EditDate value={i.getValue()} onSave={(v) => onSet(i.row.original, { date_of_finding: v })} /> }),
    col.accessor('area_manager', {
      id: 'area_manager', header: 'Area Manager',
      cell: (i) => <AreaManagerCell value={i.getValue()} options={amOptions} onSave={(v) => onSet(i.row.original, { area_manager: v })} />,
    }),
    col.accessor('report_type', { id: 'type', header: 'Type', cell: (i) => <EditSelect value={i.getValue()} options={config.types} placeholder="—" onSave={(v) => onSet(i.row.original, { report_type: v })} /> }),
    col.accessor('issue', {
      header: 'Issue',
      cell: (i) => <EditSelect value={i.getValue()} options={config.issues[i.row.original.report_type ?? ''] ?? []} placeholder="—" allowCurrent onSave={(v) => onSet(i.row.original, { issue: v })} />,
    }),
    col.accessor((r) => impactedProducts(r).join(', '), {
      id: 'products', header: 'Impacted Products', enableSorting: false,
      cell: (i) => <ImpactedProductsPicker compact companyId={companyId} locationId={i.row.original.location_id} selected={impactedProducts(i.row.original)}
        onChange={(ids) => onSet(i.row.original, { metadata: { ...(i.row.original.metadata ?? {}), impacted_products: ids } })} />,
    }),
    col.accessor((r) => stripHtml(r.details), {
      id: 'details', header: 'Details',
      cell: (i) => <ExpandableTextCell value={i.getValue()} onSave={(v) => onSet(i.row.original, { details: v })} />,
    }),
    col.accessor('contacted', {
      id: 'contacted', header: 'Contacted',
      cell: (i) => {
        const r = i.row.original
        return (
          <div className="flex items-center gap-1">
            <input type="checkbox" checked={r.contacted} onChange={(e) => onSet(r, { contacted: e.target.checked })} className="accent-sky" />
            {r.contacted && <EditDate value={r.contacted_date} onSave={(v) => onSet(r, { contacted_date: v })} />}
          </div>
        )
      },
    }),
    col.accessor((r) => followUpDate(r), {
      id: 'follow_up', header: 'Follow-Up Sent',
      cell: (i) => <EditDate value={followUpDate(i.row.original)} title="Date a follow-up was sent — restarts the response window"
        onSave={(v) => onSet(i.row.original, { metadata: { ...(i.row.original.metadata ?? {}), follow_up_date: v } })} />,
    }),
    col.accessor('response', { header: 'Response', cell: (i) => <ResponseCell value={i.getValue()} onSave={(v) => onSet(i.row.original, { response: v })} /> }),
    col.accessor('date_of_shop_action', {
      id: 'response_date', header: 'Response Date',
      cell: (i) => {
        const r = i.row.original
        return isYesResponse(r.response)
          ? <EditDate value={r.date_of_shop_action} onSave={(v) => { onSet(r, { date_of_shop_action: v }); if (v) onQuick(r, { responseDate: v }) }} />
          : <span className="text-inky/30">—</span>
      },
    }),
    col.accessor((r) => regionalDirector(r.location_id), {
      id: 'rd', header: 'Regional Director', enableSorting: false,
      cell: (i) => {
        const r = i.row.original
        const info = rdCell(r, config.responseDays)
        return info.mode === 'left' ? <span className="text-[10px] font-mono text-inky/70">{info.daysLeft}d left</span>
          : info.mode === 'rd' ? <span className="text-navy">{regionalDirector(r.location_id) || '—'}</span>
          : <span className="text-inky/40">—</span>
      },
    }),
    col.accessor((r) => stripHtml(r.response_notes), {
      id: 'response_notes', header: 'Response Notes',
      cell: (i) => <ExpandableTextCell value={i.getValue()} onSave={(v) => onSet(i.row.original, { response_notes: v })} />,
    }),
  ], [col, config, companyId, amOptions, onSet, onEdit, onQuick, shopLabel, regionalDirector])

  const persistKey = tableKey ?? TABLE_KEY
  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder, columnPinning, setColumnPinning } = useTable(rows, columns, {
    persistKey,
    initialPageSize: 25,
    initialColumnPinning: { left: DEFAULT_PINNED, right: [] },
  })
  useColumnPrefs(persistKey, table, columnVisibility, columnOrder, setColumnOrder)

  const allColItems: ColItem[] = useMemo(
    () => table.getAllLeafColumns().map((c) => ({ id: c.id, label: String(c.columnDef.header ?? c.id) })),
    [table],
  )
  const shownOrder = useMemo(() => {
    const ids = table.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return ids
    const known = columnOrder.filter((id) => ids.includes(id))
    return [...known, ...ids.filter((id) => !known.includes(id))]
  }, [table, columnOrder])

  function applyShown(shown: string[]) {
    setColumnOrder(shown)
    const vis: Record<string, boolean> = {}
    for (const c of allColItems) vis[c.id] = shown.includes(c.id)
    table.setColumnVisibility(vis)
  }
  function resetColumns() {
    setColumnOrder([])
    table.setColumnVisibility({})
    table.setColumnSizing({})
    setColumnPinning({ left: DEFAULT_PINNED, right: [] })
  }

  if (!rows.length) return <p className="text-xs font-mono text-inky/50 py-8">No exception reports for this filter.</p>

  return (
    <>
      <DataTable
        table={table}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        exportFilename="Exception Reports"
        onRowClick={onEdit}
        hideColumnControl
        getRowClassName={(r) => (isExceptionStale(r, config.staleDays, config.responseDays) ? STALE_ROW_BG : statusRowClass(r.status))}
        actions={<button onClick={() => setColumnManagerOpen(true)} className="text-xs font-mono text-inky border border-navy/30 rounded px-2 py-1 hover:border-navy">Manage Columns</button>}
      />
      <ColumnManagerModal
        open={columnManagerOpen}
        onClose={() => setColumnManagerOpen(false)}
        all={allColItems.filter((c) => c.id !== 'select')}
        shown={shownOrder.filter((id) => id !== 'select')}
        onChange={applyShown}
        onReset={resetColumns}
        pinned={columnPinning.left ?? []}
        onPinChange={(left) => setColumnPinning({ left, right: [] })}
      />
    </>
  )
}
