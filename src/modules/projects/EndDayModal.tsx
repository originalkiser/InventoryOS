import { useEffect, useState } from 'react'
import { format, addDays } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Modal, Button } from '@/components/ui'
import toast from 'react-hot-toast'

interface PendingTask {
  id: string
  task_name: string
  project_name: string
  due_date: string | null
  times_pushed: number
}

interface EndDayModalProps {
  open: boolean
  onClose: () => void
  onSaved?: () => void
}

// Returns the next workday from today, skipping weekends + holidays + blocked days.
export function nextWorkday(
  skipWeekends: boolean,
  holidays: string[],
  blockedDays: string[],
): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  if (!skipWeekends) return format(d, 'yyyy-MM-dd')
  while (true) {
    const dow = d.getDay()
    const iso = format(d, 'yyyy-MM-dd')
    if (dow !== 0 && dow !== 6 && !holidays.includes(iso) && !blockedDays.includes(iso)) return iso
    d.setDate(d.getDate() + 1)
  }
}

export function EndDayModal({ open, onClose, onSaved }: EndDayModalProps) {
  const { profile } = useAuthStore()
  const [tasks, setTasks] = useState<PendingTask[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [actions, setActions] = useState<Record<string, 'done' | 'push' | 'date' | null>>({})
  const [datePicks, setDatePicks] = useState<Record<string, string>>({})
  const [holidays, setHolidays] = useState<string[]>([])

  const today = format(new Date(), 'yyyy-MM-dd')
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

  const skipWeekends = profile?.skip_weekends_holidays ?? false
  const userBlockedDays = (profile?.blocked_days ?? []).map((d) => d.date)
  const pushDate = nextWorkday(skipWeekends, holidays, userBlockedDays)
  const pushLabel = pushDate === tomorrow
    ? '→ Tomorrow'
    : `→ ${format(new Date(pushDate + 'T00:00:00'), 'EEE, MMM d')}`

  useEffect(() => {
    if (!open || !profile?.company_id) return
    load()
  }, [open, profile?.company_id])

  async function load() {
    if (!profile?.company_id) return
    setLoading(true)
    setActions({})
    setDatePicks({})
    const sb = supabase as any

    const [tasksRes, holidayRes] = await Promise.all([
      sb.schema('inventory').from('project_tasks')
        .select('id, task_name, times_pushed, done, due_date, projects!inner(project_name)')
        .eq('company_id', profile.company_id)
        .eq('done', false)
        .lte('due_date', today)
        .order('due_date'),
      sb.schema('core').from('company_holidays')
        .select('date')
        .eq('company_id', profile.company_id)
        .gte('date', tomorrow)
        .lte('date', format(addDays(new Date(), 90), 'yyyy-MM-dd')),
    ])

    if (tasksRes.error) { toast.error('Failed to load tasks'); setLoading(false); return }

    const loaded: PendingTask[] = (tasksRes.data ?? []).map((t: any) => ({
      id: t.id,
      task_name: t.task_name,
      project_name: t.projects?.project_name ?? '—',
      due_date: t.due_date,
      times_pushed: t.times_pushed ?? 0,
    }))

    setHolidays((holidayRes.data ?? []).map((h: any) => h.date as string))
    setTasks(loaded)

    if (profile?.auto_push_tasks && loaded.length > 0) {
      setActions(Object.fromEntries(loaded.map((t) => [t.id, 'push'])))
    }

    setLoading(false)
  }

  function setAction(id: string, a: 'done' | 'push' | 'date') {
    setActions((prev) => ({ ...prev, [id]: prev[id] === a ? null : a }))
  }
  function markAllDone() { setActions(Object.fromEntries(tasks.map((t) => [t.id, 'done']))) }
  function pushAll() { setActions(Object.fromEntries(tasks.map((t) => [t.id, 'push']))) }

  async function save() {
    setSaving(true)
    const sb = supabase as any
    const doneIds = tasks.filter((t) => actions[t.id] === 'done').map((t) => t.id)
    const pushTasks = tasks.filter((t) => actions[t.id] === 'push')
    const dateTasks = tasks.filter((t) => actions[t.id] === 'date' && datePicks[t.id])

    const ops: Promise<any>[] = []
    if (doneIds.length) {
      ops.push(sb.schema('inventory').from('project_tasks')
        .update({ done: true, status: 'Complete' }).in('id', doneIds))
    }
    for (const t of pushTasks) {
      ops.push(sb.schema('inventory').from('project_tasks')
        .update({ due_date: pushDate, times_pushed: t.times_pushed + 1 }).eq('id', t.id))
    }
    for (const t of dateTasks) {
      ops.push(sb.schema('inventory').from('project_tasks')
        .update({ due_date: datePicks[t.id], times_pushed: t.times_pushed + 1 }).eq('id', t.id))
    }

    const results = await Promise.all(ops)
    const err = results.find((r) => r.error)?.error
    if (err) { toast.error(err.message); setSaving(false); return }

    const msgs: string[] = []
    if (doneIds.length) msgs.push(`${doneIds.length} completed`)
    const pushed = pushTasks.length + dateTasks.length
    if (pushed) msgs.push(`${pushed} pushed`)
    if (msgs.length) toast.success(msgs.join(', '))

    setSaving(false)
    onSaved?.()
    onClose()
  }

  const actionedCount = tasks.filter((t) => {
    const a = actions[t.id]
    return a === 'done' || a === 'push' || (a === 'date' && datePicks[t.id])
  }).length

  return (
    <Modal open={open} onClose={onClose} title="End of Day Check-In" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs font-body text-inky">
          {loading ? 'Loading tasks…' : tasks.length === 0
            ? 'No overdue or due-today tasks. Great work!'
            : `${tasks.length} task${tasks.length !== 1 ? 's' : ''} due today or overdue. Mark each as done, push, or pick a specific date.`
          }
        </p>

        {tasks.length > 0 && (
          <>
            <div className="flex gap-2 flex-wrap">
              <button onClick={markAllDone} className="text-xs font-body text-inky hover:text-navy underline">Mark all done</button>
              <span className="text-inky/40">·</span>
              <button onClick={pushAll} className="text-xs font-body text-inky hover:text-navy underline">
                Push all {pushDate === tomorrow ? 'to tomorrow' : `to ${format(new Date(pushDate + 'T00:00:00'), 'EEE, MMM d')}`}
              </button>
            </div>

            <div className="flex flex-col divide-y divide-navy/10 max-h-96 overflow-y-auto border border-navy/20 rounded-lg">
              {tasks.map((t) => {
                const action = actions[t.id]
                const isOverdue = t.due_date && t.due_date < today
                return (
                  <div key={t.id} className={[
                    'flex flex-col gap-1.5 px-4 py-2.5 transition-colors',
                    action === 'done' ? 'bg-sky/10' : action === 'push' || action === 'date' ? 'bg-orange-50/40' : '',
                  ].join(' ')}>
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className={['text-xs font-body truncate', action === 'done' ? 'line-through text-inky/50' : 'text-navy'].join(' ')}>
                          {t.task_name}
                        </p>
                        <p className="text-[10px] font-body text-inky/70 truncate">
                          {t.project_name}
                          {t.due_date && (
                            <span className={isOverdue ? ' text-[#C0392B]' : ''}>
                              {' · '}{isOverdue ? 'Overdue: ' : ''}{format(new Date(t.due_date + 'T00:00:00'), 'MMM d')}
                            </span>
                          )}
                          {t.times_pushed > 0 && (
                            <span className="text-orange-600"> · pushed {t.times_pushed}×</span>
                          )}
                        </p>
                      </div>
                      <div className="flex gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => setAction(t.id, 'done')}
                          className={[
                            'px-2 py-1 text-[10px] font-heading uppercase tracking-wide rounded border transition-all',
                            action === 'done'
                              ? 'bg-sky/30 border-sky text-navy'
                              : 'border-navy/30 text-inky hover:border-navy hover:text-navy',
                          ].join(' ')}
                        >
                          ✓ Done
                        </button>
                        <button
                          onClick={() => setAction(t.id, 'push')}
                          className={[
                            'px-2 py-1 text-[10px] font-heading uppercase tracking-wide rounded border transition-all',
                            action === 'push'
                              ? 'bg-orange-500/20 border-orange-500/60 text-orange-700'
                              : 'border-navy/30 text-inky hover:border-navy hover:text-navy',
                          ].join(' ')}
                        >
                          {pushLabel}
                        </button>
                        <button
                          onClick={() => setAction(t.id, 'date')}
                          title="Push to a specific date"
                          className={[
                            'px-2 py-1 text-[10px] font-heading uppercase tracking-wide rounded border transition-all',
                            action === 'date'
                              ? 'bg-orange-500/20 border-orange-500/60 text-orange-700'
                              : 'border-navy/30 text-inky hover:border-navy hover:text-navy',
                          ].join(' ')}
                        >
                          📅
                        </button>
                      </div>
                    </div>

                    {action === 'date' && (
                      <div className="flex items-center gap-2 pl-0">
                        <label className="text-[10px] font-mono text-inky/70 whitespace-nowrap">Push to:</label>
                        <input
                          type="date"
                          min={tomorrow}
                          value={datePicks[t.id] ?? ''}
                          onChange={(e) => setDatePicks((prev) => ({ ...prev, [t.id]: e.target.value }))}
                          className="text-xs font-mono rounded border border-navy/30 bg-cream px-2 py-0.5 text-navy focus:border-[#00e5ff] focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {tasks.length === 0 ? 'Close' : 'Skip'}
          </Button>
          {tasks.length > 0 && (
            <Button size="sm" loading={saving} disabled={actionedCount === 0} onClick={save}>
              Save {actionedCount > 0 ? `(${actionedCount})` : ''}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}
