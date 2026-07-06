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
import { IssueImportModal } from './IssueImportModal'
import { isAdminOrDeveloper } from '@/lib/roles'
import type { Issue, IssueColumnType, IssueTrackerColumn, Department } from '@/types'
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

const BUILT_IN_COL_DEFS = [
  { id: 'department', label: 'Department' },
  { id: 'location_name', label: 'Location' },
  { id: 'category_name', label: 'Category' },
  { id: 'status', label: 'Status' },
  { id: 'start_date', label: 'Start Date' },
  { id: 'target_resolution_date', label: 'Target' },
  { id: 'resolved_date', label: 'Resolved' },
  { id: 'days_open', label: 'Days Open' },
  { id: 'vendor', label: 'Vendor' },
  { id: 'issue_notes', label: 'Issue Notes' },
  { id: 'resolution_notes', label: 'Resolution Notes' },
  { id: 'helpful_links', label: 'Helpful Links' },
  { id: 'attachments', label: 'Attachments' },
]

// --- inline cell editors ---------------------------------------------------

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

function InlineDate({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input autoFocus type="date" defaultValue={value ?? ''}
        className="rounded border border-sky/60 px-1.5 py-0.5 text-xs font-mono text-navy bg-cream focus:outline-none"
        onBlur={(e) => { setEditing(false); onSave(e.target.value || null) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(false)
        }}
      />
    )
  }
  return (
    <button onClick={() => setEditing(true)} className="text-xs font-mono text-left px-1 hover:text-navy w-full">
      {value ? format(new Date(value + 'T00:00:00'), 'MMM d, yyyy') : <span className="text-inky/30">—</span>}
    </button>
  )
}

