import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

export type ImportMode = 'merge' | 'replace'

export interface ImportOptions<T> {
  mode: ImportMode
  // Natural-key extractor used to match incoming rows to existing ones (merge).
  keyOf?: (row: Partial<T>) => string
  source?: string // last_change_source value (default 'upload')
}

export function useConfigTab<T>(tableName: string) {
  const { profile } = useAuthStore()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    const { data: rows, error } = await (supabase as any)
      .from(tableName)
      .select('*')
      .eq('company_id', profile.company_id)
      .order('created_at', { ascending: false })
    if (error) toast.error(`Failed to load ${tableName}`)
    else setData((rows ?? []) as T[])
    setLoading(false)
  }, [profile?.company_id, tableName])

  useEffect(() => { load() }, [load])

  function stamp(row: Record<string, unknown>, source: string) {
    return { ...row, company_id: profile!.company_id, updated_by: profile!.id ?? null, last_change_source: source }
  }

  async function insert(row: Partial<T> & { company_id?: string }) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const { error } = await (supabase as any).from(tableName).insert(stamp(row as Record<string, unknown>, 'manual'))
    if (error) toast.error(error.message)
    else { toast.success('Saved'); await load() }
  }

  async function update(id: string, patch: Partial<T>) {
    const { error } = await (supabase as any).from(tableName).update(stamp(patch as Record<string, unknown>, 'manual')).eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Updated'); await load() }
  }

  // Back-compat: append upsert (no key matching). Prefer importRows.
  async function upsertBatch(rows: Partial<T>[]) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const payload = rows.map((r) => stamp(r as Record<string, unknown>, 'upload'))
    const { error } = await (supabase as any).from(tableName).upsert(payload)
    if (error) toast.error(error.message)
    else { toast.success(`Imported ${rows.length} rows`); await load() }
  }

  // Merge (match existing by natural key, update or insert) or replace-all.
  async function importRows(rows: Partial<T>[], opts: ImportOptions<T>) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const sb = supabase as any
    const source = opts.source ?? 'upload'

    if (opts.mode === 'replace') {
      const { error: delErr } = await sb.from(tableName).delete().eq('company_id', profile.company_id)
      if (delErr) { toast.error(delErr.message); return }
      const { error } = await sb.from(tableName).insert(rows.map((r) => stamp(r as Record<string, unknown>, source)))
      if (error) toast.error(error.message)
      else { toast.success(`Replaced with ${rows.length} rows`); await load() }
      return
    }

    // merge — attach existing id to matching rows so upsert updates them in place
    const keyOf = opts.keyOf
    const existingByKey = new Map<string, string>()
    if (keyOf) {
      for (const d of data as Array<Partial<T> & { id?: string }>) {
        if (d.id) existingByKey.set(keyOf(d), d.id)
      }
    }
    const payload = rows.map((r) => {
      const base = stamp(r as Record<string, unknown>, source)
      const id = keyOf ? existingByKey.get(keyOf(r)) : undefined
      return id ? { ...base, id } : base
    })
    const { error } = await sb.from(tableName).upsert(payload)
    if (error) toast.error(error.message)
    else {
      const updated = payload.filter((p: any) => p.id).length
      toast.success(`Imported ${rows.length} rows (${updated} updated, ${rows.length - updated} new)`)
      await load()
    }
  }

  async function remove(id: string) {
    const { error } = await (supabase as any).from(tableName).delete().eq('id', id)
    if (error) toast.error(error.message)
    else await load()
  }

  return { data, loading, load, insert, update, upsertBatch, importRows, remove }
}
