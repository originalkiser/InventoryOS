import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Routes, useLocation, type Location } from 'react-router-dom'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { APP_ROUTE_ELEMENTS } from '@/routes/appRoutes'
import { PageActiveContext } from '@/hooks/usePageActive'

// "A small cache keyed by path, probably just the last few visited pages" —
// matches the Recent Pages carousel's own group-of-3 convention.
const MAX_CACHED_PAGES = 3

interface CachedEntry {
  key: string
  location: Location
}

/**
 * Renders the app's routed content — but keeps the last few visited pages
 * mounted in the background (hidden, not unmounted) instead of a plain
 * <Outlet/> that destroys a page's already-fetched data every time you
 * navigate away from it. Bouncing back to one of those pages (via the
 * Recent Pages widget/hotkeys, or the sidebar) is then instant: same
 * component instance, same in-memory state, no refetch/loading flash.
 *
 * Each cached page gets its own <Routes location={...}> instance, pinned to
 * the location it was visited at, rather than sharing one ambient router
 * context — needed so a hidden page's useParams()/useSearchParams() keep
 * returning ITS OWN values even while the browser is somewhere else (and so
 * two different :id routes, e.g. two different order drafts, don't
 * collide). This is the same officially-supported <Routes location> pattern
 * React Router's own docs use for animated route transitions — see
 * src/routes/appRoutes.tsx for the shared route list every instance here
 * renders.
 *
 * Trade-off: a cached page's data-fetching effects don't re-run just
 * because you've navigated back to it — nothing unmounted, so nothing
 * re-mounts, so it shows exactly what it looked like when you left. A
 * page's own realtime subscription (if it has one) keeps it fresh in the
 * background regardless; a page with none can go stale until it's evicted
 * from the cache (pushed past the 3rd-most-recent slot) and freshly
 * mounted next time.
 */
export function KeepAlivePages({ animClass, animTick }: { animClass: string; animTick: number }) {
  const location = useLocation()
  // Query string included: several pages (Location Lookup, Issues, Config,
  // Meeting Notes) read their own state from useSearchParams(), so two
  // visits with different query strings are different cached pages, not
  // the same one re-shown with the wrong filter applied.
  const currentKey = location.pathname + location.search

  const [entries, setEntries] = useState<CachedEntry[]>(() => [{ key: currentKey, location }])
  const lastKeyRef = useRef(currentKey)
  // Derived during render, not in an effect — an effect runs one tick
  // after this render commits, so the very first paint of a brand-new path
  // would have no matching entry yet and flash a blank content area.
  if (lastKeyRef.current !== currentKey) {
    lastKeyRef.current = currentKey
    setEntries((prev) => {
      const rest = prev.filter((e) => e.key !== currentKey)
      return [{ key: currentKey, location }, ...rest].slice(0, MAX_CACHED_PAGES)
    })
  }

  return (
    <>
      {entries.map((entry) => {
        const isActive = entry.key === currentKey
        return (
          <div key={entry.key} style={{ display: isActive ? 'block' : 'none' }}>
            <PageActiveContext.Provider value={isActive}>
              <SwipeAnimator animTick={animTick} animClass={isActive ? animClass : ''}>
                <ErrorBoundary>
                  {/* The active entry uses the live location object (full
                      fidelity — hash/state included); a backgrounded entry
                      replays the location it was last visited at. */}
                  <Routes location={isActive ? location : entry.location}>{APP_ROUTE_ELEMENTS}</Routes>
                </ErrorBoundary>
              </SwipeAnimator>
            </PageActiveContext.Provider>
          </div>
        )
      })}
    </>
  )
}

/**
 * Restarts a CSS swipe/fade animation on demand. Re-applying the exact same
 * class string doesn't replay a CSS animation on its own, so this clears
 * the class for one frame before setting it — animTick changing (not
 * animClass, which can repeat, e.g. two consecutive "back" navigations)
 * is what triggers the restart. A no-op (empty animClass) for every
 * backgrounded entry.
 */
function SwipeAnimator({ animTick, animClass, children }: { animTick: number; animClass: string; children: ReactNode }) {
  const [cls, setCls] = useState('')
  useEffect(() => {
    if (!animClass) { setCls(''); return }
    setCls('')
    const raf = requestAnimationFrame(() => setCls(animClass))
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animTick])
  return <div className={cls}>{children}</div>
}
