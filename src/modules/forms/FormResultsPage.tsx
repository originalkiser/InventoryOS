import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { loadFormWithFields } from '@/hooks/useForms'
import { Button, Badge } from '@/components/ui'
import type { FormDefinition, FormField, FormSubmission, FormResponse, ScoreStreak } from '@/types/forms'
import { format } from 'date-fns'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'

const sb = supabase as any

export function FormResultsPage() {
  const { formId } = useParams<{ formId: string }>()
  const navigate = useNavigate()
  const [form, setForm] = useState<FormDefinition | null>(null)
  const [fields, setFields] = useState<FormField[]>([])
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [responses, setResponses] = useState<FormResponse[]>([])
  const [streaks, setStreaks] = useState<ScoreStreak[]>([])
  const [tab, setTab] = useState<'responses' | 'streaks'>('responses')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!formId) return
    ;(async () => {
      const res = await loadFormWithFields(formId)
      if (!res) return
      setForm(res.form); setFields(res.fields)

      const [subRes, streakRes] = await Promise.all([
        sb.schema('forms').from('submissions').select('*').eq('form_id', formId).order('submitted_at', { ascending: false }),
        sb.schema('forms').from('score_streaks').select('*').eq('form_id', formId),
      ])
      setSubmissions(subRes.data ?? [])

      if (subRes.data?.length) {
        const subIds = subRes.data.map((s: any) => s.id)
        const { data: rData } = await sb.schema('forms').from('responses').select('*').in('submission_id', subIds)
        setResponses(rData ?? [])
      }
      setStreaks(streakRes.data ?? [])
      setLoading(false)
    })()
  }, [formId])

  const responseMap = useMemo(() => {
    const map: Record<string, Record<string, FormResponse>> = {}
    for (const r of responses) {
      if (!map[r.submission_id]) map[r.submission_id] = {}
      map[r.submission_id][r.field_id] = r
    }
    return map
  }, [responses])

  function displayValue(resp: FormResponse | undefined, field: FormField): string {
    if (!resp) return '—'
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      return field.options.find((o) => o.id === resp.value_option_id)?.label ?? resp.value_option_id ?? '—'
    }
    if (field.field_type === 'multi_select') {
      return (resp.value_array ?? []).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(', ') || '—'
    }
    if (field.field_type === 'file_upload') {
      const count = resp.file_paths?.length ?? 0
      return count ? `${count} file${count > 1 ? 's' : ''}` : '—'
    }
    return resp.value_text ?? '—'
  }

  function exportExcel() {
    const dataFields = fields.filter((f) => f.field_type !== 'text_block' && f.field_type !== 'calculation')
    const rows = submissions.map((sub) => {
      const row: Record<string, any> = {
        'Submitted At': format(new Date(sub.submitted_at), 'yyyy-MM-dd HH:mm'),
        'Respondent': sub.respondent_name ?? sub.submitted_by ?? 'Anonymous',
        'Total Score': sub.total_score ?? '',
        'Max Score': sub.max_possible_score ?? '',
      }
      for (const field of dataFields) {
        row[field.label] = displayValue(responseMap[sub.id]?.[field.id], field)
      }
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Responses')
    XLSX.writeFile(wb, `form_responses_${formId}.xlsx`)
  }

  const dataFields = fields.filter((f) => f.field_type !== 'text_block' && f.field_type !== 'calculation')
  const alertStreaks = streaks.filter((s) => s.streak_count >= 2)

  function streakColor(s: ScoreStreak): string {
    if (s.streak_count >= 3) return 'border-l-red-500 bg-red-50/30'
    if (s.streak_count >= 2) return 'border-l-amber-500 bg-amber-50/30'
    return 'border-l-sky bg-sky/5'
  }

  if (loading) return <div className="py-8 text-xs font-mono text-inky">Loading…</div>
  if (!form) return <div className="py-8 text-xs font-mono text-inky">Form not found.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate('/forms')} className="text-xs font-mono text-inky hover:text-navy">← Forms</button>
        <h1 className="flex-1 text-sm font-heading font-bold text-navy">{form.title} — Results</h1>
        <Button size="sm" variant="secondary" onClick={exportExcel}>Export Excel</Button>
        <Button size="sm" onClick={() => navigate(`/forms/${formId}/edit`)}>Edit Form</Button>
      </div>

      {/* Stats row */}
      <div className="flex gap-4 flex-wrap">
        {[
          { label: 'Total Responses', value: submissions.length },
          { label: 'Avg Score', value: submissions.filter((s) => s.total_score != null).length > 0
            ? (submissions.reduce((a, s) => a + (s.total_score ?? 0), 0) / submissions.filter((s) => s.total_score != null).length).toFixed(1)
            : '—' },
          { label: 'Score Alerts', value: alertStreaks.length },
        ].map(({ label, value }) => (
          <div key={label} className="rounded border border-navy/20 bg-cream px-4 py-3 flex flex-col">
            <span className="text-xs font-mono text-inky uppercase tracking-wide">{label}</span>
            <span className="text-2xl font-bold text-navy mt-1">{value}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-navy/20">
        {(['responses', 'streaks'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={['px-4 py-2 text-xs font-mono uppercase tracking-wide capitalize transition-colors', tab === t ? 'text-navy border-b-2 border-navy' : 'text-inky/60 hover:text-navy'].join(' ')}>
            {t === 'streaks' ? 'Score Trends' : t}
          </button>
        ))}
      </div>

      {tab === 'responses' && (
        submissions.length === 0 ? (
          <p className="text-xs font-mono text-inky py-8 text-center">No responses yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono" style={{ minWidth: 600 }}>
              <thead>
                <tr className="border-b border-navy/30 bg-cream">
                  <th className="px-3 py-2 text-left text-inky uppercase tracking-wide">Date</th>
                  <th className="px-3 py-2 text-left text-inky uppercase tracking-wide">Respondent</th>
                  <th className="px-3 py-2 text-right text-inky uppercase tracking-wide">Score</th>
                  {dataFields.map((f) => (
                    <th key={f.id} className="px-3 py-2 text-left text-inky uppercase tracking-wide truncate max-w-[120px]">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {submissions.map((sub) => (
                  <tr key={sub.id} className="border-b border-navy/10 hover:bg-navy/5">
                    <td className="px-3 py-2 text-inky/70">{format(new Date(sub.submitted_at), 'MMM d, yyyy')}</td>
                    <td className="px-3 py-2 text-navy">{sub.respondent_name ?? sub.submitted_by ?? 'Anonymous'}</td>
                    <td className="px-3 py-2 text-right text-navy">
                      {sub.total_score != null ? `${sub.total_score}/${sub.max_possible_score ?? '?'}` : '—'}
                    </td>
                    {dataFields.map((f) => (
                      <td key={f.id} className="px-3 py-2 text-navy truncate max-w-[120px]">
                        {displayValue(responseMap[sub.id]?.[f.id], f)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {tab === 'streaks' && (
        alertStreaks.length === 0 ? (
          <p className="text-xs font-mono text-inky py-8 text-center">No score streaks detected yet.</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-mono text-inky/60">Locations receiving the same score on consecutive submissions.</p>
            {alertStreaks.map((streak) => {
              const field = fields.find((f) => f.id === streak.field_id)
              return (
                <div key={streak.id} className={['rounded border-l-4 border border-navy/20 px-4 py-3', streakColor(streak)].join(' ')}>
                  <div className="flex items-center gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-heading text-navy">{field?.label ?? 'Unknown Field'}</div>
                      <div className="text-[10px] font-mono text-inky/60">Location: {streak.location_id ?? 'Unknown'}</div>
                    </div>
                    <Badge color={streak.streak_count >= 3 ? 'red' : 'amber'}>
                      Score {streak.streak_score} × {streak.streak_count} in a row
                    </Badge>
                    <span className="text-[10px] font-mono text-inky/50">
                      Last: {format(new Date(streak.updated_at), 'MMM d, yyyy')}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
