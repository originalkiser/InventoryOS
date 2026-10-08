// Shared state for the open shop exceptions (one store, so the location dropdown's icons, the Location Lookup card, its modal and the triage view
// always agree). Status changes are written straight to inventory.shop_exceptions and mirrored locally so the UI updates at once.
import { useCallback, useEffect, useMemo } from 'react'
import { create } from 'zustand'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { sortExceptions, type ShopException } from './shopExceptionTypes'

const sb = () => supabase as any
const COLUMNS = 'id, location_id, type, severity, status, first_seen, last_seen, items, acked_keys, status_changed_at, logged_message'

interface State {
  items: ShopException[]
  loadedFor: string | null
  loading: boolean
  load: (companyId: string, force?: boolean) => Promise<void>
  patchLocal: (id: string, patch: Partial<ShopException>) => void
}

export const useShopExceptionsStore = create<State>((set, get) => ({
  items: [], loadedFor: null, loading: false,
  load: async (companyId, force = false) => {
    if (get().loading || (!force && get().loadedFor === companyId)) return
    set({ loading: true })
    const rows: ShopException[] = []
    try {
      for (let from = 0; ; ) {
        const { data, error } = await sb().schema('inventory').from('shop_exceptions').select(COLUMNS).eq('company_id', companyId).neq('status', 'resolved').order('id').range(from, from + 999)
        if (error) throw error
        const batch = (data ?? []) as ShopException[]
        rows.push(...batch)
        if (batch.length < 1000) break
        from += batch.length
      }
      set({ items: rows.map((r) => ({ ...r, items: r.items ?? [], acked_keys: r.acked_keys ?? [] })), loadedFor: companyId, loading: false })
    } catch (e) {
      set({ loading: false })
      toast.error(`Couldn't load exceptions: ${e instanceof Error ? e.message : 'unknown error'}`)
    }
  },
  patchLocal: (id, patch) => set((s) => ({ items: s.items.map((e) => (e.id === id ? { ...e, ...patch } : e)) })),
}))

export type ExceptionAction = 'skip' | 'excuse' | 'restore' | 'log'

export function useShopExceptions() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const items = useShopExceptionsStore((s) => s.items)
  const loading = useShopExceptionsStore((s) => s.loading)
  const loadedFor = useShopExceptionsStore((s) => s.loadedFor)
  const load = useShopExceptionsStore((s) => s.load)
  const patchLocal = useShopExceptionsStore((s) => s.patchLocal)

  useEffect(() => { if (companyId) void load(companyId) }, [companyId, load])
  const reload = useCallback(() => (companyId ? load(companyId, true) : Promise.resolve()), [companyId, load])

  const pendingByLocation = useMemo(() => {
    const m = new Map<string, ShopException[]>()
    for (const e of items) if (e.status === 'pending') { if (!m.has(e.location_id)) m.set(e.location_id, []); m.get(e.location_id)!.push(e) }
    for (const l of m.values()) l.sort(sortExceptions)
    return m
  }, [items])

  /** Skip / Excuse / Log remember which items were showing, so only a NEW item reopens it; Restore puts it back to pending. */
  const act = useCallback(async (e: ShopException, action: ExceptionAction, message?: string): Promise<boolean> => {
    const now = new Date().toISOString()
    const keys = e.items.map((i) => i.key)
    const patch: Partial<ShopException> & Record<string, unknown> =
      action === 'restore' ? { status: 'pending', acked_keys: [] }
      : action === 'log' ? { status: 'logged', acked_keys: keys, logged_message: message ?? null }
      : { status: action === 'skip' ? 'skipped' : 'excused', acked_keys: keys }
    const before = { status: e.status, acked_keys: e.acked_keys, logged_message: e.logged_message }
    patchLocal(e.id, { ...(patch as Partial<ShopException>), status_changed_at: now })
    const { error } = await sb().schema('inventory').from('shop_exceptions').update({ ...patch, status_changed_at: now, status_changed_by: userId, updated_at: now }).eq('id', e.id)
    if (error) { patchLocal(e.id, before as Partial<ShopException>); toast.error(`Couldn't save: ${error.message}`); return false }
    return true
  }, [patchLocal, userId])

  return { exceptions: items, loading: loading || (!!companyId && loadedFor !== companyId), reload, pendingByLocation, act }
}
