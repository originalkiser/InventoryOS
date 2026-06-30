import { useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { completeSetup } from '@/pages/Setup'
import type { User } from '@supabase/supabase-js'
import toast from 'react-hot-toast'

// Guards against concurrent repair runs (getSession + onAuthStateChange both fire on load)
let healInFlight = false

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

    // Either no profile, or a profile with no company linked (a setup that never
    // completed). Self-heal: ensure a company exists and the profile points to it.
    if (healInFlight) {
      if (prof) setProfile(prof)
      return
    }
    healInFlight = true
    try {
      const meta = user.user_metadata ?? {}
      const emailLocal = (user.email ?? 'workspace').split('@')[0]
      const companyName: string = meta.pending_company || prof?.full_name || `${emailLocal}'s Workspace`
      const fullName: string = meta.full_name || prof?.full_name || user.email || emailLocal

      if (prof && !prof.company_id) {
        // Profile exists but company_id is NULL. Creating a new company here would
        // silently isolate this account from all existing company data.
        // Fix: run the backfill SQL from supabase/migrations/backfill_company_id.sql
        // in the Supabase dashboard, then redeploy.
        throw new Error(
          'Your account is not linked to a workspace. A developer must run the company_id backfill SQL in the Supabase dashboard to fix this.'
        )
      } else if (!prof) {
        // No profile row at all — create company + profile
        await completeSetup(user.id, companyName, fullName, user.email ?? '')
      }

      await supabase.auth.updateUser({ data: { pending_company: null, full_name: fullName } })
      const { data: fresh } = await sb.schema('platform').from('user_profiles').select('*').eq('id', user.id).single()
      if (fresh) {
        setProfile(fresh)
        toast.success('Workspace ready')
      } else if (prof) {
        setProfile(prof)
      }
    } catch (e) {
      const msg = (e as any)?.message ?? (e as any)?.error_description ?? JSON.stringify(e)
      console.error('Workspace setup/repair failed:', e)
      toast.error(`Workspace setup incomplete: ${msg}`)
      if (prof) setProfile(prof) // set what we have so the shell isn't fully dead
    } finally {
      healInFlight = false
    }
  }
}
