import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { loadFormWithFields } from '@/hooks/useForms'
import { useAuthStore } from '@/stores/authStore'
import { Button, Badge } from '@/components/ui'
import type {
  FormDefinition, FormField, FormSubmission, FormResponse, ScoreStreak,
  SubmissionColumn, SubmissionColumnValue, ResponseOverride,
} from '@/types/forms'
import { format } from 'date-fns'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'

const sb = supabase as any

interface ResolvedResponse extends FormResponse {
  isOverridden?: boolean
  override?: ResponseOverride
}

function resolveDisplayValue(response: FormResponse, override: ResponseOverride | null): ResolvedResponse {
  if (!override) return response
  return {
    ...response,
    value_text: override.override_value_text ?? response.value_text,
    value_array: override.override_value_array ?? response.value_array,
    value_option_id: override.override_value_option_id ?? response.value_option_id,
    isOverridden: true,
    override,
  }
}

// ── Override cell popover ─────────────────────────────────────────────────────

function OverrideCellPopover({
  response, override, field, canWrite, onEdit, onRevert, onClose,
}: {
  response: FormResponse
  override: ResponseOverride
  field: FormField
  canWrite: boolean
  onEdit: () => void
  onRevert: () => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onOut(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onOut)
    return () => document.removeEventListener('mousedown', onOut)
  }, [onClose])

  function origDisplay(): string {
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      return field.options.find((o) => o.id === override.original_value_option_id)?.label ?? override.original_value_option_id ?? '—'
    }
    if (field.field_type === 'multi_select') {
      return (override.original_value_array ?? []).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(', ') || '—'
    }
    return override.original_value_text ?? '—'
  }

  function currDisplay(): string {
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      return field.options.find((o) => o.id === override.override_value_option_id)?.label ?? override.override_value_option_id ?? '—'
    }
    if (field.field_type === 'multi_select') {
      return (override.override_value_array ?? []).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(', ') || '—'
    }
    return override.override_value_text ?? '—'
  }

  return (
    <div ref={ref} className="absolute z-50 top-0 left-0 bg-cream rounded border border-navy/30 shadow-xl p-4 min-w-[260px] flex flex-col gap-3">
      <div>
        <div className="text-[10px] font-mono text-inky uppercase tracking-wide">Current Value</div>
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className="text-xs font-mono text-navy">{currDisplay()}</span>
          {canWrite && <button onClick={() => { onClose(); onEdit() }} className="text-xs font-mono text-inky/60 hover:text-navy">✏</button>}
        </div>
      </div>
      <div className="border-t border-navy/10 pt-2">
        <div className="text-[10px] font-mono text-inky uppercase tracking-wide">▾ Original Submission</div>
        <div className="text-xs font-mono text-inky/70 mt-1">{origDisplay()}</div>
        {override.override_note && (
          <div className="text-[10px] font-mono text-inky/50 mt-1 italic">Note: {override.override_note}</div>
        )}
      </div>
      <div className="text-[9px] font-mono text-inky/40">
        Overridden by {override.overridden_by ? override.overridden_by.slice(0, 8) + '…' : 'unknown'} · {format(new Date(override.overridden_at), 'MMM d, yyyy h:mm a')}
      </div>
      {canWrite && (
        <div className="flex gap-2 pt-1 border-t border-navy/10">
          <button onClick={() => { onClose(); onEdit() }} className="flex-1 text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40">Edit Override</button>
          <button onClick={() => { onClose(); onRevert() }} className="flex-1 text-xs font-mono border border-red-200 rounded px-2 py-1 text-red-500 hover:border-red-400">Revert</button>
        </div>
      )}
    </div>
  )
}

// ── Response cell (editable with override support) ────────────────────────────

