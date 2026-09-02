import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { invalidateInventoryCache } from '@/hooks/useInventory'
import { requestImportConfirm, type ImportSummary } from '@/components/config/ImportPreviewHost'
import toast from 'react-hot-toast'

// Config tables whose writes must also drop the shared inventory cache
// (Dashboard / On Hand read them via useInventory).
const INVENTORY_SOURCE_TABLES = new Set(['location_order_config', 'product_usage'])

export type ImportMode = 'merge' | 'replace'

export interface ImportOptions<T> {
  mode: ImportMode
  // Natural-key extractor used to match incoming rows to existing ones (merge).
  keyOf?: (row: Partial<T>) => string
  source?: string // last_change_source value (default 'upload')
  // When true, existing rows that share a natural key (true duplicates) are
  // collapsed to one on merge — the extras are deleted after the upsert.
  dedupeExisting?: boolean
  // Pre-write review (defaults to the shared ImportPreviewHost modal). Pass
  // `false` for non-interactive callers; pass your own to customise.
  confirm?: ((summary: ImportSummary) => Promise<boolean>) | false
  // Label shown per new row in the review list. Defaults to keyOf.
  labelOf?: (row: Partial<T>) => string
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

export function useConfigTab<T>(tableName: string, schemaName = 'public') {
  const { profile } = useAuthStore()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)

  // Public schema must use supabase.from() directly — .schema('public') is not
  // a valid PostgREST header and causes "not found in schema cache" errors.
  const tbl = () => schemaName === 'public'
    ? (supabase as any).from(tableName)
    : (supabase as any).schema(schemaName).from(tableName)

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

