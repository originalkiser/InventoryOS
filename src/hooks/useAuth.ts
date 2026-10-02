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

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // supabase-js re-emits SIGNED_IN (and refreshes the token) every time
      // the browser tab/window regains focus. Treating each as a brand-new
      // login swapped in fresh session/user/profile objects and re-fetched
      // the profile on every alt-tab, which re-rendered — and in places
      // re-fetched — whatever page was open (found live 2026-10-02: Orders
      // v2 flashing and jumping to the top after switching windows). When it's
      // the SAME user we already have loaded, only the session (new access
      // token) needs updating; the user and profile objects stay as they are.
      const current = useAuthStore.getState()
      const sameUser = !!session?.user && current.user?.id === session.user.id && !!current.profile
      if (sameUser && (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED')) {
        setSession(session)
        return
      }
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
