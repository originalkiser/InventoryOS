import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { labelForPath } from '@/lib/routeLabels'

export interface PresenceUser {
  user_id: string
  name: string
  initials: string
  page_path: string
  page_label: string
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

// Presence roster — who's currently in the app. Scope defaults to the
// user's own department ("team"), with a toggle to widen to company-wide.
// Switching scope unsubscribes from one channel and subscribes to the
// other rather than filtering a single company-wide channel client-side, so
// a "team" roster never has to download company-wide presence data.
//
// Not authorized via Realtime Authorization (see migration
// 20260828_realtime_authorization.sql) — presence payloads aren't
// sensitive and this is a single-tenant deployment.
export function usePresence() {
  const { profile } = useAuthStore()
  const location = useLocation()
  const [scope, setScope] = useState<'team' | 'company'>('team')
  const [roster, setRoster] = useState<PresenceUser[]>([])
  const [departmentId, setDepartmentId] = useState<string | null>(null)
  const channelRef = useRef<RealtimeChannel | null>(null)

  useEffect(() => {
    if (!profile?.id) return
    ;(supabase as any).schema('platform').from('user_department_memberships')
      .select('department_id').eq('user_id', profile.id).limit(1).maybeSingle()
      .then(({ data }: { data: { department_id: string } | null }) => setDepartmentId(data?.department_id ?? null))
  }, [profile?.id])

  const hasTeam = !!departmentId
  const channelName = scope === 'company' || !departmentId ? 'presence:company' : `presence:team:${departmentId}`

  function myPresence(): PresenceUser {
    const name = profile?.full_name ?? 'Unknown'
    return {
      user_id: profile!.id,
      name,
      initials: initialsFor(name),
      page_path: location.pathname,
      page_label: labelForPath(location.pathname),
    }
  }

  useEffect(() => {
    if (!profile?.id) return
    const channel = supabase.channel(channelName, { config: { presence: { key: profile.id } } })
    channelRef.current = channel

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState<PresenceUser>()
      const users = Object.values(state).flat().filter((u) => u.user_id !== profile.id)
      setRoster(users)
    })

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await channel.track(myPresence())
    })

    return () => { channel.unsubscribe(); channelRef.current = null }
    // Re-subscribing on every keystroke of navigation would churn the
    // channel — route changes re-track (below) instead of resubscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelName, profile?.id])

  // Re-track (not re-subscribe) on route change so "currently on" stays live.
  useEffect(() => {
    if (!channelRef.current || !profile?.id) return
    channelRef.current.track(myPresence())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, profile?.id])

  return { roster, scope, setScope, hasTeam }
}
