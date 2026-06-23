import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui'
import { isAdminOrDeveloper, isDepartmentHead } from '@/lib/roles'
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
  created_at: string
  updated_at: string
}

interface RequestNote {
  id: string
  request_id: string
  author_id: string
  note: string
  created_at: string
}

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

function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${STATUS_STYLES[status]}`}>
      {status.replace('_', ' ')}
    </span>
  )
}

function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded capitalize ${PRIORITY_STYLES[priority]}`}>
      {priority}
    </span>
  )
}

function RequestCard({
  request,
  myId,
  onPing,
  onRemove,
  onAddNote,
}: {
  request: FeatureRequest
  myId: string
  onPing: (id: string) => void
  onRemove: (id: string) => void
  onAddNote: (id: string, note: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [notes, setNotes] = useState<RequestNote[]>([])
  const [notesLoaded, setNotesLoaded] = useState(false)
  const [newNote, setNewNote] = useState('')
  const [addingNote, setAddingNote] = useState(false)
  const [hasPingedToday, setHasPingedToday] = useState(false)
  const canPing = ['submitted', 'under_review', 'in_progress'].includes(request.status)

  useEffect(() => {
    if (!expanded || notesLoaded) return
    const sb = supabase as any
    sb.schema('platform').from('feature_request_notes')
      .select('*')
      .eq('request_id', request.id)
      .order('created_at', { ascending: false })
      .then(({ data }: any) => { setNotes(data ?? []); setNotesLoaded(true) })

    // Check today's ping
    const today = new Date().toISOString().slice(0, 10)
    sb.schema('platform').from('feature_request_pings')
      .select('id')
      .eq('request_id', request.id)
      .eq('user_id', myId)
      .gte('pinged_at', today)
      .maybeSingle()
      .then(({ data }: any) => { if (data) setHasPingedToday(true) })
  }, [expanded, notesLoaded, request.id, myId])

  async function handleAddNote() {
    if (!newNote.trim()) return
    setAddingNote(true)
    await onAddNote(request.id, newNote.trim())
    setNewNote('')
    // Reload notes
    const sb = supabase as any
    const { data } = await sb.schema('platform').from('feature_request_notes')
      .select('*').eq('request_id', request.id).order('created_at', { ascending: false })
    setNotes(data ?? [])
    setAddingNote(false)
  }

  return (
    <div className="rounded border border-navy/15 bg-cream dark:bg-navy/20 p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-heading text-navy dark:text-cream font-semibold">{request.title}</div>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            <StatusBadge status={request.status} />
            <PriorityBadge priority={request.priority} />
            {request.departments.map((d) => (
              <span key={d} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-navy/5 text-inky">{d}</span>
            ))}
          </div>
        </div>
        <div className="text-[10px] font-mono text-inky/50 flex-shrink-0">
          {format(new Date(request.created_at), 'MMM d, yyyy')}
        </div>
      </div>

      <p className={`text-xs font-body text-inky dark:text-[#F2F1E6]/70 ${expanded ? 'whitespace-pre-wrap' : 'line-clamp-3'}`}>
        {request.description}
      </p>
      <button onClick={() => setExpanded((e) => !e)} className="self-start text-[10px] font-mono text-inky/50 hover:underline">
        {expanded ? 'less' : 'more'}
      </button>

      {request.developer_note && (
        <div className="rounded bg-sky/10 border border-sky/30 px-3 py-2">
          <div className="text-[10px] font-heading text-inky uppercase tracking-wide mb-1">Developer Update</div>
          <p className="text-xs font-body text-navy">{request.developer_note}</p>
        </div>
      )}

      {expanded && (
        <div className="flex flex-col gap-2 pt-2 border-t border-navy/10">
          {notes.map((n) => (
            <div key={n.id} className="text-xs font-body text-inky">
              <span className="font-mono text-[10px] text-inky/50 mr-2">
                {format(new Date(n.created_at), 'MMM d')}
              </span>
              {n.note}
            </div>
          ))}
          <div className="flex gap-2 mt-1">
            <input
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddNote() } }}
              placeholder="Add a note…"
              className="flex-1 rounded border border-navy/20 bg-cream px-2 py-1 text-xs font-body text-navy focus:border-sky focus:outline-none"
            />
            <button
              onClick={handleAddNote}
              disabled={!newNote.trim() || addingNote}
              className="px-3 py-1 rounded border border-navy/20 text-xs font-mono text-inky hover:border-navy/40 disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {canPing && (
          <button
            onClick={() => { if (!hasPingedToday) { onPing(request.id); setHasPingedToday(true) } }}
            disabled={hasPingedToday}
            className={[
              'text-xs font-mono px-3 py-1 rounded border transition-colors',
              hasPingedToday
                ? 'border-navy/10 text-inky/30 cursor-default'
                : 'border-navy/20 text-inky hover:border-navy/40',
            ].join(' ')}
          >
            Ping for Update
          </button>
        )}
        <button
          onClick={() => onRemove(request.id)}
          className="text-[10px] font-mono text-inky/30 hover:text-inky/60 transition-colors ml-auto"
        >
          Request Removal
        </button>
      </div>
    </div>
  )
}

