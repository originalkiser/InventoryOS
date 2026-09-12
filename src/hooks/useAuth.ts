import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { User } from '@supabase/supabase-js'
import toast from 'react-hot-toast'

export function useAuth() {
  const { setUser, setSession, setProfile, setInitialized, clear } = useAuthStore()

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) {
        loadProfile(session.user).finally(() => setInitialized())
      } else {
        setInitialized()
      }
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
    const sb = supabase as any
    const { data: prof } = await sb
      .schema('platform').from('user_profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle()

    // Healthy profile — done.
    if (prof && prof.company_id) {
      setProfile(prof)
      return
    }

    // There is no self-serve signup anymore — every real user is created by
    // an admin via the invite-user Edge Function, which always creates the
    // profile row in the same step. A session that reaches here with no
    // profile row at all, or a profile with no company linked, is either
    // stale data needing a developer to fix (see the company_id backfill
    // SQL in supabase/migrations), or someone who obtained a Supabase Auth
    // session some other way, bypassing the app entirely. Either way, never
    // silently provision a new workspace for it — sign them back out.
    console.error(
      prof ? 'Profile has no company_id linked:' : 'No profile row for this authenticated user:',
      user.id,
    )
    toast.error('No account found for this login. Contact an administrator.')
    await supabase.auth.signOut()
    clear()
  }
}