function ResponseCell({
  response, override, field, canWrite, onOverrideSave, onRevert,
}: {
  response: FormResponse | undefined
  override: ResponseOverride | null
  field: FormField
  canWrite: boolean
  onOverrideSave: (fieldId: string, responseId: string, submissionId: string, value: any, note?: string) => Promise<void>
  onRevert: (responseId: string) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState<any>(null)
  const [showPopover, setShowPopover] = useState(false)

  if (!response) return <span className="text-inky/40">—</span>

  const resolved = resolveDisplayValue(response, override)

  function displayText(): string {
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      return field.options.find((o) => o.id === resolved.value_option_id)?.label ?? resolved.value_option_id ?? '—'
    }
    if (field.field_type === 'multi_select') {
      return (resolved.value_array ?? []).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(', ') || '—'
    }
    if (field.field_type === 'file_upload') {
      const c = resolved.file_paths?.length ?? 0
      return c ? `${c} file${c > 1 ? 's' : ''}` : '—'
    }
    return resolved.value_text ?? '—'
  }

  function startEdit() {
    if (field.field_type === 'file_upload') { toast('File responses cannot be overridden. Add a note instead.'); return }
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      setEditValue(resolved.value_option_id ?? '')
    } else if (field.field_type === 'multi_select') {
      setEditValue(resolved.value_array ?? [])
    } else {
      setEditValue(resolved.value_text ?? '')
    }
    setEditing(true)
  }

  async function commitEdit() {
    if (!response) return
    const note = undefined
    await onOverrideSave(field.id, response.id, response.submission_id, editValue, note)
    setEditing(false)
  }

  if (editing) {
    const inputClass = 'rounded border border-navy/30 bg-cream text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none px-1.5 py-0.5 w-full'

    let input: React.ReactNode = (
      <input autoFocus value={editValue ?? ''} onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) commitEdit(); if (e.key === 'Escape') setEditing(false) }}
        className={inputClass} />
    )
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      input = (
        <select autoFocus value={editValue ?? ''} onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit} className={inputClass}>
          <option value="">—</option>
          {field.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      )
    } else if (field.field_type === 'multi_select') {
      input = (
        <div className="flex flex-col gap-0.5 bg-cream rounded border border-navy/30 p-1">
          {field.options.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5 cursor-pointer">
              <input type="checkbox" checked={Array.isArray(editValue) && editValue.includes(o.id)}
                onChange={(e) => {
                  const curr = Array.isArray(editValue) ? editValue : []
                  setEditValue(e.target.checked ? [...curr, o.id] : curr.filter((id: string) => id !== o.id))
                }} className="accent-navy" />
              <span className="text-xs font-mono text-navy">{o.label}</span>
            </label>
          ))}
          <button onClick={commitEdit} className="mt-1 text-[10px] font-mono bg-navy text-cream rounded px-1.5 py-0.5 self-start">Save</button>
        </div>
      )
    }

    return <div className="relative">{input}</div>
  }

  return (
    <div className="relative group/cell">
      <span
        className={['cursor-pointer text-xs font-mono', resolved.isOverridden ? 'px-1 rounded' : ''].join(' ')}
        style={resolved.isOverridden ? { background: 'rgba(122, 51, 0, 0.15)' } : {}}
        onClick={() => {
          if (resolved.isOverridden && override) { setShowPopover(true); return }
          if (canWrite) startEdit()
        }}>
        {displayText()}
      </span>
      {canWrite && !resolved.isOverridden && (
        <button
          onClick={startEdit}
          className="absolute top-0 right-0 opacity-0 group-hover/cell:opacity-100 transition-opacity text-[9px] text-inky/40 hover:text-navy">
          ✏
        </button>
      )}
      {showPopover && override && (
        <OverrideCellPopover
          response={response}
          override={override}
          field={field}
          canWrite={canWrite}
          onEdit={startEdit}
          onRevert={() => onRevert(response.id)}
          onClose={() => setShowPopover(false)}
        />
      )}
    </div>
  )
}

// ── Add Custom Column Modal ───────────────────────────────────────────────────

