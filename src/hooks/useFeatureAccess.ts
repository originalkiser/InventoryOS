import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isAdminOrDeveloper } from '@/lib/roles'

export function useFeatureAccess(featureKey: string): { enabled: boolean; loading: boolean } {
  const { profile } = useAuthStore()
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!profile) return

    // Admins and developers always have full access
    if (isAdminOrDeveloper(profile.role)) {
      setEnabled(true)
      setLoading(false)
      return
    }

    const sb = supabase as any
    sb.schema('core').from('user_feature_access')
      .select('enabled')
      .eq('user_id', profile.id)
      .eq('feature_key', featureKey)
      .maybeSingle()
      .then(({ data }: any) => {
        setEnabled(data?.enabled ?? false)
        setLoading(false)
      })
      .catch(() => {
        setEnabled(false)
        setLoading(false)
      })
  }, [profile?.id, profile?.role, featureKey])

  return { enabled, loading }
}
