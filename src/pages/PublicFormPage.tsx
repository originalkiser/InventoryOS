import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { loadPublicForm, submitForm } from '@/hooks/useForms'
import { FormCanvas } from '@/modules/forms/FormBuilderPage'
import { useAuthStore } from '@/stores/authStore'
import type { FormDefinition, FormField, FieldCondition } from '@/types/forms'
import { resolveThemeColors } from '@/lib/resolveThemeColors'
import toast from 'react-hot-toast'

const sb = supabase as any

export function PublicFormPage() {
  const { shareToken } = useParams<{ shareToken: string }>()
  const [searchParams] = useSearchParams()
  const assignmentId = searchParams.get('assignment')
  const { session } = useAuthStore()

  const [form, setForm] = useState<FormDefinition | null>(null)
  const [fields, setFields] = useState<FormField[]>([])
  const [conditions, setConditions] = useState<FieldCondition[]>([])
  const [loading, setLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  useEffect(() => {
    if (!shareToken) return
    loadPublicForm(shareToken).then((res) => {
      if (!res) { setNotFound(true); setLoading(false); return }
      setForm(res.form)
      setFields(res.fields)
      setConditions(res.conditions)
      setLoading(false)
    })
  }, [shareToken])

  async function handleSubmit(data: {
    responses: Record<string, any>
    files: Record<string, File[]>
    anonName: string | null
    anonEmail: string | null
    total: number
    max: number
  }) {
    if (!form) return

    // Upload files
    const filePaths: Record<string, string[]> = {}
    for (const [fieldId, fileList] of Object.entries(data.files)) {
      if (!fileList.length) continue
      filePaths[fieldId] = []
      for (const file of fileList) {
        const path = `form-submissions/${form.id}/${crypto.randomUUID()}/${fieldId}/${Date.now()}-${file.name}`
        const { error: uploadErr } = await supabase.storage.from('form-submissions').upload(path, file)
        if (uploadErr) { toast.error(`Failed to upload ${file.name}`); continue }
        filePaths[fieldId].push(path)
      }
    }

    // Build response rows
    const responseRows = fields
      .filter((f) => f.field_type !== 'text_block' && f.field_type !== 'calculation')
      .map((field) => {
        const val = data.responses[field.id]
        const fPaths = filePaths[field.id] ?? null
        let valueText: string | null = null
        let valueArray: string[] | null = null
        let valueOptionId: string | null = null
        let valueScore: number | null = null

        if (field.field_type === 'multiple_choice' || field.field_type === 'dropdown') {
          valueOptionId = val ?? null
          valueScore = field.options.find((o) => o.id === val)?.score ?? null
        } else if (field.field_type === 'multi_select') {
          valueArray = Array.isArray(val) ? val : null
          if (valueArray) valueScore = valueArray.reduce((s, id) => s + (field.options.find((o) => o.id === id)?.score ?? 0), 0)
        } else {
          valueText = val != null ? String(val) : null
        }

        return { fieldId: field.id, valueText, valueArray, valueOptionId, valueScore, filePaths: fPaths }
      })
      .filter((r) => r.valueText != null || r.valueArray != null || r.valueOptionId != null || (r.filePaths?.length ?? 0) > 0)

    const subId = await submitForm({
      formId: form.id,
      assignmentId: assignmentId ?? null,
      submittedBy: session?.user?.id ?? null,
      respondentName: data.anonName,
      respondentEmail: data.anonEmail,
      responses: responseRows,
      totalScore: data.max > 0 ? data.total : null,
      maxScore: data.max > 0 ? data.max : null,
    })

    if (!subId) return

    // Update score streaks (client-side, per spec)
    if (data.max > 0) {
      for (const field of fields.filter((f) => ['multiple_choice', 'multi_select', 'dropdown'].includes(f.field_type))) {
        const resp = responseRows.find((r) => r.fieldId === field.id)
        if (!resp || resp.valueScore == null) continue
        const score = resp.valueScore
        const { data: existing } = await sb.schema('forms').from('score_streaks')
          .select('*').eq('form_id', form.id).eq('field_id', field.id).is('location_id', null).maybeSingle()
        if (existing) {
          await sb.schema('forms').from('score_streaks').update({
            streak_score: score,
            streak_count: existing.streak_score === score ? existing.streak_count + 1 : 1,
            last_submission_id: subId,
            updated_at: new Date().toISOString(),
          }).eq('id', existing.id)
        } else {
          await sb.schema('forms').from('score_streaks').insert({
            form_id: form.id, field_id: field.id, location_id: null,
            streak_score: score, streak_count: 1, last_submission_id: subId,
          })
        }
      }
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#002745] flex items-center justify-center">
        <div className="text-[#F2F1E6] text-xs font-mono animate-pulse">Loading…</div>
      </div>
    )
  }

  if (notFound || !form) {
    return (
      <div className="min-h-screen bg-[#002745] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-[#F2F1E6] text-lg font-bold mb-2">Form Not Found</div>
          <div className="text-[#B7E0DE] text-sm">This form link may be invalid or the form has been removed.</div>
        </div>
      </div>
    )
  }

  if (!form.is_published) {
    return (
      <div className="min-h-screen bg-[#002745] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-[#F2F1E6] text-lg font-bold mb-2">Form Not Available</div>
          <div className="text-[#B7E0DE] text-sm">This form has not been published yet.</div>
        </div>
      </div>
    )
  }

  if (form.requires_login && !session) {
    return (
      <div className="min-h-screen bg-[#002745] flex items-center justify-center px-4">
        <div className="text-center">
          <div className="text-[#F2F1E6] text-lg font-bold mb-2">Login Required</div>
          <div className="text-[#B7E0DE] text-sm mb-4">You must be logged in to submit this form.</div>
          <a href="/login" className="text-[#00e5ff] text-sm underline">Log in to SB Net</a>
        </div>
      </div>
    )
  }

  const colors = resolveThemeColors(form.theme)

  return (
    <div className="min-h-screen py-8 px-4" style={{ background: colors.background }}>
      <div className="max-w-xl mx-auto">
        <FormCanvas
          form={form}
          fields={fields}
          conditions={conditions}
          onSubmit={handleSubmit}
          submittedBy={session?.user?.id ?? null}
          assignmentId={assignmentId}
        />
      </div>
    </div>
  )
}