function AddColumnModal({ formId, profile, onAdded, onClose }: {
  formId: string; profile: any
  onAdded: (col: SubmissionColumn) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [columnType, setColumnType] = useState<SubmissionColumn['column_type']>('text')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!label.trim()) return
    setSaving(true)
    const { data, error } = await sb.schema('forms').from('submission_columns').insert({
      form_id: formId,
      label: label.trim(),
      column_type: columnType,
      created_by: profile?.id,
    }).select().single()
    setSaving(false)
    if (error) { toast.error(error.message); return }
    onAdded(data as SubmissionColumn)
    toast.success('Column added')
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm">
      <div className="w-full max-w-sm bg-cream rounded-lg border border-navy/30 shadow-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Add Column</h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Column Name</label>
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            placeholder="e.g. Review Status, Auditor Notes…"
            className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Type</label>
          <select value={columnType} onChange={(e) => setColumnType(e.target.value as SubmissionColumn['column_type'])}
            className="rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none">
            {['text', 'number', 'date', 'status', 'checkbox', 'select', 'user'].map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">Cancel</button>
          <button onClick={save} disabled={saving || !label.trim()} className="text-xs font-mono bg-navy text-cream rounded px-3 py-1.5 hover:bg-inky disabled:opacity-40">
            {saving ? 'Adding…' : 'Add Column'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Results Page ─────────────────────────────────────────────────────────

export function FormResultsPage() {
  const { formId } = useParams<{ formId: string }>()
  const navigate = useNavigate()
  const { profile } = useAuthStore()

  const [form, setForm] = useState<FormDefinition | null>(null)
  const [fields, setFields] = useState<FormField[]>([])
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [responses, setResponses] = useState<FormResponse[]>([])
  const [streaks, setStreaks] = useState<ScoreStreak[]>([])
  const [submissionColumns, setSubmissionColumns] = useState<SubmissionColumn[]>([])
  const [columnValues, setColumnValues] = useState<SubmissionColumnValue[]>([])
  const [overrides, setOverrides] = useState<ResponseOverride[]>([])
  const [submitterProfiles, setSubmitterProfiles] = useState<Record<string, { full_name: string | null; email: string | null }>>({})
  const [tab, setTab] = useState<'responses' | 'streaks'>('responses')
  const [loading, setLoading] = useState(true)
  const [addColumnOpen, setAddColumnOpen] = useState(false)
  const [canWrite, setCanWrite] = useState(false)
  const [editingCell, setEditingCell] = useState<{ submId: string; colId: string } | null>(null)
  const [editCellValue, setEditCellValue] = useState('')

  useEffect(() => {
    if (!formId || !profile?.id) return
    ;(async () => {
      const res = await loadFormWithFields(formId)
      if (!res) return
      setForm(res.form); setFields(res.fields)

      // Determine can_write: form creator always can
      if (res.form.created_by === profile.id) setCanWrite(true)
      else {
        const { data: ruleData } = await sb.schema('forms').from('submission_access_rules')
          .select('can_write').eq('form_id', formId).eq('principal_type', 'user').eq('principal_value', profile.id).maybeSingle()
        if (ruleData?.can_write) setCanWrite(true)
      }

      const [subRes, streakRes, colRes] = await Promise.all([
        sb.schema('forms').from('submissions').select('*').eq('form_id', formId).order('submitted_at', { ascending: false }),
        sb.schema('forms').from('score_streaks').select('*').eq('form_id', formId),
        sb.schema('forms').from('submission_columns').select('*').eq('form_id', formId).order('sort_order'),
      ])
      setSubmissions(subRes.data ?? [])
      setStreaks(streakRes.data ?? [])
      setSubmissionColumns(colRes.data ?? [])

      if (subRes.data?.length) {
        const subIds = subRes.data.map((s: any) => s.id)
        const [rData, cvData, ovData] = await Promise.all([
          sb.schema('forms').from('responses').select('*').in('submission_id', subIds),
          sb.schema('forms').from('submission_column_values').select('*').in('submission_id', subIds),
          sb.schema('forms').from('response_overrides').select('*').in('submission_id', subIds),
        ])
        setResponses(rData.data ?? [])
        setColumnValues(cvData.data ?? [])
        setOverrides(ovData.data ?? [])

        // Load submitter profiles
        const userIds = [...new Set(subRes.data.filter((s: any) => s.submitted_by).map((s: any) => s.submitted_by as string))]
        if (userIds.length) {
          const { data: profData } = await sb.schema('platform').from('user_profiles').select('id, full_name, email').in('id', userIds)
          const map: Record<string, { full_name: string | null; email: string | null }> = {}
          for (const p of (profData ?? [])) map[p.id] = p
          setSubmitterProfiles(map)
        }
      }
      setLoading(false)
    })()
  }, [formId, profile?.id])

  const responseMap = useMemo(() => {
    const map: Record<string, Record<string, FormResponse>> = {}
    for (const r of responses) {
      if (!map[r.submission_id]) map[r.submission_id] = {}
      map[r.submission_id][r.field_id] = r
    }
    return map
  }, [responses])

  const overrideMap = useMemo(() => {
    const map: Record<string, ResponseOverride> = {}
    for (const o of overrides) map[o.response_id] = o
    return map
  }, [overrides])

  const columnValueMap = useMemo(() => {
    const map: Record<string, Record<string, string>> = {}
    for (const cv of columnValues) {
      if (!map[cv.submission_id]) map[cv.submission_id] = {}
      map[cv.submission_id][cv.column_id] = cv.value ?? ''
    }
    return map
  }, [columnValues])

  function displayValue(resp: FormResponse | undefined, field: FormField): string {
    if (!resp) return '—'
    const ov = overrideMap[resp.id] ?? null
    const resolved = resolveDisplayValue(resp, ov)
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      return field.options.find((o) => o.id === resolved.value_option_id)?.label ?? resolved.value_option_id ?? '—'
    }
    if (field.field_type === 'multi_select') {
      return (resolved.value_array ?? []).map((id) => field.options.find((o) => o.id === id)?.label ?? id).join(', ') || '—'
    }
    if (field.field_type === 'file_upload') {
      const c = resolved.file_paths?.length ?? 0
      return c ? `${c} file${c > 1 ? 's' : ''}` : '—'
    }
    return resolved.value_text ?? '—'
  }

  async function handleOverrideSave(fieldId: string, responseId: string, submissionId: string, value: any) {
    if (!profile?.id) return
    const response = responses.find((r) => r.id === responseId)
    if (!response) return

    const field = fields.find((f) => f.id === fieldId)
    if (!field) return

    const existing = overrides.find((o) => o.response_id === responseId)

    let overrideValueText: string | null = null
    let overrideValueArray: string[] | null = null
    let overrideValueOptionId: string | null = null

    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
      overrideValueOptionId = value || null
    } else if (field.field_type === 'multi_select') {
      overrideValueArray = Array.isArray(value) ? value : null
    } else {
      overrideValueText = value ? String(value) : null
    }

    if (existing) {
      const { error } = await sb.schema('forms').from('response_overrides')
        .update({ override_value_text: overrideValueText, override_value_array: overrideValueArray, override_value_option_id: overrideValueOptionId, overridden_by: profile.id, overridden_at: new Date().toISOString() })
        .eq('id', existing.id)
      if (error) { toast.error(error.message); return }
      setOverrides((p) => p.map((o) => o.id === existing.id ? {
        ...o, override_value_text: overrideValueText, override_value_array: overrideValueArray, override_value_option_id: overrideValueOptionId, overridden_by: profile.id, overridden_at: new Date().toISOString(),
      } : o))
    } else {
      const { data, error } = await sb.schema('forms').from('response_overrides').insert({
        response_id: responseId, submission_id: submissionId, field_id: fieldId,
        original_value_text: response.value_text, original_value_array: response.value_array, original_value_option_id: response.value_option_id,
        override_value_text: overrideValueText, override_value_array: overrideValueArray, override_value_option_id: overrideValueOptionId,
        overridden_by: profile.id,
      }).select().single()
      if (error) { toast.error(error.message); return }
      setOverrides((p) => [...p, data as ResponseOverride])
    }
    toast.success('Override saved')
  }

  async function handleRevert(responseId: string) {
    const existing = overrides.find((o) => o.response_id === responseId)
    if (!existing) return
    const { error } = await sb.schema('forms').from('response_overrides').delete().eq('id', existing.id)
    if (error) { toast.error(error.message); return }
    setOverrides((p) => p.filter((o) => o.id !== existing.id))
    toast.success('Reverted to original')
  }

  async function saveColumnValue(submissionId: string, columnId: string, value: string) {
    if (!profile?.id) return
    const existing = columnValues.find((cv) => cv.submission_id === submissionId && cv.column_id === columnId)
    if (existing) {
      await sb.schema('forms').from('submission_column_values').update({ value, updated_by: profile.id, updated_at: new Date().toISOString() }).eq('id', existing.id)
      setColumnValues((p) => p.map((cv) => cv.id === existing.id ? { ...cv, value } : cv))
    } else {
      const { data } = await sb.schema('forms').from('submission_column_values').insert({
        submission_id: submissionId, column_id: columnId, value, updated_by: profile.id,
      }).select().single()
      if (data) setColumnValues((p) => [...p, data as SubmissionColumnValue])
    }
  }

  function exportExcel() {
    const dataFields = fields.filter((f) => f.field_type !== 'text_block' && f.field_type !== 'calculation')
    const rows = submissions.map((sub) => {
      const submitter = sub.submitted_by ? submitterProfiles[sub.submitted_by] : null
      const row: Record<string, any> = {
        '#': submissions.indexOf(sub) + 1,
        'Submitted At': format(new Date(sub.submitted_at), 'yyyy-MM-dd HH:mm'),
        'Submitted By': submitter?.full_name ?? sub.respondent_name ?? (sub.submitted_by ? sub.submitted_by : 'Anonymous'),
        'Total Score': sub.total_score ?? '',
        'Max Score': sub.max_possible_score ?? '',
      }
      for (const field of dataFields) {
        row[field.label] = displayValue(responseMap[sub.id]?.[field.id], field)
      }
      for (const col of submissionColumns) {
        row[col.label] = columnValueMap[sub.id]?.[col.id] ?? ''
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
          { label: 'Overrides', value: overrides.length },
        ].map(({ label, value }) => (
          <div key={label} className="rounded border border-navy/20 bg-cream px-4 py-3 flex flex-col">
            <span className="text-xs font-mono text-inky uppercase tracking-wide">{label}</span>
            <span className="text-2xl font-bold text-navy mt-1">{value}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex border-b border-navy/20 items-center">
        {(['responses', 'streaks'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={['px-4 py-2 text-xs font-mono uppercase tracking-wide capitalize transition-colors', tab === t ? 'text-navy border-b-2 border-navy' : 'text-inky/60 hover:text-navy'].join(' ')}>
            {t === 'streaks' ? 'Score Trends' : t}
          </button>
        ))}
        <div className="flex-1" />
        {tab === 'responses' && canWrite && (
          <button onClick={() => setAddColumnOpen(true)} className="text-xs font-mono border border-navy/20 rounded px-2 py-1 text-inky hover:border-navy/40 mr-1">
            + Add Column
          </button>
        )}
      </div>

      {tab === 'responses' && (
        submissions.length === 0 ? (
          <p className="text-xs font-mono text-inky py-8 text-center">No responses yet.</p>
        ) : (
          <div className="overflow-x-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono" style={{ minWidth: 600 }}>
              <thead>
                <tr className="border-b border-navy/30 bg-cream">
                  <th className="px-3 py-2 text-left text-inky uppercase tracking-wide w-8">#</th>
                  <th className="px-3 py-2 text-left text-inky uppercase tracking-wide whitespace-nowrap">Submitted At</th>
                  <th className="px-3 py-2 text-left text-inky uppercase tracking-wide whitespace-nowrap">Submitted By</th>
                  <th className="px-3 py-2 text-right text-inky uppercase tracking-wide">Score</th>
                  {dataFields.map((f) => (
                    <th key={f.id} className="px-3 py-2 text-left text-inky uppercase tracking-wide truncate max-w-[120px]">{f.label}</th>
                  ))}
                  {submissionColumns.map((col) => (
                    <th key={col.id} className="px-3 py-2 text-left text-inky uppercase tracking-wide whitespace-nowrap bg-amber-50/40">
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {submissions.map((sub, idx) => {
                  const submitter = sub.submitted_by ? submitterProfiles[sub.submitted_by] : null
                  const submitterName = submitter?.full_name ?? sub.respondent_name ?? (sub.submitted_by ? null : null)
                  return (
                    <tr key={sub.id} className="border-b border-navy/10 hover:bg-navy/5">
                      <td className="px-3 py-2 text-inky/40">{idx + 1}</td>
                      <td className="px-3 py-2 text-inky/70 whitespace-nowrap">
                        {format(new Date(sub.submitted_at), 'MMM d, yyyy h:mm a')}
                      </td>
                      <td className="px-3 py-2 text-navy">
                        <span title={submitter?.email ?? undefined}>
                          {submitterName ?? '(anonymous)'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-navy">
                        {sub.total_score != null ? `${sub.total_score}/${sub.max_possible_score ?? '?'}` : '—'}
                      </td>
                      {dataFields.map((field) => {
                        const resp = responseMap[sub.id]?.[field.id]
                        const ov = resp ? (overrideMap[resp.id] ?? null) : null
                        return (
                          <td key={field.id} className="px-3 py-2 max-w-[140px] relative">
                            <ResponseCell
                              response={resp}
                              override={ov}
                              field={field}
                              canWrite={canWrite}
                              onOverrideSave={handleOverrideSave}
                              onRevert={handleRevert}
                            />
                          </td>
                        )
                      })}
                      {submissionColumns.map((col) => {
                        const currentVal = columnValueMap[sub.id]?.[col.id] ?? ''
                        const isEditing = editingCell?.submId === sub.id && editingCell?.colId === col.id
                        return (
                          <td key={col.id} className="px-3 py-2 bg-amber-50/20">
                            {canWrite ? (
                              isEditing ? (
                                <input
                                  autoFocus
                                  value={editCellValue}
                                  onChange={(e) => setEditCellValue(e.target.value)}
                                  onBlur={async () => {
                                    await saveColumnValue(sub.id, col.id, editCellValue)
                                    setEditingCell(null)
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.currentTarget.blur() }
                                    if (e.key === 'Escape') setEditingCell(null)
                                  }}
                                  className="rounded border border-navy/30 bg-cream px-1.5 py-0.5 text-xs font-mono text-navy focus:border-[#00e5ff] focus:outline-none w-full" />
                              ) : (
                                <span
                                  className="cursor-pointer hover:bg-navy/5 rounded px-1 -mx-1 text-navy min-w-[40px] inline-block"
                                  onClick={() => { setEditingCell({ submId: sub.id, colId: col.id }); setEditCellValue(currentVal) }}>
                                  {currentVal || <span className="text-inky/30">—</span>}
                                </span>
                              )
                            ) : (
                              <span className="text-navy">{currentVal || '—'}</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
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
            <p className="text-xs font-mono text-inky/60">Fields receiving the same score on consecutive submissions.</p>
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

      {addColumnOpen && formId && (
        <AddColumnModal
          formId={formId}
          profile={profile}
          onAdded={(col) => { setSubmissionColumns((p) => [...p, col]); setAddColumnOpen(false) }}
          onClose={() => setAddColumnOpen(false)}
        />
      )}
    </div>
  )
}
