import { useEffect, useRef, useState } from 'react'

// How often to re-check for a new deploy while the tab stays open.
const POLL_MS = 5 * 60 * 1000

// Fetch the deployed build id from version.json (written at build time). Returns
// null if it can't be read (e.g. in dev where the file isn't served).
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

// Wipe every Cache Storage entry so a stale service-worker/HTTP cache can't keep
// serving the old bundle, then hard-reload with a cache-busting query param.
async function forceUpdate() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    /* ignore — still reload below */
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
      // Only flag an update when we can read a concrete, different id.
      if (!cancelled && deployed && deployed !== runningId) setAvailable(true)
    }

    check()
    const interval = window.setInterval(check, POLL_MS)
    const onFocus = () => check()
    // visibilitychange catches backgrounded tabs that never fire 'focus'.
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
      <div className="flex items-center gap-3 rounded-lg border border-[#39ff14]/40 bg-[#161820] px-4 py-3 shadow-lg shadow-black/40">
        <span className="text-[#39ff14] text-base leading-none">●</span>
        <div className="font-mono text-xs text-gray-200">
          <div className="font-semibold text-white">Update available</div>
          <div className="text-gray-500">A newer version is ready.</div>
        </div>
        <button
          onClick={forceUpdate}
          className="ml-2 rounded border border-[#39ff14]/60 px-3 py-1.5 font-mono text-xs font-semibold text-[#39ff14] transition-colors hover:bg-[#39ff14]/10"
        >
          Update now
        </button>
        <button
          onClick={() => setAvailable(false)}
          className="rounded px-2 py-1.5 font-mono text-xs text-gray-500 transition-colors hover:text-gray-300"
          aria-label="Dismiss"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
