import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

type Status = 'submitted' | 'under_review' | 'in_progress' | 'completed' | 'declined' | 'deferred'
type Priority = 'low' | 'medium' | 'high' | 'critical'

interface FeatureRequest {
  id: string
  submitted_by: string
  title: string
  description: string
  departments: string[]
  priority: Priority
  status: Status
  developer_note: string | null
  removal_requested?: boolean
  created_at: string
  updated_at: string
  ping_count?: number
}

const ALL_STATUSES: Status[] = ['submitted', 'under_review', 'in_progress', 'completed', 'declined', 'deferred']

const STATUS_STYLES: Record<Status, string> = {
  submitted: 'bg-inky/10 text-inky',
  under_review: 'bg-sky/20 text-navy',
  in_progress: 'bg-yellow-100 text-yellow-800',
  completed: 'bg-green-100 text-green-800',
  declined: 'bg-red-100 text-red-700',
  deferred: 'bg-navy/10 text-inky',
}

const PRIORITY_STYLES: Record<Priority, string> = {
  low: 'bg-navy/5 text-inky',
  medium: 'bg-sky/10 text-navy',
  high: 'bg-yellow-100 text-yellow-800',
  critical: 'bg-red-100 text-red-700',
}

export function ManageRequestsPage() {
  const { profile } = useAuthStore()
  const myId = profile?.id ?? ''

  const [requests, setRequests] = useState<FeatureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [filterStatus, setFilterStatus] = useState<Status | ''>('')
  const [filterPriority, setFilterPriority] = useState<Priority | ''>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [devNotes, setDevNotes] = useState<Record<string, string>>({})
  const [savingNote, setSavingNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const sb = supabase as any
    let q = sb.schema('platform').from('feature_requests').select('*').order('created_at', { ascending: false })
    if (filterStatus) q = q.eq('status', filterStatus)
    if (filterPriority) q = q.eq('priority', filterPriority)
    const { data } = await q
    setRequests(data ?? [])
    setLoading(false)
  }, [filterStatus, filterPriority])

  useEffect(() => { load() }, [load])

  async function updateStatus(id: string, status: Status) {
    const sb = supabase as any
    const { error } = await sb.schema('platform').from('feature_requests')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error(error.message); return }
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, status } : r))
  }

  async function saveDevNote(id: string) {
    const note = devNotes[id] ?? ''
    setSavingNote(id)
    const sb = supabase as any
    const { error } = await sb.schema('platform').from('feature_requests')
      .update({ developer_note: note, updated_at: new Date().toISOString() })
      .eq('id', id)
    setSavingNote(null)
    if (error) { toast.error(error.message); return }
    setRequests((prev) => prev.map((r) => r.id === id ? { ...r, developer_note: note } : r))
    toast.success('Developer note saved')
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Manage Feature Requests</h1>
        <p className="text-xs text-inky mt-0.5">All submitted requests across departments.</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as Status | '')}
          className="rounded border border-navy/20 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-sky focus:outline-none"
        >
          <option value="">All Statuses</option>
          {ALL_STATUSES.map((s) => (
            <option key={s} value={s}>{s.replace('_', ' ')}</option>
          ))}
        </select>
        <select
          value={filterPriority}
          onChange={(e) => setFilterPriority(e.target.value as Priority | '')}
          className="rounded border border-navy/20 bg-cream px-2 py-1.5 text-xs font-mono text-navy focus:border-sky focus:outline-none"
        >
          <option value="">All Priorities</option>
          {(['low', 'medium', 'high', 'critical'] as Priority[]).map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading…</div>
      ) : (
        <div className="flex flex-col gap-3">
          {requests.map((req) => {
            const isExpanded = expandedId === req.id
            return (
              <div key={req.id} className="rounded border border-navy/15 bg-cream p-4 flex flex-col gap-3">
                {req.removal_requested && (
                  <div className="rounded bg-red-50 border border-red-200 px-3 py-1.5 text-xs font-mono text-red-700">
                    ⚠ Removal requested by submitter
                  </div>
                )}

                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-heading text-navy font-semibold">{req.title}</div>
                    <div className="flex flex-wrap gap-1.5 mt-1.5">
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${STATUS_STYLES[req.status]}`}>
                        {req.status.replace('_', ' ')}
                      </span>
                      <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${PRIORITY_STYLES[req.priority]}`}>
                        {req.priority}
                      </span>
                      {req.departments.map((d) => (
                        <span key={d} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-navy/5 text-inky">{d}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <select
                      value={req.status}
                      onChange={(e) => updateStatus(req.id, e.target.value as Status)}
                      className="rounded border border-navy/20 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-sky focus:outline-none"
                    >
                      {ALL_STATUSES.map((s) => (
                        <option key={s} value={s}>{s.replace('_', ' ')}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => setExpandedId(isExpanded ? null : req.id)}
                      className="text-xs font-mono text-inky hover:underline"
                    >
                      {isExpanded ? 'Collapse' : 'Expand'}
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="flex flex-col gap-4 pt-2 border-t border-navy/10">
                    <p className="text-xs font-body text-inky whitespace-pre-wrap">{req.description}</p>

                    <div className="flex flex-col gap-1.5">
                      <label className="text-[10px] font-heading text-inky uppercase tracking-wide">
                        Developer Note (visible to submitter)
                      </label>
                      <textarea
                        value={devNotes[req.id] ?? req.developer_note ?? ''}
                        onChange={(e) => setDevNotes((p) => ({ ...p, [req.id]: e.target.value }))}
                        rows={3}
                        placeholder="Status update visible to the submitter and department users…"
                        className="rounded border border-navy/20 bg-cream px-3 py-2 text-xs font-body text-navy placeholder-inky/40 focus:border-sky focus:outline-none resize-y"
                      />
                      <button
                        onClick={() => saveDevNote(req.id)}
                        disabled={savingNote === req.id}
                        className="self-start px-3 py-1.5 rounded border border-navy/20 text-xs font-mono text-inky hover:border-navy/40 disabled:opacity-40 transition-colors"
                      >
                        {savingNote === req.id ? 'Saving…' : 'Save Note'}
                      </button>
                    </div>

                    <div className="text-[10px] font-mono text-inky/40">
                      Submitted {format(new Date(req.created_at), 'MMM d, yyyy')} · Last updated {format(new Date(req.updated_at), 'MMM d, yyyy')}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
