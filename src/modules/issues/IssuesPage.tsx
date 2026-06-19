import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useIssueColumns } from '@/hooks/useIssueColumns'
import { Button, Badge, Modal, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { LinksCell } from '@/components/shared/LinksCell'
import { AttachmentsCell } from '@/components/shared/AttachmentsCell'
import { IssueFormModal } from './IssueFormModal'
import { AddIssueColumnModal } from './AddIssueColumnModal'
import type { Issue, IssueColumnType, IssueTrackerColumn } from '@/types'
import { differenceInDays, format } from 'date-fns'
import toast from 'react-hot-toast'

interface IssueRow extends Issue {
  location_name?: string
  category_name?: string
  status_name?: string
}

const col = createColumnHelper<IssueRow>()

function daysOpen(start: string | null) {
  if (!start) return '—'
  return String(differenceInDays(new Date(), new Date(start)))
}

const statusColor = (name: string | undefined) => {
  if (!name) return 'gray'
  const lower = name.toLowerCase()
  if (lower.includes('resolved') || lower.includes('closed')) return 'green'
  if (lower.includes('pending') || lower.includes('open')) return 'magenta'
  if (lower.includes('progress')) return 'amber'
  return 'cyan'
}

const CUSTOM_STATUS_OPTIONS = ['Not Started', 'In Progress', 'Blocked', 'Complete']
const CUSTOM_STATUS_COLOR: Record<string, 'gray' | 'cyan' | 'red' | 'green'> = {
  'Not Started': 'gray', 'In Progress': 'cyan', 'Blocked': 'red', 'Complete': 'green',
}

// --- inline cell editors (used in vendor + custom columns) -----------------
function InlineText({ value, type, onSave }: { value: string | null; type?: 'text' | 'number' | 'date'; onSave: (v: string) => void }) {
  const [v, setV] = useState(value ?? '')
  useEffect(() => { setV(value ?? '') }, [value])
  return (
    <input value={v} type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((value ?? '') !== v) onSave(v) }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      placeholder="—"
      className="w-full min-w-[80px] rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs font-mono text-navy placeholder-inky/50 hover:border-navy/30 focus:border-[#00e5ff] focus:bg-cream focus:outline-none" />
  )
}

