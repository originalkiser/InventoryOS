import { useEffect, useMemo, useRef, useState } from 'react'
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
// user's own department(s) ("team"), with a toggle to widen to company-wide.
// A user can belong to several departments (Config -> Users), so "team"
// joins one channel per department they're in rather than picking just one
// — two users only need to share ONE department in common to see each
// other, and this is how that actually happens. Switching to Company scope
// swaps to the single company-wide channel instead of filtering client-side.
//
// Not authorized via Realtime Authorization (see migration
// 20260828_realtime_authorization.sql) — presence payloads aren't
// sensitive and this is a single-tenant deployment.
export function usePresence() {
  const { profile } = useAuthStore()
  const location = useLocation()
  const [scope, setScope] = useState<'team' | 'company'>('team')
  const [roster, setRoster] = useState<PresenceUser[]>([])
  const [departmentIds, setDepartmentIds] = useState<string[]>([])
  const channelsRef = useRef<RealtimeChannel[]>([])

  useEffect(() => {
    if (!profile?.id) return
    ;(supabase as any).schema('platform').from('user_department_memberships')
      .select('department_id').eq('user_id', profile.id)
      .then(({ data }: { data: { department_id: string }[] | null }) => {
        setDepartmentIds([...new Set((data ?? []).map((r) => r.department_id))])
      })
  }, [profile?.id])

  const hasTeam = departmentIds.length > 0
  const channelNames = useMemo(
    () => (scope === 'company' || !hasTeam ? ['presence:company'] : departmentIds.map((id) => `presence:team:${id}`)),
    [scope, hasTeam, departmentIds],
  )
  const channelKey = channelNames.join(',')

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
    const channels = channelNames.map((name) => supabase.channel(name, { config: { presence: { key: profile.id } } }))
    channelsRef.current = channels

    // A user can appear in more than one joined channel when departments
    // overlap — merge by user_id (last sync wins, values shouldn't differ)
    // and always exclude the current user from their own roster.
    const rosterByChannel = new Map<string, PresenceUser[]>()
    function recomputeRoster() {
      const merged = new Map<string, PresenceUser>()
      for (const list of rosterByChannel.values()) for (const u of list) merged.set(u.user_id, u)
      merged.delete(profile!.id)
      setRoster([...merged.values()])
    }

    channels.forEach((channel, i) => {
      const name = channelNames[i]
      channel.on('presence', { event: 'sync' }, () => {
        rosterByChannel.set(name, Object.values(channel.presenceState<PresenceUser>()).flat())
        recomputeRoster()
      })
      channel.subscribe(async (status) => { if (status === 'SUBSCRIBED') await channel.track(myPresence()) })
    })

    return () => { channels.forEach((c) => c.unsubscribe()); channelsRef.current = [] }
    // Re-subscribing on every keystroke of navigation would churn the
    // channels — route changes re-track (below) instead of resubscribing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelKey, profile?.id])

  // Re-track (not re-subscribe) on route change so "currently on" stays live.
  useEffect(() => {
    if (!profile?.id || channelsRef.current.length === 0) return
    channelsRef.current.forEach((c) => c.track(myPresence()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, profile?.id])

  return { roster, scope, setScope, hasTeam }
}
