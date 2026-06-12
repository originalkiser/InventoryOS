import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { CustomFieldDefinition, CustomFieldSection } from '@/types'
import toast from 'react-hot-toast'

/** Slugify a label into a stable machine key (shared keys link across sections). */
export function fieldKeyFromLabel(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export interface NewField {
  label: string
  field_type?: 'text' | 'number' | 'date'
  linked_section?: string | null
  linked_match_key?: string | null
}

export function useCustomFields(section: CustomFieldSection) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [fields, setFields] = useState<CustomFieldDefinition[]>([])
  const [loading, setLoading] = useState(true)
  // Unique per hook instance — the same section's hook can mount in two places
  // at once (the config tab + the Manage Columns modal), and reusing a channel
  // topic throws "cannot add postgres_changes callbacks after subscribe()".
  const instanceId = useRef(Math.random().toString(36).slice(2)).current

  const reload = useCallback(async () => {
    if (!companyId) { setFields([]); setLoading(false); return }
    setLoading(true)
    const { data } = await (supabase as any)
      .from('custom_field_definitions')
      .select('*')
      .eq('company_id', companyId)
      .eq('section', section)
      .order('position', { ascending: true })
    setFields((data ?? []) as CustomFieldDefinition[])
    setLoading(false)
  }, [companyId, section])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    if (!companyId) return
    const ch = supabase
      .channel(`custom-fields-${section}-${instanceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'custom_field_definitions', filter: `company_id=eq.${companyId}` }, () => reload())
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [companyId, section, reload, instanceId])

  const active = fields.filter((f) => f.active)

  async function addField(f: NewField) {
    if (!companyId) { toast.error('No workspace linked yet'); return }
    const field_key = fieldKeyFromLabel(f.label)
    if (!field_key) { toast.error('Enter a column name'); return }
    if (fields.some((x) => x.field_key === field_key)) { toast.error('A column with that name already exists'); return }
    const position = (fields.reduce((m, x) => Math.max(m, x.position), 0)) + 1
    const { error } = await (supabase as any).from('custom_field_definitions').insert({
      company_id: companyId,
      section,
      field_key,
      label: f.label.trim(),
      field_type: f.field_type ?? 'text',
      position,
      linked_section: f.linked_section ?? null,
      linked_match_key: f.linked_match_key ?? null,
      active: true,
    })
    if (error) toast.error(error.message)
    else { toast.success(`Column "${f.label.trim()}" added`); reload() }
  }

  async function updateField(id: string, patch: Partial<CustomFieldDefinition>) {
    const { error } = await (supabase as any).from('custom_field_definitions').update(patch).eq('id', id)
    if (error) toast.error(error.message)
    else reload()
  }

  async function removeField(id: string) {
    const { error } = await (supabase as any).from('custom_field_definitions').delete().eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Column removed'); reload() }
  }

  async function move(id: string, dir: -1 | 1) {
    const sorted = [...fields].sort((a, b) => a.position - b.position)
    const idx = sorted.findIndex((f) => f.id === id)
    const swap = idx + dir
    if (idx < 0 || swap < 0 || swap >= sorted.length) return
    const a = sorted[idx], b = sorted[swap]
    const sb = supabase as any
    await Promise.all([
      sb.from('custom_field_definitions').update({ position: b.position }).eq('id', a.id),
      sb.from('custom_field_definitions').update({ position: a.position }).eq('id', b.id),
    ])
    reload()
  }

  /** Seed a recommended set of columns (skips any that already exist). */
  async function seedDefaults(defs: NewField[]) {
    if (!companyId) { toast.error('No workspace linked yet'); return }
    const existing = new Set(fields.map((f) => f.field_key))
    let pos = fields.reduce((m, x) => Math.max(m, x.position), 0)
    const rows = defs
      .filter((d) => !existing.has(fieldKeyFromLabel(d.label)))
      .map((d) => ({
        company_id: companyId, section,
        field_key: fieldKeyFromLabel(d.label), label: d.label.trim(),
        field_type: d.field_type ?? 'text', position: ++pos, active: true,
      }))
    if (!rows.length) { toast('All recommended columns already exist', { icon: 'ℹ️' }); return }
    const { error } = await (supabase as any).from('custom_field_definitions').insert(rows)
    if (error) toast.error(error.message)
    else { toast.success(`Added ${rows.length} columns`); reload() }
  }

  return { fields, active, loading, reload, addField, updateField, removeField, move, seedDefaults }
}
