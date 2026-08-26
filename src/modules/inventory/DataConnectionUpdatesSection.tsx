import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Card, CardBody, CardHeader, Button, Badge, Select, SbLoader } from '@/components/ui'
import type { DataConnectionSyncLog } from '@/types/integrations'

const CONNECTION_LABELS: Record<string, string> = {
  droptop: 'Droptop',
  skybitz_tanks: 'SkyBitz Tanks',
}
const connectionLabel = (c: string) => CONNECTION_LABELS[c] ?? c

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rem = Math.round(s % 60)
  return `${m}m ${rem}s`
}

const STATUS_COLOR: Record<string, 'green' | 'orange' | 'red'> = {
  success: 'green', partial: 'orange', error: 'red',
}

type SortKey = 'connection' | 'finished_at' | 'duration_ms' | 'items_updated' | 'items_unchanged' | 'status'
interface Col { id: SortKey; label: string; align: 'left' | 'right' }
const COLUMNS: Col[] = [
  { id: 'connection', label: 'Connection', align: 'left' },
  { id: 'finished_at', label: 'Ran At', align: 'left' },
  { id: 'duration_ms', label: 'Duration', align: 'right' },
  { id: 'items_updated', label: 'Updated', align: 'right' },
  { id: 'items_unchanged', label: 'Unchanged', align: 'right' },
  { id: 'status', label: 'Status', align: 'left' },
]

export function DataConnectionUpdatesSection() {
  const { profile } = useAuthStore()
  const [rows, setRows] = useState<DataConnectionSyncLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [connectionFilter, setConnectionFilter] = useState('all')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'finished_at', dir: 'desc' })

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const { data, error } = await (supabase as any)
      .schema('inventory').from('data_connection_sync_log')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('finished_at', { ascending: false })
      .limit(200)
    if (error) setError('Table not found — apply migration 20260826_data_connection_sync_log.sql')
    else { setRows((data ?? []) as DataConnectionSyncLog[]); setError(null) }
    setLoading(false)
  }, [profile?.company_id])

  useEffect(() => { load() }, [load])

  const connectionOptions = useMemo(() => {
    const seen = new Set(rows.map((r) => r.connection))
    return [{ value: 'all', label: 'All connections' }, ...[...seen].sort().map((c) => ({ value: c, label: connectionLabel(c) }))]
  }, [rows])

  // Rows already come back newest-first, so the first occurrence per
  // connection in that order is its latest run.
  const latestPerConnection = useMemo(() => {
    const seen = new Set<string>()
    const out: DataConnectionSyncLog[] = []
    for (const r of rows) { if (!seen.has(r.connection)) { seen.add(r.connection); out.push(r) } }
    return out
  }, [rows])

  const displayRows = useMemo(() => {
    const base = expanded ? rows : latestPerConnection
    const filtered = connectionFilter === 'all' ? base : base.filter((r) => r.connection === connectionFilter)
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key]
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      return av < bv ? -dir : av > bv ? dir : 0
    })
  }, [expanded, rows, latestPerConnection, connectionFilter, sort])

  function toggleSort(key: SortKey) {
    setSort((s) => s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'finished_at' ? 'desc' : 'asc' })
  }
  const sortArrow = (key: SortKey) => sort.key === key ? (sort.dir === 'asc' ? ' ▴' : ' ▾') : ''

  return (
    <Card>
      <CardHeader className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-heading font-bold text-navy">Data Connection Updates</span>
        <div className="flex items-center gap-2">
          <div className="w-44">
            <Select options={connectionOptions} value={connectionFilter} onChange={(e) => setConnectionFilter(e.target.value)} />
          </div>
          <Button size="sm" variant="secondary" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Show Latest Only' : 'Expand History'}
          </Button>
          <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        <p className="text-[11px] font-mono text-inky/60">
          {expanded ? 'Full history' : 'Latest run per connection'} — when each ran, how many items changed vs stayed the same, and how long it took.
        </p>
        {loading && rows.length === 0 ? (
          <div className="py-6 flex justify-center"><SbLoader size={28} /></div>
        ) : error ? (
          <p className="text-xs font-mono text-[#C0392B]">{error}</p>
        ) : displayRows.length === 0 ? (
          <p className="text-xs font-mono text-inky/50">No sync runs logged yet.</p>
        ) : (
          <div className={`overflow-auto rounded border border-navy/30 ${expanded ? 'max-h-[calc(100vh-400px)]' : ''}`}>
            <table className="w-full text-xs font-mono">
              <thead className="sticky top-0">
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  {COLUMNS.map((c) => (
                    <th key={c.id} className={`px-3 py-2 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                      <button onClick={() => toggleSort(c.id)} className="uppercase tracking-wide hover:text-navy transition-colors inline-flex items-center">
                        {c.label}{sortArrow(c.id)}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((r) => (
                  <tr key={r.id} className="border-b border-navy/20">
                    <td className="px-3 py-1.5 text-navy">{connectionLabel(r.connection)}</td>
                    <td className="px-3 py-1.5 text-navy">{format(new Date(r.finished_at), 'MMM d, h:mm a')}</td>
                    <td className="px-3 py-1.5 text-right text-inky">{fmtDuration(r.duration_ms)}</td>
                    <td className="px-3 py-1.5 text-right text-navy">{r.items_updated ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right text-inky">{r.items_unchanged ?? '—'}</td>
                    <td className="px-3 py-1.5">
                      <span title={r.error_message ?? undefined}>
                        <Badge color={STATUS_COLOR[r.status] ?? 'inky'}>{r.status}</Badge>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
