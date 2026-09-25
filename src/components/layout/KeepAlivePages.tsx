import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
export function KeepAlivePages({ animClass, animTick, slideDirection }: {
  animClass: string
  animTick: number
  /** Set only for actual arrow-key Recent Pages cycling (not a plain click
      or sidebar nav) — triggers the full dual-page push transition below
      instead of the plain single-page fade/offset `animClass` handles. */
  slideDirection: 'left' | 'right' | null
}) {
  const location = useLocation()
  // Query string included: several pages (Location Lookup, Issues, Config,
  // Meeting Notes) read their own state from useSearchParams(), so two
  // visits with different query strings are different cached pages, not
  // the same one re-shown with the wrong filter applied.
  const currentKey = location.pathname + location.search

  const [entries, setEntries] = useState<CachedEntry[]>(() => [{ key: currentKey, location }])
  const lastKeyRef = useRef(currentKey)
  // The key we're navigating AWAY from — captured the instant currentKey
  // changes (during render, same reasoning as the entries update below) so
  // the tick-driven transition effect further down always has the right
  // "from" side even though it only fires one tick later.
  const prevKeyRef = useRef(currentKey)
  // Derived during render, not in an effect — an effect runs one tick
  // after this render commits, so the very first paint of a brand-new path
  // would have no matching entry yet and flash a blank content area.
  if (lastKeyRef.current !== currentKey) {
    prevKeyRef.current = lastKeyRef.current
    lastKeyRef.current = currentKey
    setEntries((prev) => {
      const rest = prev.filter((e) => e.key !== currentKey)
      return [{ key: currentKey, location }, ...rest].slice(0, MAX_CACHED_PAGES)
    })
  }

  // Full-page "PowerPoint push" (2026-09-26 ask): for the ~220ms the CSS
  // animation runs, both the outgoing and incoming entry render absolutely
  // stacked (see the wrapping div below) and slide past each other. Cleared
  // automatically after the animation finishes, reverting both entries to
  // their normal display:none/block flow. Keyed off animTick (not
  // slideDirection, which can repeat two arrow-presses in a row unchanged)
  // so two consecutive same-direction hops each still re-trigger a fresh run.
  const TRANSITION_MS = 230
  const [transition, setTransition] = useState<{ fromKey: string; toKey: string; direction: 'left' | 'right' } | null>(null)
  const lastTickRef = useRef(animTick)
  const containerRef = useRef<HTMLDivElement>(null)
  const [transitionHeight, setTransitionHeight] = useState<number | null>(null)
  useEffect(() => {
    if (animTick === lastTickRef.current) return
    lastTickRef.current = animTick
    if (!slideDirection || prevKeyRef.current === currentKey) { setTransition(null); return }
    // Height is pinned to the currently-visible viewport below this
    // container (not the full, possibly-scrolled document) — a real page
    // transition animates what's on screen, and this also sidesteps having
    // to measure a not-yet-visible cached page's own natural height.
    const el = containerRef.current
    if (el) setTransitionHeight(Math.max(240, window.innerHeight - el.getBoundingClientRect().top))
    setTransition({ fromKey: prevKeyRef.current, toKey: currentKey, direction: slideDirection })
    const t = setTimeout(() => setTransition(null), TRANSITION_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animTick])

  return (
    <div ref={containerRef} className="relative" style={transition ? { height: transitionHeight ?? undefined, overflow: 'hidden' } : undefined}>
      {entries.map((entry) => {
        const isActive = entry.key === currentKey
        const isFrom = transition?.fromKey === entry.key
        const isTo = transition?.toKey === entry.key
        const inTransition = !!transition && (isFrom || isTo)

        // Structure below (Provider > SwipeAnimator > ErrorBoundary > Routes)
        // is IDENTICAL whether or not this entry is mid-transition — only the
        // outer div's style/className and the animClass prop change. Varying
        // the tree shape between the two would unmount/remount Routes (and
        // the page underneath it) every time a transition starts or ends,
        // defeating the entire point of keeping it alive.
        let style: CSSProperties = { display: isActive || inTransition ? 'block' : 'none' }
        let slideClass = ''
        if (inTransition) {
          style = {}
          // Flipped from the literal direction name (2026-09-26 user report:
          // felt backwards) — cycleRecent's own 'right' actually steps to an
          // OLDER entry in the most-recent-first list (index+1), so the
          // visually-forward motion users expect from pressing Right is the
          // opposite of what a literal direction === 'right' mapping gives.
          const enterFromRight = transition!.direction === 'left'
          slideClass = isTo
            ? (enterFromRight ? 'sb-page-slide-in-right' : 'sb-page-slide-in-left')
            : (enterFromRight ? 'sb-page-slide-out-left' : 'sb-page-slide-out-right')
        }

        return (
          <div key={entry.key} className={slideClass} style={style}>
            <PageActiveContext.Provider value={isActive}>
              <SwipeAnimator animTick={animTick} animClass={!inTransition && isActive ? animClass : ''}>
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
    </div>
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
