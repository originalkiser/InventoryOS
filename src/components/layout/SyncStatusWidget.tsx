import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react'
import { GrDatabase } from 'react-icons/gr'
import { useSyncTasksStore, type SyncTask } from '@/stores/syncTasksStore'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { supabase } from '@/lib/supabase'
import { isAdminOrDeveloper } from '@/lib/roles'
import { formatInTz } from '@/lib/tzFormat'
import { TIMEZONE_KEY, DEFAULT_TIMEZONE } from '@/modules/config/tabs/DataConnectionsTab'
import { CONNECTION_META, CONNECTION_ORDER, statusColor, runDataConnectionNow } from '@/hooks/useDataConnectionRunner'
import { SbLoader } from '@/components/ui/SbLoader'
import type { DataConnectionSchedule } from '@/types/integrations'

// Live progress for in-flight data syncs (Droptop, SkyBitz, Automated
// Checks, ...) — lives in the TopBar, left of Recent Pages. Reads
// useSyncTasksStore directly, which is plain module state rather than any
// one page's component state, so a sync's progress keeps updating here
// correctly no matter how many pages get visited (or evicted from the
// Recent Pages keep-alive cache) while it's still running — the widget
// doesn't drive the sync, it just reflects whatever the store says.
//
// Also shows each connection's Recent Performance (last_run_at/status,
// scheduled or manual, whichever is newer) instead of a bare "nothing
// running" — and, for admins/developers, a per-connection Run Now that
// shares the exact same sync logic Data Connections' own Run Now uses (see
// useDataConnectionRunner.ts).
const DOT_CLASS: Record<ReturnType<typeof statusColor>, string> = {
  green: 'bg-sb-green',
  orange: 'bg-sb-orange',
  red: 'bg-sb-red',
  gray: 'bg-[#F2F1E6]/25',
}

