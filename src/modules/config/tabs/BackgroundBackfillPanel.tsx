import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square, Zap } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'

interface BackfillJob {
  id: string
  status: 'running' | 'completed' | 'error'
  location_ids: string[]
  cursor_month: string | null
  floor_month: string
  months_pulled: number
  months_skipped: number
  month_pending_ids: string[] | null
  usage_pending_location_ids: string[] | null
  usage_done_count: number
  last_run_at: string | null
  last_tick_summary: string | null
  error_message: string | null
}

type ConnectionKey = 'droptop_orders' | 'droptop_usage' | 'droptop_time_clock'

// The "run it and forget it" counterpart to the manual backfill card just
// above it — starting a job here hands the actual work to
// data-connection-backfill-dispatcher's own pg_cron schedule (every 10
// minutes, entirely server-side), so closing this tab, this browser, or
// the computer sleeping can't stop it. Reuses the same region/market/shop
// scoping already picked for the manual card above rather than duplicating
// pickers — the two are just two different ways to run the same connection
// against the same shop list.
export function BackgroundBackfillPanel({ connectionKey, companyId, targetLocationIds }: {
  connectionKey: ConnectionKey
  companyId: string | null
  targetLocationIds: string[] | null
}) {
  const [job, setJob] = useState<BackfillJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('data_connection_backfill_jobs')
      .select('*').eq('company_id', companyId).eq('connection_key', connectionKey)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!error) setJob(data as BackfillJob | null)
    setLoading(false)
  }, [companyId, connectionKey])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (job?.status === 'running') pollRef.current = setInterval(load, 15000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job?.status, load])

  async function start() {
    if (!companyId || !targetLocationIds?.length) return
    setBusy(true)
    const sb = supabase as any
    const nowMonth = new Date().toISOString().slice(0, 8) + '01'
    const payload: Record<string, unknown> = {
      company_id: companyId, connection_key: connectionKey, status: 'running', location_ids: targetLocationIds,
    }
    if (connectionKey === 'droptop_usage') {
      payload.usage_pending_location_ids = targetLocationIds
    } else {
      payload.cursor_month = nowMonth
    }
    const { error } = await sb.schema('inventory').from('data_connection_backfill_jobs').insert(payload)
    if (error) toast.error(error.message)
    else toast.success('Background backfill started — it will keep running even if you leave this page')
    await load()
    setBusy(false)
  }

  async function stop() {
    if (!job) return
    setBusy(true)
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('data_connection_backfill_jobs')
      .update({ status: 'completed', last_tick_summary: 'Stopped manually' }).eq('id', job.id)
    if (error) toast.error(error.message)
    await load()
    setBusy(false)
  }

  async function tickNow() {
    setBusy(true)
    try {
      const { data, error } = await supabase.functions.invoke('data-connection-backfill-dispatcher', { body: {} })
      if (error) throw new Error(error.message)
      if (data?.error) throw new Error(data.error)
      toast.success(`Tick complete (${data.jobs_processed} job(s) processed)`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Tick failed')
    } finally {
      await load()
      setBusy(false)
    }
  }

  if (loading) return null

  const isUsage = connectionKey === 'droptop_usage'
  const running = job?.status === 'running'

  return (
    <div className="flex flex-col gap-2 border-t border-navy/10 pt-3 mt-1">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] font-mono text-inky uppercase tracking-wide">Run in the background instead</span>
        {job && (
          <Badge color={job.status === 'running' ? 'sky' : job.status === 'error' ? 'red' : 'green'}>
            {job.status}
          </Badge>
        )}
      </div>
      {job && (
        <p className="text-[11px] font-mono text-inky/70">
          {isUsage
            ? `${job.usage_done_count} of ${job.location_ids.length} shop(s) pulled`
            : `Checked back to ${job.cursor_month} (floor ${job.floor_month}) — ${job.months_pulled} month(s) pulled, ${job.months_skipped} already covered`}
          {job.last_tick_summary ? ` — last tick: ${job.last_tick_summary}` : ''}
        </p>
      )}
      {job?.error_message && <p className="text-[11px] font-mono text-[#C0392B]">Last tick error (will retry automatically): {job.error_message}</p>}
      <div className="flex items-center gap-2">
        {!running ? (
          <Button size="sm" variant="secondary" loading={busy} disabled={!targetLocationIds?.length} onClick={start}>
            <Play className="w-3 h-3 mr-1" /> Start Background Backfill{targetLocationIds?.length ? ` (${targetLocationIds.length} shop${targetLocationIds.length === 1 ? '' : 's'})` : ''}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="secondary" loading={busy} onClick={tickNow} title="Run one tick right now instead of waiting up to 10 minutes for the next scheduled one">
              <Zap className="w-3 h-3 mr-1" /> Run Tick Now
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={stop}>
              <Square className="w-3 h-3 mr-1" /> Stop
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
