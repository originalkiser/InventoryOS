import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { completeSetup } from '@/pages/Setup'
import type { User } from '@supabase/supabase-js'

export function useAuth() {
  const { setUser, setSession, setProfile, clear } = useAuthStore()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) loadProfile(session.user)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        loadProfile(session.user)
      } else {
        clear()
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  async function loadProfile(user: User) {
    const { data } = await (supabase as any)
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single()

    if (data) {
      setProfile(data)
      return
    }

    // No profile — check if this is a first login after email confirmation
    const meta = user.user_metadata ?? {}
    if (meta.pending_company && meta.full_name) {
      try {
        await completeSetup(user.id, meta.pending_company, meta.full_name, user.email ?? '')
        // Clear the pending flags from user metadata
        await supabase.auth.updateUser({ data: { pending_company: null, full_name: meta.full_name } })
        // Reload the profile we just created
        const { data: newProfile } = await (supabase as any)
          .from('profiles')
          .select('*')
          .eq('id', user.id)
          .single()
        if (newProfile) setProfile(newProfile)
      } catch (e) {
        console.error('Failed to complete workspace setup:', e)
      }
    }
  }
}
