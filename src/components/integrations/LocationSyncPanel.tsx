import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { syncLocationsFromMonday, getLastSyncLog, getSyncHistory } from '@/services/mondayService'
import type { LocationSyncLog, SyncResult } from '@/types/integrations'

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

const STATUS_COLOR: Record<LocationSyncLog['status'], string> = {
  success: 'text-green-700',
  partial: 'text-sky',
  error: 'text-red-600',
}

export function LocationSyncPanel() {
  const [syncing, setSyncing] = useState(false)
  const [lastLog, setLastLog] = useState<LocationSyncLog | null>(null)
  const [history, setHistory] = useState<LocationSyncLog[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [result, setResult] = useState<SyncResult | null>(null)

  useEffect(() => {
    getLastSyncLog().then(setLastLog).catch(() => {})
  }, [])

  async function handleSync() {
    setSyncing(true)
    setResult(null)
    try {
      const r = await syncLocationsFromMonday()
      setResult(r)
      toast.success(`Sync complete — ${r.added} added, ${r.updated} updated, ${r.deactivated} deactivated`)
      const updated = await getLastSyncLog()
      setLastLog(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sync failed')
    } finally {
      setSyncing(false)
    }
  }

  async function handleShowHistory() {
    const h = await getSyncHistory(10)
    setHistory(h)
    setShowHistory(true)
  }

  return (
    <div className="border border-inky/20 rounded p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-heading text-sm uppercase tracking-wider text-navy">monday.com Location Sync</h3>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={handleShowHistory} className="text-xs">
            History
          </Button>
          <Button size="sm" onClick={handleSync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync Now'}
          </Button>
        </div>
      </div>

      {lastLog && (
        <div className="text-xs font-mono text-inky/60 flex gap-4 flex-wrap">
          <span>Last sync: <span className="text-navy">{fmtDate(lastLog.synced_at)}</span></span>
          <span className={STATUS_COLOR[lastLog.status]}>{lastLog.status}</span>
          <span>+{lastLog.records_added} added</span>
          <span>~{lastLog.records_updated} updated</span>
          <span>-{lastLog.records_deactivated} deactivated</span>
        </div>
      )}

      {!lastLog && !syncing && (
        <p className="text-xs font-mono text-inky/40">No sync history. Run a sync to pull locations from monday.com.</p>
      )}

      {result && result.errors.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2">
          <p className="text-xs font-mono text-red-700 font-bold mb-1">{result.errors.length} error(s):</p>
          <ul className="text-xs font-mono text-red-600 space-y-0.5">
            {result.errors.slice(0, 5).map((e, i) => <li key={i}>{e}</li>)}
            {result.errors.length > 5 && <li>…and {result.errors.length - 5} more</li>}
          </ul>
        </div>
      )}

      {showHistory && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-heading uppercase tracking-wider text-inky/60">Sync History</h4>
            <button onClick={() => setShowHistory(false)} className="text-[10px] font-mono text-inky/40 hover:underline">hide</button>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-inky/20">
                <th className="text-left py-1 pr-3 font-normal text-inky/60">When</th>
                <th className="text-left py-1 pr-3 font-normal text-inky/60">Status</th>
                <th className="text-right py-1 pr-3 font-normal text-inky/60">+Added</th>
                <th className="text-right py-1 pr-3 font-normal text-inky/60">~Updated</th>
                <th className="text-right py-1 font-normal text-inky/60">-Deact.</th>
              </tr>
            </thead>
            <tbody>
              {history.map((log) => (
                <tr key={log.id} className="border-b border-inky/10 hover:bg-inky/5">
                  <td className="py-1 pr-3 text-navy">{fmtDate(log.synced_at)}</td>
                  <td className={`py-1 pr-3 ${STATUS_COLOR[log.status]}`}>{log.status}</td>
                  <td className="py-1 pr-3 text-right">{log.records_added}</td>
                  <td className="py-1 pr-3 text-right">{log.records_updated}</td>
                  <td className="py-1 text-right">{log.records_deactivated}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
