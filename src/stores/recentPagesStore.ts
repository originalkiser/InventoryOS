import { create } from 'zustand'

// Recent Pages navigation state — a fixed-order ring of up to 3 distinct
// recently-visited pages (matches KeepAlivePages.tsx's own MAX_CACHED_PAGES,
// so a page shown here is guaranteed to still be warm in the keep-alive
// cache). Alt+Left/Alt+Right cycle this ring directly (circularly) rather
// than walking a separate linear browser-history stack — there is no linear
// stack anymore. Persisted to sessionStorage (per-device, per-tab-session) —
// this is ephemeral browsing history, not a cross-device preference, so it
// doesn't belong in user_sidebar_prefs.
//
// Order rule (2026-09-23, explicit ask): the ring's ORDER only changes when
// a genuinely new page (not already one of the tracked entries) is visited.
// Re-visiting or cycling to an already-tracked page — via Alt+arrow, via
// clicking its button, or via an ordinary sidebar click that happens to land
// on one of the 3 — never reorders the ring, it only updates which entry is
// "active."

export interface RecentPageEntry {
  path: string
  label: string
  visitedAt: number
}

const STORAGE_KEY = 'sbnet:recentPages'
const MAX_ENTRIES = 3

interface Persisted {
  recentPages: RecentPageEntry[]
  activePath: string | null
}

function loadPersisted(): Persisted {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && Array.isArray(v.recentPages)) {
        return { recentPages: v.recentPages, activePath: typeof v.activePath === 'string' ? v.activePath : null }
      }
    }
  } catch { /* ignore */ }
  return { recentPages: [], activePath: null }
}

function savePersisted(state: Persisted) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

// Set on every successful cycleRecent/recordJump — RecentPagesWidget watches
// this to auto-reveal itself, pin open, and pick a highlight direction;
// AppShell watches it too, to decide whether the page content itself should
// swipe in (only for navigation through this widget/hotkeys, not an
// ordinary sidebar click). `at` changes on every call (even repeated
// same-direction presses) so effects fire every time, not just once.
export interface LastCycleNav {
  path: string
  direction: 'left' | 'right' | 'jump'
  at: number
}

interface RecentPagesState extends Persisted {
  lastCycleNav: LastCycleNav | null
  recordVisit: (path: string, label: string) => void
  // Moves one step around the ring from the current active page, wrapping
  // circularly. Returns the target path for the caller to navigate() to, or
  // null if there's nothing to cycle to (0 or 1 tracked pages).
  cycleRecent: (direction: 'left' | 'right') => string | null
  // Clicking a specific page button directly — not a cycle step, just "go
  // here" — but still worth the same reveal/pin treatment.
  recordJump: (path: string) => void
}

export const useRecentPagesStore = create<RecentPagesState>((set, get) => ({
  ...loadPersisted(),
  lastCycleNav: null,

  recordVisit: (path, label) => {
    const { recentPages } = get()
    const existingIdx = recentPages.findIndex((p) => p.path === path)
    const nextRecent =
      existingIdx !== -1
        // Already tracked — refresh its timestamp only, keep its position.
        ? recentPages.map((p, i) => (i === existingIdx ? { ...p, visitedAt: Date.now() } : p))
        // Genuinely new — insert at front, evict the oldest past MAX_ENTRIES.
        : [{ path, label, visitedAt: Date.now() }, ...recentPages].slice(0, MAX_ENTRIES)

    const next: Persisted = { recentPages: nextRecent, activePath: path }
    savePersisted(next)
    set(next)
  },

  cycleRecent: (direction) => {
    const { recentPages, activePath } = get()
    if (recentPages.length < 2) return null
    const curIdx = recentPages.findIndex((p) => p.path === activePath)
    const from = curIdx === -1 ? 0 : curIdx
    const delta = direction === 'right' ? 1 : -1
    const nextIdx = (from + delta + recentPages.length) % recentPages.length
    const path = recentPages[nextIdx].path
    set({ lastCycleNav: { path, direction, at: Date.now() } })
    return path
  },

  recordJump: (path) => set({ lastCycleNav: { path, direction: 'jump', at: Date.now() } }),
}))
