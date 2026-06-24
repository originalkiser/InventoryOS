import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

export const DEFAULT_SECTION_ORDER = ['inventory', 'global-config', 'operations', 'finance', 'accounting', 'marketing']
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
    await sb.schema('core').from('user_sidebar_prefs').upsert({
      user_id: userId,
      updated_at: new Date().toISOString(),
      ...data,
    })
  } catch {
    // table may not exist yet during migration window — silent fail
  }
}

export function useSidebarPrefs() {
  const { user } = useAuthStore()
  const [prefs, setPrefs] = useState<SidebarPrefs>(DEFAULT_PREFS)

  useEffect(() => {
    if (!user) return
    const sb = supabase as any
    sb.schema('core').from('user_sidebar_prefs')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }: any) => {
        if (!data) return
        setPrefs({
          sectionOrder: data.section_order?.length
            ? [...new Set([...DEFAULT_SECTION_ORDER, ...data.section_order])]
            : DEFAULT_SECTION_ORDER,
          sectionCollapsed: { marketing: true, ...data.section_collapsed },
          itemOrder: data.item_order ?? {},
          favorites: data.favorites ?? [],
          utilityNavOrder: data.utility_nav_order?.length ? data.utility_nav_order : DEFAULT_UTILITY_ORDER,
        })
      })
      .catch(() => {})
  }, [user?.id])

  const setSectionOrder = useCallback((sectionOrder: string[]) => {
    setPrefs((p) => ({ ...p, sectionOrder }))
    if (user) upsertPrefs(user.id, { section_order: sectionOrder })
  }, [user])

  const toggleSection = useCallback((key: string) => {
    setPrefs((p) => {
      const sectionCollapsed = { ...p.sectionCollapsed, [key]: !p.sectionCollapsed[key] }
      if (user) upsertPrefs(user.id, { section_collapsed: sectionCollapsed })
      return { ...p, sectionCollapsed }
    })
  }, [user])

  const toggleFavorite = useCallback((itemKey: string) => {
    setPrefs((p) => {
      const favorites = p.favorites.includes(itemKey)
        ? p.favorites.filter((k) => k !== itemKey)
        : [...p.favorites, itemKey]
      if (user) upsertPrefs(user.id, { favorites })
      return { ...p, favorites }
    })
  }, [user])

  const setFavoritesOrder = useCallback((favorites: string[]) => {
    setPrefs((p) => ({ ...p, favorites }))
    if (user) upsertPrefs(user.id, { favorites })
  }, [user])

  const setUtilityNavOrder = useCallback((utilityNavOrder: string[]) => {
    setPrefs((p) => ({ ...p, utilityNavOrder }))
    if (user) upsertPrefs(user.id, { utility_nav_order: utilityNavOrder })
  }, [user])

  const setItemOrder = useCallback((sectionKey: string, items: string[]) => {
    setPrefs((p) => {
      const itemOrder = { ...p.itemOrder, [sectionKey]: items }
      if (user) upsertPrefs(user.id, { item_order: itemOrder })
      return { ...p, itemOrder }
    })
  }, [user])

  return {
    sectionOrder: prefs.sectionOrder,
    sectionCollapsed: prefs.sectionCollapsed,
    itemOrder: prefs.itemOrder,
    favorites: prefs.favorites,
    utilityNavOrder: prefs.utilityNavOrder,
    setSectionOrder,
    toggleSection,
    toggleFavorite,
    setFavoritesOrder,
    setUtilityNavOrder,
    setItemOrder,
  }
}
