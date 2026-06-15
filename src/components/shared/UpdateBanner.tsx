import { useEffect, useRef, useState } from 'react'

const POLL_MS = 5 * 60 * 1000

async function fetchDeployedBuildId(): Promise<string | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const json = (await res.json()) as { buildId?: string }
    return json.buildId ?? null
  } catch {
    return null
  }
}

async function forceUpdate() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore */
  }
  const url = new URL(window.location.href)
  url.searchParams.set('_v', String(Date.now()))
  window.location.replace(url.toString())
}

export function UpdateBanner() {
  const [available, setAvailable] = useState(false)
  const runningId = useRef(__APP_BUILD_ID__).current

  useEffect(() => {
    let cancelled = false

    async function check() {
      const deployed = await fetchDeployedBuildId()
      if (!cancelled && deployed && deployed !== runningId) setAvailable(true)
    }

    check()
    const interval = window.setInterval(check, POLL_MS)
    const onFocus = () => check()
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [runningId])

  if (!available) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] max-w-[92vw]">
      <div className="flex items-center gap-3 rounded-lg border-l-4 border-l-sky bg-navy px-4 py-3 shadow-lg">
        <div className="font-body text-xs text-cream">
          <div className="font-medium text-cream">Update available</div>
          <div className="text-cream/60">A newer version is ready.</div>
        </div>
        <button
          onClick={forceUpdate}
          className="ml-2 rounded bg-inky px-3 py-1.5 font-heading text-xs font-bold uppercase tracking-wide text-cream transition-colors hover:bg-sky hover:text-navy"
        >
          Update Now
        </button>
        <button
          onClick={() => setAvailable(false)}
          className="rounded px-2 py-1.5 font-body text-xs text-cream/40 transition-colors hover:text-cream"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
