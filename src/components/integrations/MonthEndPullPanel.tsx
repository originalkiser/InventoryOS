import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { runDroptopSync, getLastDroptopSyncLog, getDroptopSyncHistory } from '@/services/droptopService'
import { isMonthEndPeriod, daysUntilMonthEndPeriod } from '@/utils/monthEndUtils'
import type { DroptopSyncLog } from '@/types/integrations'

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

export function MonthEndPullPanel() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [pulling, setPulling] = useState(false)
  const [progress, setProgress] = useState<{ batch: number; totalBatches: number } | null>(null)
  const [lastLog, setLastLog] = useState<DroptopSyncLog | null>(null)
  const [history, setHistory] = useState<DroptopSyncLog[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const inPeriod = isMonthEndPeriod()
  const daysUntil = daysUntilMonthEndPeriod()

  useEffect(() => {
    if (!companyId) return
    getLastDroptopSyncLog(companyId).then(setLastLog).catch(() => {})
  }, [companyId])

  async function handlePull() {
    if (!companyId) return
    setPulling(true)
    setProgress(null)
    try {
      // Daily pull: current on-hands (always a live snapshot) + the last
      // day's usage — a lighter, incremental version of Product Usage's
      // manual Full Sync (which defaults to a 30-day usage window).
      const result = await runDroptopSync(
        companyId,
        { mode: 'both', daysBack: 1 },
        (p) => setProgress(p),
      )
      toast.success(`Pull complete — ${result.products_upserted.toLocaleString()} products updated across ${result.operations_synced} location${result.operations_synced === 1 ? '' : 's'}`)
      if (result.warnings?.length) {
        toast(`${result.warnings.length} location${result.warnings.length === 1 ? '' : 's'} had issues — see History`, { icon: '⚠️' })
      }
      // Built from the aggregated result rather than re-fetched from
      // droptop_sync_log — a full-company pull runs as several chunked
      // invocations (see runDroptopSync), each logging its own row, so
      // reading "the last log row" here would only show the final chunk's
      // numbers, not the combined total the toast above just reported.
      setLastLog({
        id: 'local',
        company_id: companyId,
        synced_at: new Date().toISOString(),
        operations_count: result.operations_synced,
        products_upserted: result.products_upserted,
        status: result.warnings?.length ? 'partial' : 'success',
        error_message: result.warnings?.length ? result.warnings.join(' | ') : null,
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pull failed')
    } finally {
      setPulling(false)
      setProgress(null)
    }
  }

  async function handleShowHistory() {
    if (!companyId) return
    const h = await getDroptopSyncHistory(companyId, 10)
    setHistory(h)
    setShowHistory(true)
  }

  return (
    <div className="border border-inky/20 rounded p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="font-heading text-sm uppercase tracking-wider text-navy">Droptop Daily Pull</h3>
          {inPeriod ? (
            <p className="text-xs font-mono text-green-700 mt-0.5">Month-end period active — pulls enabled</p>
          ) : (
            <p className="text-xs font-mono text-inky/50 mt-0.5">
              {daysUntil > 0 ? `Month-end period starts in ${daysUntil} day${daysUntil !== 1 ? 's' : ''}` : 'Outside month-end period'}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={handleShowHistory} className="text-xs">
            History
          </Button>
          <Button size="sm" onClick={handlePull} disabled={pulling || !inPeriod}>
            {pulling ? (progress ? `Pulling… (${progress.batch}/${progress.totalBatches})` : 'Pulling…') : 'Pull Now'}
          </Button>
        </div>
      </div>

      {lastLog && (
        <div className="text-xs font-mono text-inky/60 flex gap-4 flex-wrap">
          <span>Last pull: <span className="text-navy">{fmtDate(lastLog.synced_at)}</span></span>
          <span className={lastLog.status === 'error' ? 'text-red-600' : lastLog.status === 'partial' ? 'text-amber-600' : 'text-green-700'}>{lastLog.status}</span>
          <span>{lastLog.products_upserted ?? 0} products updated</span>
          <span>{lastLog.operations_count ?? 0} locations</span>
        </div>
      )}

      {lastLog?.error_message && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2">
          <p className="text-xs font-mono text-red-700">{lastLog.error_message}</p>
        </div>
      )}

      {!lastLog && (
        <p className="text-xs font-mono text-inky/40">No pull history yet. Pulls also run automatically during month-end period.</p>
      )}

      {showHistory && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-heading uppercase tracking-wider text-inky/60">Pull History</h4>
            <button onClick={() => setShowHistory(false)} className="text-[10px] font-mono text-inky/40 hover:underline">hide</button>
          </div>
          {history.length === 0 ? (
            <p className="text-xs font-mono text-inky/40">No pulls logged yet.</p>
          ) : (
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="border-b border-inky/20">
                  <th className="text-left py-1 pr-3 font-normal text-inky/60">Pulled At</th>
                  <th className="text-left py-1 pr-3 font-normal text-inky/60">Status</th>
                  <th className="text-right py-1 pr-3 font-normal text-inky/60">Products</th>
                  <th className="text-right py-1 font-normal text-inky/60">Locations</th>
                </tr>
              </thead>
              <tbody>
                {history.map((log) => (
                  <tr key={log.id} className="border-b border-inky/10 hover:bg-inky/5">
                    <td className="py-1 pr-3 text-navy">{fmtDate(log.synced_at)}</td>
                    <td className={`py-1 pr-3 ${log.status === 'error' ? 'text-red-600' : log.status === 'partial' ? 'text-amber-600' : 'text-green-700'}`}>{log.status}</td>
                    <td className="py-1 pr-3 text-right">{log.products_upserted ?? 0}</td>
                    <td className="py-1 text-right">{log.operations_count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
