import { useEffect, useRef, useState } from 'react'
import { usePresence } from '@/hooks/usePresence'
import { useJoinMe } from '@/hooks/useJoinMe'
import { useAuthStore } from '@/stores/authStore'

// "Who's online" roster + Join Me — lives in the TopBar next to Recent
// Pages. Always mounted (not just while its panel is open) so the Join Me
// receive-listener (inside useJoinMe) stays active the whole session.
export function PresenceWidget() {
  const { profile } = useAuthStore()
  const { roster, scope, setScope, hasTeam } = usePresence()
  const { sendJoinMe } = useJoinMe()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  return (
    <div className="relative flex-shrink-0" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Who's online"
        className="flex items-center gap-1 px-2 h-7 rounded border border-[#F2F1E6]/20 text-[#F2F1E6]/60 hover:text-[#F2F1E6] transition-all"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a4 4 0 10-4-4" />
        </svg>
        {roster.length > 0 && <span className="text-[10px] font-mono text-sky">{roster.length}</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-40 w-64 bg-[#002745] border border-[#F2F1E6]/20 rounded-xl shadow-xl p-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-[#F2F1E6]/40 uppercase tracking-wide">Online now</span>
            {hasTeam && (
              <div className="flex gap-1 text-[9px] font-mono">
                <button onClick={() => setScope('team')} className={`px-1.5 py-0.5 rounded transition-colors ${scope === 'team' ? 'bg-sky text-[#002745]' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'}`}>Team</button>
                <button onClick={() => setScope('company')} className={`px-1.5 py-0.5 rounded transition-colors ${scope === 'company' ? 'bg-sky text-[#002745]' : 'text-[#F2F1E6]/50 hover:text-[#F2F1E6]'}`}>Company</button>
              </div>
            )}
          </div>

          {roster.length === 0 ? (
            <p className="text-xs font-mono text-[#F2F1E6]/40 italic py-2 text-center">No one else online right now.</p>
          ) : (
            <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
              {roster.map((u) => (
                <div key={u.user_id} className="flex items-center gap-2 px-1.5 py-1.5 rounded hover:bg-[#F2F1E6]/5">
                  <span className="w-6 h-6 rounded-full bg-sky/20 border border-sky/40 text-sky text-[10px] font-heading font-semibold flex items-center justify-center flex-shrink-0">
                    {u.initials}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono text-[#F2F1E6] truncate">{u.name}</div>
                    <div className="text-[9px] font-mono text-[#F2F1E6]/45 truncate">on {u.page_label}</div>
                  </div>
                  <button
                    onClick={() => sendJoinMe(u.user_id, profile?.full_name ?? 'A teammate')}
                    title={`Invite ${u.name} to join you here`}
                    className="text-[9px] font-mono text-sky hover:text-sky/70 flex-shrink-0 whitespace-nowrap"
                  >
                    Join me →
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
