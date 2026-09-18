// Public, no-auth view of a form's Results table (2026-09-18) — reached at
// /results/:token on the main app domain (no new subdomain needed, unlike
// Menu Board/Forms' own custom-URL features, since this path doesn't
// collide with any real app route). All data comes from the
// get_submission_share_data RPC (SECURITY DEFINER, keyed by token — see
// migration 20260930ag_forms_submission_shares.sql), which re-validates the
// share is active and not expired on every call; a 'read' link renders the
// exact same SubmissionsResultsTable as FormResultsPage.tsx with canWrite
// false, an 'edit' link with it true, wired to the share-scoped RPCs
// instead of the internal authenticated table writes.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { format } from 'date-fns'
import * as XLSX from 'xlsx'
import { SbLoader } from '@/components/ui'
import {
  loadSubmissionShareData, saveSubmissionShareOverride, revertSubmissionShareOverride, saveSubmissionShareColumnValue,
} from '@/hooks/useForms'
import { SubmissionsResultsTable, displayValueFor } from '@/modules/forms/FormResultsPage'
import type { FormField, FormSubmission, FormResponse, SubmissionColumn, SubmissionColumnValue, ResponseOverride } from '@/types/forms'

type Status = 'loading' | 'ok' | 'not_found' | 'expired'

export function PublicSubmissionSharePage() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<Status>('loading')
  const [permission, setPermission] = useState<'read' | 'edit'>('read')
  const [formTitle, setFormTitle] = useState('')
  const [shareLabel, setShareLabel] = useState<string | null>(null)
  const [fields, setFields] = useState<FormField[]>([])
  const [submissions, setSubmissions] = useState<FormSubmission[]>([])
  const [responses, setResponses] = useState<FormResponse[]>([])
  const [submissionColumns, setSubmissionColumns] = useState<SubmissionColumn[]>([])
  const [columnValues, setColumnValues] = useState<SubmissionColumnValue[]>([])
  const [overrides, setOverrides] = useState<ResponseOverride[]>([])

  const load = useCallback(async () => {
    if (!token) return
    const data = await loadSubmissionShareData(token)
    if (data?.error) { setStatus(data.error === 'expired' ? 'expired' : 'not_found'); return }
    setPermission(data.permission)
    setShareLabel(data.label ?? null)
    setFormTitle(data.form?.title ?? '')
    setFields((data.fields ?? []).map((f: any) => ({
      id: f.id, form_id: f.form_id, field_type: f.field_type, label: f.label,
      placeholder: null, helper_text: null, is_required: false, sort_order: f.sort_order,
      options: f.options ?? [], calculation_config: {}, file_types_allowed: null,
      max_file_size_mb: 25, content: null, created_at: '',
    })))
    setSubmissions((data.submissions ?? []).map((s: any) => ({
      id: s.id, form_id: s.form_id, submitted_by: null, respondent_email: null,
      respondent_name: s.respondent_name, location_id: null, assignment_id: null,
      total_score: s.total_score, max_possible_score: s.max_possible_score, submitted_at: s.submitted_at,
    })))
    setResponses(data.responses ?? [])
    setSubmissionColumns(data.submission_columns ?? [])
    setColumnValues(data.submission_column_values ?? [])
    setOverrides(data.response_overrides ?? [])
    setStatus('ok')
  }, [token])

  useEffect(() => { load() }, [load])

  const dataFields = useMemo(() => fields.filter((f) => f.field_type !== 'text_block' && f.field_type !== 'calculation'), [fields])

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

  async function handleOverrideSave(fieldId: string, responseId: string, _submissionId: string, value: any) {
    if (!token) return
    const field = fields.find((f) => f.id === fieldId)
    if (!field) return
    let valueText: string | null = null
    let valueArray: string[] | null = null
    let valueOptionId: string | null = null
    if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') valueOptionId = value || null
    else if (field.field_type === 'multi_select') valueArray = Array.isArray(value) ? value : null
    else valueText = value ? String(value) : null
    const ok = await saveSubmissionShareOverride(token, responseId, valueText, valueArray, valueOptionId)
    if (ok) await load()
  }

  async function handleRevert(responseId: string) {
    if (!token) return
    const ok = await revertSubmissionShareOverride(token, responseId)
    if (ok) await load()
  }

  async function handleSaveColumnValue(submissionId: string, columnId: string, value: string) {
    if (!token) return
    const ok = await saveSubmissionShareColumnValue(token, submissionId, columnId, value)
    if (ok) await load()
  }

  function exportExcel() {
    const rows = submissions.map((sub, i) => {
      const row: Record<string, any> = {
        '#': i + 1,
        'Submitted At': format(new Date(sub.submitted_at), 'yyyy-MM-dd HH:mm'),
        'Submitted By': sub.respondent_name ?? '(anonymous)',
        'Total Score': sub.total_score ?? '',
        'Max Score': sub.max_possible_score ?? '',
      }
      for (const field of dataFields) row[field.label] = displayValueFor(responseMap[sub.id]?.[field.id], field, overrideMap)
      for (const col of submissionColumns) row[col.label] = columnValueMap[sub.id]?.[col.id] ?? ''
      return row
    })
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Responses')
    XLSX.writeFile(wb, `form_responses_${token}.xlsx`)
  }

  if (status === 'loading') {
    return <div className="min-h-screen bg-cream flex items-center justify-center"><SbLoader size={40} /></div>
  }
  if (status === 'not_found') {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-cream text-lg font-bold mb-2">Link Not Found</div>
          <div className="text-sky text-sm">This share link may be invalid or has been revoked.</div>
        </div>
      </div>
    )
  }
  if (status === 'expired') {
    return (
      <div className="min-h-screen bg-navy flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-cream text-lg font-bold mb-2">Link Expired</div>
          <div className="text-sky text-sm">This share link is no longer active. Ask the form owner for a new one.</div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream py-8 px-4">
      <div className="max-w-6xl mx-auto flex flex-col gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="flex-1 text-sm font-heading font-bold text-navy">{formTitle} — Results{shareLabel ? ` (${shareLabel})` : ''}</h1>
          <span className={['text-[10px] font-mono uppercase tracking-wide px-2 py-1 rounded border', permission === 'edit' ? 'border-[#E67E22]/50 text-[#E67E22]' : 'border-navy/20 text-inky/60'].join(' ')}>
            {permission === 'edit' ? 'Can Edit' : 'Read Only'}
          </span>
          <button onClick={exportExcel} className="text-xs font-mono border border-navy/20 rounded px-3 py-1.5 text-inky hover:border-navy/40">
            Export Excel
          </button>
        </div>

        <div className="flex gap-4 flex-wrap">
          <div className="rounded border border-navy/20 bg-white px-4 py-3 flex flex-col">
            <span className="text-xs font-mono text-inky uppercase tracking-wide">Total Responses</span>
            <span className="text-2xl font-bold text-navy mt-1">{submissions.length}</span>
          </div>
        </div>

        <SubmissionsResultsTable
          dataFields={dataFields}
          submissions={submissions}
          responseMap={responseMap}
          overrideMap={overrideMap}
          submissionColumns={submissionColumns}
          columnValueMap={columnValueMap}
          canWrite={permission === 'edit'}
          onOverrideSave={handleOverrideSave}
          onRevert={handleRevert}
          onSaveColumnValue={handleSaveColumnValue}
          submitterNameFor={(sub) => ({ name: sub.respondent_name ?? '(anonymous)' })}
        />
      </div>
    </div>
  )
}
