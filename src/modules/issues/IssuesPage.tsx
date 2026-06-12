import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createColumnHelper } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { Button, Badge, Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui'
import { IssueFormModal } from './IssueFormModal'
import type { Issue } from '@/types'
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

const COLUMNS = [
  col.accessor('title', { header: 'Title', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('location_name', { header: 'Location', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('category_name', { header: 'Category', cell: (i) => i.getValue() ?? '—' }),
  col.accessor('status_name', { header: 'Status', cell: (i) => (
    <Badge color={statusColor(i.getValue())}>{i.getValue() ?? '—'}</Badge>
  )}),
  col.accessor('start_date', { header: 'Start', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('target_resolution_date', { header: 'Target', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('resolved_date', { header: 'Resolved', cell: (i) => i.getValue() ? format(new Date(i.getValue()!), 'MMM d, yyyy') : '—' }),
  col.accessor('start_date', { id: 'days_open', header: 'Days Open', cell: (i) => daysOpen(i.getValue()) }),
]

// Hoisted to module scope — defining this inside IssuesPage made it a new
// component type on every render, remounting the whole table subtree on each
// state change (which swallowed the "+ New Issue" click before it could open
// the modal).
function IssuesTable({
  table, filter, onFilterChange, issues, loading, onNew,
}: {
  table: any
  filter: string
  onFilterChange: (v: string) => void
  issues: IssueRow[]
  loading: boolean
  onNew: () => void
}) {
  return (
    <DataTable
      table={table}
      globalFilter={filter}
      onGlobalFilterChange={onFilterChange}
      exportFilename="issues.csv"
      exportData={issues}
      loading={loading}
      actions={<Button size="sm" onClick={onNew}>+ New Issue</Button>}
    />
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

  const allTable = useTable(issues, COLUMNS)
  const pendingTable = useTable(issues.filter((i) => {
    const s = i.status_name?.toLowerCase() ?? ''
    return s.includes('pending') || s.includes('open')
  }), COLUMNS)
  const resolvedTable = useTable(issues.filter((i) => {
    const s = i.status_name?.toLowerCase() ?? ''
    return s.includes('resolved') || s.includes('closed')
  }), COLUMNS)

  useEffect(() => {
    if (!profile?.company_id) return
    loadIssues()

    const channel = supabase
      .channel('issues-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues', filter: `company_id=eq.${profile.company_id}` },
        (payload) => {
          toast(`Issue ${payload.eventType}`, { icon: '📋' })
          loadIssues()
        }
      )
      .subscribe()

    return () => { void supabase.removeChannel(channel) }
  }, [profile?.company_id])

  async function loadIssues() {
    if (!profile?.company_id) return
    setLoading(true)
    const { data, error } = await supabase
      .from('issues')
      .select(`
        *,
        locations(name),
        issue_categories(name),
        issue_statuses(name)
      `)
      .eq('company_id', profile.company_id)
      .order('created_at', { ascending: false })

    if (error) toast.error('Failed to load issues')
    else {
      setIssues((data ?? []).map((r: any) => ({
        ...r,
        location_name: r.locations?.name,
        category_name: r.issue_categories?.name,
        status_name: r.issue_statuses?.name,
      })))
    }
    setLoading(false)
  }

  const onNew = () => { setEditIssue(null); setModalOpen(true) }

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
          <IssuesTable table={allTable.table} filter={allTable.globalFilter} onFilterChange={allTable.setGlobalFilter} issues={issues} loading={loading} onNew={onNew} />
        </TabsContent>
        <TabsContent value="pending">
          <IssuesTable table={pendingTable.table} filter={pendingTable.globalFilter} onFilterChange={pendingTable.setGlobalFilter} issues={issues} loading={loading} onNew={onNew} />
        </TabsContent>
        <TabsContent value="resolved">
          <IssuesTable table={resolvedTable.table} filter={resolvedTable.globalFilter} onFilterChange={resolvedTable.setGlobalFilter} issues={issues} loading={loading} onNew={onNew} />
        </TabsContent>
      </Tabs>

      <IssueFormModal
        open={modalOpen}
        onClose={() => { setModalOpen(false); setEditIssue(null) }}
        existing={editIssue}
        onSaved={loadIssues}
      />
    </div>
  )
}
