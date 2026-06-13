import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useIssueColumns } from '@/hooks/useIssueColumns'
import { Button, Badge, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
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
      className="w-full min-w-[80px] rounded border border-transparent bg-transparent px-1.5 py-0.5 text-xs font-mono text-gray-200 placeholder-gray-600 hover:border-[#2a2d3e] focus:border-[#00e5ff] focus:bg-[#0f1117] focus:outline-none" />
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
          <div className="absolute z-50 mt-1 w-40 rounded border border-[#2a2d3e] bg-[#161820] py-1 shadow-xl">
            {CUSTOM_STATUS_OPTIONS.map((s) => (
              <button key={s} onClick={() => { onSave(s); setOpen(false) }} className="flex w-full px-2 py-1 hover:bg-white/5">
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
  if (type === 'checkbox') return <input type="checkbox" checked={value === 'true'} className="accent-[#00e5ff]" onChange={(e) => onSave(e.target.checked ? 'true' : '')} />
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
      <span className="flex items-center gap-0.5 text-gray-600">
        <button onClick={() => onMove(c.id, -1)} title="Move left" className="hover:text-gray-300">◀</button>
        <button onClick={() => onMove(c.id, 1)} title="Move right" className="hover:text-gray-300">▶</button>
        <button onClick={() => onPin(c.id)} title={c.pinned ? 'Unpin' : 'Pin to left'} className={c.pinned ? 'text-[#ffb300]' : 'hover:text-gray-300'}>📌</button>
        <button onClick={() => { if (confirm(`Delete column “${c.label}”?`)) onDelete(c.id) }} title="Delete column" className="hover:text-red-400">✕</button>
      </span>
    </span>
  )
}

const BASE_COLUMNS = [
  col.accessor('title', { header: 'Title', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('location_name', { header: 'Location', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('category_name', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('status_name', { header: 'Status', cell: (i) => (<Badge color={statusColor(i.getValue())}>{i.getValue() ?? '—'}</Badge>) }),
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
      exportFilename="issues.csv" exportData={issues} loading={loading} actions={actions} />
  )
}

export function IssuesPage() {
  const { profile } = useAuthStore()
  const [searchParams] = useSearchParams()
  const defaultTab = searchParams.get('tab') === 'pending' ? 'pending' : 'all'

  const [issues, setIssues] = useState<IssueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editIssue, setEditIssue] = useState<IssueRow | null>(null)
  const [addColOpen, setAddColOpen] = useState(false)

  const issueCols = useIssueColumns()

  const openEdit = useCallback((r: IssueRow) => { setEditIssue(r); setModalOpen(true) }, [])

  const loadIssues = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const { data, error } = await supabase
      .from('issues')
      .select(`*, locations(name), issue_categories(name), issue_statuses(name)`)
      .eq('company_id', profile.company_id)
      .order('created_at', { ascending: false })
    if (error) toast.error('Failed to load issues')
    else {
      setIssues((data ?? []).map((r: any) => ({
        ...r, location_name: r.locations?.name, category_name: r.issue_categories?.name, status_name: r.issue_statuses?.name,
      })))
    }
    setLoading(false)
  }, [profile?.company_id])

  // Optimistic inline vendor edit on the issues row.
  const updateVendor = useCallback(async (id: string, val: string) => {
    const next = val || null
    setIssues((prev) => prev.map((i) => (i.id === id ? { ...i, vendor: next } : i)))
    const { error } = await (supabase as any).from('issues').update({ vendor: next }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  const { columns: customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn } = issueCols

  const columns = useMemo(() => {
    const customs = [...customColumns].sort((a, b) => a.sort_order - b.sort_order).map((c) => ({
      id: `cf_${c.id}`,
      enableSorting: false,
      enableColumnFilter: false,
      header: () => <CustomColHeader col={c} onMove={moveColumn} onPin={togglePin} onDelete={removeColumn} />,
      cell: (i: any) => <CustomCell type={c.type} value={valueFor(i.row.original.id, c.id)} onSave={(v) => setValue(i.row.original.id, c.id, v)} />,
    }))
    return [
      ...BASE_COLUMNS,
      { id: 'vendor', header: 'Vendor', enableColumnFilter: false, accessorFn: (r: IssueRow) => r.vendor ?? '', cell: (i: any) => <InlineText value={i.row.original.vendor} onSave={(v) => updateVendor(i.row.original.id, v)} /> },
      ...customs,
      { id: 'edit', header: '', enableColumnFilter: false, enableSorting: false, cell: (i: any) => (<button onClick={() => openEdit(i.row.original as IssueRow)} className="text-xs font-mono text-[#00e5ff] hover:underline">Edit</button>) },
    ]
  }, [openEdit, customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn, updateVendor])

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
          <h1 className="text-lg font-bold text-white tracking-wide uppercase">Issue Tracker</h1>
          <p className="text-xs text-gray-500 mt-0.5">Track and resolve location issues</p>
        </div>
      </div>

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
    </div>
  )
}