// Options are read via getOptions() at call time so the component never needs
// to remount when the options list changes (avoids closing an open dropdown).
function InlineCombobox({ getOptions, value, onSave, onCreateOption }: {
  getOptions: () => { value: string; label: string }[]
  value: string | null
  onSave: (v: string | null, label?: string) => void
  onCreateOption?: (name: string) => Promise<{ value: string; label: string } | null>
}) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  const options = getOptions()
  const label = options.find(o => o.value === value)?.label

  function toggle() {
    if (!open && btnRef.current) { const r = btnRef.current.getBoundingClientRect(); setRect({ left: r.left, top: r.bottom + 2 }) }
    setOpen(o => !o)
  }

  async function handleCreate() {
    const n = newName.trim()
    if (!n || !onCreateOption) return
    const result = await onCreateOption(n)
    if (result) { onSave(result.value, result.label); setOpen(false); setCreating(false); setNewName('') }
  }

  return (
    <>
      <button ref={btnRef} onClick={toggle} className="text-xs font-mono text-left px-1 hover:text-navy w-full">
        {label ?? <span className="text-inky/30">—</span>}
      </button>
      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => { setOpen(false); setCreating(false); setNewName('') }} />
          <div className="fixed z-[61] w-52 rounded border border-navy/30 bg-cream py-0.5 shadow-xl max-h-56 overflow-y-auto"
            style={{ left: rect.left, top: rect.top }}>
            <button onClick={() => { onSave(null); setOpen(false) }}
              className="flex w-full px-2 py-1 text-xs font-mono text-inky/40 hover:bg-navy/5 text-left">— None</button>
            {options.map(o => (
              <button key={o.value} onClick={() => { onSave(o.value, o.label); setOpen(false) }}
                className={['flex w-full px-2 py-1 text-xs font-mono hover:bg-navy/5 text-left', o.value === value ? 'text-sky font-bold' : 'text-navy'].join(' ')}>
                {o.label}
              </button>
            ))}
            {onCreateOption && (
              <>
                <div className="border-t border-navy/10 my-0.5" />
                {creating ? (
                  <div className="px-2 py-1 flex gap-1" onClick={e => e.stopPropagation()}>
                    <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
                      placeholder="Name…"
                      className="flex-1 min-w-0 rounded border border-sky/60 px-1.5 py-0.5 text-xs font-mono text-navy bg-cream focus:outline-none" />
                    <button onClick={handleCreate} className="text-xs font-mono text-navy px-1 hover:text-sky">✓</button>
                  </div>
                ) : (
                  <button onClick={() => setCreating(true)}
                    className="flex w-full px-2 py-1 text-xs font-mono text-inky/60 hover:bg-navy/5 hover:text-navy text-left">＋ Create new…</button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </>
  )
}

// Expandable text cell — shows "more/less" toggle when content overflows.
function ExpandableText({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const [v, setV] = useState(value ?? '')
  const textRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setV(value ?? '') }, [value])

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
      <div ref={textRef} onClick={() => setEditing(true)}
        className={['cursor-text text-xs font-mono', text ? 'text-navy' : 'text-inky/40', expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'].join(' ')}>
        {text || '—'}
      </div>
      {(canExpand || expanded) && (
        <button onClick={() => setExpanded(e => !e)} className="mt-0.5 text-[10px] font-mono text-inky hover:underline">
          {expanded ? 'less' : 'more'}
        </button>
      )}
    </div>
  )
}

// Title cell — 2-line clamp with "more/less" toggle; clicking opens edit modal.
function ExpandableTitle({ value, onEdit }: { value: string | null; onEdit: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [canExpand, setCanExpand] = useState(false)
  const textRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (expanded) return
    const el = textRef.current
    if (!el) return
    setCanExpand(el.scrollHeight > el.clientHeight + 1)
  })

  return (
    <div className="flex items-start gap-1.5 group/title px-1 whitespace-normal">
      <div className="flex-1 min-w-0">
        <div ref={textRef} onClick={onEdit}
          className={['cursor-pointer text-xs font-mono', value ? 'text-navy' : 'text-inky/40', expanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-2'].join(' ')}>
          {value || '—'}
        </div>
        {(canExpand || expanded) && (
          <button onClick={e => { e.stopPropagation(); setExpanded(x => !x) }}
            className="mt-0.5 text-[10px] font-mono text-inky hover:underline">
            {expanded ? 'less' : 'more'}
          </button>
        )}
      </div>
      <button onClick={e => { e.stopPropagation(); onEdit() }} title="Edit issue"
        className="opacity-0 group-hover/title:opacity-100 transition-opacity flex-shrink-0 p-0.5 rounded hover:bg-navy/10 text-inky/60 hover:text-navy mt-0.5">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </button>
    </div>
  )
}

function InlineStatus({ value, onSave }: { value: string | null; onSave: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const v = value || 'Not Started'
  return (
    <div className="relative inline-block">
      <button onClick={() => setOpen(o => !o)}><Badge color={CUSTOM_STATUS_COLOR[v] ?? 'gray'}>{v}</Badge></button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute z-50 mt-1 w-40 rounded border border-navy/30 bg-cream py-1 shadow-xl">
            {CUSTOM_STATUS_OPTIONS.map(s => (
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
  if (type === 'checkbox') return <input type="checkbox" checked={value === 'true'} className="accent-inky" onChange={e => onSave(e.target.checked ? 'true' : '')} />
  return <InlineText value={value} type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'} onSave={v => onSave(v || null)} />
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
      <span className="flex items-center gap-0.5">
        <button onClick={() => onMove(c.id, -1)} title="Move left" className="text-inky/70 hover:text-navy">◀</button>
        <button onClick={() => onMove(c.id, 1)} title="Move right" className="text-inky/70 hover:text-navy">▶</button>
        <button onClick={() => onPin(c.id)} title={c.pinned ? 'Unpin' : 'Pin to left'}
          className={['px-0.5 text-xs', c.pinned ? 'text-orange-600' : 'text-inky/70 hover:text-navy'].join(' ')}>📌</button>
        <button onClick={() => { if (confirm(`Delete column "${c.label}"?`)) onDelete(c.id) }} title="Delete column" className="text-inky/70 hover:text-red-400">✕</button>
      </span>
    </span>
  )
}

interface StatusOpt { id: string; name: string }

function IssueStatusCell({ name, statuses, onChange, onAdd }: { name: string | undefined; statuses: StatusOpt[]; onChange: (statusId: string) => void; onAdd: (name: string) => Promise<string | null> }) {
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<{ left: number; top: number } | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const btnRef = useRef<HTMLButtonElement>(null)
  function toggle() {
    if (!open && btnRef.current) { const r = btnRef.current.getBoundingClientRect(); setRect({ left: r.left, top: r.bottom + 4 }) }
    setOpen(o => !o)
  }
  async function handleCreate() {
    const n = newName.trim()
    if (!n) return
    const id = await onAdd(n)
    if (id) { onChange(id); setOpen(false); setCreating(false); setNewName('') }
  }
  return (
    <>
      <button ref={btnRef} onClick={toggle}><Badge color={statusColor(name)}>{name ?? '—'}</Badge></button>
      {open && rect && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => { setOpen(false); setCreating(false) }} />
          <div className="fixed z-[61] w-44 rounded border border-navy/30 bg-cream py-1 shadow-xl" style={{ left: rect.left, top: rect.top }}>
            {statuses.map(s => (
              <button key={s.id} onClick={() => { onChange(s.id); setOpen(false) }} className="flex w-full px-2 py-1 hover:bg-navy/5">
                <Badge color={statusColor(s.name)}>{s.name}</Badge>
              </button>
            ))}
            <div className="border-t border-navy/10 mt-0.5" />
            {creating ? (
              <div className="px-2 py-1 flex gap-1" onClick={e => e.stopPropagation()}>
                <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
                  placeholder="Status name…"
                  className="flex-1 min-w-0 rounded border border-sky/60 px-1.5 py-0.5 text-xs font-mono text-navy bg-cream focus:outline-none" />
                <button onClick={handleCreate} className="text-xs font-mono text-navy px-1 hover:text-sky">✓</button>
              </div>
            ) : (
              <button onClick={() => setCreating(true)} className="flex w-full px-2 py-1 text-xs font-mono text-inky hover:bg-navy/5">＋ add status…</button>
            )}
          </div>
        </>
      )}
    </>
  )
}

// Hoisted to module scope — defining inside IssuesPage remounted the table
// subtree on each render and swallowed the "+ New Issue" click.
function IssuesTable({ table, filter, onFilterChange, issues, loading, actions, onSelectionChange, clearSelectionToken }: {
  table: any; filter: string; onFilterChange: (v: string) => void; issues: IssueRow[]
  loading: boolean; actions: React.ReactNode; onSelectionChange?: (ids: Set<string>) => void
  clearSelectionToken?: number
}) {
  return (
    <DataTable table={table} globalFilter={filter} onGlobalFilterChange={onFilterChange}
      exportFilename="issues.csv" exportData={issues} loading={loading} actions={actions}
      attachmentEntityType="issue" hideColumnControl onSelectionChange={onSelectionChange}
      clearSelectionToken={clearSelectionToken} />
  )
}

const PERSONAL_DEPT_ID = '__personal__'

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
  const [importOpen, setImportOpen] = useState(false)
  const [statuses, setStatuses] = useState<StatusOpt[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedDeptId, setSelectedDeptId] = useState<string>('')
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [clearToken, setClearToken] = useState(0)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false)
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set())
  const [deptMap, setDeptMap] = useState<Record<string, string>>({})
  // Built-in column ordering and pinning (separate from custom column pinning)
  const [builtinOrder, setBuiltinOrder] = useState<string[]>(BUILT_IN_COL_DEFS.map(c => c.id))
  const [builtinPinnedArr, setBuiltinPinnedArr] = useState<string[]>([])

  // Options for location/category inline comboboxes — stored in refs so updates
  // don't trigger useMemo re-runs and close open dropdowns.
  const locOptionsRef = useRef<{ value: string; label: string }[]>([])
  const catOptionsRef = useRef<{ value: string; label: string }[]>([])

  const issueCols = useIssueColumns()

  const openEdit = useCallback((r: IssueRow) => { setEditIssue(r); setModalOpen(true) }, [])

  const handleSelectionChange = useCallback((ids: Set<string>) => {
    setSelectedRows(ids)
  }, [])

  const loadIssues = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const sb = supabase as any
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    void sb.schema('platform').from('issues').delete().eq('company_id', profile.company_id).lt('deleted_at', cutoff).not('deleted_at', 'is', null)

    let liveQ = sb.schema('platform').from('issues')
      .select('*').eq('company_id', profile.company_id).is('deleted_at', null).order('created_at', { ascending: false })
    let delQ = sb.schema('platform').from('issues')
      .select('*').eq('company_id', profile.company_id).not('deleted_at', 'is', null).order('deleted_at', { ascending: false })

    if (selectedDeptId === PERSONAL_DEPT_ID) {
      // Personal = null-dept issues OR private visibility issues created by the user
      liveQ = liveQ.eq('created_by', profile.id).or('department_id.is.null,visibility.eq.private')
      delQ = delQ.eq('created_by', profile.id).or('department_id.is.null,visibility.eq.private')
    } else if (selectedDeptId) {
      // Department view: exclude private issues (those belong in Personal tab)
      liveQ = liveQ.eq('department_id', selectedDeptId).neq('visibility', 'private')
      delQ = delQ.eq('department_id', selectedDeptId).neq('visibility', 'private')
    }

    const [liveRes, delRes, locRes, catRes, statusRes] = await Promise.all([
      liveQ, delQ,
      sb.schema('core').from('locations').select('id, name, shop_city').eq('company_id', profile.company_id).order('name'),
      sb.schema('inventory').from('issue_categories').select('id, name').eq('company_id', profile.company_id),
      sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', profile.company_id),
    ])

    if (liveRes.error) { toast.error(`Failed to load issues: ${liveRes.error.message}`); setLoading(false); return }
    if (locRes.error) { console.error('[IssuesPage] locations query failed:', locRes.error) }

    const locMap: Record<string, string> = Object.fromEntries((locRes.data ?? []).map((l: any) => [l.id, l.shop_city ?? l.name]))
    const catMap: Record<string, string> = Object.fromEntries((catRes.data ?? []).map((c: any) => [c.id, c.name]))
    const statusMap: Record<string, string> = Object.fromEntries((statusRes.data ?? []).map((s: any) => [s.id, s.name]))

    // Update refs so InlineCombobox cells pick up fresh options without re-mounting
    locOptionsRef.current = (locRes.data ?? []).map((l: any) => ({ value: l.id, label: l.shop_city ?? l.name }))
    catOptionsRef.current = (catRes.data ?? []).map((c: any) => ({ value: c.id, label: c.name }))

    const mapRow = (data: any[]) => (data ?? []).map((r: any) => ({
      ...r,
      location_name: locMap[r.location_id],
      category_name: catMap[r.category_id],
      status_name: statusMap[r.status_id],
    }))
    setIssues(mapRow(liveRes.data ?? []))
    setDeletedIssues(mapRow(delRes.data ?? []))
    setLoading(false)
  }, [profile?.company_id, profile?.id, selectedDeptId])

  const loadDepartments = useCallback(async () => {
    if (!profile?.company_id) return
    const sb = supabase as any
    let data: Department[] = []
    if (isAdminOrDeveloper(profile.role)) {
      const res = await sb.schema('platform').from('departments')
        .select('id, name, slug, sort_order').eq('company_id', profile.company_id).order('sort_order')
      data = (res.data ?? []) as Department[]
    } else {
      const { data: memberships } = await sb.schema('platform').from('user_department_memberships')
        .select('department_id').eq('user_id', profile.id).eq('company_id', profile.company_id)
      const deptIds = (memberships ?? []).map((m: any) => m.department_id as string)
      if (deptIds.length) {
        const res = await sb.schema('platform').from('departments')
          .select('id, name, slug, sort_order').in('id', deptIds).order('sort_order')
        data = (res.data ?? []) as Department[]
      }
    }
    setDepartments(data)
    setDeptMap(Object.fromEntries(data.map(d => [d.id, d.name])))
  }, [profile?.company_id, profile?.id, profile?.role])

  useEffect(() => { loadDepartments() }, [loadDepartments])

  const updateLinks = useCallback(async (id: string, links: string[]) => {
    setIssues(prev => prev.map(i => (i.id === id ? { ...i, helpful_links: links } : i)))
    const { error } = await (supabase as any).schema('platform').from('issues').update({ helpful_links: links }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  const updateVendor = useCallback(async (id: string, val: string) => {
    const next = val || null
    setIssues(prev => prev.map(i => (i.id === id ? { ...i, vendor: next } : i)))
    const { error } = await (supabase as any).schema('platform').from('issues').update({ vendor: next }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  const updateIssue = useCallback(async (id: string, dbPatch: Record<string, unknown>, localPatch: Partial<IssueRow> = {}) => {
    setIssues(prev => prev.map(i => (i.id === id ? { ...i, ...dbPatch, ...localPatch } : i)))
    const { error } = await (supabase as any).schema('platform').from('issues').update(dbPatch).eq('id', id)
    if (error) { toast.error(error.message); loadIssues() }
  }, [loadIssues])

  useEffect(() => {
    if (!profile?.company_id) return
    ;(supabase as any).schema('inventory').from('issue_statuses').select('id, name').eq('company_id', profile.company_id)
      .then(({ data }: any) => setStatuses((data ?? []) as StatusOpt[]))
  }, [profile?.company_id])

  const addStatus = useCallback(async (name: string): Promise<string | null> => {
    if (!profile?.company_id) return null
    const { data, error } = await (supabase as any).schema('inventory').from('issue_statuses').insert({ company_id: profile.company_id, name }).select().single()
    if (error || !data) { toast.error(error?.message ?? 'Could not add status'); return null }
    setStatuses(prev => [...prev, { id: data.id, name: data.name }])
    return data.id as string
  }, [profile?.company_id])

  const addCategory = useCallback(async (name: string): Promise<{ value: string; label: string } | null> => {
    if (!profile?.company_id) return null
    const { data, error } = await (supabase as any).schema('inventory').from('issue_categories').insert({ company_id: profile.company_id, name }).select().single()
    if (error || !data) { toast.error(error?.message ?? 'Could not add category'); return null }
    const opt = { value: data.id, label: data.name }
    catOptionsRef.current = [...catOptionsRef.current, opt]
    return opt
  }, [profile?.company_id])

  function moveBuiltin(id: string, dir: -1 | 1) {
    setBuiltinOrder(prev => {
      const arr = [...prev]
      const idx = arr.indexOf(id)
      const next = idx + dir
      if (next < 0 || next >= arr.length) return prev
      ;[arr[idx], arr[next]] = [arr[next], arr[idx]]
      return arr
    })
  }

  function toggleBuiltinPin(id: string) {
    setBuiltinPinnedArr(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const { columns: customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn } = issueCols

  const columns = useMemo(() => {
    const customs = [...customColumns].sort((a, b) => a.sort_order - b.sort_order).map(c => ({
      id: `cf_${c.id}`,
      enableSorting: false,
      enableColumnFilter: false,
      header: () => <CustomColHeader col={c} onMove={moveColumn} onPin={togglePin} onDelete={removeColumn} />,
      cell: (i: any) => <CustomCell type={c.type} value={valueFor(i.row.original.id, c.id)} onSave={v => setValue(i.row.original.id, c.id, v)} />,
    }))

    const titleCol = col.accessor('title', {
      header: 'Title',
      enableColumnFilter: false,
      meta: { noClip: true },
      cell: (i) => <ExpandableTitle value={i.getValue()} onEdit={() => openEdit(i.row.original as IssueRow)} />,
    })

    const hasCustomIssueNotes = customColumns.some(c => c.label.toLowerCase() === 'issue notes')

    // Build individual column defs for each built-in column
    const builtinColMap: Record<string, any> = {
      department: hiddenCols.has('department') ? null : {
        id: 'department', header: 'Department', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.department_id ? (deptMap[r.department_id] ?? '') : 'Personal',
        cell: (i: any) => (
          <span className="text-xs font-mono">
            {i.row.original.department_id
              ? <span className="text-navy">{deptMap[i.row.original.department_id] ?? '—'}</span>
              : <span className="text-inky/50 italic">Personal</span>}
          </span>
        ),
      },
      location_name: hiddenCols.has('location_name') ? null : {
        id: 'location_name', header: 'Location', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.location_name ?? '',
        cell: (i: any) => <InlineCombobox
          getOptions={() => locOptionsRef.current}
          value={i.row.original.location_id}
          onSave={(v, label) => updateIssue(i.row.original.id, { location_id: v }, { location_name: label ?? undefined })} />,
      },
      category_name: hiddenCols.has('category_name') ? null : {
        id: 'category_name', header: 'Category', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.category_name ?? '',
        cell: (i: any) => <InlineCombobox
          getOptions={() => catOptionsRef.current}
          value={i.row.original.category_id}
          onSave={(v, label) => updateIssue(i.row.original.id, { category_id: v }, { category_name: label ?? undefined })}
          onCreateOption={addCategory} />,
      },
      status: hiddenCols.has('status') ? null : {
        id: 'status', header: 'Status', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.status_name ?? '',
        cell: (i: any) => (
          <IssueStatusCell name={i.row.original.status_name} statuses={statuses} onAdd={addStatus}
            onChange={sid => {
              const statusName = statuses.find(s => s.id === sid)?.name ?? ''
              const patch: Record<string, unknown> = { status_id: sid }
              const local: Partial<IssueRow> = { status_name: statusName }
              if (statusName.toLowerCase().includes('resolved') && !i.row.original.resolved_date) {
                const today = new Date().toISOString().split('T')[0]
                patch.resolved_date = today
                local.resolved_date = today
              }
              updateIssue(i.row.original.id, patch, local)
            }} />
        ),
      },
      start_date: hiddenCols.has('start_date') ? null : {
        id: 'start_date', header: 'Start', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.start_date ?? '',
        cell: (i: any) => <InlineDate value={i.row.original.start_date} onSave={v => updateIssue(i.row.original.id, { start_date: v })} />,
      },
      target_resolution_date: hiddenCols.has('target_resolution_date') ? null : {
        id: 'target_resolution_date', header: 'Target', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.target_resolution_date ?? '',
        cell: (i: any) => <InlineDate value={i.row.original.target_resolution_date} onSave={v => updateIssue(i.row.original.id, { target_resolution_date: v })} />,
      },
      resolved_date: hiddenCols.has('resolved_date') ? null : {
        id: 'resolved_date', header: 'Resolved', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.resolved_date ?? '',
        cell: (i: any) => <InlineDate value={i.row.original.resolved_date} onSave={v => updateIssue(i.row.original.id, { resolved_date: v })} />,
      },
      days_open: hiddenCols.has('days_open') ? null : {
        id: 'days_open', header: 'Days Open', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.start_date ? differenceInDays(new Date(), new Date(r.start_date)) : -1,
        cell: (i: any) => <span className="text-xs font-mono text-navy px-1">{daysOpen(i.row.original.start_date)}</span>,
      },
      vendor: hiddenCols.has('vendor') ? null : {
        id: 'vendor', header: 'Vendor', enableColumnFilter: false,
        accessorFn: (r: IssueRow) => r.vendor ?? '',
        cell: (i: any) => <InlineText value={i.row.original.vendor} onSave={v => updateVendor(i.row.original.id, v)} />,
      },
      issue_notes: (hasCustomIssueNotes || hiddenCols.has('issue_notes')) ? null : {
        id: 'issue_notes', header: 'Issue Notes', enableColumnFilter: false, enableSorting: false, meta: { noClip: true },
        accessorFn: (r: IssueRow) => r.issue_notes ?? '',
        cell: (i: any) => <ExpandableText value={i.row.original.issue_notes} onSave={v => updateIssue(i.row.original.id, { issue_notes: v || null })} />,
      },
      resolution_notes: hiddenCols.has('resolution_notes') ? null : {
        id: 'resolution_notes', header: 'Resolution Notes', enableColumnFilter: false, enableSorting: false, meta: { noClip: true },
        accessorFn: (r: IssueRow) => r.resolution_notes ?? '',
        cell: (i: any) => <ExpandableText value={i.row.original.resolution_notes} onSave={v => updateIssue(i.row.original.id, { resolution_notes: v || null })} />,
      },
      helpful_links: hiddenCols.has('helpful_links') ? null : {
        id: 'helpful_links', header: 'Helpful Links', enableColumnFilter: false, enableSorting: false, meta: { noClip: true },
        accessorFn: (r: IssueRow) => r.helpful_links?.join(' ') ?? '',
        cell: (i: any) => <LinksCell links={i.row.original.helpful_links ?? []} onSave={links => updateLinks(i.row.original.id, links)} />,
      },
      attachments: hiddenCols.has('attachments') ? null : {
        id: 'attachments', header: 'Attachments', enableColumnFilter: false, enableSorting: false,
        cell: (i: any) => <AttachmentsCell entityType="issue" entityId={i.row.original.id} companyId={profile?.company_id ?? ''} />,
      },
    }

    const orderedBuiltins = builtinOrder.map(id => builtinColMap[id]).filter(Boolean)

    return [titleCol, ...orderedBuiltins, ...customs].filter(Boolean) as any[]
  }, [openEdit, customColumns, valueFor, setValue, moveColumn, togglePin, removeColumn,
    updateVendor, updateIssue, updateLinks, statuses, addStatus, addCategory,
    profile?.company_id, hiddenCols, builtinOrder, deptMap])

  const allTable = useTable(issues, columns)
  const pendingTable = useTable(issues.filter(i => { const s = i.status_name?.toLowerCase() ?? ''; return s.includes('pending') || s.includes('open') }), columns)
  const resolvedTable = useTable(issues.filter(i => { const s = i.status_name?.toLowerCase() ?? ''; return s.includes('resolved') || s.includes('closed') }), columns)

  const pinnedIds = useMemo(() => customColumns.filter(c => c.pinned).map(c => `cf_${c.id}`), [customColumns])
  const { setColumnPinning: setAllPin } = allTable
  const { setColumnPinning: setPendPin } = pendingTable
  const { setColumnPinning: setResPin } = resolvedTable
  useEffect(() => {
    const p = { left: [...builtinPinnedArr, ...pinnedIds], right: [] }
    setAllPin(p); setPendPin(p); setResPin(p)
  }, [builtinPinnedArr, pinnedIds, setAllPin, setPendPin, setResPin])

  useEffect(() => {
    if (!profile?.company_id) return
    loadIssues()
    const channel = supabase
      .channel('issues-rt')
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'issues', filter: `company_id=eq.${profile.company_id}` }, () => loadIssues())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [profile?.company_id, loadIssues])

  async function softDeleteIssue(id: string) {
    setIssues(prev => prev.filter(i => i.id !== id))
    const { error } = await (supabase as any).schema('platform').from('issues').update({ deleted_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); loadIssues(); return }
    toast.success('Issue moved to deleted items')
    loadIssues()
  }

  async function restoreIssue(id: string) {
    const { error } = await (supabase as any).schema('platform').from('issues').update({ deleted_at: null }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Issue restored')
    loadIssues()
  }

  async function hardDeleteIssue(id: string) {
    const { error } = await (supabase as any).schema('platform').from('issues').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Issue permanently deleted')
    loadIssues()
  }

  async function bulkSoftDelete() {
    const ids = [...selectedRows]
    setIssues(prev => prev.filter(i => !ids.includes(i.id)))
    setBulkDeleteConfirm(false)
    const { error } = await (supabase as any).schema('platform').from('issues')
      .update({ deleted_at: new Date().toISOString() }).in('id', ids)
    if (error) { toast.error(`Failed to delete: ${error.message}`); loadIssues(); return }
    toast.success(`Deleted ${ids.length} issue${ids.length !== 1 ? 's' : ''}`)
    setSelectedRows(new Set())
    setClearToken(t => t + 1)
    loadIssues()
  }

  async function bulkMove(targetDeptId: string | null) {
    const ids = [...selectedRows]
    setBulkMoveOpen(false)
    const patch = {
      department_id: targetDeptId,
      visibility: (targetDeptId === null ? 'private' : 'department') as IssueRow['visibility'],
    }
    // Optimistic: update in state; if dept-filtered, rows with wrong dept will
    // disappear naturally after reload
    setIssues(prev => prev.map(i => ids.includes(i.id) ? { ...i, ...patch } : i))
    const { error } = await (supabase as any).schema('platform').from('issues').update(patch).in('id', ids)
    if (error) { toast.error(`Failed to move: ${error.message}`); loadIssues(); return }
    const label = targetDeptId ? (departments.find(d => d.id === targetDeptId)?.name ?? 'department') : 'Personal'
    toast.success(`Moved ${ids.length} issue${ids.length !== 1 ? 's' : ''} to ${label}`)
    setSelectedRows(new Set())
    setClearToken(t => t + 1)
    loadIssues()
  }

  const onNew = () => { setEditIssue(null); setModalOpen(true) }
  const toggleHiddenCol = (id: string) => setHiddenCols(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })

  const actions = (
    <>
      {selectedRows.size > 0 && (
        <>
          <div className="relative">
            <button onClick={() => setBulkMoveOpen(o => !o)}
              className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy hover:bg-navy/5 whitespace-nowrap">
              Move {selectedRows.size} selected ▾
            </button>
            {bulkMoveOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setBulkMoveOpen(false)} />
                <div className="absolute left-0 z-50 mt-1 w-52 rounded border border-navy/30 bg-cream shadow-xl py-1">
                  <div className="px-2 pb-1 text-[10px] font-mono text-inky/60 uppercase tracking-wide">Move to…</div>
                  <button onClick={() => bulkMove(null)}
                    className="flex w-full px-3 py-1.5 text-xs font-mono text-navy hover:bg-navy/5 text-left gap-1.5">
                    🔒 Personal
                  </button>
                  {departments.length > 0 && <div className="border-t border-navy/10 my-0.5" />}
                  {departments.map(d => (
                    <button key={d.id} onClick={() => bulkMove(d.id)}
                      className="flex w-full px-3 py-1.5 text-xs font-mono text-navy hover:bg-navy/5 text-left">
                      {d.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <Button size="sm" variant="danger" onClick={() => setBulkDeleteConfirm(true)}>
            Delete {selectedRows.size} selected
          </Button>
        </>
      )}
      <Button size="sm" onClick={onNew}>+ New Issue</Button>
      <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>+ Import</Button>
      <div className="relative">
        <button onClick={() => setColMenuOpen(o => !o)}
          className="rounded border border-navy/30 bg-cream px-2 py-1.5 text-xs font-mono text-navy hover:bg-navy/5 whitespace-nowrap">
          Columns ▾
        </button>
        {colMenuOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setColMenuOpen(false)} />
            <div className="absolute right-0 z-50 mt-1 w-64 rounded border border-navy/30 bg-cream shadow-xl py-1.5 max-h-[70vh] overflow-y-auto">
              <div className="px-2 pb-1 text-[10px] font-mono text-inky/60 uppercase tracking-wide">Built-in columns</div>
              {builtinOrder.map((id, idx) => {
                const def = BUILT_IN_COL_DEFS.find(c => c.id === id)
                if (!def) return null
                const isPinned = builtinPinnedArr.includes(id)
                const isHidden = hiddenCols.has(id)
                return (
                  <div key={id} className="flex items-center gap-1 px-2 py-0.5 hover:bg-navy/5">
                    <input type="checkbox" checked={!isHidden} onChange={() => toggleHiddenCol(id)} className="accent-inky flex-shrink-0 cursor-pointer" />
                    <span className={['text-xs font-mono flex-1 truncate cursor-pointer select-none', isHidden ? 'text-inky/40' : 'text-navy'].join(' ')}
                      onClick={() => toggleHiddenCol(id)}>{def.label}</span>
                    <span className="flex items-center gap-0.5 text-inky/70 flex-shrink-0">
                      <button onClick={() => moveBuiltin(id, -1)} disabled={idx === 0}
                        className="hover:text-navy disabled:opacity-20 text-[11px] px-0.5">◀</button>
                      <button onClick={() => moveBuiltin(id, 1)} disabled={idx === builtinOrder.length - 1}
                        className="hover:text-navy disabled:opacity-20 text-[11px] px-0.5">▶</button>
                      <button onClick={() => toggleBuiltinPin(id)} title={isPinned ? 'Unpin' : 'Pin to left'}
                        className={['px-0.5 text-[11px]', isPinned ? 'text-orange-600' : 'text-inky/70 hover:text-navy'].join(' ')}>📌</button>
                    </span>
                  </div>
                )
              })}
              {customColumns.length > 0 && (
                <>
                  <div className="border-t border-navy/10 mt-1 mb-1 mx-2" />
                  <div className="px-2 pb-1 text-[10px] font-mono text-inky/60 uppercase tracking-wide">Custom columns</div>
                  {[...customColumns].sort((a, b) => a.sort_order - b.sort_order).map(c => (
                    <div key={c.id} className="flex items-center justify-between gap-1 px-2 py-0.5 hover:bg-navy/5">
                      <span className="text-xs font-mono flex-1 truncate text-navy">{c.label}</span>
                      <span className="flex items-center gap-0.5 flex-shrink-0">
                        <button onClick={() => moveColumn(c.id, -1)} className="text-inky/70 hover:text-navy text-[11px] px-0.5">◀</button>
                        <button onClick={() => moveColumn(c.id, 1)} className="text-inky/70 hover:text-navy text-[11px] px-0.5">▶</button>
                        <button onClick={() => togglePin(c.id)}
                          className={['px-0.5 text-[11px]', c.pinned ? 'text-orange-600' : 'text-inky/70 hover:text-navy'].join(' ')}>📌</button>
                        <button onClick={() => { if (confirm(`Delete "${c.label}"?`)) removeColumn(c.id) }}
                          className="text-inky/70 hover:text-red-400 text-[11px] px-0.5">✕</button>
                      </span>
                    </div>
                  ))}
                </>
              )}
              <div className="border-t border-navy/10 mt-1 mx-2" />
              <button onClick={() => { setColMenuOpen(false); setAddColOpen(true) }}
                className="w-full text-left px-2 py-1 text-xs font-mono text-inky/60 hover:text-navy hover:bg-navy/5">
                ＋ Add column…
              </button>
            </div>
          </>
        )}
      </div>
    </>
  )

  return (
    <div className="flex flex-col gap-6">
      {departments.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button onClick={() => setSelectedDeptId('')}
            className={['px-2.5 py-1 rounded text-xs font-mono transition-colors', selectedDeptId === '' ? 'bg-navy text-cream' : 'bg-navy/10 text-navy/70 hover:bg-navy/20'].join(' ')}>
            All
          </button>
          {departments.map(d => (
            <button key={d.id} onClick={() => setSelectedDeptId(d.id)}
              className={['px-2.5 py-1 rounded text-xs font-mono transition-colors', selectedDeptId === d.id ? 'bg-navy text-cream' : 'bg-navy/10 text-navy/70 hover:bg-navy/20'].join(' ')}>
              {d.name}
            </button>
          ))}
          <button onClick={() => setSelectedDeptId(PERSONAL_DEPT_ID)}
            className={['px-2.5 py-1 rounded text-xs font-mono transition-colors', selectedDeptId === PERSONAL_DEPT_ID ? 'bg-navy text-cream' : 'bg-navy/10 text-navy/70 hover:bg-navy/20'].join(' ')}>
            🔒 Personal
          </button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Issue Tracker</h1>
          <p className="text-xs text-inky mt-0.5">Track and resolve location issues</p>
        </div>
        {deletedIssues.length > 0 && (
          <button onClick={() => setShowDeleted(v => !v)}
            className="text-xs font-mono text-inky/60 hover:text-navy underline decoration-dotted">
            {showDeleted ? 'Hide deleted' : `Show deleted (${deletedIssues.length})`}
          </button>
        )}
      </div>

      {showDeleted && deletedIssues.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50/40">
          <div className="px-4 py-2 border-b border-red-200">
            <span className="text-xs font-mono text-red-600 uppercase tracking-wide font-bold">Deleted Issues</span>
            <span className="text-[10px] font-mono text-red-400 ml-2">— auto-purge after 30 days</span>
          </div>
          <ul className="divide-y divide-red-100">
            {deletedIssues.map(issue => (
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
          <IssuesTable table={allTable.table} filter={allTable.globalFilter} onFilterChange={allTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} onSelectionChange={handleSelectionChange} clearSelectionToken={clearToken} />
        </TabsContent>
        <TabsContent value="pending">
          <IssuesTable table={pendingTable.table} filter={pendingTable.globalFilter} onFilterChange={pendingTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} onSelectionChange={handleSelectionChange} clearSelectionToken={clearToken} />
        </TabsContent>
        <TabsContent value="resolved">
          <IssuesTable table={resolvedTable.table} filter={resolvedTable.globalFilter} onFilterChange={resolvedTable.setGlobalFilter} issues={issues} loading={loading} actions={actions} onSelectionChange={handleSelectionChange} clearSelectionToken={clearToken} />
        </TabsContent>
      </Tabs>

      <IssueFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditIssue(null) }}
        existing={editIssue}
        onSaved={loadIssues}
        defaultDepartmentId={selectedDeptId === PERSONAL_DEPT_ID ? PERSONAL_DEPT_ID : selectedDeptId}
        departments={departments}
        onDelete={id => { softDeleteIssue(id); setModalOpen(false); setEditIssue(null) }}
      />
      <AddIssueColumnModal open={addColOpen} onClose={() => setAddColOpen(false)} existingColumns={customColumns} onAdd={issueCols.addColumn} />
      <IssueImportModal open={importOpen} onClose={() => setImportOpen(false)} onImported={loadIssues} departments={departments} defaultDepartmentId={selectedDeptId === PERSONAL_DEPT_ID ? '' : selectedDeptId} />

      {bulkDeleteConfirm && (
        <Modal open onClose={() => setBulkDeleteConfirm(false)} title="Delete Issues?">
          <div className="flex flex-col gap-4">
            <p className="text-sm font-body text-navy">
              You are about to delete <span className="font-bold">{selectedRows.size} issue{selectedRows.size !== 1 ? 's' : ''}</span>, continue?
            </p>
            <p className="text-xs font-mono text-inky/70">Issues will be kept for 30 days and can be restored.</p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setBulkDeleteConfirm(false)}>Cancel</Button>
              <Button variant="danger" size="sm" onClick={bulkSoftDelete}>Delete</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
