import { useCallback, useEffect, useRef, useState } from 'react'

// Foreground (tab-open) desktop notifications via the Web Notification API.
// No backend / service worker — fired from the TopBar polling loop while SB Net
// is open. Per-type prefs + permission live per-device (localStorage), since a
// notification permission is inherently per-browser.

const PREFS_KEY = 'sbnet:notifications:prefs'
export const NOTIF_PROMPT_DISMISSED_KEY = 'sbnet:notifications:prompt-dismissed'

export type NotifType = 'eod' | 'tasks' | 'events'
export interface NotifPrefs {
  enabled: boolean
  types: Record<NotifType, boolean>
}
const DEFAULT_PREFS: NotifPrefs = { enabled: true, types: { eod: true, tasks: true, events: true } }

const canNotify = typeof window !== 'undefined' && 'Notification' in window

function loadPrefs(): NotifPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      return { enabled: p.enabled ?? true, types: { ...DEFAULT_PREFS.types, ...(p.types ?? {}) } }
    }
  } catch { /* ignore */ }
  return DEFAULT_PREFS
}

export function useNotifications() {
  const [permission, setPermission] = useState<NotificationPermission>(canNotify ? Notification.permission : 'denied')
  const [prefs, setPrefsState] = useState<NotifPrefs>(loadPrefs)

  // Mirror to refs so `notify` can stay a stable callback that always reads the
  // current permission/prefs (the TopBar intervals capture it once).
  const permRef = useRef(permission)
  useEffect(() => { permRef.current = permission }, [permission])
  const prefsRef = useRef(prefs)
  useEffect(() => { prefsRef.current = prefs }, [prefs])

  const setPrefs = useCallback((next: NotifPrefs) => {
    setPrefsState(next)
    prefsRef.current = next
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }, [])

  const requestPermission = useCallback(async (): Promise<NotificationPermission> => {
    if (!canNotify) return 'denied'
    try {
      const r = await Notification.requestPermission()
      setPermission(r)
      permRef.current = r
      return r
    } catch {
      return 'denied'
    }
  }, [])

  // Fire a desktop notification, deduped by `key` (once per key, ever — callers
  // include the date so daily notifications recur but never repeat same-day).
  const notify = useCallback((type: NotifType, key: string, title: string, opts?: { body?: string; onClick?: () => void }) => {
    if (!canNotify || permRef.current !== 'granted') return
    const p = prefsRef.current
    if (!p.enabled || !p.types[type]) return
    const dedupeKey = `sbnet:notified:${key}`
    try {
      if (localStorage.getItem(dedupeKey)) return
      localStorage.setItem(dedupeKey, '1')
    } catch { /* ignore */ }
    try {
      const n = new Notification(title, { body: opts?.body, tag: key })
      n.onclick = () => { try { window.focus() } catch { /* ignore */ } opts?.onClick?.(); n.close() }
    } catch { /* ignore */ }
  }, [])

  return { canNotify, permission, prefs, setPrefs, requestPermission, notify }
}
