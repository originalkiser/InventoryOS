import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, CheckCircle2, XCircle, X } from 'lucide-react'
import { useSyncTasksStore, type SyncTask } from '@/stores/syncTasksStore'

// Live progress for in-flight data syncs (Droptop, SkyBitz, Automated
// Checks, ...) — lives in the TopBar, left of Recent Pages. Reads
// useSyncTasksStore directly, which is plain module state rather than any
// one page's component state, so a sync's progress keeps updating here
// correctly no matter how many pages get visited (or evicted from the
// Recent Pages keep-alive cache) while it's still running — the widget
// doesn't drive the sync, it just reflects whatever the store says.
//
// Seed of a broader task/notification surface later (per the project's own
// direction) — deliberately generic (label/progress/dismiss) rather than
// Droptop-specific.
export function SyncStatusWidget() {
  const tasks = useSyncTasksStore((s) => s.tasks)
  const dismiss = useSyncTasksStore((s) => s.dismiss)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const running = tasks.filter((t) => t.status === 'running')
  const finished = tasks.filter((t) => t.status !== 'running')

  function openPanel() {
    const r = buttonRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
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
        <RefreshCw className={`w-4 h-4 ${running.length > 0 ? 'animate-spin' : ''}`} />
        {running.length > 1 && <span className="text-[10px] font-mono">{running.length}</span>}
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ top: pos.top, left: pos.left }}
          className="fixed z-[100] w-72 bg-[#002745] border border-[#F2F1E6]/20 rounded-xl shadow-xl p-3 flex flex-col gap-2 animate-[fadeIn_120ms_ease-out]"
        >
          <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Data Syncs</span>
          {tasks.length === 0 ? (
            <p className="text-xs font-mono text-[#F2F1E6]/40 italic py-2 text-center">Nothing running right now.</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
              {[...running, ...finished].map((t) => <TaskRow key={t.id} task={t} onDismiss={() => dismiss(t.id)} />)}
            </div>
          )}
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
      {task.status === 'error' && task.message && (
        <p className="text-[10px] font-mono text-[#C0392B]/90 truncate" title={task.message}>{task.message}</p>
      )}
    </div>
  )
}
