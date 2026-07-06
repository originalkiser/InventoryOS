import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Returns the set of sidebar section keys the current user is allowed to see,
 * based on their department memberships — or null if no filtering applies
 * (i.e. the user is not a department_user, so they see everything).
 */
export function useDeptAccess(): Set<string> | null {
  const { profile } = useAuthStore()
  const [allowed, setAllowed] = useState<Set<string> | null>(null)

  const isDeptUser = (profile?.role as string) === 'department_user'

  useEffect(() => {
    if (!isDeptUser || !profile?.id || !profile?.company_id) {
      setAllowed(null)
      return
    }
    const userId = profile.id
    let cancelled = false
    async function load() {
      const sb = supabase as any
      const { data: memberships } = await sb.schema('platform')
        .from('user_department_memberships')
        .select('department_id')
        .eq('user_id', userId)
      if (cancelled) return
      const deptIds = (memberships ?? []).map((m: any) => m.department_id as string)
      if (!deptIds.length) { setAllowed(new Set()); return }
      const { data: depts } = await sb.schema('platform')
        .from('departments')
        .select('id, slug')
        .in('id', deptIds)
      if (cancelled) return
      setAllowed(new Set((depts ?? []).map((d: any) => d.slug as string)))
    }
    load()
    return () => { cancelled = true }
  }, [isDeptUser, profile?.id, profile?.company_id])

  return isDeptUser ? allowed : null
}
