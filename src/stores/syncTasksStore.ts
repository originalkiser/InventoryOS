import { create } from 'zustand'

// Tracks in-progress/recently-finished data syncs (Droptop, SkyBitz,
// Automated Checks, ...) so the TopBar's status indicator can show real
// progress — and, critically, so that progress survives navigation. A
// sync's actual work (the batch loop in droptopService.ts etc.) is kicked
// off from whatever page's button started it, but this store is plain
// module-level state, not React component state — it isn't tied to any
// page's mount lifecycle, so it keeps reporting accurately no matter how
// many pages get visited (or evicted from the Recent Pages keep-alive
// cache) while a sync is still running.
//
// This is deliberately generic (id/label/batches, not "Droptop-specific")
// since it's meant to be the seed of a broader task/notification surface
// later, not a one-off progress bar for Droptop alone.

export interface SyncTask {
  id: string
  label: string
  status: 'running' | 'success' | 'partial' | 'error'
  currentBatch: number
  totalBatches: number // 0 = not a batched/chunked sync — shown as an indeterminate spinner, not a fraction
  message: string | null
  startedAt: number
  finishedAt: number | null
}

interface SyncTasksState {
  tasks: SyncTask[]
  /** Begin tracking a task — replaces any existing task with the same id. */
  start: (id: string, label: string, totalBatches?: number) => void
  setProgress: (id: string, currentBatch: number, totalBatches?: number) => void
  /** Marks done; auto-dismisses after a delay — errors and partials stay until dismissed by hand. */
  finish: (id: string, status: 'success' | 'partial' | 'error', message?: string | null) => void
  dismiss: (id: string) => void
}

// Errors and partials don't auto-dismiss at all (see finish() below) — only
// a clean success does. A partial run has warnings worth actually reading,
// same reasoning as an outright error.
const SUCCESS_AUTO_DISMISS_MS = 8000

// Stable task ids shared between wherever a given sync can be triggered
// from (Data Connections' "Run Now", a module's own page like PO Status)
// so starting it from either place updates the SAME tracked task instead
// of two independent ones.
export const DROPTOP_ON_HAND_TASK_ID = 'droptop-on-hand'
export const DROPTOP_USAGE_TASK_ID = 'droptop-usage'
export const DROPTOP_PO_SYNC_TASK_ID = 'droptop-po-sync'
export const DROPTOP_ORDERS_TASK_ID = 'droptop-orders'
export const SKYBITZ_TANKS_TASK_ID = 'skybitz-tanks'
export const AUTOMATED_CHECKS_TASK_ID = 'automated-checks'
export const GEOCODE_ORDERS_TASK_ID = 'geocode-orders'
export const HEATMAP_ROLLUP_TASK_ID = 'heatmap-rollup-refresh'

export const useSyncTasksStore = create<SyncTasksState>((set, get) => ({
  tasks: [],

  start: (id, label, totalBatches = 0) => {
    set((s) => ({
      tasks: [
        ...s.tasks.filter((t) => t.id !== id),
        { id, label, status: 'running', currentBatch: 0, totalBatches, message: null, startedAt: Date.now(), finishedAt: null },
      ],
    }))
  },

  setProgress: (id, currentBatch, totalBatches) => {
    set((s) => ({
      tasks: s.tasks.map((t) => (t.id === id ? { ...t, currentBatch, ...(totalBatches != null ? { totalBatches } : {}) } : t)),
    }))
  },

  finish: (id, status, message = null) => {
    set((s) => ({ tasks: s.tasks.map((t) => (t.id === id ? { ...t, status, message, finishedAt: Date.now() } : t)) }))
    // Errors and partials stay until manually dismissed — a message (a
    // Postgres conflict, a Droptop rate limit, "N missing a zip match",
    // whatever) is exactly the kind of thing that shouldn't quietly
    // disappear before anyone's read it.
    if (status === 'error' || status === 'partial') return
    setTimeout(() => {
      // Only auto-dismiss if it's still the same finished task (not
      // restarted in the meantime).
      const t = get().tasks.find((t) => t.id === id)
      if (t && t.status !== 'running') get().dismiss(id)
    }, SUCCESS_AUTO_DISMISS_MS)
  },

  dismiss: (id) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) })),
}))