    // Sequential keyset (seek) pagination, not OFFSET/.range() fired all at
    // once. The old approach had two compounding problems on a table that
    // grows large: OFFSET pagination gets progressively more expensive per
    // page (Postgres has to walk and discard every preceding row before it
    // can return one), AND firing every page concurrently via Promise.all
    // meant a six-figure-row table fired 100+ simultaneous large queries at
    // the database at once. A real run hit "canceling statement due to
    // statement timeout" (57014) — same failure class already found and
    // fixed once in ProductUsageTab.tsx, but worse here because of the
    // added concurrency. The seek predicate below keeps the exact same
    // (created_at desc, id asc) ordering — id is still the tiebreaker bulk
    // uploads sharing one created_at need to paginate without gaps/dupes —
    // while costing the same regardless of how deep into the table it is,
    // since it's a direct index seek with nothing to skip.
    const all: T[] = []
    let cursor: { createdAt: string; id: string } | null = null
    for (;;) {
      let q = tbl().select('*')
        .eq('company_id', profile.company_id)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .limit(PAGE)
      if (cursor) {
        q = q.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`)
      }
      const { data: rows, error } = await q
      if (error) { toast.error(`Failed to load ${tableName}`); setLoading(false); return }
      const batch = (rows ?? []) as any[]
      all.push(...batch)
      // Exit only on a genuinely empty page — the project's API "Max Rows"
      // setting silently caps every response at 1000 regardless of
      // .limit(PAGE), so a full page here doesn't mean "last page."
      if (batch.length === 0) break
      const last = batch[batch.length - 1]
      // Fallback sentinel for a null created_at (shouldn't happen — every
      // config table carries it as an audit column — but a well-defined
      // comparison here matters more than a rare row briefly sorting first).
      cursor = { createdAt: last.created_at ?? '1970-01-01T00:00:00Z', id: last.id }
    }

    tabCache.set(key, { data: all as T[], ts: Date.now() })
    setData(all as T[])
    setLoading(false)
  }, [profile?.company_id, tableName, schemaName])

  // Insert/upsert in batches — 4 concurrent at 2000 rows each for large imports.
  async function writeInBatches(rows: Record<string, unknown>[], op: 'insert' | 'upsert'): Promise<{ message: string } | null> {
    const BATCH = 2000
    const CONCURRENCY = 4
    const batches: Record<string, unknown>[][] = []
    for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH))

    for (let i = 0; i < batches.length; i += CONCURRENCY) {
      const group = batches.slice(i, i + CONCURRENCY)
      const results = await Promise.all(
        group.map((slice) =>
          op === 'upsert'
            ? tbl().upsert(slice, { onConflict: 'id' })
            : tbl().insert(slice)
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
    if (INVENTORY_SOURCE_TABLES.has(tableName)) invalidateInventoryCache()
  }

  // Force a real refetch even inside the TTL window — `load()` alone would
  // just re-serve the cached data. For a manual "Refresh" button, or for a
  // page catching up after being kept warm in the Recent Pages cache
  // (usePageRevisit) — either case wants to know about a change another
  // user just made, not whatever was cached up to 5 minutes ago.
  async function refresh() {
    invalidate()
    await load()
  }

  function stamp(row: Record<string, unknown>, source: string) {
    return { ...row, company_id: profile!.company_id, updated_by: profile!.id ?? null, last_change_source: source }
  }

  async function insert(row: Partial<T> & { company_id?: string }): Promise<boolean> {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return false }
    const { error } = await tbl().insert(stamp(row as Record<string, unknown>, 'manual'))
    if (error) { toast.error(error.message); return false }
    toast.success('Saved'); invalidate(); await load()
    return true
  }

  async function update(id: string, patch: Partial<T>): Promise<boolean> {
    const { error } = await tbl().update(stamp(patch as Record<string, unknown>, 'manual')).eq('id', id)
    if (error) { toast.error(error.message); return false }
    toast.success('Updated'); invalidate(); await load()
    return true
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
  // Returns whether the write actually happened, so a caller with a
  // side-effect that must stay in sync (e.g. price history) can gate on it
  // instead of firing regardless of a cancelled confirm or a failed write.
  async function importRows(rows: Partial<T>[], opts: ImportOptions<T>): Promise<boolean> {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return false }
    const source = opts.source ?? 'upload'
    // Review step — shows what will be updated vs newly created before any
    // write happens, so a mis-mapped key column doesn't quietly insert a
    // duplicate set of rows.
    const askConfirm = opts.confirm === false ? null : (opts.confirm ?? requestImportConfirm)
    const labelFor = (r: Partial<T>) => (opts.labelOf ?? opts.keyOf)?.(r) ?? ''

    if (opts.mode === 'replace') {
      if (askConfirm) {
        const ok = await askConfirm({
          mode: 'replace', total: rows.length, updates: 0, creates: rows.length,
          deletes: data.length, newRows: rows.map(labelFor),
        })
        if (!ok) return false
      }
      const { error: delErr } = await tbl().delete().eq('company_id', profile.company_id)
      if (delErr) { toast.error(delErr.message); return false }
      const error = await writeInBatches(rows.map((r) => stamp(r as Record<string, unknown>, source)), 'insert')
      if (error) { toast.error(error.message); return false }
      toast.success(`Replaced with ${rows.length.toLocaleString()} rows`)
      invalidate(); load().catch(() => {})
      return true
    }

    // merge — attach existing id to matching rows so upsert updates them in place
    const keyOf = opts.keyOf
    const existingByKey = new Map<string, string>()
    const dupeIds: string[] = []
    if (keyOf) {
      for (const d of data as Array<Partial<T> & { id?: string }>) {
        if (!d.id) continue
        const k = keyOf(d)
        // First row per key is canonical (data is newest-first); any further
        // existing rows sharing that key are redundant duplicates.
        if (existingByKey.has(k)) { if (opts.dedupeExisting) dupeIds.push(d.id) }
        else existingByKey.set(k, d.id)
      }
    }
    let matched = 0
    const newLabels: string[] = []
    const payload = rows.map((r) => {
      const base = stamp(r as Record<string, unknown>, source)
      const existingId = keyOf ? existingByKey.get(keyOf(r)) : undefined
      // Always supply an id — upsert with onConflict:'id' needs a PK present.
      // New rows get a fresh UUID; existing rows get their stored id so Postgres
      // resolves the conflict and updates in place rather than inserting.
      if (existingId) matched++
      else newLabels.push(labelFor(r))
      const id = existingId ?? crypto.randomUUID()
      return { ...base, id }
    })

    if (askConfirm) {
      const ok = await askConfirm({
        mode: 'merge', total: rows.length, updates: matched,
        creates: rows.length - matched, deletes: 0, newRows: newLabels,
      })
      if (!ok) return false
    }
    // Collapse duplicate ids (two incoming rows mapping to the same existing row)
    // — otherwise Postgres errors "ON CONFLICT DO UPDATE cannot affect row a
    // second time". Last write wins.
    const byIdMerge = new Map<string, Record<string, unknown>>()
    for (const p of payload) byIdMerge.set(String((p as any).id), p)
    const dedupedPayload = [...byIdMerge.values()]
    const error = await writeInBatches(dedupedPayload, 'upsert')
    if (error) { toast.error(error.message); return false }
    // Remove now-redundant duplicate rows that shared a natural key (opt-in).
    if (opts.dedupeExisting && dupeIds.length) {
      const CHUNK = 200
      for (let i = 0; i < dupeIds.length; i += CHUNK) {
        const { error: delErr } = await tbl().delete().eq('company_id', profile.company_id).in('id', dupeIds.slice(i, i + CHUNK))
        if (delErr) { console.warn('[importRows] dedupe delete failed:', delErr.message); break }
      }
    }
    const created = rows.length - matched
    const extra = dupeIds.length ? `, ${dupeIds.length.toLocaleString()} duplicates removed` : ''
    toast.success(`Imported ${rows.length.toLocaleString()} rows (${matched.toLocaleString()} updated, ${created.toLocaleString()} new${extra})`)
    invalidate(); load().catch(() => {})
    return true
  }

  async function remove(id: string) {
    const { error } = await tbl().delete().eq('id', id)
    if (error) toast.error(error.message)
    else { invalidate(); await load() }
  }

  // Delete a specific set of rows. Preferred over clearAll + re-upload when
  // fixing duplicates/bad rows: untouched rows keep their ids, so anything
  // referencing them (exception reports, comms, project assignments, order
  // config…) stays linked instead of being silently orphaned.
  async function removeMany(ids: string[]) {
    if (!ids.length) return
    const CHUNK = 200
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { error } = await tbl().delete().in('id', ids.slice(i, i + CHUNK))
      if (error) { toast.error(error.message); return }
    }
    toast.success(`Deleted ${ids.length.toLocaleString()} row${ids.length !== 1 ? 's' : ''}`)
    invalidate()
    await load()
  }

  async function clearAll() {
    if (!profile?.company_id) return
    const { error } = await tbl().delete().eq('company_id', profile.company_id)
    if (error) { toast.error(error.message); return }
    toast.success('Table cleared')
    invalidate()
    await load()
  }

  return { data, loading, load, refresh, insert, update, upsertBatch, importRows, remove, removeMany, clearAll }
}
