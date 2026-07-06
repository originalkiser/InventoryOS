import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import toast from 'react-hot-toast'
import type {
  MarketingMonthlyPlan,
  MarketingCampaignAssignment,
  MarketingCampaignTask,
  MarketingLocation,
  TaskStatus,
} from '@/types/marketing'
import { MONTHS, TASK_STATUS_LABELS, calcProgress } from '@/types/marketing'

interface Props {
  plan: MarketingMonthlyPlan
  location: MarketingLocation | undefined
  isAdmin: boolean
  onClose: () => void
  onUpdated: (updated: MarketingMonthlyPlan) => void
  onDeleted: (planId: string) => void
}

export function PlanDetailModal({ plan, location, isAdmin, onClose, onUpdated, onDeleted }: Props) {
  const { profile } = useAuthStore()
  const userId = profile?.id
  const sb = supabase as any

  const [assignments, setAssignments] = useState<MarketingCampaignAssignment[]>(
    plan.campaign_assignments ?? []
  )
  const [activeTab, setActiveTab] = useState(0)
  const [saving, setSaving] = useState<string | null>(null)
  const [noteEditing, setNoteEditing] = useState<string | null>(null)
  const [noteValue, setNoteValue] = useState('')
  const [deleting, setDeleting] = useState(false)

  const monthLabel = `${MONTHS[plan.plan_month - 1]} ${plan.plan_year}`
  const locationLabel = location?.shop_city ?? location?.name ?? 'Unknown Shop'

  const allTasks = assignments.flatMap(a => a.campaign_tasks ?? [])
  const overall = calcProgress(allTasks)

  const activeAssignment = assignments[activeTab] as MarketingCampaignAssignment | undefined
  const tasks: MarketingCampaignTask[] = activeAssignment?.campaign_tasks ?? []
  const tabProgress = calcProgress(tasks)

  function patchAssignments(updatedAssignment: MarketingCampaignAssignment) {
    const next = assignments.map(a => a.id === updatedAssignment.id ? updatedAssignment : a)
    setAssignments(next)
    onUpdated({ ...plan, campaign_assignments: next })
  }

  async function updateStatus(task: MarketingCampaignTask, status: TaskStatus) {
    if (!activeAssignment) return
    setSaving(task.id)
    const now = new Date().toISOString()
    const patch: Partial<MarketingCampaignTask> = {
      status,
      updated_at: now,
      updated_by: userId ?? undefined,
      completed_at: status === 'complete' ? now : null,
      completed_by: status === 'complete' ? (userId ?? undefined) : null,
    }
    const { error } = await sb.schema('marketing').from('campaign_tasks')
      .update(patch)
      .eq('id', task.id)
    if (error) { toast.error('Failed to save'); setSaving(null); return }
    const updatedTasks = tasks.map(t => t.id === task.id ? { ...t, ...patch } as MarketingCampaignTask : t)
    patchAssignments({ ...activeAssignment, campaign_tasks: updatedTasks })
    setSaving(null)
  }

  async function saveNote(taskId: string) {
    if (!activeAssignment) return
    const note = noteValue.trim() || null
    const { error } = await sb.schema('marketing').from('campaign_tasks')
      .update({ notes: note, updated_at: new Date().toISOString(), updated_by: userId })
      .eq('id', taskId)
    if (error) { toast.error('Failed to save note'); return }
    const updatedTasks = tasks.map(t => t.id === taskId ? { ...t, notes: note } : t)
    patchAssignments({ ...activeAssignment, campaign_tasks: updatedTasks })
    setNoteEditing(null)
  }

  async function deletePlan() {
    if (!confirm(`Delete the plan for ${locationLabel} — ${monthLabel}? This removes all campaign and task data.`)) return
    setDeleting(true)
    const { error } = await sb.schema('marketing').from('monthly_plans').delete().eq('id', plan.id)
    if (error) { toast.error('Failed to delete plan'); setDeleting(false); return }
    toast.success('Plan deleted')
    onDeleted(plan.id)
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 overflow-y-auto py-8">
      <div className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-6 pb-4">
          <div>
            <h2 className="font-heading font-bold text-navy text-lg">{locationLabel}</h2>
            <p className="text-xs font-mono text-inky/60 mt-0.5">
              {location?.name && <span>{location.name} · </span>}
              {monthLabel}
            </p>
          </div>
          <button onClick={onClose} className="text-inky/40 hover:text-navy text-xl shrink-0 mt-0.5">✕</button>
        </div>

        {/* Overall progress */}
        <div className="px-6 pb-4">
          <div className="flex justify-between text-xs font-mono text-inky/60 mb-1">
            <span>Overall — {assignments.length} campaign{assignments.length !== 1 ? 's' : ''}</span>
            <span>{overall.done}/{overall.total} tasks · {overall.pct}%</span>
          </div>
          <div className="h-1.5 rounded bg-sky/20">
            <div className="h-1.5 rounded transition-all"
              style={{ width: `${overall.pct}%`, backgroundColor: overall.pct === 100 ? '#2ECC71' : overall.pct >= 50 ? '#E67E22' : '#4F7489' }} />
          </div>
        </div>

        {assignments.length === 0 ? (
          <div className="px-6 pb-6 text-xs font-mono text-inky/60">No campaigns assigned to this plan.</div>
        ) : (
          <>
            {/* Campaign tabs */}
            <div className="border-t border-sky/20 overflow-x-auto">
              <div className="flex min-w-max px-6">
                {assignments.map((a, i) => {
                  const { pct } = calcProgress(a.campaign_tasks ?? [])
                  const isActive = i === activeTab
                  return (
                    <button
                      key={a.id}
                      onClick={() => { setActiveTab(i); setNoteEditing(null) }}
                      className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-mono border-b-2 transition-colors whitespace-nowrap ${
                        isActive
                          ? 'border-navy text-navy font-semibold'
                          : 'border-transparent text-inky/50 hover:text-navy hover:border-sky/40'
                      }`}
                    >
                      {a.campaign_name_snapshot}
                      <span className={`text-[10px] px-1 rounded ${pct === 100 ? 'bg-sb-green/20 text-sb-green' : pct > 0 ? 'bg-sb-orange/20 text-sb-orange' : 'bg-inky/10 text-inky/50'}`}>
                        {pct}%
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Active campaign tasks */}
            <div className="flex flex-col gap-2 p-6 pt-4 max-h-[420px] overflow-y-auto">
              <div className="flex justify-between text-xs font-mono text-inky/60 mb-1">
                <span>{activeAssignment?.campaign_category_snapshot}</span>
                <span>{tabProgress.done}/{tabProgress.total} tasks complete</span>
              </div>

              {tasks.length === 0 ? (
                <p className="text-xs font-mono text-inky/40">No tasks for this campaign.</p>
              ) : tasks.map(task => (
                <div key={task.id} className="border border-sky/20 dark:border-[#F2F1E6]/10 rounded-lg p-3 dark:bg-[#0a2235]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono text-navy">{task.task_name_snapshot}</span>
                        {task.is_required && <Badge color="inky">Required</Badge>}
                      </div>
                      {task.task_description_snapshot && (
                        <p className="text-xs font-mono text-inky/50 mt-0.5 truncate">{task.task_description_snapshot}</p>
                      )}
                    </div>
                    <select
                      className="border border-sky/30 dark:border-[#F2F1E6]/20 rounded px-2 py-1 text-xs font-mono bg-cream dark:bg-[#122b40] text-navy dark:text-[#F2F1E6] shrink-0 disabled:opacity-50"
                      value={task.status}
                      disabled={saving === task.id}
                      onChange={e => updateStatus(task, e.target.value as TaskStatus)}
                    >
                      {(Object.entries(TASK_STATUS_LABELS) as [TaskStatus, string][]).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                  </div>

                  <div className="mt-2">
                    {noteEditing === task.id ? (
                      <div className="flex gap-2">
                        <input
                          className="flex-1 border border-sky/30 dark:border-[#F2F1E6]/20 rounded px-2 py-1 text-xs font-mono bg-cream dark:bg-[#122b40] text-navy dark:text-[#F2F1E6] focus:outline-none focus:ring-1 focus:ring-sky"
                          value={noteValue}
                          onChange={e => setNoteValue(e.target.value)}
                          placeholder="Add a note…"
                          autoFocus
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
                    <p className="text-xs font-mono text-inky/30 mt-1">
                      Completed {new Date(task.completed_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-sky/20">
          {isAdmin ? (
            <Button variant="ghost" size="sm" onClick={deletePlan} disabled={deleting}>
              <span className="text-sb-red">{deleting ? 'Deleting…' : 'Delete Plan'}</span>
            </Button>
          ) : <div />}
          <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