export function FeatureRequestsPage() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const myId = profile?.id ?? ''
  const canManage = isAdminOrDeveloper(profile?.role)
  const isDeptHead = isDepartmentHead(profile?.role)

  const [tab, setTab] = useState<'mine' | 'department'>('mine')
  const [requests, setRequests] = useState<FeatureRequest[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!myId) return
    setLoading(true)
    const sb = supabase as any
    if (tab === 'mine') {
      const { data } = await sb.schema('platform').from('feature_requests')
        .select('*').eq('submitted_by', myId).order('created_at', { ascending: false })
      setRequests(data ?? [])
    } else {
      const dept = (profile as any)?.department
      const { data } = await sb.schema('platform').from('feature_requests')
        .select('*')
        .contains('departments', dept ? [dept] : [])
        .order('created_at', { ascending: false })
      setRequests(data ?? [])
    }
    setLoading(false)
  }, [myId, tab, (profile as any)?.department])

  useEffect(() => { load() }, [load])

  async function handlePing(requestId: string) {
    const sb = supabase as any
    await sb.schema('platform').from('feature_request_pings').insert({
      request_id: requestId,
      user_id: myId,
    })
  }

  async function handleRemove(requestId: string) {
    const sb = supabase as any
    await sb.schema('platform').from('feature_requests')
      .update({ removal_requested: true })
      .eq('id', requestId)
    toast.success('Removal request sent')
  }

  async function handleAddNote(requestId: string, note: string) {
    const sb = supabase as any
    const { error } = await sb.schema('platform').from('feature_request_notes').insert({
      request_id: requestId,
      author_id: myId,
      note,
    })
    if (error) toast.error(error.message)
  }

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Feature Requests</h1>
          <p className="text-xs text-inky mt-0.5">Submit ideas and track their progress.</p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button size="sm" variant="secondary" onClick={() => navigate('/feature-requests/manage')}>
              Manage All
            </Button>
          )}
          <Button size="sm" onClick={() => navigate('/feature-requests/new')}>
            + New Request
          </Button>
        </div>
      </div>

      {isDeptHead && (
        <div className="flex gap-1 border-b border-navy/10">
          {(['mine', 'department'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={[
                'px-4 py-2 text-xs font-heading uppercase tracking-wide transition-colors',
                tab === t
                  ? 'border-b-2 border-sky text-navy'
                  : 'text-inky hover:text-navy',
              ].join(' ')}
            >
              {t === 'mine' ? 'My Requests' : 'Department Requests'}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="text-xs font-mono text-inky/50 animate-pulse">Loading…</div>
      ) : requests.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-sm font-body text-inky/50">No requests yet.</p>
          <button onClick={() => navigate('/feature-requests/new')} className="mt-2 text-xs font-mono text-inky hover:underline">
            Submit your first request →
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {requests.map((req) => (
            <RequestCard
              key={req.id}
              request={req}
              myId={myId}
              onPing={handlePing}
              onRemove={handleRemove}
              onAddNote={handleAddNote}
            />
          ))}
        </div>
      )}
    </div>
  )
}
