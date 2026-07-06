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
  const [togglingNotDoing, setTogglingNotDoing] = useState<string | null>(null)
  const [noteEditing, setNoteEditing] = useState<string | null>(null)
  const [noteValue, setNoteValue] = useState('')
  const [deleting, setDeleting] = useState(false)

  const monthLabel = `${MONTHS[plan.plan_month - 1]} ${plan.plan_year}`
  const locationLabel = location?.shop_city ?? location?.name ?? 'Unknown Shop'

  // Exclude "not doing" campaigns from overall progress
  const activeTasks = assignments
    .filter(a => a.status !== 'not_doing')
    .flatMap(a => a.campaign_tasks ?? [])
  const overall = calcProgress(activeTasks)
  const activeCount = assignments.filter(a => a.status !== 'not_doing').length

  const activeAssignment = assignments[activeTab] as MarketingCampaignAssignment | undefined
  const isNotDoing = activeAssignment?.status === 'not_doing'
  const tasks: MarketingCampaignTask[] = activeAssignment?.campaign_tasks ?? []
  const tabProgress = calcProgress(tasks)

  function patchAssignments(updatedAssignment: MarketingCampaignAssignment) {
    const next = assignments.map(a => a.id === updatedAssignment.id ? updatedAssignment : a)
    setAssignments(next)
    onUpdated({ ...plan, campaign_assignments: next })
  }

  async function toggleNotDoing(assignment: MarketingCampaignAssignment) {
    setTogglingNotDoing(assignment.id)
    const newStatus = assignment.status === 'not_doing' ? 'not_started' : 'not_doing'
    const { error } = await sb.schema('marketing').from('campaign_assignments')
      .update({ status: newStatus, updated_at: new Date().toISOString(), updated_by: userId })
      .eq('id', assignment.id)
    if (error) { toast.error('Failed to update'); setTogglingNotDoing(null); return }
    patchAssignments({ ...assignment, status: newStatus })
    setTogglingNotDoing(null)
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

  function tabStyle(a: MarketingCampaignAssignment, isActive: boolean) {
    const notDoing = a.status === 'not_doing'
    const { pct } = calcProgress(a.campaign_tasks ?? [])
    const hasProgress = pct > 0

    if (isActive) {
      if (notDoing) return 'border-sb-orange text-sb-orange font-semibold'
      if (hasProgress) return 'border-sb-green text-sb-green font-semibold'
      return 'border-navy text-navy font-semibold'
    }
    if (notDoing) return 'border-transparent text-sb-orange/60 hover:text-sb-orange hover:border-sb-orange/40'
    if (hasProgress) return 'border-transparent text-sb-green/70 hover:text-sb-green hover:border-sb-green/40'
    return 'border-transparent text-inky hover:text-navy hover:border-sky/40'
  }

  function tabBadge(a: MarketingCampaignAssignment) {
    const notDoing = a.status === 'not_doing'
    const { pct } = calcProgress(a.campaign_tasks ?? [])
    if (notDoing) return <span className="text-[10px] px-1 rounded bg-sb-orange/20 text-sb-orange">N/A</span>
    if (pct === 100) return <span className="text-[10px] px-1 rounded bg-sb-green/20 text-sb-green">{pct}%</span>
    if (pct > 0) return <span className="text-[10px] px-1 rounded bg-sb-green/10 text-sb-green">{pct}%</span>
    return <span className="text-[10px] px-1 rounded bg-inky/10 text-inky">{pct}%</span>
  }

  return (
    // Backdrop — click to close
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      {/* Modal — stop propagation so clicks inside don't close */}
      <div
        className="bg-cream dark:bg-[#0e2638] rounded-lg shadow-xl w-full max-w-2xl flex flex-col"
        style={{ height: 'min(88vh, 860px)' }}
        onClick={e => e.stopPropagation()}
      >

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-6 pt-5 pb-3 shrink-0">
          <div>
            <h2 className="font-heading font-bold text-navy text-lg">{locationLabel}</h2>
            <p className="text-xs font-mono text-inky mt-0.5">
              {location?.name && <span>{location.name} · </span>}
              {monthLabel}
            </p>
          </div>
          <button onClick={onClose} className="text-inky hover:text-navy text-xl shrink-0 mt-0.5">✕</button>
        </div>

        {/* Overall progress */}
        <div className="px-6 pb-3 shrink-0">
          <div className="flex justify-between text-xs font-mono text-inky mb-1">
            <span>Overall — {activeCount} of {assignments.length} campaign{assignments.length !== 1 ? 's' : ''} active</span>
            <span>{overall.done}/{overall.total} tasks · {overall.pct}%</span>
          </div>
          <div className="h-1.5 rounded bg-sky/20">
            <div className="h-1.5 rounded transition-all"
              style={{ width: `${overall.pct}%`, backgroundColor: overall.pct === 100 ? '#2ECC71' : overall.pct >= 50 ? '#E67E22' : '#4F7489' }} />
          </div>
        </div>

        {assignments.length === 0 ? (
          <div className="px-6 pb-6 text-xs font-mono text-inky shrink-0">No campaigns assigned to this plan.</div>
        ) : (
          <>
            {/* Campaign tabs */}
            <div className="border-t border-sky/20 overflow-x-auto shrink-0">
              <div className="flex min-w-max px-4">
                {assignments.map((a, i) => (
                  <button
                    key={a.id}
                    onClick={() => { setActiveTab(i); setNoteEditing(null) }}
                    className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-mono border-b-2 transition-colors whitespace-nowrap ${tabStyle(a, i === activeTab)}`}
                  >
                    {a.campaign_name_snapshot}
                    {tabBadge(a)}
                  </button>
                ))}
              </div>
            </div>

            {/* Active campaign tasks — flex-1 fills remaining height */}
            <div className="flex flex-col flex-1 min-h-0 p-6 pt-3 gap-2 overflow-y-auto">
              {/* Campaign header row */}
              <div className="flex items-center justify-between mb-1 shrink-0">
                <span className="text-xs font-mono text-inky">{activeAssignment?.campaign_category_snapshot}</span>
                <div className="flex items-center gap-3">
                  {!isNotDoing && (
                    <span className="text-xs font-mono text-inky">{tabProgress.done}/{tabProgress.total} tasks complete</span>
                  )}
                  {activeAssignment && (
                    <button
                      className={`text-xs font-mono px-2 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                        isNotDoing
                          ? 'border-sb-orange/40 text-sb-orange hover:bg-sb-orange/10'
                          : 'border-inky/20 text-inky hover:text-sb-orange hover:border-sb-orange/40'
                      }`}
                      disabled={togglingNotDoing === activeAssignment.id}
                      onClick={() => toggleNotDoing(activeAssignment)}
                    >
                      {isNotDoing ? 'Resume campaign' : 'Not doing'}
                    </button>
                  )}
                </div>
              </div>

              {isNotDoing && (
                <div className="border border-sb-orange/20 rounded-lg px-4 py-3 bg-sb-orange/5 text-xs font-mono text-sb-orange shrink-0">
                  This campaign is marked as not doing — its tasks are excluded from overall progress.
                </div>
              )}

              {tasks.length === 0 ? (
                <p className="text-xs font-mono text-inky">No tasks for this campaign.</p>
              ) : tasks.map(task => (
                <div
                  key={task.id}
                  className={`border rounded-lg p-3 shrink-0 transition-opacity ${
                    isNotDoing
                      ? 'border-sky/20 dark:border-[#F2F1E6]/5 bg-white/70 dark:bg-[#0a2235] opacity-40'
                      : 'border-sky/30 dark:border-[#F2F1E6]/10 bg-white/70 dark:bg-[#0a2235]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-mono text-navy">{task.task_name_snapshot}</span>
                        {task.is_required && <Badge color="inky">Required</Badge>}
                      </div>
                      {task.task_description_snapshot && (
                        <p className="text-xs font-mono text-inky mt-0.5 truncate">{task.task_description_snapshot}</p>
                      )}
                    </div>
                    <select
                      className="border border-sky/30 dark:border-[#F2F1E6]/20 rounded px-2 py-1 text-xs font-mono bg-cream dark:bg-[#122b40] text-navy dark:text-[#F2F1E6] shrink-0 disabled:opacity-50"
                      value={task.status}
                      disabled={saving === task.id || isNotDoing}
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
                        className="text-xs font-mono text-inky hover:text-navy disabled:cursor-default"
                        disabled={isNotDoing}
                        onClick={() => { if (!isNotDoing) { setNoteEditing(task.id); setNoteValue(task.notes ?? '') } }}
                      >
                        {task.notes ? `Note: ${task.notes}` : '+ Add note'}
                      </button>
                    )}
                  </div>

                  {task.status === 'complete' && task.completed_at && (
                    <p className="text-xs font-mono text-inky mt-1">
                      Completed {new Date(task.completed_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-6 py-4 border-t border-sky/20 shrink-0">
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
