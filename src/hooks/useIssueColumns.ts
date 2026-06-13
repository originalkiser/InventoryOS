import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { IssueTrackerColumn, IssueColumnType, IssueCustomValue } from '@/types'
import toast from 'react-hot-toast'

const sb = supabase as any

// Custom-column definitions for the Issue Tracker grid + their per-issue cell
// values. Values edit optimistically and roll back on a Supabase error.
export function useIssueColumns() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [columns, setColumns] = useState<IssueTrackerColumn[]>([])
  const [values, setValues] = useState<Record<string, string | null>>({}) // `${issueId}:${columnId}` → value

  const key = (issueId: string, columnId: string) => `${issueId}:${columnId}`

  const load = useCallback(async () => {
    if (!companyId) return
    const [c, v] = await Promise.all([
      sb.from('issue_tracker_columns').select('*').eq('company_id', companyId).order('sort_order'),
      sb.from('issue_custom_values').select('*').eq('company_id', companyId),
    ])
    setColumns((c.data ?? []) as IssueTrackerColumn[])
    const map: Record<string, string | null> = {}
    for (const row of (v.data ?? []) as IssueCustomValue[]) map[key(row.issue_id, row.column_id)] = row.value
    setValues(map)
  }, [companyId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!companyId) return
    const ch = supabase
      .channel('issue-cols-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issue_tracker_columns', filter: `company_id=eq.${companyId}` }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issue_custom_values', filter: `company_id=eq.${companyId}` }, () => load())
      .subscribe()
    return () => { void supabase.removeChannel(ch) }
  }, [companyId, load])

  const valueFor = useCallback((issueId: string, columnId: string) => values[key(issueId, columnId)] ?? null, [values])

  async function addColumn(label: string, type: IssueColumnType, afterColumnId: string | null) {
    if (!companyId) return
    // Position: sort_order just after the chosen column, else at the end.
    const after = columns.find((c) => c.id === afterColumnId)
    const base = after ? after.sort_order : (columns.reduce((m, c) => Math.max(m, c.sort_order), 0))
    const { error } = await sb.from('issue_tracker_columns').insert({ company_id: companyId, label, type, sort_order: base + 1 })
    if (error) toast.error(error.message)
    else { toast.success('Column added'); await load() }
  }

  async function removeColumn(id: string) {
    const { error } = await sb.from('issue_tracker_columns').delete().eq('id', id)
    if (error) toast.error(error.message); else await load()
  }

  async function togglePin(id: string) {
    const col = columns.find((c) => c.id === id); if (!col) return
    setColumns((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)))
    const { error } = await sb.from('issue_tracker_columns').update({ pinned: !col.pinned }).eq('id', id)
    if (error) { toast.error(error.message); await load() }
  }

  // Swap sort_order with the previous/next sibling.
  async function moveColumn(id: string, dir: -1 | 1) {
    const sorted = [...columns].sort((a, b) => a.sort_order - b.sort_order)
    const i = sorted.findIndex((c) => c.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= sorted.length) return
    const a = sorted[i], b = sorted[j]
    setColumns((prev) => prev.map((c) => c.id === a.id ? { ...c, sort_order: b.sort_order } : c.id === b.id ? { ...c, sort_order: a.sort_order } : c))
    const r = await Promise.all([
      sb.from('issue_tracker_columns').update({ sort_order: b.sort_order }).eq('id', a.id),
      sb.from('issue_tracker_columns').update({ sort_order: a.sort_order }).eq('id', b.id),
    ])
    if (r.some((x: any) => x.error)) { toast.error('Failed to reorder'); await load() }
  }

  async function setValue(issueId: string, columnId: string, value: string | null) {
    if (!companyId) return
    const k = key(issueId, columnId)
    const snapshot = values
    setValues((prev) => ({ ...prev, [k]: value }))
    const { error } = await sb.from('issue_custom_values')
      .upsert({ company_id: companyId, issue_id: issueId, column_id: columnId, value }, { onConflict: 'issue_id,column_id' })
    if (error) { setValues(snapshot); toast.error(error.message) }
  }

  return { columns, valueFor, addColumn, removeColumn, togglePin, moveColumn, setValue }
}
