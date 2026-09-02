// Generic per-browser cache backed by IndexedDB — native browser API, no
// dependency. Meant for "this exact query is expensive, and it's fine to
// show slightly-stale data for a little while so returning to a page
// doesn't have to re-run the full thing" cases (first user: Customer
// Heatmap's own order fetch). Private to whichever browser/device wrote
// it — never shared between users or devices, and gone if the user clears
// site data. Every call is best-effort: IndexedDB can throw in a private
// window or when blocked by browser settings, and a cache miss/failure
// should never be treated as an error by the caller — just fall through to
// the real fetch.

const DB_NAME = 'inventoryos-cache'
const STORE = 'kv'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

interface CacheEntry<T> { value: T; cachedAt: number }

/** Reads a cached value if present and younger than `maxAgeMs`. Never throws — a miss/error/expiry all just resolve to null. */
export async function getCached<T>(key: string, maxAgeMs: number): Promise<T | null> {
  try {
    const db = await openDb()
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => {
        const entry = req.result as CacheEntry<T> | undefined
        if (!entry || Date.now() - entry.cachedAt > maxAgeMs) { resolve(null); return }
        resolve(entry.value)
      }
      req.onerror = () => resolve(null)
    })
  } catch { return null }
}

/** Writes a value with the current time as its cache timestamp. Never throws — a write failure is silently ignored (worst case: next load just re-fetches). */
export async function setCached<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ value, cachedAt: Date.now() } as CacheEntry<T>, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    })
  } catch { /* best-effort */ }
}
