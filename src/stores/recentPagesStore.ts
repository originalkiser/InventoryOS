import { create } from 'zustand'

// Recent Pages navigation state. Two related but distinct concepts:
//   - recentPages: the carousel's full list (deduped consecutive visits,
//     capped), used for jump-to-any-of-these browsing.
//   - visitStack + visitCursor: a linear back/forward path through actual
//     navigation, walked by Alt+Left / Alt+Right — same shape as browser
//     history, not the same thing as the carousel's page-of-3 pagination.
// Persisted to sessionStorage (per-device, per-tab-session) — this is
// ephemeral browsing history, not a cross-device preference, so it doesn't
// belong in user_sidebar_prefs.

export interface RecentPageEntry {
  path: string
  label: string
  visitedAt: number
}

const STORAGE_KEY = 'sbnet:recentPages'
const MAX_ENTRIES = 10

interface Persisted {
  recentPages: RecentPageEntry[]
  visitStack: string[]
  visitCursor: number
}

function loadPersisted(): Persisted {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      if (v && Array.isArray(v.recentPages) && Array.isArray(v.visitStack) && typeof v.visitCursor === 'number') {
        return v as Persisted
      }
    }
  } catch { /* ignore */ }
  return { recentPages: [], visitStack: [], visitCursor: -1 }
}

function savePersisted(state: Persisted) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* ignore */ }
}

// Set on every successful goBack/goForward — RecentPagesWidget watches this
// to auto-reveal itself, jump to the right page, and pick which direction
// to slide in from. `at` changes on every call (even repeated same-direction
// presses) so the widget's effect fires each time, not just on first press.
export interface LastStackNav {
  path: string
  direction: 'back' | 'forward'
  at: number
}

interface RecentPagesState extends Persisted {
  // True for the one recordVisit() call that follows a goBack/goForward —
  // the stack already reflects that move, so it must not be treated as a
  // fresh visit (which would trim "forward" history and push a duplicate).
  navigatingViaStack: boolean
  lastStackNav: LastStackNav | null
  recordVisit: (path: string, label: string) => void
  goBack: () => string | null
  goForward: () => string | null
}

export const useRecentPagesStore = create<RecentPagesState>((set, get) => ({
  ...loadPersisted(),
  navigatingViaStack: false,
  lastStackNav: null,

  recordVisit: (path, label) => {
    const { navigatingViaStack, recentPages, visitStack, visitCursor } = get()
    if (navigatingViaStack) {
      set({ navigatingViaStack: false })
      return
    }

    // De-dupe by path anywhere in the list (not just a repeated consecutive
    // visit) — revisiting a page after browsing elsewhere should move it to
    // the front, not add a second entry for the same page.
    const nextRecent = [
      { path, label, visitedAt: Date.now() },
      ...recentPages.filter((p) => p.path !== path),
    ].slice(0, MAX_ENTRIES)

    // Trim anything past the current cursor (browser-history semantics: a
    // fresh navigation from a rewound position discards the old "forward" path).
    const trimmed = visitStack.slice(0, visitCursor + 1)
    const nextStack = trimmed[trimmed.length - 1] === path ? trimmed : [...trimmed, path]
    const nextCursor = nextStack.length - 1

    const next: Persisted = { recentPages: nextRecent, visitStack: nextStack, visitCursor: nextCursor }
    savePersisted(next)
    set(next)
  },

  goBack: () => {
    const { visitStack, visitCursor } = get()
    if (visitCursor <= 0) return null
    const nextCursor = visitCursor - 1
    const path = visitStack[nextCursor]
    set({ visitCursor: nextCursor, navigatingViaStack: true, lastStackNav: { path, direction: 'back', at: Date.now() } })
    savePersisted({ recentPages: get().recentPages, visitStack, visitCursor: nextCursor })
    return path
  },

  goForward: () => {
    const { visitStack, visitCursor } = get()
    if (visitCursor >= visitStack.length - 1) return null
    const nextCursor = visitCursor + 1
    const path = visitStack[nextCursor]
    set({ visitCursor: nextCursor, navigatingViaStack: true, lastStackNav: { path, direction: 'forward', at: Date.now() } })
    savePersisted({ recentPages: get().recentPages, visitStack, visitCursor: nextCursor })
    return path
  },
}))
