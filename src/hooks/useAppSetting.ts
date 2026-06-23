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
    if (companyId) void sb.schema('platform').from('app_settings').upsert({ company_id: companyId, key, value: v, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' })
  }, [companyId, key])

  return [value, save, loaded]
}