export function SyncStatusWidget() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const canRunNow = isAdminOrDeveloper(profile?.role)
  const [timezone] = useAppSetting<string>(TIMEZONE_KEY, DEFAULT_TIMEZONE)
  const tasks = useSyncTasksStore((s) => s.tasks)
  const dismiss = useSyncTasksStore((s) => s.dismiss)
  const [open, setOpen] = useState(false)
  // Right-anchored, same as PresenceWidget's own panel — the button sits
  // near the right edge of the TopBar, so anchoring by left edge could push
  // a fixed-width panel past the viewport's right edge instead of lining up
  // with the button that opened it.
  const [pos, setPos] = useState({ top: 0, right: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const [rows, setRows] = useState<DataConnectionSchedule[] | null>(null)
  const [runningKey, setRunningKey] = useState<string | null>(null)

  const loadRows = useCallback(async () => {
    if (!companyId) return
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('data_connection_schedules').select('*').eq('company_id', companyId)
    setRows((data ?? []) as DataConnectionSchedule[])
  }, [companyId])

  useEffect(() => { if (open) loadRows() }, [open, loadRows])

  const running = tasks.filter((t) => t.status === 'running')
  const finished = tasks.filter((t) => t.status !== 'running')

  // In-app navigation survives fine (see this file's own header comment —
  // the store is module state, not tied to any page), but an actual tab
  // close/reload/computer-sleep kills the JS running the sync outright,
  // with no server-side job behind it to resume from. A long backfill can
  // run for hours, so warn before that specific action rather than let it
  // silently vanish. Browsers ignore any custom message text here and show
  // their own fixed wording, but the confirmation prompt itself still fires.
  useEffect(() => {
    if (running.length === 0) return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [running.length])

  function openPanel() {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right })
    setOpen((v) => !v)
  }

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) {
      const target = e.target as Node
      if (buttonRef.current?.contains(target)) return
      if (panelRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // Auto-open the first time a sync starts, so progress is visible without
  // having to know to go look for it — matches Recent Pages' own
  // auto-reveal-on-navigation behavior.
  const prevRunningCount = useRef(0)
  useEffect(() => {
    if (running.length > 0 && prevRunningCount.current === 0) setOpen(true)
    prevRunningCount.current = running.length
  }, [running.length])

  async function runNow(key: string) {
    if (!companyId) return
    setRunningKey(key)
    try {
      await runDataConnectionNow(key, { companyId, rows, profileId: profile?.id ?? null })
    } finally {
      setRunningKey(null)
      loadRows()
    }
  }

  return (
    <div className="relative flex-shrink-0">
      <button
        ref={buttonRef}
        onClick={openPanel}
        title={running.length > 0 ? `${running.length} sync${running.length !== 1 ? 's' : ''} running` : 'Data sync status'}
        className={[
          'flex items-center gap-1 px-2 h-7 rounded border transition-all',
          running.length > 0 ? 'border-sky text-sky' : 'border-[#F2F1E6]/20 text-[#F2F1E6]/60 hover:text-[#F2F1E6]',
        ].join(' ')}
      >
        {running.length > 0 ? <SbLoader size={16} hideMark /> : <GrDatabase className="w-4 h-4" />}
        {running.length > 1 && <span className="text-[10px] font-mono">{running.length}</span>}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ top: pos.top, right: pos.right }}
          className="fixed z-[100] w-80 bg-[#002745] border border-[#F2F1E6]/20 rounded-xl shadow-xl p-3 flex flex-col gap-3 animate-[fadeIn_120ms_ease-out]"
        >
          {tasks.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Active</span>
              <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
                {[...running, ...finished].map((t) => <TaskRow key={t.id} task={t} onDismiss={() => dismiss(t.id)} />)}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Recent Performance</span>
            {rows === null ? (
              <p className="text-xs font-mono text-[#F2F1E6]/40 italic py-2 text-center">Loading…</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-72 overflow-y-auto">
                {CONNECTION_ORDER.map((key) => {
                  const row = rows.find((r) => r.connection_key === key)
                  const meta = CONNECTION_META[key] ?? { label: key }
                  // Whichever of the scheduled/manual run actually happened
                  // most recently — a manual Run Now shouldn't be shadowed
                  // by an older scheduled-run timestamp, or vice versa.
                  const scheduledAt = row?.last_run_at ?? null
                  const manualAt = row?.last_manual_run_at ?? null
                  const useManual = manualAt && (!scheduledAt || new Date(manualAt) > new Date(scheduledAt))
                  const lastAt = useManual ? manualAt : scheduledAt
                  const lastStatus = useManual ? (row?.last_manual_run_status ?? null) : (row?.last_run_status ?? null)
                  return (
                    <div key={key} className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-[#F2F1E6]/5">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT_CLASS[statusColor(lastStatus)]}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-mono text-[#F2F1E6] truncate">{meta.label}</div>
                        <div className="text-[10px] font-mono text-[#F2F1E6]/40">{lastAt ? formatInTz(lastAt, timezone) : 'Never run'}</div>
                      </div>
                      {canRunNow && (
                        <button
                          onClick={() => runNow(key)}
                          disabled={runningKey === key || running.some((t) => t.label === meta.label)}
                          className="text-[10px] font-mono uppercase tracking-wide text-sky hover:text-[#F2F1E6] disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                        >
                          {runningKey === key ? '…' : 'Run Now'}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

function TaskRow({ task, onDismiss }: { task: SyncTask; onDismiss: () => void }) {
  const pct = task.totalBatches > 0 ? Math.min(100, Math.round((task.currentBatch / task.totalBatches) * 100)) : null
  return (
    <div className="flex flex-col gap-1 px-1.5 py-1.5 rounded hover:bg-[#F2F1E6]/5">
      <div className="flex items-center gap-2">
        {task.status === 'running' && <RefreshCw className="w-3.5 h-3.5 text-sky animate-spin flex-shrink-0" />}
        {task.status === 'success' && <CheckCircle2 className="w-3.5 h-3.5 text-[#2ECC71] flex-shrink-0" />}
        {task.status === 'partial' && <AlertTriangle className="w-3.5 h-3.5 text-[#E67E22] flex-shrink-0" />}
        {task.status === 'error' && <XCircle className="w-3.5 h-3.5 text-[#C0392B] flex-shrink-0" />}
        <span className="text-xs font-mono text-[#F2F1E6] flex-1 truncate">{task.label}</span>
        {task.status === 'running' && task.totalBatches > 0 && (
          <span className="text-[9px] font-mono text-[#F2F1E6]/50 flex-shrink-0">{task.currentBatch}/{task.totalBatches}</span>
        )}
        {task.status !== 'running' && (
          <button onClick={onDismiss} title="Dismiss" className="text-[#F2F1E6]/30 hover:text-[#F2F1E6] flex-shrink-0">
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
      {task.status === 'running' && (
        <div className="h-1 rounded-full bg-[#F2F1E6]/10 overflow-hidden">
          {pct != null ? (
            <div className="h-full bg-sky rounded-full transition-[width] duration-300" style={{ width: `${pct}%` }} />
          ) : (
            <div className="h-full w-1/3 bg-sky rounded-full animate-pulse" />
          )}
        </div>
      )}
      {(task.status === 'error' || task.status === 'partial') && task.message && (
        <p className={`text-[10px] font-mono whitespace-normal break-words ${task.status === 'error' ? 'text-[#C0392B]/90' : 'text-[#E67E22]/90'}`}>{task.message}</p>
      )}
    </div>
  )
}
