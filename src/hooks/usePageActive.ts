import { createContext, useContext, useEffect, useRef } from 'react'

// Provided by KeepAlivePages (src/components/layout/KeepAlivePages.tsx) —
// true while this page is the one currently visible, false while it's a
// backgrounded keep-alive entry. Defaults to true so a page rendered
// outside KeepAlivePages (a test, or before it's wired in) behaves as if
// always active.
export const PageActiveContext = createContext(true)

/**
 * Fires `onRevisit` when the user comes back to THIS page after being
 * somewhere else — either navigating back to it while it sat kept warm in
 * the background (see KeepAlivePages — the whole reason a page like this
 * doesn't naturally re-fetch on its own is that it never unmounted), or
 * returning to this browser tab after it lost focus. Wire a page's own
 * reload/refresh function into this so it catches up as soon as it's back
 * on screen instead of quietly showing whatever it looked like when you
 * left — an alert someone else already resolved, a comms log someone else
 * already updated — without waiting on a timer or a manual click.
 *
 * Rate-limited (default 3s) so rapid back-and-forth navigation (e.g.
 * mashing Alt+Left/Right) can't spam a real refetch every time.
 */
export function usePageRevisit(onRevisit: () => void, minIntervalMs = 3000) {
  const isActive = useContext(PageActiveContext)
  const wasActive = useRef(isActive)
  const onRevisitRef = useRef(onRevisit)
  const lastFiredRef = useRef(0)
  onRevisitRef.current = onRevisit

  function fire() {
    const now = Date.now()
    if (now - lastFiredRef.current < minIntervalMs) return
    lastFiredRef.current = now
    onRevisitRef.current()
  }

  // Came back from being a backgrounded keep-alive entry.
  useEffect(() => {
    if (isActive && !wasActive.current) fire()
    wasActive.current = isActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  // Came back to this browser tab while this page happens to be the active one.
  useEffect(() => {
    if (!isActive) return
    function onVisibility() {
      if (document.visibilityState === 'visible') fire()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])
}
