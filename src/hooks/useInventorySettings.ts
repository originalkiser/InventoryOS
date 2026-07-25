import { useEffect } from 'react'
import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

// Per-company "relevance" filters for the inventory-health surfaces (Dashboard
// cards, Days of Supply, On Hand). Persisted in platform.app_settings. Kept in a
// shared store so every useInventory instance reacts the instant they change
// (useAppSetting only re-syncs on mount, which left sub-views stale).
export const ONLY_CONFIG_KEY = 'dashboard.onlyConfigProducts'
export const EXCLUDED_CATEGORIES_KEY = 'dashboard.excludedCategories'

const sb = supabase as any

function saveSetting(companyId: string, key: string, value: unknown) {
  void sb.schema('platform').from('app_settings')
    .upsert({ company_id: companyId, key, value, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' })
    .then(({ error }: any) => { if (error) console.warn('[InventorySettings] save failed:', error.message) })
}

interface InvSettingsStore {
  onlyConfig: boolean
  excludedCategories: string[]
  loadedFor: string | null
  load: (companyId: string) => void
  setOnlyConfig: (companyId: string, v: boolean) => void
  setExcludedCategories: (companyId: string, v: string[]) => void
}

const useStore = create<InvSettingsStore>((set) => ({
  onlyConfig: false,
  excludedCategories: [],
  loadedFor: null,
  load: (companyId) => {
    set({ loadedFor: companyId })
    sb.schema('platform').from('app_settings')
      .select('key, value').eq('company_id', companyId)
      .in('key', [ONLY_CONFIG_KEY, EXCLUDED_CATEGORIES_KEY])
      .then(({ data, error }: any) => {
        if (error) return
        const patch: Partial<InvSettingsStore> = {}
        for (const row of data ?? []) {
          if (row.key === ONLY_CONFIG_KEY) patch.onlyConfig = !!row.value
          if (row.key === EXCLUDED_CATEGORIES_KEY && Array.isArray(row.value)) patch.excludedCategories = row.value as string[]
        }
        set(patch)
      })
  },
  setOnlyConfig: (companyId, v) => { set({ onlyConfig: v }); saveSetting(companyId, ONLY_CONFIG_KEY, v) },
  setExcludedCategories: (companyId, v) => { set({ excludedCategories: v }); saveSetting(companyId, EXCLUDED_CATEGORIES_KEY, v) },
}))

export function useInventorySettings() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const onlyConfig = useStore((s) => s.onlyConfig)
  const excludedCategories = useStore((s) => s.excludedCategories)
  const loadedFor = useStore((s) => s.loadedFor)
  const load = useStore((s) => s.load)
  const setOnlyConfigRaw = useStore((s) => s.setOnlyConfig)
  const setExcludedCategoriesRaw = useStore((s) => s.setExcludedCategories)

  useEffect(() => {
    if (companyId && loadedFor !== companyId) load(companyId)
  }, [companyId, loadedFor, load])

  return {
    onlyConfig,
    excludedCategories,
    setOnlyConfig: (v: boolean) => { if (companyId) setOnlyConfigRaw(companyId, v) },
    setExcludedCategories: (v: string[]) => { if (companyId) setExcludedCategoriesRaw(companyId, v) },
  }
}
