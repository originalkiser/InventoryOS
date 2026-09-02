import { useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

export const DEFAULT_SECTION_ORDER = ['inventory', 'droptop', 'data-connections', 'global-config', 'operations', 'finance', 'accounting', 'marketing']
export const DEFAULT_UTILITY_ORDER = ['calendar', 'issues', 'meetings', 'feature-requests', 'tasks']

interface SidebarPrefs {
  sectionOrder: string[]
  sectionCollapsed: Record<string, boolean>
  itemOrder: Record<string, string[]>
  favorites: string[]
  utilityNavOrder: string[]
}

const DEFAULT_PREFS: SidebarPrefs = {
  sectionOrder: DEFAULT_SECTION_ORDER,
  sectionCollapsed: { 'global-config': true, operations: true, finance: true, accounting: true, marketing: true },
  itemOrder: {},
  favorites: [],
  utilityNavOrder: DEFAULT_UTILITY_ORDER,
}

async function upsertPrefs(userId: string, data: Record<string, unknown>) {
  try {
    const sb = supabase as any
    const { error } = await sb.schema('core').from('user_sidebar_prefs').upsert(
      { user_id: userId, updated_at: new Date().toISOString(), ...data },
      { onConflict: 'user_id' },
    )
    if (error) console.warn('[SidebarPrefs] upsert error:', error)
  } catch (err) {
    console.warn('[SidebarPrefs] upsert exception:', err)
  }
}

// Shared store so prefs load ONCE per user. Previously this was per-hook state,
// so re-mounting the sidebar (expand from collapsed) re-fetched from defaults and
// briefly showed the wrong section-collapsed state before snapping to saved.
interface State extends SidebarPrefs {
  loadedFor: string | null
  userId: string | null
  load: (userId: string) => void
  setSectionOrder: (v: string[]) => void
  toggleSection: (key: string) => void
  toggleFavorite: (key: string) => void
  setFavoritesOrder: (v: string[]) => void
  setUtilityNavOrder: (v: string[]) => void
  setItemOrder: (sectionKey: string, items: string[]) => void
}

const useStore = create<State>((set, get) => ({
  ...DEFAULT_PREFS,
  loadedFor: null,
  userId: null,
  load: (userId) => {
    if (get().loadedFor === userId) return
    set({ loadedFor: userId, userId })
    const sb = supabase as any
    sb.schema('core').from('user_sidebar_prefs').select('*').eq('user_id', userId).maybeSingle()
      .then(({ data }: any) => {
        if (!data) return
        set({
          sectionOrder: data.section_order?.length
            ? [
                ...data.section_order.filter((k: string) => DEFAULT_SECTION_ORDER.includes(k)),
                ...DEFAULT_SECTION_ORDER.filter((k) => !data.section_order.includes(k)),
              ]
            : DEFAULT_SECTION_ORDER,
          sectionCollapsed: { marketing: true, ...data.section_collapsed },
          itemOrder: data.item_order ?? {},
          favorites: data.favorites ?? [],
          utilityNavOrder: data.utility_nav_order?.length ? data.utility_nav_order : DEFAULT_UTILITY_ORDER,
        })
      })
      .catch(() => {})
  },
  setSectionOrder: (sectionOrder) => { set({ sectionOrder }); const u = get().userId; if (u) upsertPrefs(u, { section_order: sectionOrder }) },
  toggleSection: (key) => { const sectionCollapsed = { ...get().sectionCollapsed, [key]: !get().sectionCollapsed[key] }; set({ sectionCollapsed }); const u = get().userId; if (u) upsertPrefs(u, { section_collapsed: sectionCollapsed }) },
  toggleFavorite: (itemKey) => { const cur = get().favorites; const favorites = cur.includes(itemKey) ? cur.filter((k) => k !== itemKey) : [...cur, itemKey]; set({ favorites }); const u = get().userId; if (u) upsertPrefs(u, { favorites }) },
  setFavoritesOrder: (favorites) => { set({ favorites }); const u = get().userId; if (u) upsertPrefs(u, { favorites }) },
  setUtilityNavOrder: (utilityNavOrder) => { set({ utilityNavOrder }); const u = get().userId; if (u) upsertPrefs(u, { utility_nav_order: utilityNavOrder }) },
  setItemOrder: (sectionKey, items) => { const itemOrder = { ...get().itemOrder, [sectionKey]: items }; set({ itemOrder }); const u = get().userId; if (u) upsertPrefs(u, { item_order: itemOrder }) },
}))

export function useSidebarPrefs() {
  const { user } = useAuthStore()
  useEffect(() => { if (user?.id) useStore.getState().load(user.id) }, [user?.id])
  const sectionOrder = useStore((s) => s.sectionOrder)
  const sectionCollapsed = useStore((s) => s.sectionCollapsed)
  const itemOrder = useStore((s) => s.itemOrder)
  const favorites = useStore((s) => s.favorites)
  const utilityNavOrder = useStore((s) => s.utilityNavOrder)
  const setSectionOrder = useStore((s) => s.setSectionOrder)
  const toggleSection = useStore((s) => s.toggleSection)
  const toggleFavorite = useStore((s) => s.toggleFavorite)
  const setFavoritesOrder = useStore((s) => s.setFavoritesOrder)
  const setUtilityNavOrder = useStore((s) => s.setUtilityNavOrder)
  const setItemOrder = useStore((s) => s.setItemOrder)
  return { sectionOrder, sectionCollapsed, itemOrder, favorites, utilityNavOrder, setSectionOrder, toggleSection, toggleFavorite, setFavoritesOrder, setUtilityNavOrder, setItemOrder }
}
