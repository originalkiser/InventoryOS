import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { FormDefinition, FormField, FieldCondition, ConditionRule } from '@/types/forms'
import toast from 'react-hot-toast'

const sb = supabase as any

export function useForms() {
  const { profile } = useAuthStore()
  const [forms, setForms] = useState<FormDefinition[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile?.id) return
    setLoading(true)
    const { data } = await sb.schema('forms').from('forms')
      .select('*')
      .eq('created_by', profile.id)
      .order('created_at', { ascending: false })
    setForms((data ?? []) as FormDefinition[])
    setLoading(false)
  }, [profile?.id])

  useEffect(() => { load() }, [load])

  async function createForm(data: Partial<FormDefinition>): Promise<FormDefinition | null> {
    if (!profile?.id) return null
    const { data: row, error } = await sb.schema('forms').from('forms')
      .insert({ ...data, created_by: profile.id, company_id: profile.company_id })
      .select().single()
    if (error) { toast.error(error.message); return null }
    setForms((p) => [row as FormDefinition, ...p])
    return row as FormDefinition
  }

  async function updateForm(id: string, patch: Partial<FormDefinition>): Promise<boolean> {
    const { error } = await sb.schema('forms').from('forms')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error(error.message); return false }
    setForms((p) => p.map((f) => f.id === id ? { ...f, ...patch } : f))
    return true
  }

  async function deleteForm(id: string) {
    const { error } = await sb.schema('forms').from('forms').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setForms((p) => p.filter((f) => f.id !== id))
    toast.success('Form deleted')
  }

  async function duplicateForm(form: FormDefinition): Promise<FormDefinition | null> {
    if (!profile?.id) return null
    const { data: newForm, error } = await sb.schema('forms').from('forms')
      .insert({
        title: `${form.title} (Copy)`,
        description: form.description,
        department: form.department,
        theme: form.theme,
        show_score_to_respondent: form.show_score_to_respondent,
        allow_multiple_submissions: form.allow_multiple_submissions,
        requires_login: form.requires_login,
        created_by: profile.id,
        company_id: profile.company_id,
      }).select().single()
    if (error) { toast.error(error.message); return null }

    // Copy fields
    const { data: fields } = await sb.schema('forms').from('fields').select('*').eq('form_id', form.id)
    if (fields?.length) {
      const newFields = fields.map(({ id: _id, form_id: _fid, created_at: _ca, ...f }: any) => ({
        ...f, form_id: newForm.id,
      }))
      await sb.schema('forms').from('fields').insert(newFields)
    }

    setForms((p) => [newForm as FormDefinition, ...p])
    toast.success('Form duplicated')
    return newForm as FormDefinition
  }

  return { forms, loading, load, createForm, updateForm, deleteForm, duplicateForm }
}

export async function loadFormWithFields(formId: string): Promise<{
  form: FormDefinition
  fields: FormField[]
  conditions: FieldCondition[]
} | null> {
  const [formRes, fieldsRes, condRes] = await Promise.all([
    (sb as any).schema('forms').from('forms').select('*').eq('id', formId).single(),
    (sb as any).schema('forms').from('fields').select('*').eq('form_id', formId).order('sort_order'),
    (sb as any).schema('forms').from('field_conditions').select('*, rules:condition_rules(*)').eq('form_id', formId),
  ])
  if (formRes.error) return null
  const conditions: FieldCondition[] = (condRes.data ?? []).map((c: any) => ({
    ...c,
    rules: c.rules ?? [],
  }))
  return {
    form: formRes.data as FormDefinition,
    fields: (fieldsRes.data ?? []) as FormField[],
    conditions,
  }
}

export async function loadPublicForm(shareToken: string): Promise<{
  form: FormDefinition
  fields: FormField[]
  conditions: FieldCondition[]
} | null> {
  const formRes = await (sb as any).schema('forms').from('forms').select('*').eq('share_token', shareToken).maybeSingle()
  if (!formRes.data) return null
  return loadFormWithFields(formRes.data.id)
}

export async function saveFormFields(
  formId: string,
  fields: FormField[],
  conditions: FieldCondition[],
): Promise<boolean> {
  // Delete existing fields (cascade deletes conditions/rules)
  await (sb as any).schema('forms').from('fields').delete().eq('form_id', formId)

  if (fields.length) {
    const rows = fields.map(({ created_at: _ca, ...f }, i) => ({
      ...f, form_id: formId, sort_order: i,
    }))
    const { error } = await (sb as any).schema('forms').from('fields').insert(rows)
    if (error) { toast.error(error.message); return false }
  }

  // Save conditions
  for (const cond of conditions) {
    const { rules, ...condData } = cond
    const { data: savedCond, error: condErr } = await (sb as any).schema('forms').from('field_conditions')
      .insert({ ...condData, form_id: formId }).select().single()
    if (condErr) continue
    if (rules.length) {
      await (sb as any).schema('forms').from('condition_rules').insert(
        rules.map(({ id: _id, condition_id: _ci, ...r }) => ({ ...r, condition_id: savedCond.id }))
      )
    }
  }

  return true
}

export async function submitForm(payload: {
  formId: string
  assignmentId?: string | null
  submittedBy?: string | null
  respondentName?: string | null
  respondentEmail?: string | null
  locationId?: string | null
  responses: {
    fieldId: string
    valueText?: string | null
    valueArray?: string[] | null
    valueOptionId?: string | null
    valueScore?: number | null
    filePaths?: string[] | null
  }[]
  totalScore: number | null
  maxScore: number | null
}): Promise<string | null> {
  const { data: sub, error } = await (sb as any).schema('forms').from('submissions').insert({
    form_id: payload.formId,
    submitted_by: payload.submittedBy ?? null,
    respondent_name: payload.respondentName ?? null,
    respondent_email: payload.respondentEmail ?? null,
    location_id: payload.locationId ?? null,
    assignment_id: payload.assignmentId ?? null,
    total_score: payload.totalScore,
    max_possible_score: payload.maxScore,
  }).select().single()
  if (error) { toast.error(error.message); return null }

  if (payload.responses.length) {
    await (sb as any).schema('forms').from('responses').insert(
      payload.responses.map((r) => ({
        submission_id: sub.id,
        field_id: r.fieldId,
        value_text: r.valueText ?? null,
        value_array: r.valueArray ?? null,
        value_option_id: r.valueOptionId ?? null,
        value_score: r.valueScore ?? null,
        file_paths: r.filePaths ?? null,
      }))
    )
  }

  // Mark assignment complete
  if (payload.assignmentId) {
    await (sb as any).schema('forms').from('assignments')
      .update({ is_completed: true, completed_at: new Date().toISOString() })
      .eq('id', payload.assignmentId)
  }

  return sub.id as string
}
