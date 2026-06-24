import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useForms } from '@/hooks/useForms'
import { Button, Badge } from '@/components/ui'
import type { FormDefinition, FormAssignment, AssignmentRule } from '@/types/forms'
import { format, isPast, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

const sb = supabase as any

interface SharedForm extends FormDefinition {
  submission_count?: number
  last_submitted_at?: string | null
}

export function FormsListPage() {
  const navigate = useNavigate()
  const { profile } = useAuthStore()
  const { forms, loading, deleteForm, duplicateForm } = useForms()
  const [assignments, setAssignments] = useState<(FormAssignment & { form?: FormDefinition })[]>([])
  const [submissionCounts, setSubmissionCounts] = useState<Record<string, number>>({})
  const [lastSubmittedAt, setLastSubmittedAt] = useState<Record<string, string>>({})
  const [sharedForms, setSharedForms] = useState<SharedForm[]>([])
  const [activeRules, setActiveRules] = useState<Record<string, AssignmentRule[]>>({})
  const [rulesPopover, setRulesPopover] = useState<string | null>(null)

  useEffect(() => {
    if (!profile?.id || !profile?.company_id) return

    // Load my assignments (pending)
    sb.schema('forms').from('assignments')
      .select('*, form:forms(*)')
      .eq('assigned_to', profile.id)
      .eq('is_completed', false)
      .order('due_date', { ascending: true })
      .then(({ data }: any) => setAssignments(data ?? []))

    // Load submission counts and last submission per form
    sb.schema('forms').from('submissions')
      .select('form_id, submitted_at')
      .then(({ data }: any) => {
        const counts: Record<string, number> = {}
        const lasts: Record<string, string> = {}
        for (const row of (data ?? [])) {
          counts[row.form_id] = (counts[row.form_id] ?? 0) + 1
          if (!lasts[row.form_id] || row.submitted_at > lasts[row.form_id]) {
            lasts[row.form_id] = row.submitted_at
          }
        }
        setSubmissionCounts(counts)
        setLastSubmittedAt(lasts)
      })

    // Load shared forms: org-wide or department-shared (created by others)
    sb.schema('forms').from('forms')
      .select('*')
      .eq('company_id', profile.company_id)
      .neq('created_by', profile.id)
      .eq('is_published', true)
      .in('visibility', ['org', 'departments'])
      .order('updated_at', { ascending: false })
      .then(({ data }: any) => setSharedForms(data ?? []))

    // Load active assignment rules per form
    sb.schema('forms').from('assignment_rules')
      .select('*')
      .eq('is_active', true)
      .then(({ data }: any) => {
        const byForm: Record<string, AssignmentRule[]> = {}
        for (const rule of (data ?? [])) {
          if (!byForm[rule.form_id]) byForm[rule.form_id] = []
          byForm[rule.form_id].push(rule)
        }
        setActiveRules(byForm)
      })
  }, [profile?.id, profile?.company_id])

  function shareUrl(form: FormDefinition) {
    return `${window.location.origin}${import.meta.env.BASE_URL}f/${form.share_token}`
  }

  function FormCard({ form, showActions = false }: { form: FormDefinition; showActions?: boolean }) {
    const count = submissionCounts[form.id] ?? 0
    const last = lastSubmittedAt[form.id]
    const rules = activeRules[form.id] ?? []
    const deptCat = [form.department !== 'All' ? form.department : null, form.category].filter(Boolean).join(' · ')

    return (
      <div className="flex items-start gap-4 rounded border border-navy/20 bg-cream px-4 py-3 group hover:border-navy/40 transition-colors">
        <span className="text-base mt-0.5">📋</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-heading text-navy truncate">{form.title}</span>
            <span className={['text-[9px] font-mono px-1.5 py-0.5 rounded-full border', form.requires_login ? 'border-navy/30 text-navy bg-navy/5' : 'border-[#00e5ff]/40 text-[#00e5ff] bg-[#00e5ff]/5'].join(' ')}>
              {form.requires_login ? '🔒 Org-Only' : '🌐 Public'}
            </span>
            {!form.is_published && <Badge color="gray">Draft</Badge>}
            {!form.is_accepting_responses && <Badge color="amber">Closed</Badge>}
          </div>
          {deptCat && <div className="text-[10px] font-mono text-inky/50 mt-0.5">{deptCat}</div>}
          {form.description && (
            <p className="text-xs font-mono text-inky/60 mt-0.5 line-clamp-2"
              dangerouslySetInnerHTML={{ __html: form.description.replace(/<[^>]+>/g, ' ').trim() }} />
          )}
          <div className="flex gap-3 mt-0.5 text-[10px] font-mono text-inky/50 flex-wrap">
            <span>{count} response{count !== 1 ? 's' : ''}</span>
            {last && <span>Last: {format(new Date(last), 'MMM d, yyyy')}</span>}
            {rules.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => setRulesPopover(rulesPopover === form.id ? null : form.id)}
                  className="text-[10px] font-mono text-amber-600 hover:text-amber-800 underline">
                  📅 {rules.length} active rule{rules.length !== 1 ? 's' : ''}
                </button>
                {rulesPopover === form.id && (
                  <div className="absolute z-20 bottom-full mb-1 left-0 bg-cream rounded border border-navy/20 shadow-xl p-3 min-w-[220px]">
                    <p className="text-[10px] font-mono text-inky uppercase tracking-wide mb-2">Assignment Rules</p>
                    {rules.map((r) => (
                      <div key={r.id} className="text-xs font-mono text-navy mb-1">
                        {r.rule_name}
                        <span className="text-inky/40 ml-1">({r.rule_type})</span>
                      </div>
                    ))}
                    <button onClick={() => navigate(`/forms/${form.id}/assignments`)} className="text-[10px] font-mono text-[#00e5ff] underline mt-1">Manage →</button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {showActions && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0 flex-wrap">
            <button onClick={() => navigate(`/forms/${form.id}/edit`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Edit</button>
            <button onClick={() => navigate(`/forms/${form.id}/results`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Results</button>
            <button onClick={() => navigate(`/forms/${form.id}/assignments`)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Assign</button>
            <button onClick={() => { navigator.clipboard.writeText(shareUrl(form)); toast.success('Link copied') }} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Share</button>
            <button onClick={() => duplicateForm(form)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Duplicate</button>
            <button onClick={() => { if (confirm(`Delete "${form.title}"?`)) deleteForm(form.id) }} className="text-xs font-mono border border-red-200 rounded px-2 py-1 text-red-500 hover:border-red-400">Delete</button>
          </div>
        )}

        {!showActions && (
          <div className="flex-shrink-0">
            <Button size="sm" onClick={() => navigate(`/f/${form.share_token}`)}>Fill Out Form</Button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6" onClick={() => setRulesPopover(null)}>
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
                  <Button size="sm" onClick={() => navigate(`/f/${(a.form as any)?.share_token}?assignment=${a.id}`)}>
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
          <p className="text-xs font-mono text-inky animate-pulse">Loading…</p>
        ) : forms.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded border border-dashed border-navy/30 py-16">
            <p className="text-sm font-mono text-inky">No forms yet</p>
            <Button size="sm" onClick={() => navigate('/forms/new')}>+ New Form</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {forms.map((form) => (
              <FormCard key={form.id} form={form} showActions />
            ))}
          </div>
        )}
      </div>

      {/* Shared with my org / department */}
      {sharedForms.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-mono text-inky uppercase tracking-wide">Shared with My Org</h2>
          <div className="flex flex-col gap-2">
            {sharedForms.map((form) => (
              <FormCard key={form.id} form={form} showActions={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
