// One model of "what can this user navigate to", shared by the sidebar search, the top-bar mega menu and the floating dock — same visibility
// rules as the sidebar itself (department access, hidden sections, admin-only config) and the user's own item order.
import { useMemo } from 'react'
import { useAuthStore } from '@/stores/authStore'
import { useDeptAccess } from '@/hooks/useDeptAccess'
import { useProfilePref } from '@/hooks/useProfilePrefs'
import { useSidebarPrefs } from '@/hooks/useSidebarPrefs'
import { isAdminOrDeveloper } from '@/lib/roles'
import { SECTION_ITEMS, SECTION_META, UTILITY_ITEMS, type NavItem } from './navData'
import { NAV_META, SECTION_BLURB } from './navMeta'

export const HOME_ITEM: NavItem = { key: 'home', label: 'Home', to: '/home' }

export interface NavSection { key: string; label: string; blurb: string; items: NavItem[] }
export interface NavEntry {
  id: string
  kind: 'page' | 'action'
  label: string
  /** Section the page lives in ("Shortcuts" for the utility pages, "Actions" for actions). */
  group: string
  desc: string
  to: string | null
  /** For an action: what to do (handled by the component that renders the results). */
  action?: string
  itemKey?: string
  search: string
}

export function useNavModel() {
  const { profile } = useAuthStore()
  const isAdmin = isAdminOrDeveloper(profile?.role)
  const allowed = useDeptAccess()
  const [hiddenSections] = useProfilePref<string[]>('sidebar:hiddenSections', [])
  const { sectionOrder, itemOrder } = useSidebarPrefs()

  const sections = useMemo<NavSection[]>(() => {
    const out: NavSection[] = []
    for (const k of sectionOrder) {
      if (hiddenSections.includes(k)) continue
      if (k === 'global-config' && !isAdmin) continue
      if (k !== 'global-config' && allowed !== null && !allowed.has(k)) continue
      const base = (SECTION_ITEMS[k] ?? []).filter((i) => i.to)
      const saved = itemOrder[k] ?? []
      const items = saved.length
        ? [...saved.map((key) => base.find((i) => i.key === key)).filter((i): i is NavItem => !!i), ...base.filter((i) => !saved.includes(i.key))]
        : base
      if (items.length) out.push({ key: k, label: SECTION_META[k]?.label ?? k, blurb: SECTION_BLURB[k] ?? '', items })
    }
    return out
  }, [sectionOrder, itemOrder, hiddenSections, isAdmin, allowed])

  const utility = useMemo(() => UTILITY_ITEMS.filter((i) => i.to), [])

  const entries = useMemo<NavEntry[]>(() => {
    const out: NavEntry[] = []
    const add = (i: NavItem, group: string) => {
      const m = NAV_META[i.key]
      out.push({ id: `page:${i.key}`, kind: 'page', label: i.label, group, desc: m?.desc ?? '', to: i.to, itemKey: i.key, search: `${i.label} ${group} ${m?.desc ?? ''} ${m?.kw ?? ''}`.toLowerCase() })
    }
    add(HOME_ITEM, 'Start')
    for (const s of sections) for (const i of s.items) add(i, s.label)
    for (const i of utility) add(i, 'Shortcuts')
    return out
  }, [sections, utility])

  return { sections, utility, entries }
}

export const NAV_ACTIONS: NavEntry[] = [
  { id: 'act:tasks', kind: 'action', label: "Today's Tasks panel", group: 'Actions', desc: 'Open your tasks beside the page', to: null, action: 'tasks', search: "today's tasks panel todo" },
  { id: 'act:lookup', kind: 'action', label: 'Location Lookup panel', group: 'Actions', desc: 'Look up a shop without leaving this page', to: null, action: 'lookup', search: 'location lookup panel shop' },
  { id: 'act:meeting', kind: 'action', label: 'Quick Meeting panel', group: 'Actions', desc: 'Jot down meeting notes', to: null, action: 'meeting', search: 'quick meeting notes panel' },
  { id: 'act:inventory', kind: 'action', label: 'Inventory panel', group: 'Actions', desc: 'Quick inventory view beside the page', to: null, action: 'inventory', search: 'inventory panel on hand' },
  { id: 'act:dark', kind: 'action', label: 'Switch light / dark mode', group: 'Actions', desc: 'Toggle the app theme', to: null, action: 'dark', search: 'dark mode light theme appearance' },
]

/** Pages (and optionally actions) matching a query, best matches first. Every word must match somewhere. */
export function searchNav(entries: NavEntry[], query: string, limit = 14): NavEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const scored: { e: NavEntry; score: number }[] = []
  for (const e of entries) {
    if (!words.every((w) => e.search.includes(w))) continue
    const label = e.label.toLowerCase()
    let score = 0
    for (const w of words) {
      if (label === w) score += 100
      else if (label.startsWith(w)) score += 60
      else if (label.split(/[\s/-]+/).some((p) => p.startsWith(w))) score += 40
      else if (label.includes(w)) score += 25
      else if (e.group.toLowerCase().includes(w)) score += 10
      else score += 4
    }
    scored.push({ e, score })
  }
  return scored.sort((a, b) => b.score - a.score || a.e.label.localeCompare(b.e.label)).slice(0, limit).map((s) => s.e)
}
