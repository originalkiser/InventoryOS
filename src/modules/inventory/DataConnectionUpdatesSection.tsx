import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Card, CardBody, CardHeader, Button, Badge, SbLoader } from '@/components/ui'
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

export function DataConnectionUpdatesSection() {
  const { profile } = useAuthStore()
  const [rows, setRows] = useState<DataConnectionSyncLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const { data, error } = await (supabase as any)
      .schema('inventory').from('data_connection_sync_log')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('finished_at', { ascending: false })
      .limit(25)
    if (error) setError('Table not found — apply migration 20260826_data_connection_sync_log.sql')
    else { setRows((data ?? []) as DataConnectionSyncLog[]); setError(null) }
    setLoading(false)
  }, [profile?.company_id])

  useEffect(() => { load() }, [load])

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-sm font-heading font-bold text-navy">Data Connection Updates</span>
        <Button size="sm" variant="secondary" onClick={load} disabled={loading}>
          <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </CardHeader>
      <CardBody className="flex flex-col gap-2">
        <p className="text-[11px] font-mono text-inky/60">
          Recent runs from live data connections (Droptop, SkyBitz Tanks) — when each ran, how many items changed vs stayed the same, and how long it took.
        </p>
        {loading && rows.length === 0 ? (
          <div className="py-6 flex justify-center"><SbLoader size={28} /></div>
        ) : error ? (
          <p className="text-xs font-mono text-[#C0392B]">{error}</p>
        ) : rows.length === 0 ? (
          <p className="text-xs font-mono text-inky/50">No sync runs logged yet.</p>
        ) : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Connection</th>
                  <th className="px-3 py-2 text-left">Ran At</th>
                  <th className="px-3 py-2 text-right">Duration</th>
                  <th className="px-3 py-2 text-right">Updated</th>
                  <th className="px-3 py-2 text-right">Unchanged</th>
                  <th className="px-3 py-2 text-left">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
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
