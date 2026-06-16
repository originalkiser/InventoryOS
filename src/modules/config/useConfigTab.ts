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

// ---------------------------------------------------------------------------
// Module-level cache — survives tab switches, cleared on any mutation.
// Stale-while-revalidate: data older than TTL is served immediately but
// triggers a silent background refresh.
interface CacheEntry { data: unknown[]; ts: number }
const tabCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

function cacheKey(companyId: string, tableName: string) {
  return `${companyId}|${tableName}`
}
// ---------------------------------------------------------------------------

const PAGE = 1000

export function useConfigTab<T>(tableName: string) {
  const { profile } = useAuthStore()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    const key = cacheKey(profile.company_id, tableName)
    const cached = tabCache.get(key)

    if (cached) {
      // Serve cached data instantly — no loading spinner
      setData(cached.data as T[])
      setLoading(false)
      // Cache is still fresh — skip network entirely
      if (Date.now() - cached.ts < CACHE_TTL_MS) return
      // Cache is stale — refresh silently in background (data already displayed)
    } else {
      setLoading(true)
    }

    const sb = supabase as any

    // Count first so we know exactly how many pages to fire in parallel
    const { count, error: countErr } = await sb
      .from(tableName)
      .select('*', { count: 'exact', head: true })
      .eq('company_id', profile.company_id)

    if (countErr) { toast.error(`Failed to load ${tableName}`); setLoading(false); return }

    if (!count) {
      const empty: T[] = []
      tabCache.set(key, { data: empty, ts: Date.now() })
      setData(empty)
      setLoading(false)
      return
    }

    // Fire all pages concurrently — Promise.all preserves insertion order
    const pageCount = Math.ceil(count / PAGE)
    const results = await Promise.all(
      Array.from({ length: pageCount }, (_, i) =>
        sb.from(tableName).select('*')
          .eq('company_id', profile.company_id)
          .order('created_at', { ascending: false })
          .range(i * PAGE, (i + 1) * PAGE - 1)
      )
    )

    if (results.some((r: any) => r.error)) {
      toast.error(`Failed to load ${tableName}`)
      setLoading(false)
      return
    }

    const all = results.flatMap((r: any) => (r.data ?? []) as T[])
    tabCache.set(key, { data: all, ts: Date.now() })
    setData(all)
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

  function invalidate() {
    if (profile?.company_id) tabCache.delete(cacheKey(profile.company_id, tableName))
  }

  function stamp(row: Record<string, unknown>, source: string) {
    return { ...row, company_id: profile!.company_id, updated_by: profile!.id ?? null, last_change_source: source }
  }

  async function insert(row: Partial<T> & { company_id?: string }) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const { error } = await (supabase as any).from(tableName).insert(stamp(row as Record<string, unknown>, 'manual'))
    if (error) toast.error(error.message)
    else { toast.success('Saved'); invalidate(); await load() }
  }

  async function update(id: string, patch: Partial<T>) {
    const { error } = await (supabase as any).from(tableName).update(stamp(patch as Record<string, unknown>, 'manual')).eq('id', id)
    if (error) toast.error(error.message)
    else { toast.success('Updated'); invalidate(); await load() }
  }

  // Back-compat: append upsert (no key matching). Prefer importRows.
  async function upsertBatch(rows: Partial<T>[]) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const payload = rows.map((r) => stamp(r as Record<string, unknown>, 'upload'))
    const error = await writeInBatches(payload, 'upsert')
    if (error) toast.error(error.message)
    else { toast.success(`Imported ${rows.length} rows`); invalidate(); load().catch(() => {}) }
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
      invalidate(); load().catch(() => {})
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
    invalidate(); load().catch(() => {})
  }

  async function remove(id: string) {
    const { error } = await (supabase as any).from(tableName).delete().eq('id', id)
    if (error) toast.error(error.message)
    else { invalidate(); await load() }
  }

  async function clearAll() {
    if (!profile?.company_id) return
    const { error } = await (supabase as any).from(tableName).delete().eq('company_id', profile.company_id)
    if (error) { toast.error(error.message); return }
    toast.success('Table cleared')
    invalidate()
    await load()
  }

  return { data, loading, load, insert, update, upsertBatch, importRows, remove, clearAll }
}
