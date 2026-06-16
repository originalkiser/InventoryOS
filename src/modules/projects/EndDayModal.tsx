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
  done: boolean
}

interface EndDayModalProps {
  open: boolean
  onClose: () => void
}

export function EndDayModal({ open, onClose }: EndDayModalProps) {
  const { profile } = useAuthStore()
  const [tasks, setTasks] = useState<PendingTask[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [toggled, setToggled] = useState<Record<string, 'done' | 'push' | null>>({})

  const today = format(new Date(), 'yyyy-MM-dd')
  const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd')

  useEffect(() => {
    if (!open || !profile?.company_id) return
    load()
  }, [open, profile?.company_id])

  async function load() {
    if (!profile?.company_id) return
    setLoading(true)
    setToggled({})
    const sb = supabase as any
    const { data, error } = await sb
      .from('project_tasks')
      .select('id, task_name, times_pushed, done, due_date, projects!inner(project_name)')
      .eq('company_id', profile.company_id)
      .eq('done', false)
      .lte('due_date', today)
      .order('due_date')
    if (error) { toast.error('Failed to load tasks'); setLoading(false); return }
    setTasks(
      (data ?? []).map((t: any) => ({
        id: t.id,
        task_name: t.task_name,
        project_name: t.projects?.project_name ?? '—',
        due_date: t.due_date,
        times_pushed: t.times_pushed ?? 0,
        done: t.done,
      }))
    )
    setLoading(false)
  }

  function markDone(id: string) {
    setToggled((prev) => ({ ...prev, [id]: prev[id] === 'done' ? null : 'done' }))
  }
  function markPush(id: string) {
    setToggled((prev) => ({ ...prev, [id]: prev[id] === 'push' ? null : 'push' }))
  }
  function markAllDone() {
    setToggled(Object.fromEntries(tasks.map((t) => [t.id, 'done'])))
  }
  function pushAll() {
    setToggled(Object.fromEntries(tasks.map((t) => [t.id, 'push'])))
  }

  async function save() {
    setSaving(true)
    const sb = supabase as any
    const doneIds = tasks.filter((t) => toggled[t.id] === 'done').map((t) => t.id)
    const pushTasks = tasks.filter((t) => toggled[t.id] === 'push')

    const ops: Promise<any>[] = []
    if (doneIds.length) {
      ops.push(sb.from('project_tasks').update({ done: true, status: 'Complete' }).in('id', doneIds))
    }
    for (const t of pushTasks) {
      ops.push(
        sb.from('project_tasks').update({
          due_date: tomorrow,
          times_pushed: (t.times_pushed ?? 0) + 1,
        }).eq('id', t.id)
      )
    }

    const results = await Promise.all(ops)
    const err = results.find((r) => r.error)?.error
    if (err) { toast.error(err.message); setSaving(false); return }

    const doneCount = doneIds.length
    const pushCount = pushTasks.length
    const msgs: string[] = []
    if (doneCount) msgs.push(`${doneCount} completed`)
    if (pushCount) msgs.push(`${pushCount} pushed to tomorrow`)
    if (msgs.length) toast.success(msgs.join(', '))
    setSaving(false)
    onClose()
  }

  const actionedCount = Object.values(toggled).filter(Boolean).length

  return (
    <Modal open={open} onClose={onClose} title="End of Day Check-In" size="lg">
      <div className="flex flex-col gap-4">
        <p className="text-xs font-body text-inky">
          {loading ? 'Loading tasks…' : tasks.length === 0
            ? 'No overdue or due-today tasks. Great work!'
            : `${tasks.length} task${tasks.length !== 1 ? 's' : ''} due today or overdue. Mark each as done or push to tomorrow.`
          }
        </p>

        {tasks.length > 0 && (
          <>
            <div className="flex gap-2">
              <button onClick={markAllDone} className="text-xs font-body text-inky hover:text-navy underline">Mark all done</button>
              <span className="text-inky/40">·</span>
              <button onClick={pushAll} className="text-xs font-body text-inky hover:text-navy underline">Push all to tomorrow</button>
            </div>

            <div className="flex flex-col divide-y divide-navy/10 max-h-80 overflow-y-auto border border-navy/20 rounded-lg">
              {tasks.map((t) => {
                const action = toggled[t.id]
                const isOverdue = t.due_date && t.due_date < today
                return (
                  <div key={t.id} className={[
                    'flex items-center gap-3 px-4 py-2.5 transition-colors',
                    action === 'done' ? 'bg-sky/10' : action === 'push' ? 'bg-cream' : '',
                  ].join(' ')}>
                    <div className="flex-1 min-w-0">
                      <p className={['text-xs font-body truncate', action === 'done' ? 'line-through text-inky/50' : 'text-navy'].join(' ')}>
                        {t.task_name}
                      </p>
                      <p className="text-[10px] font-body text-inky/70 truncate">
                        {t.project_name}
                        {t.due_date && (
                          <span className={isOverdue ? ' text-[#C0392B]' : ''}>
                            {' · '}
                            {isOverdue ? 'Overdue: ' : ''}{format(new Date(t.due_date + 'T00:00:00'), 'MMM d')}
                          </span>
                        )}
                        {t.times_pushed > 0 && (
                          <span className="text-orange-600"> · pushed {t.times_pushed}×</span>
                        )}
                      </p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => markDone(t.id)}
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
                        onClick={() => markPush(t.id)}
                        className={[
                          'px-2 py-1 text-[10px] font-heading uppercase tracking-wide rounded border transition-all',
                          action === 'push'
                            ? 'bg-orange-500/20 border-orange-500/60 text-orange-700'
                            : 'border-navy/30 text-inky hover:border-navy hover:text-navy',
                        ].join(' ')}
                      >
                        → Tomorrow
                      </button>
                    </div>
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