// Expandable text cell for long-form text columns.
// Shows a "more/less" toggle only when the text is actually clipped by the column width —
// detected via DOM overflow measurement so it responds to column resizes too.
function ExpandableText({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [v, setV] = useState(value ?? '')
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setV(value ?? '') }, [value])

  // Run after every render (no deps) so column resizes are caught immediately.
  // When expanded, skip the check so canExpand is preserved for the "less" button.
  // React bails out of re-render when setCanExpand receives the same value, so this
  // settles after at most one extra render per change and doesn't loop.
  useLayoutEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    setCanExpand(el.scrollHeight > el.clientHeight + 1)
  })

  const text = value ?? ''
  if (editing) {
    return (
      <textarea autoFocus value={v} onChange={(e) => setV(e.target.value)}
        onBlur={() => { setEditing(false); if ((value ?? '') !== v) onSave(v) }}
        rows={3}
        className="w-full resize-y rounded border border-[#00e5ff] bg-cream px-1.5 py-1 text-xs font-mono text-navy focus:outline-none" />
    )
  }
  return (
    <div className="px-1 whitespace-normal">
      <div
        ref={textRef}
        onClick={() => setEditing(true)}
        className={['cursor-text text-xs font-mono', text ? 'text-navy' : 'text-inky/40', expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-1'].join(' ')}
      >
        {text || '—'}
      </div>
      {(canExpand || expanded) && (
        <button onClick={() => setExpanded((e) => !e)} className="mt-0.5 text-[10px] font-mono text-inky hover:underline">
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

function InlineStatus({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const v = value || 'Not Started'
  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen((o) => !o)}><Badge color={CUSTOM_STATUS_COLOR[v] ?? 'gray'}>{v}</Badge></button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-40 rounded border border-navy/30 bg-cream py-1 shadow-xl">
            {CUSTOM_STATUS_OPTIONS.map((s) => (
              <button key={s} onClick={() => { onSave(s); setOpen(false) }} className="flex w-full px-2 py-1 hover:bg-navy/5">
                <Badge color={CUSTOM_STATUS_COLOR[s]}>{s}</Badge>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function CustomCell({ type, value, onSave }: { type: IssueColumnType; value: string | null; onSave: (v: string | null) => void }) {
  if (type === 'status') return <InlineStatus value={value} onSave={onSave} />
  if (type === 'checkbox') return <input type="checkbox" checked={value === 'true'} className="accent-inky" onChange={(e) => onSave(e.target.checked ? 'true' : '')} />
  return <InlineText value={value} type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} onSave={(v) => onSave(v || null)} />
}

function CustomColHeader({ col: c, onMove, onPin, onDelete }: {
  col: IssueTrackerColumn
  onMove: (id: string, dir: -1 | 1) => void
  onPin: (id: string) => void
  onDelete: (id: string) => void
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="truncate">{c.label}</span>
      <span className="flex items-center gap-0.5 text-inky/70">
        <button onClick={() => onMove(c.id, -1)} title="Move left" className="hover:text-navy">◀</button>
        <button onClick={() => onMove(c.id, 1)} title="Move right" className="hover:text-navy">▶</button>
        <button onClick={() => onPin(c.id)} title={c.pinned ? 'Unpin' : 'Pin to left'} className={c.pinned ? 'text-orange-600' : 'hover:text-navy'}>📌</button>
        <button onClick={() => { if (confirm(`Delete column “${c.label}”?`)) onDelete(c.id) }} title="Delete column" className="hover:text-red-400">✕</button>
      </span>
    </span>
  )
}

interface StatusOpt { id: string; name: string }

// Inline status: badge button + fixed-position dropdown (escapes the grid's
// overflow clip) writing status_id.
function IssueStatusCell({ name, statuses, onChange, onAdd }: { name: string | undefined; statuses: StatusOpt[]; onChange: (statusId: string) => void; onAdd: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  function toggle() {
    if (!open && btnRef.current) { const r = btnRef.current.getBoundingClientRect(); setRect({ left: r.left, top: r.bottom + 4 }) }
    setOpen((o) => !o)
  }
  async function addNew() {
    const n = prompt('New status name')?.trim()
    setOpen(false)
    if (!n) return
    const id = await onAdd(n)
    if (id) onChange(id)
  }
  return (
    <>
      <button ref={btnRef} onClick={toggle}><Badge color={statusColor(name)}>{name ?? '—'}</Badge></button>
      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div className="fixed z-[61] w-44 rounded border border-navy/30 bg-cream py-1 shadow-xl" style={{ left: rect.left, top: rect.top }}>
            {statuses.map((s) => (
              <button key={s.id} onClick={() => { onChange(s.id); setOpen(false) }} className="flex w-full px-2 py-1 hover:bg-navy/5">
                <Badge color={statusColor(s.name)}>{s.name}</Badge>
              </button>
            ))}
            <button onClick={addNew} className="flex w-full px-2 py-1 text-xs font-mono text-inky hover:bg-navy/5">＋ add status…</button>
          </div>
        </>
      )}
    </>
  )
}

const BASE_BEFORE = [
  col.accessor('title', { header: 'Title', enableColumnFilter: false, meta: { noClip: true }, cell: (i) => <ExpandableText value={i.getValue() ?? ''} onSave={() => {}} /> }),
  col.accessor('location_name', { header: 'Location', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('category_name', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
]
const BASE_AFTER = [
  col.accessor('start_date', { header: 'Start', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('target_resolution_date', { header: 'Target', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('resolved_date', { header: 'Resolved', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('start_date', { id: 'days_open', header: 'Days Open', cell: (i) => daysOpen(i.getValue()) }),
]

// Hoisted to module scope — see git history; defining inside the page remounted
// the table subtree on each render and swallowed the "+ New Issue" click.
function IssuesTable({ table, filter, onFilterChange, issues, loading, actions }: {
  table: any; filter: string; onFilterChange: (v: string) => void; issues: IssueRow[]; loading: boolean; actions: React.ReactNode
}) {
  return (
    <DataTable table={table} globalFilter={filter} onGlobalFilterChange={onFilterChange}
      exportFilename="issues.csv" exportData={issues} loading={loading} actions={actions}
      attachmentEntityType="issue" />
  )
}

export function IssuesPage() {
  const { profile } = useAuthStore()
  const [searchParams] = useSearchParams()
  const defaultTab = searchParams.get('tab') === 'pending' ? 'pending' : 'all'

  const [issues, setIssues] = useState<IssueRow[]>([])
  const [deletedIssues, setDeletedIssues] = useState<IssueRow[]>([])
  const [showDeleted, setShowDeleted] = useState(false)
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editIssue, setEditIssue] = useState<IssueRow | null>(null)
  const [addColOpen, setAddColOpen] = useState(false)
  const [statuses, setStatuses] = useState<StatusOpt[]>([])
  const [deleteTarget, setDeleteTarget] = useState<IssueRow | null>(null)

  const issueCols = useIssueColumns()

  const openEdit = useCallback((r: IssueRow) => { setEditIssue(r); setModalOpen(true) }, [])

  const loadIssues = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    // Purge issues older than 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    void (supabase as any).from('issues').delete().eq('company_id', profile.company_id).lt('deleted_at', cutoff).not('deleted_at', 'is', null)

    const [liveRes, delRes] = await Promise.all([
      supabase.from('issues').select(`*, locations(name), issue_categories(name), issue_statuses(name)`).eq('company_id', profile.company_id).is('deleted_at', null).order('created_at', { ascending: false }),
      (supabase as any).from('issues').select(`*, locations(name), issue_categories(name), issue_statuses(name)`).eq('company_id', profile.company_id).not('deleted_at', 'is', null).order('deleted_at', { ascending: false }),
    ])
    if (liveRes.error) toast.error('Failed to load issues')
    else {
      const map = (data: any[]) => (data ?? []).map((r: any) => ({
        ...r, location_name: r.locations?.name, category_name: r.issue_categories?.name, status_name: r.issue_statuses?.name,
      }))
      setIssues(map(liveRes.data ?? []))
      setDeletedIssues(map(delRes.data ?? []))
    }
    setLoading(false)
  }, [profile?.company_id])

  const updateLinks = useCallback(async (id: string, links: string[]) => {
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, helpful_links: links } : i)))
    const { error } = await (supabase as any).from('issues').update({ helpful_links: links }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  // Optimistic inline vendor edit on the issues row.
  const updateVendor = useCallback(async (id: string, val: string) => {
    const next = val || null
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, vendor: next } : i)))
    const { error } = await (supabase as any).from('issues').update({ vendor: next }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  // Optimistic inline edit for status / resolution notes (dbPatch writes the row;
  // localPatch carries derived display fields like status_name).
  const updateIssue = useCallback(async (id: string, dbPatch: Record<string, unknown>, localPatch: Partial<IssueRow> = {}) => {
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, ...dbPatch, ...localPatch } : i)))
    const { error } = await (supabase as any).from('issues').update(dbPatch).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  // Load the company's issue statuses for the inline dropdown.
  useEffect(() => {
    if (!profile?.company_id) return
    ;(supabase as any).from('issue_statuses').select('id, name').eq('company_id', profile.company_id)
      .then(({ data }: any) => setStatuses((data ?? []) as StatusOpt[]))
  }, [profile?.company_id])

  // Create a new status inline (no full dialog) and add it to the dropdown.
  const addStatus = useCallback(async (name: string): Promise<string | null> => {
    if (!profile?.company_id) return null
    const { data, error } = await (supabase as any).from('issue_statuses').insert({ company_id: profile.company_id, name }).select().single()
    if (error || !data) { toast.error(error?.message ?? 'Could not add status'); return null }
    setStatuses((prev) => [...prev, { id: data.id, name: data.name }])
    return data.id as string
  }, [profile?.company_id])

  const { columns: customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn } = issueCols

  const columns = useMemo(() => {
    const customs = [...customColumns].sort((a, b) => a.sort_order - b.sort_order).map((c) => ({
      id: `cf_${c.id}`,
      enableSorting: false,
      enableColumnFilter: false,
      header: () => <CustomColHeader col={c} onMove={moveColumn} onPin={togglePin} onDelete={removeColumn} />,
      cell: (i: any) => <CustomCell type={c.type} value={valueFor(i.row.original.id, c.id)} onSave={(v) => setValue(i.row.original.id, c.id, v)} />,
    }))
    const statusCol = {
      id: 'status', header: 'Status', enableColumnFilter: false, accessorFn: (r: IssueRow) => r.status_name ?? '',
      cell: (i: any) => <IssueStatusCell name={i.row.original.status_name} statuses={statuses} onAdd={addStatus} onChange={(sid) => updateIssue(i.row.original.id, { status_id: sid }, { status_name: statuses.find((s) => s.id === sid)?.name })} />,
    }
    const issueNotesCol = {
      id: 'issue_notes', header: 'Issue Notes', enableColumnFilter: false, enableSorting: false, meta: { noClip: true }, accessorFn: (r: IssueRow) => r.issue_notes ?? '',
      cell: (i: any) => <ExpandableText value={i.row.original.issue_notes} onSave={(v) => updateIssue(i.row.original.id, { issue_notes: v || null })} />,
    }
    const notesCol = {
      id: 'resolution_notes', header: 'Resolution Notes', enableColumnFilter: false, enableSorting: false, meta: { noClip: true }, accessorFn: (r: IssueRow) => r.resolution_notes ?? '',
      cell: (i: any) => <ExpandableText value={i.row.original.resolution_notes} onSave={(v) => updateIssue(i.row.original.id, { resolution_notes: v || null })} />,
    }
    const linksCol = {
      id: 'helpful_links', header: 'Helpful Links', enableColumnFilter: false, enableSorting: false, meta: { noClip: true },
      accessorFn: (r: IssueRow) => r.helpful_links?.join(' ') ?? '',
      cell: (i: any) => <LinksCell links={i.row.original.helpful_links ?? []} onSave={(links) => updateLinks(i.row.original.id, links)} />,
    }
    const attachmentsCol = {
      id: 'attachments', header: '📎', enableColumnFilter: false, enableSorting: false,
      cell: (i: any) => <AttachmentsCell entityType="issue" entityId={i.row.original.id} companyId={profile?.company_id ?? ''} />,
    }

    // Only add the built-in Issue Notes column if the user hasn't already created
    // a custom column with that name via "+ Add Column".
    const hasCustomIssueNotes = customColumns.some((c) => c.label.toLowerCase() === 'issue notes')
    return [
      ...BASE_BEFORE,
      statusCol,
      ...BASE_AFTER,
      { id: 'vendor', header: 'Vendor', enableColumnFilter: false, accessorFn: (r: IssueRow) => r.vendor ?? '', cell: (i: any) => <InlineText value={i.row.original.vendor} onSave={(v) => updateVendor(i.row.original.id, v)} /> },
      ...customs,
      ...(hasCustomIssueNotes ? [] : [issueNotesCol]),
      notesCol,
      linksCol,
      attachmentsCol,
      { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => (
        <div className="flex items-center gap-2">
          <button onClick={() => openEdit(i.row.original as IssueRow)} className="text-xs font-mono text-inky hover:underline">Edit</button>
          <button onClick={() => setDeleteTarget(i.row.original as IssueRow)} className="text-xs font-mono text-red-400 hover:underline">Delete</button>
        </div>
      )},
    ]
  }, [openEdit, customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn, updateVendor, updateIssue, updateLinks, statuses, addStatus, profile?.company_id])

  const allTable = useTable(issues, columns)
  const pendingTable = useTable(issues.filter((i) => { const s = i.status_name?.toLowerCase() ?? ''; return s.includes('pending') || s.includes('open') }), columns)
  const resolvedTable = useTable(issues.filter((i) => { const s = i.status_name?.toLowerCase() ?? ''; return s.includes('resolved') || s.includes('closed') }), columns)

  // Apply pinned custom columns (true sticky) to every tab's table.
  const pinnedIds = useMemo(() => customColumns.filter((c) => c.pinned).map((c) => `cf_${c.id}`), [customColumns])
  const { setColumnPinning: setAllPin } = allTable
  const { setColumnPinning: setPendPin } = pendingTable
  const { setColumnPinning: setResPin } = resolvedTable
  useEffect(() => {
    const p = { left: pinnedIds, right: [] }
    setAllPin(p); setPendPin(p); setResPin(p)
  }, [pinnedIds, setAllPin, setPendPin, setResPin])

  useEffect(() => {
    if (!profile?.company_id) return
    loadIssues()
    const channel = supabase
      .channel('issues-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues', filter: `company_id=eq.${profile.company_id}` }, () => loadIssues())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [profile?.company_id, loadIssues])

  async function softDeleteIssue(id: string) {
    const { error } = await (supabase as any).from('issues').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Issue moved to deleted items')
    setDeleteTarget(null)
    loadIssues()
  }

  async function restoreIssue(id: string) {
    const { error } = await (supabase as any).from('issues').update({ deleted_at: null }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Issue restored')
    loadIssues()
  }

  async function hardDeleteIssue(id: string) {
    const { error } = await (supabase as any).from('issues').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Issue permanently deleted')
    loadIssues()
  }

  const onNew = () => { setEditIssue(null); setModalOpen(true) }
  const actions = (
    <>
      <Button size="sm" onClick={onNew}>+ New Issue</Button>
      <Button size="sm" variant="secondary" onClick={() => setAddColOpen(true)}>+ Add Column</Button>
    </>
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Issue Tracker</h1>
          <p className="text-xs text-inky mt-0.5">Track and resolve location issues</p>
        </div>
        {deletedIssues.length > 0 && (
          <button
            onClick={() => setShowDeleted((v) => !v)}
            className="text-xs font-mono text-inky/60 hover:text-navy underline decoration-dotted"
          >
            {showDeleted ? 'Hide deleted' : `Show deleted (${deletedIssues.length})`}
          </button>
        )}
      </div>

      {/* Deleted issues panel */}
      {showDeleted && deletedIssues.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50/40">
          <div className="px-4 py-2 border-b border-red-200">
            <span className="text-xs font-mono text-red-600 uppercase tracking-wide font-bold">Deleted Issues</span>
            <span className="text-[10px] font-mono text-red-400 ml-2">— auto-purge after 30 days</span>
          </div>
          <ul className="divide-y divide-red-100">
            {deletedIssues.map((issue) => (
              <li key={issue.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 text-sm font-body text-inky/60 line-through">{issue.title ?? '(untitled)'}</span>
                <span className="text-[10px] font-mono text-inky/40">
                  {issue.deleted_at ? format(new Date(issue.deleted_at), 'MMM d, yyyy') : ''}
                </span>
                <button onClick={() => restoreIssue(issue.id)} className="text-xs font-mono text-sky hover:underline">Restore</button>
                <button onClick={() => { if (confirm('Permanently delete this issue?')) hardDeleteIssue(issue.id) }} className="text-xs font-mono text-red-400 hover:underline">Delete Forever</button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="all">All Issues ({issues.length})</TabsTrigger>
          <TabsTrigger value="pending">Pending ({pendingTable.table.getCoreRowModel().rows.length})</TabsTrigger>
          <TabsTrigger value="resolved">Resolved ({resolvedTable.table.getCoreRowModel().rows.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="all">
          <IssuesTable table={allTable.table} filter={allTable.globalFilter} onFilterChange={allTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} />
        </TabsContent>
        <TabsContent value="pending">
          <IssuesTable table={pendingTable.table} filter={pendingTable.globalFilter} onFilterChange={pendingTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} />
        </TabsContent>
        <TabsContent value="resolved">
          <IssuesTable table={resolvedTable.table} filter={resolvedTable.globalFilter} onFilterChange={resolvedTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} />
        </TabsContent>
      </Tabs>

      <IssueFormModal open={modalOpen} onClose={() => { setModalOpen(false); setEditIssue(null) }} existing={editIssue} onSaved={loadIssues} />
      <AddIssueColumnModal open={addColOpen} onClose={() => setAddColOpen(false)} existingColumns={customColumns} onAdd={issueCols.addColumn} />

      {/* Delete confirmation */}
      {deleteTarget && (
        <Modal open onClose={() => setDeleteTarget(null)} title="Delete Issue?">
          <div className="flex flex-col gap-4">
            <p className="text-sm font-body text-navy">
              Delete <span className="font-bold">"{deleteTarget.title ?? 'this issue'}"</span>?
            </p>
            <p className="text-xs font-mono text-inky/70">The issue will be kept for 30 days and can be restored before that.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={() => softDeleteIssue(deleteTarget.id)}>Delete</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
