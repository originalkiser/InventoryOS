// Tracks which table rows the user has actually had on screen — the Review step won't move to Final
// Review until the LAST row of the order has been seen (direct ask 2026-10-03), whether that means
// scrolling to the bottom or paging to the last page. An IntersectionObserver with the viewport as its
// root already accounts for rows clipped by a scrolling container or sitting on another page (a row that
// isn't rendered, or is scrolled out of its container, never intersects).
import { useCallback, useEffect, useRef } from 'react'

export function useRowSeenTracker() {
  const seen = useRef<Set<string>>(new Set())
  const observer = useRef<IntersectionObserver | null>(null)

  const getObserver = useCallback(() => {
    if (observer.current || typeof IntersectionObserver === 'undefined') return observer.current
    observer.current = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const key = (e.target as HTMLElement).dataset.seenKey
        if (key) seen.current.add(key)
      }
    }, { threshold: 0.6 })
    return observer.current
  }, [])

  /** Ref-callback body: start watching a row element under `key`. */
  const observe = useCallback((el: HTMLElement | null, key: string) => {
    if (!el) return
    el.dataset.seenKey = key
    getObserver()?.observe(el)
  }, [getObserver])

  useEffect(() => () => { observer.current?.disconnect(); observer.current = null }, [])

  /** True when there's nothing to check, the browser can't observe, or the key has been on screen. */
  const hasSeen = useCallback((key: string | null) => {
    if (!key || typeof IntersectionObserver === 'undefined') return true
    return seen.current.has(key)
  }, [])

  /** Strict: has this exact row key been on screen? (hasSeen above is lenient when there's nothing to check.) */
  const isSeen = useCallback((key: string) => seen.current.has(key), [])

  /** Mark rows as reviewed without an element on screen (the phone view shows one shop's rows at a time). */
  const markSeen = useCallback((keys: string[]) => { for (const k of keys) seen.current.add(k) }, [])

  return { observe, hasSeen, isSeen, markSeen }
}
