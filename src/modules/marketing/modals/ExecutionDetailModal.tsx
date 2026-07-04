import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type { MarketingCampaignAssignment, MarketingCampaignTask, TaskStatus } from '@/types/marketing'
import { TASK_STATUS_LABELS, TASK_STATUS_COLORS, calcProgress } from '@/types/marketing'

interface Props {
  locationName: string
  planMonth: string
  assignment: MarketingCampaignAssignment
  onClose: () => void
  onUpdated: (updated: MarketingCampaignAssignment) => void
}

export function ExecutionDetailModal({ locationName, planMonth, assignment, onClose, onUpdated }: Props) {
  const { profile } = useAuthStore()
  const userId = profile?.id
  const sb = supabase as any

  const [tasks, setTasks] = useState<MarketingCampaignTask[]>(assignment.campaign_tasks ?? [])
  const [saving, setSaving] = useState<string | null>(null)
  const [noteEditing, setNoteEditing] = useState<string | null>(null)
  const [noteValue, setNoteValue] = useState('')

  const { done, total, pct } = calcProgress(tasks)

  async function updateStatus(task: MarketingCampaignTask, status: TaskStatus) {
    setSaving(task.id)
    const now = new Date().toISOString()
    const update: Partial<MarketingCampaignTask> = {
      status,
      updated_at: now,
      updated_by: userId ?? undefined,
      completed_at: status === 'complete' ? now : null,
      completed_by: status === 'complete' ? (userId ?? undefined) : null,
    }
    const { error } = await sb.schema('marketing').from('campaign_tasks')
      .update(update)
      .eq('id', task.id)
    if (error) { toast.error('Failed to save'); setSaving(null); return }
    const updated = tasks.map(t => t.id === task.id ? { ...t, ...update } as MarketingCampaignTask : t)
    setTasks(updated)
    onUpdated({ ...assignment, campaign_tasks: updated })
    setSaving(null)
  }

  async function saveNote(taskId: string) {
    const { error } = await sb.schema('marketing').from('campaign_tasks')
      .update({ notes: noteValue.trim() || null, updated_at: new Date().toISOString(), updated_by: userId })
      .eq('id', taskId)
    if (error) { toast.error('Failed to save note'); return }
    setTasks(ts => ts.map(t => t.id === taskId ? { ...t, notes: noteValue.trim() || null } : t))
    setNoteEditing(null)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto py-8">
      <div className="bg-cream rounded-lg shadow-xl w-full max-w-xl mx-4 flex flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="font-heading font-bold text-navy">{assignment.campaign_name_snapshot}</h2>
            <p className="text-xs font-mono text-inky/60 mt-0.5">{locationName} · {planMonth}</p>
          </div>
          <button onClick={onClose} className="text-inky/40 hover:text-navy text-xl shrink-0">✕</button>
        </div>

        {/* Progress */}
        <div>
          <div className="flex justify-between text-xs font-mono text-inky/60 mb-1">
            <span>{done} / {total} complete</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 rounded bg-sky/20">
            <div className="h-2 rounded transition-all"
              style={{ width: `${pct}%`, backgroundColor: pct === 100 ? '#2ECC71' : pct >= 50 ? '#E67E22' : '#4F7489' }} />
          </div>
        </div>

        {/* Tasks */}
        <div className="flex flex-col gap-2">
          {tasks.map(task => (
            <div key={task.id} className="border border-sky/20 rounded-lg p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-navy">{task.task_name_snapshot}</span>
                    {task.is_required && <Badge color="inky">Required</Badge>}
                  </div>
                  {task.task_description_snapshot && (
                    <p className="text-xs font-mono text-inky/50 mt-0.5 truncate">{task.task_description_snapshot}</p>
                  )}
                </div>

                <select
                  className="border border-sky/30 rounded px-2 py-1 text-xs font-mono bg-white shrink-0 disabled:opacity-50"
                  value={task.status}
                  disabled={saving === task.id}
                  onChange={e => updateStatus(task, e.target.value as TaskStatus)}
                >
                  {(Object.entries(TASK_STATUS_LABELS) as [TaskStatus, string][]).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Notes */}
              <div className="mt-2">
                {noteEditing === task.id ? (
                  <div className="flex gap-2">
                    <input
                      className="flex-1 border border-sky/30 rounded px-2 py-1 text-xs font-mono bg-white focus:outline-none focus:ring-1 focus:ring-sky"
                      value={noteValue}
                      onChange={e => setNoteValue(e.target.value)}
                      placeholder="Add a note…"
                    />
                    <Button size="sm" variant="primary" onClick={() => saveNote(task.id)}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setNoteEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <button
                    className="text-xs font-mono text-inky/40 hover:text-navy"
                    onClick={() => { setNoteEditing(task.id); setNoteValue(task.notes ?? '') }}
                  >
                    {task.notes ? `Note: ${task.notes}` : '+ Add note'}
                  </button>
                )}
              </div>

              {task.status === 'complete' && task.completed_at && (
                <p className="text-xs font-mono text-inky/30 mt-1">Completed {new Date(task.completed_at).toLocaleDateString()}</p>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
