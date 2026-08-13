import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = supabase as any

// Per-company key/value JSON setting (flag scale, allowable types, toggles).
// Cross-device via app_settings; returns [value, save, loaded].
export function useAppSetting<T>(key: string, def: T): [T, (v: T) => void, boolean] {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [value, setValue] = useState<T>(def)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    sb.schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', key).maybeSingle()
      .then(({ data }: any) => { if (!cancelled) { if (data?.value != null) setValue(data.value as T); setLoaded(true) } })
    return () => { cancelled = true }
  }, [companyId, key])

  const save = useCallback((v: T) => {
    setValue(v)
    // supabase-js v2 builders are lazy thenables — the request only fires when
    // subscribed. Calling .then() here is what actually persists the write;
    // without it the value only lived in local state and vanished on reload.
    if (companyId) {
      sb.schema('platform').from('app_settings')
        .upsert({ company_id: companyId, key, value: v, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' })
        .then(({ error }: any) => { if (error) console.warn(`[useAppSetting] save failed for "${key}":`, error.message) })
    }
  }, [companyId, key])

  return [value, save, loaded]
}
