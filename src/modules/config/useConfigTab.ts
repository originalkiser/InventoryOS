import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

export function useConfigTab<T>(tableName: string) {
  const { profile } = useAuthStore()
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!profile?.company_id) return
    setLoading(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  async function insert(row: Partial<T> & { company_id?: string }) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(tableName).insert({ ...row, company_id: profile.company_id })
    if (error) toast.error(error.message)
    else { toast.success('Saved'); await load() }
  }

  async function upsertBatch(rows: Partial<T>[]) {
    if (!profile?.company_id) { toast.error('No workspace linked yet — try refreshing the page'); return }
    const payload = rows.map((r) => ({ ...r, company_id: profile.company_id }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(tableName).upsert(payload)
    if (error) toast.error(error.message)
    else { toast.success(`Imported ${rows.length} rows`); await load() }
  }

  async function remove(id: string) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from(tableName).delete().eq('id', id)
    if (error) toast.error(error.message)
    else await load()
  }

  return { data, loading, load, insert, upsertBatch, remove }
}
