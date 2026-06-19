import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { runDailyMonthEndPull, getPullHistory, getLastPullLog } from '@/services/droptopService'
import { isMonthEndPeriod, daysUntilMonthEndPeriod } from '@/utils/monthEndUtils'
import type { MonthEndPullLog } from '@/types/integrations'

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}

export function MonthEndPullPanel() {
  const [pulling, setPulling] = useState(false)
  const [lastLog, setLastLog] = useState<MonthEndPullLog | null>(null)
  const [history, setHistory] = useState<MonthEndPullLog[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const inPeriod = isMonthEndPeriod()
  const daysUntil = daysUntilMonthEndPeriod()

  useEffect(() => {
    getLastPullLog().then(setLastLog).catch(() => {})
  }, [])

  async function handlePull() {
    setPulling(true)
    try {
      const result = await runDailyMonthEndPull()
      toast.success(`Pull complete — ${result.recordsWritten} records written for ${result.date}`)
      const updated = await getLastPullLog()
      setLastLog(updated)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Pull failed')
    } finally {
      setPulling(false)
    }
  }

  async function handleShowHistory() {
    const h = await getPullHistory(10)
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
            {pulling ? 'Pulling…' : 'Pull Now'}
          </Button>
        </div>
      </div>

      {lastLog && (
        <div className="text-xs font-mono text-inky/60 flex gap-4 flex-wrap">
          <span>Last pull: <span className="text-navy">{fmtDate(lastLog.pulled_at)}</span></span>
          <span className={lastLog.status === 'error' ? 'text-red-600' : 'text-green-700'}>{lastLog.status}</span>
          <span>{lastLog.records_written} records written</span>
          <span>{lastLog.locations_pulled} locations</span>
        </div>
      )}

      {lastLog?.error_message && (
        <div className="bg-red-50 border border-red-200 rounded px-3 py-2">
          <p className="text-xs font-mono text-red-700">{lastLog.error_message}</p>
        </div>
      )}

      {!lastLog && (
        <p className="text-xs font-mono text-inky/40">No pull history. Runs automatically during month-end period.</p>
      )}

      {showHistory && (
        <div className="mt-2">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-heading uppercase tracking-wider text-inky/60">Pull History</h4>
            <button onClick={() => setShowHistory(false)} className="text-[10px] font-mono text-inky/40 hover:underline">hide</button>
          </div>
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-inky/20">
                <th className="text-left py-1 pr-3 font-normal text-inky/60">Date</th>
                <th className="text-left py-1 pr-3 font-normal text-inky/60">Pulled At</th>
                <th className="text-left py-1 pr-3 font-normal text-inky/60">Status</th>
                <th className="text-right py-1 pr-3 font-normal text-inky/60">Records</th>
                <th className="text-right py-1 font-normal text-inky/60">Locations</th>
              </tr>
            </thead>
            <tbody>
              {history.map((log) => (
                <tr key={log.id} className="border-b border-inky/10 hover:bg-inky/5">
                  <td className="py-1 pr-3 text-navy">{log.pull_date}</td>
                  <td className="py-1 pr-3">{fmtDate(log.pulled_at)}</td>
                  <td className={`py-1 pr-3 ${log.status === 'error' ? 'text-red-600' : 'text-green-700'}`}>{log.status}</td>
                  <td className="py-1 pr-3 text-right">{log.records_written}</td>
                  <td className="py-1 text-right">{log.locations_pulled}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
