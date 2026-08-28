import { useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { labelForPath } from '@/lib/routeLabels'

// "Join Me" — invite another currently-online user to jump to the page
// you're on (walking someone through SB Net, or pulling them into a live
// look at a record). Sent over a private, RLS-authorized broadcast channel
// per recipient (see migration 20260828_realtime_authorization.sql) so a
// user can only send as themselves and can only receive on their own
// channel — this is deliberately not an open broadcast.
interface JoinMePayload { fromName: string; path: string; label: string }

export function useJoinMe() {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const locationRef = useRef(location)
  locationRef.current = location

  // Receive: subscribe to my own private channel for the life of the app shell.
  useEffect(() => {
    if (!profile?.id) return
    const channel = supabase.channel(`joinme:${profile.id}`, { config: { private: true } })
    channel.on('broadcast', { event: 'invite' }, ({ payload }: { payload: JoinMePayload }) => {
      toast.custom(
        (t) => (
          <div className="bg-[#002745] text-[#F2F1E6] border border-sky/40 rounded-lg shadow-xl px-4 py-3 flex items-center gap-3 font-mono text-xs max-w-sm">
            <span className="flex-1">
              <strong className="text-sky">{payload.fromName}</strong> wants to show you <strong>{payload.label}</strong>
            </span>
            <button
              onClick={() => { navigate(payload.path); toast.dismiss(t.id) }}
              className="px-2 py-1 rounded bg-sky text-[#002745] font-heading uppercase tracking-wide hover:bg-sky/80 flex-shrink-0"
            >
              Go there
            </button>
            <button onClick={() => toast.dismiss(t.id)} className="text-[#F2F1E6]/50 hover:text-[#F2F1E6] flex-shrink-0">
              Dismiss
            </button>
          </div>
        ),
        { duration: 15000 },
      )
    })
    channel.subscribe()
    return () => { channel.unsubscribe() }
  }, [profile?.id, navigate])

  function sendJoinMe(targetUserId: string, fromName: string) {
    const channel = supabase.channel(`joinme:${targetUserId}`, { config: { private: true } })
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        const payload: JoinMePayload = {
          fromName,
          path: locationRef.current.pathname,
          label: labelForPath(locationRef.current.pathname),
        }
        channel.send({ type: 'broadcast', event: 'invite', payload }).then(() => channel.unsubscribe())
      }
    })
  }

  return { sendJoinMe }
}
