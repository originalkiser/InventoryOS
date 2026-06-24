import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useForms } from '@/hooks/useForms'
import { Button, Badge } from '@/components/ui'
import type { FormDefinition, FormAssignment } from '@/types/forms'
import { format, isPast, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const sb = supabase as any

export function FormsListPage() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const { forms, loading, deleteForm, duplicateForm } = useForms()
  const [assignments, setAssignments] = useState<(FormAssignment & { form?: FormDefinition })[]>([])
  const [submissionCounts, setSubmissionCounts] = useState<Record<string, number>>({})

  useEffect(() => {
    if (!profile?.id) return
    // Load my assignments
    sb.schema('forms').from('assignments')
      .select('*, form:forms(*)')
      .eq('assigned_to', profile.id)
      .eq('is_completed', false)
      .order('due_date', { ascending: true })
      .then(({ data }: any) => setAssignments(data ?? []))

    // Load submission counts per form
    sb.schema('forms').from('submissions')
      .select('form_id')
      .then(({ data }: any) => {
        const counts: Record<string, number> = {}
        for (const row of (data ?? [])) counts[row.form_id] = (counts[row.form_id] ?? 0) + 1
        setSubmissionCounts(counts)
      })
  }, [profile?.id])

  function shareUrl(form: FormDefinition) {
    return `${window.location.origin}${import.meta.env.BASE_URL}f/${form.share_token}`
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold uppercase tracking-wide text-navy">Forms</h1>
          <p className="mt-0.5 text-xs text-inky">Build forms, collect responses, track scores</p>
        </div>
        <Button size="sm" onClick={() => navigate('/forms/new')}>+ New Form</Button>
      </div>

      {/* Assigned to me */}
      {assignments.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-mono text-inky uppercase tracking-wide">Assigned to Me</h2>
          <div className="flex flex-col gap-2">
            {assignments.map((a) => {
              const overdue = a.due_date && isPast(parseISO(a.due_date + 'T23:59:59'))
              return (
                <div key={a.id} className="flex items-center gap-3 rounded border border-navy/20 bg-cream px-4 py-3">
                  <span className="text-sm">📋</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-heading text-navy">{(a.form as any)?.title ?? 'Form'}</div>
                    {a.due_date && (
                      <div className={['text-xs font-mono', overdue ? 'text-red-600' : 'text-inky/60'].join(' ')}>
                        Due: {format(parseISO(a.due_date), 'MMM d, yyyy')}
                        {overdue && ' ⚠ OVERDUE'}
                      </div>
                    )}
                  </div>
                  <Button size="sm" onClick={() => navigate(`/forms/${a.form_id}/submit?assignment=${a.id}`)}>
                    Start Form
                  </Button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Forms I created */}
      <div className="flex flex-col gap-2">
        <h2 className="text-xs font-mono text-inky uppercase tracking-wide">Forms I Created</h2>
        {loading ? (
          <p className="text-xs font-mono text-inky">Loading…</p>
        ) : forms.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded border border-dashed border-navy/30 py-16">
            <p className="text-sm font-mono text-inky">No forms yet</p>
            <Button size="sm" onClick={() => navigate('/forms/new')}>+ New Form</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {forms.map((form) => (
              <div key={form.id} className="flex items-center gap-4 rounded border border-navy/20 bg-cream px-4 py-3 group hover:border-navy/40 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-heading text-navy truncate">{form.title}</span>
                    <Badge color={form.is_published ? 'green' : 'gray'}>{form.is_published ? 'Published' : 'Draft'}</Badge>
                    {!form.is_accepting_responses && <Badge color="amber">Closed</Badge>}
                    <span className="text-[10px] font-mono text-inky/50 bg-navy/5 px-1.5 py-0.5 rounded">{form.department}</span>
                  </div>
                  <div className="flex gap-3 mt-0.5 text-[10px] font-mono text-inky/50">
                    <span>{submissionCounts[form.id] ?? 0} responses</span>
                    <span>Updated {format(new Date(form.updated_at), 'MMM d, yyyy')}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                  <button onClick={() => navigate(`/forms/${form.id}/edit`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Edit</button>
                  <button onClick={() => navigate(`/forms/${form.id}/results`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Results</button>
                  <button onClick={() => navigate(`/forms/${form.id}/assignments`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Assign</button>
                  <button onClick={() => { navigator.clipboard.writeText(shareUrl(form)); toast.success('Link copied') }} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Share</button>
                  <button onClick={() => duplicateForm(form)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Duplicate</button>
                  <button onClick={() => { if (confirm(`Delete "${form.title}"?`)) deleteForm(form.id) }} className="text-xs font-mono border border-red-200 rounded px-2 py-1 text-red-500 hover:border-red-400">Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
