import { useCallback, useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

// Per-user UI preferences that follow the user across devices. Stored in
// platform.user_profiles.preferences (jsonb). localStorage is kept as an
// instant cache and as the one-time migration source for existing setups.
//
// Fail-soft: if the `preferences` column isn't applied yet, reads/writes to the
// profile no-op and the app behaves exactly like the old localStorage-only path.

const sb = supabase as any

interface PrefsState {
  prefs: Record<string, unknown>
  loadedFor: string | null
  loading: boolean
  load: (userId: string) => Promise<void>
  set: (userId: string, key: string, value: unknown) => void
}

export const useProfilePrefsStore = create<PrefsState>((set, get) => ({
  prefs: {}, loadedFor: null, loading: false,
  load: async (userId) => {
    const s = get()
    if (s.loadedFor === userId || s.loading) return
    set({ loading: true })
    const { data, error } = await sb.schema('platform').from('user_profiles').select('preferences').eq('id', userId).maybeSingle()
    const prefs = (!error && data?.preferences && typeof data.preferences === 'object') ? (data.preferences as Record<string, unknown>) : {}
    set({ prefs, loadedFor: userId, loading: false })
  },
  set: (userId, key, value) => {
    const next = { ...get().prefs, [key]: value }
    set({ prefs: next })
    sb.schema('platform').from('user_profiles').update({ preferences: next }).eq('id', userId)
      .then(({ error }: any) => { if (error) console.warn(`[profilePrefs] save failed for "${key}":`, error.message) })
  },
}))

function cachedOr<T>(key: string, def: T): T {
  try { const raw = localStorage.getItem(key); if (raw != null) return JSON.parse(raw) as T } catch { /* ignore */ }
  return def
}

// [value, setValue, loaded]. Value comes from the profile once loaded, else the
// localStorage cache (so there's no flash on first paint).
export function useProfilePref<T>(key: string, def: T): [T, (v: T) => void, boolean] {
  const { user } = useAuthStore()
  const userId = user?.id ?? null
  const prefs = useProfilePrefsStore((s) => s.prefs)
  const loadedFor = useProfilePrefsStore((s) => s.loadedFor)
  const load = useProfilePrefsStore((s) => s.load)
  const setStore = useProfilePrefsStore((s) => s.set)
  const loaded = !!userId && loadedFor === userId

  useEffect(() => { if (userId) load(userId) }, [userId, load])

  // One-time migration: once the profile is loaded and has no value for this
  // key, seed it from this device's localStorage so nothing is lost.
  useEffect(() => {
    if (!userId || !loaded || prefs[key] !== undefined) return
    try { const raw = localStorage.getItem(key); if (raw != null) setStore(userId, key, JSON.parse(raw)) } catch { /* ignore */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, loaded, key])

  const value = (loaded && prefs[key] !== undefined) ? (prefs[key] as T) : cachedOr(key, def)

  const setValue = useCallback((v: T) => {
    try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* ignore */ }
    if (userId) setStore(userId, key, v)
  }, [userId, key, setStore])

  return [value, setValue, loaded]
}
