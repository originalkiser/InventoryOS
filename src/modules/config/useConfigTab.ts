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
    // Paginate past PostgREST's default 1000-row response cap so large tables
    // (e.g. a 2,000+ row tank-monitor import) load fully.
    const sb = supabase as any
    const PAGE = 1000
    const all: T[] = []
    let from = 0
    let err: { message: string } | null = null
    for (;;) {
      const { data: rows, error } = await sb.from(tableName).select('*')
        .eq('company_id', profile.company_id).order('created_at', { ascending: false })
        .range(from, from + PAGE - 1)
      if (error) { err = error; break }
      all.push(...((rows ?? []) as T[]))
      if (!rows || rows.length < PAGE) break
      from += PAGE
    }
    if (err) toast.error(`Failed to load ${tableName}`)
    else setData(all)
    setLoading(false)
  }, [profile?.company_id, tableName])

  // Insert/upsert in batches — 4 concurrent at 2000 rows each for large imports.
  async function writeInBatches(rows: Record<string, unknown>[], op: 'insert' | 'upsert'): Promise<{ message: string } | null> {
    const sb = supabase as any
    const BATCH = 2000
    const CONCURRENCY = 4
    const batches: Record<string, unknown>[][] = []
    for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH))

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const group = batches.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        group.map((slice) =>
          op === 'upsert' ? sb.from(tableName).upsert(slice) : sb.from(tableName).insert(slice)
        )
      )
      for (const { error } of results) {
        if (error) return error
      }
    }
    return null
  }

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
    const error = await writeInBatches(payload, 'upsert')
    if (error) toast.error(error.message)
    else { toast.success(`Imported ${rows.length} rows`); load().catch(() => {}) }
  }

  // Merge (match existing by natural key, update or insert) or replace-all.
  async function importRows(rows: Partial<T>[], opts: ImportOptions<T>) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const sb = supabase as any
    const source = opts.source ?? 'upload'

    if (opts.mode === 'replace') {
      const { error: delErr } = await sb.from(tableName).delete().eq('company_id', profile.company_id)
      if (delErr) { toast.error(delErr.message); return }
      const error = await writeInBatches(rows.map((r) => stamp(r as Record<string, unknown>, source)), 'insert')
      if (error) { toast.error(error.message); return }
      toast.success(`Replaced with ${rows.length.toLocaleString()} rows`)
      load().catch(() => {})
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
    const error = await writeInBatches(payload, 'upsert')
    if (error) { toast.error(error.message); return }
    const updated = payload.filter((p: any) => p.id).length
    toast.success(`Imported ${rows.length.toLocaleString()} rows (${updated.toLocaleString()} updated, ${(rows.length - updated).toLocaleString()} new)`)
    load().catch(() => {})
  }

  async function remove(id: string) {
    const { error } = await (supabase as any).from(tableName).delete().eq('id', id)
    if (error) toast.error(error.message)
    else await load()
  }

  return { data, loading, load, insert, update, upsertBatch, importRows, remove }
}
