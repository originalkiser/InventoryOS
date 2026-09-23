import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useRecentPagesStore } from '@/stores/recentPagesStore'
import { labelForPath } from '@/lib/routeLabels'

// Wires route changes into the Recent Pages store, and owns the two global
// hotkeys (Alt+Left/Right) — these cycle the capped-at-3 recent-pages ring
// circularly, wrapping around, rather than walking full browser-style
// history. Cmd/Ctrl+K to reveal the widget itself lives in
// RecentPagesWidget, since that one only needs to open a UI panel rather
// than trigger navigation.
export function useRecentPagesTracking() {
  const location = useLocation()
  const navigate = useNavigate()
  const recordVisit = useRecentPagesStore((s) => s.recordVisit)
  const cycleRecent = useRecentPagesStore((s) => s.cycleRecent)

  useEffect(() => {
    recordVisit(location.pathname, labelForPath(location.pathname))
  }, [location.pathname, recordVisit])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (typing) return
      if (e.altKey && e.key === 'ArrowLeft') {
        e.preventDefault()
        const path = cycleRecent('left')
        if (path) navigate(path)
      } else if (e.altKey && e.key === 'ArrowRight') {
        e.preventDefault()
        const path = cycleRecent('right')
        if (path) navigate(path)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [navigate, cycleRecent])
}
