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

interface RecentPagesState extends Persisted {
  // True for the one recordVisit() call that follows a goBack/goForward —
  // the stack already reflects that move, so it must not be treated as a
  // fresh visit (which would trim "forward" history and push a duplicate).
  navigatingViaStack: boolean
  recordVisit: (path: string, label: string) => void
  goBack: () => string | null
  goForward: () => string | null
}

export const useRecentPagesStore = create<RecentPagesState>((set, get) => ({
  ...loadPersisted(),
  navigatingViaStack: false,

  recordVisit: (path, label) => {
    const { navigatingViaStack, recentPages, visitStack, visitCursor } = get()
    if (navigatingViaStack) {
      set({ navigatingViaStack: false })
      return
    }

    const nextRecent = recentPages[0]?.path === path
      ? [{ path, label, visitedAt: Date.now() }, ...recentPages.slice(1)]
      : [{ path, label, visitedAt: Date.now() }, ...recentPages].slice(0, MAX_ENTRIES)

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
    set({ visitCursor: nextCursor, navigatingViaStack: true })
    savePersisted({ recentPages: get().recentPages, visitStack, visitCursor: nextCursor })
    return visitStack[nextCursor]
  },

  goForward: () => {
    const { visitStack, visitCursor } = get()
    if (visitCursor >= visitStack.length - 1) return null
    const nextCursor = visitCursor + 1
    set({ visitCursor: nextCursor, navigatingViaStack: true })
    savePersisted({ recentPages: get().recentPages, visitStack, visitCursor: nextCursor })
    return visitStack[nextCursor]
  },
}))
