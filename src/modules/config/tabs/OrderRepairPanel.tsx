import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { Button, Badge } from '@/components/ui'

interface RepairJob {
  id: string
  status: 'running' | 'completed' | 'error'
  cursor_month: string | null
  floor_month: string
  repair_pending: string[] | null
  repair_round: number
  repair_gave_up: string[]
  repair_found: number
  repair_fixed: number
  paused_until: string | null
  last_run_at: string | null
  last_tick_summary: string | null
  error_message: string | null
}

// Orders data repair (migration 20260930cm, tickRepairJob in
// data-connection-backfill-dispatcher). Finds shop-weeks whose Finalized orders
// are missing their package rows — left behind when the 2026-10-02/03 backfill
// ran against a saturated database — re-pulls only those, and re-scans each
// month to verify. Runs on its own, one call at a time, only in a nightly
// window clear of the scheduled syncs, and pauses itself on timeouts. There is
// deliberately no "run a tick now" button: the guards are the point.
export function OrderRepairPanel({ companyId }: { companyId: string | null }) {
  const [job, setJob] = useState<RepairJob | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await (supabase as any).schema('inventory').from('data_connection_backfill_jobs')
      .select('*').eq('company_id', companyId).eq('connection_key', 'droptop_orders').eq('job_kind', 'repair')
      .order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (!error) setJob(data as RepairJob | null)
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (job?.status === 'running') pollRef.current = setInterval(load, 30000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [job?.status, load])

  async function start() {
    if (!companyId) return
    setBusy(true)
    const sb = supabase as any
    const { data: locs, error: locErr } = await sb.schema('core').from('locations').select('id')
      .eq('company_id', companyId).eq('active', true).not('droptop_operation_id', 'is', null)
    if (locErr || !locs?.length) { toast.error(locErr?.message ?? 'No active Droptop shops found'); setBusy(false); return }
    const { error } = await sb.schema('inventory').from('data_connection_backfill_jobs').insert({
      company_id: companyId, connection_key: 'droptop_orders', job_kind: 'repair', status: 'running',
      location_ids: locs.map((l: { id: string }) => l.id), cursor_month: '2026-09-01', floor_month: '2025-08-01',
    })
    if (error) {
      // The one-running-job-per-connection index also blocks this while an Orders backfill is running.
      if (error.code === '23505') toast.error('An Orders backfill or repair is already running')
      else toast.error(error.message)
    } else {
      toast.success('Repair started — it runs by itself, overnight')
    }
    await load()
    setBusy(false)
  }

  async function stop() {
    if (!job) return
    setBusy(true)
    const { error } = await (supabase as any).schema('inventory').from('data_connection_backfill_jobs')
      .update({ status: 'completed', last_tick_summary: 'Stopped manually', error_message: null, paused_until: null }).eq('id', job.id)
    if (error) toast.error(error.message)
    await load()
    setBusy(false)
  }

  if (loading) return null
  const running = job?.status === 'running'
  const paused = running && job?.paused_until && new Date(job.paused_until) > new Date()

  return (
    <div className="flex flex-col gap-2 border border-navy/20 rounded p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">Orders data repair</span>
        {job && <Badge color={job.status === 'running' ? 'sky' : job.status === 'error' ? 'red' : 'green'}>{paused ? 'paused' : job.status}</Badge>}
      </div>
      <p className="text-[11px] font-mono text-inky/70">
        Finds shop-weeks whose orders are missing their package records (left by the heavy backfill) and re-pulls only
        those, then re-checks each month. It runs by itself between 11pm and 5am Eastern, one call at a time, stays
        clear of the scheduled syncs, and pauses itself if it sees timeouts.
      </p>
      {job && (
        <p className="text-[11px] font-mono text-inky/70">
          Checking {job.cursor_month?.slice(0, 7)} (back to {job.floor_month.slice(0, 7)}) — {job.repair_found} shop-week(s) found,{' '}
          {job.repair_fixed} re-pulled clean, {job.repair_gave_up.length} given up
          {job.repair_pending?.length ? `, ${job.repair_pending.length} left this month (round ${job.repair_round})` : ''}
          {paused ? ` — paused until ${new Date(job.paused_until as string).toLocaleTimeString()}` : ''}
          {job.last_tick_summary ? ` — last: ${job.last_tick_summary}` : ''}
        </p>
      )}
      {job?.error_message && <p className="text-[11px] font-mono text-[#C0392B]">{job.error_message}</p>}
      <div className="flex items-center gap-2">
        {!running ? (
          <Button size="sm" variant="secondary" onClick={start} loading={busy}>
            <Play className="w-3.5 h-3.5 mr-1" /> {job ? 'Start a new repair' : 'Start repair'}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={stop} loading={busy}>
            <Square className="w-3.5 h-3.5 mr-1" /> Stop
          </Button>
        )}
      </div>
    </div>
  )
}
