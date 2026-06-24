import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { TableKey } from '@/lib/tableKeys'
import toast from 'react-hot-toast'

export type CustomColumnType = 'text' | 'number' | 'date' | 'status' | 'checkbox' | 'select' | 'user'

export interface CustomColumn {
  id: string
  company_id: string
  table_key: string
  label: string
  column_type: CustomColumnType
  options: { label: string; color?: string }[]
  sort_order: number
  width: number
  is_pinned: boolean
  created_at: string
}

export interface CustomValue {
  id: string
  column_id: string
  row_id: string
  company_id: string
  table_key: string
  value: string | null
}

const sb = supabase as any

export function useCustomColumns(tableKey: TableKey) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [columns, setColumns] = useState<CustomColumn[]>([])
  const [values, setValues] = useState<Record<string, string | null>>({}) // `${rowId}:${columnId}` → value

  const key = (rowId: string, columnId: string) => `${rowId}:${columnId}`

  const load = useCallback(async () => {
    if (!companyId) return
    const [c, v] = await Promise.all([
      sb.schema('platform').from('custom_columns').select('*').eq('company_id', companyId).eq('table_key', tableKey).order('sort_order'),
      sb.schema('platform').from('custom_values').select('*').eq('company_id', companyId).eq('table_key', tableKey),
    ])
    setColumns((c.data ?? []) as CustomColumn[])
    const map: Record<string, string | null> = {}
    for (const row of (v.data ?? []) as CustomValue[]) map[key(row.row_id, row.column_id)] = row.value
    setValues(map)
  }, [companyId, tableKey])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const ch = supabase
      .channel(`custom-cols-${tableKey}`)
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'custom_columns', filter: `company_id=eq.${companyId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'platform', table: 'custom_values', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [companyId, tableKey, load])

  const valueFor = useCallback((rowId: string, columnId: string) => values[key(rowId, columnId)] ?? null, [values])

  async function addColumn(label: string, type: CustomColumnType, options: { label: string; color?: string }[] = []) {
    if (!companyId) return
    const maxOrder = columns.reduce((m, c) => Math.max(m, c.sort_order), 0)
    const { error } = await sb.schema('platform').from('custom_columns').insert({
      company_id: companyId, table_key: tableKey, label, column_type: type, options, sort_order: maxOrder + 1,
    })
    if (error) toast.error(error.message)
    else { toast.success('Column added'); await load() }
  }

  async function removeColumn(id: string) {
    const { error } = await sb.schema('platform').from('custom_columns').delete().eq('id', id)
    if (error) toast.error(error.message); else await load()
  }

  async function togglePin(id: string) {
    const col = columns.find((c) => c.id === id); if (!col) return
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, is_pinned: !c.is_pinned } : c)))
    const { error } = await sb.schema('platform').from('custom_columns').update({ is_pinned: !col.is_pinned }).eq('id', id)
    if (error) { toast.error(error.message); await load() }
  }

  async function moveColumn(id: string, dir: -1 | 1) {
    const sorted = [...columns].sort((a, b) => a.sort_order - b.sort_order)
    const i = sorted.findIndex((c) => c.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= sorted.length) return
    const a = sorted[i], b = sorted[j]
    setColumns((prev) => prev.map((c) => c.id === a.id ? { ...c, sort_order: b.sort_order } : c.id === b.id ? { ...c, sort_order: a.sort_order } : c))
    await Promise.all([
      sb.schema('platform').from('custom_columns').update({ sort_order: b.sort_order }).eq('id', a.id),
      sb.schema('platform').from('custom_columns').update({ sort_order: a.sort_order }).eq('id', b.id),
    ])
  }

  async function setValue(rowId: string, columnId: string, value: string | null) {
    if (!companyId) return
    const k = key(rowId, columnId)
    const snapshot = values
    setValues((prev) => ({ ...prev, [k]: value }))
    const { error } = await sb.schema('platform').from('custom_values')
      .upsert({ company_id: companyId, table_key: tableKey, column_id: columnId, row_id: rowId, value }, { onConflict: 'column_id,row_id' })
    if (error) { setValues(snapshot); toast.error(error.message) }
  }

  return { columns, valueFor, addColumn, removeColumn, togglePin, moveColumn, setValue }
}
