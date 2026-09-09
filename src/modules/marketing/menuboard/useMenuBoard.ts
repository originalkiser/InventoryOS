// Menu Board (Marketing) — package-to-price-column mapping, board layout
// (position/size per package), and price-per-extra-quart (company default +
// per-location override). See the migration's own header comment
// (20260910b_menu_board.sql) for how the price_column mapping was verified
// against a real board.

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

export interface MenuBoardPackage {
  id: string
  package_key: string
  display_name: string
  qualifier: string | null
  price_column: string | null
  sort_order: number
  active: boolean
  price_pos_x: number
  price_pos_y: number
  price_font_size: number
  quart_pos_x: number
  quart_pos_y: number
  quart_font_size: number
}

export function useMenuBoardPackages() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [packages, setPackages] = useState<MenuBoardPackage[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data, error } = await sb().schema('marketing').from('menu_board_packages')
      .select('*').eq('company_id', companyId).order('sort_order')
    if (!error) setPackages((data ?? []) as MenuBoardPackage[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const update = useCallback(async (id: string, patch: Partial<MenuBoardPackage>) => {
    // Optimistic — this is edited live while looking at the board (dragging
    // a position, nudging a font size), so waiting on a round trip before
    // reflecting it would feel laggy for something meant to be immediate.
    setPackages((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
    const { error } = await sb().schema('marketing').from('menu_board_packages')
      .update({ ...patch, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) { toast.error(`Couldn't save: ${error.message}`); await load(); return false }
    return true
  }, [profile?.id, load])

  return { packages, loading, update, reload: load }
}

export interface QuartPricingRow {
  id: string
  package_key: string
  price_per_quart: number | null
  included_quarts: number | null
}
export interface QuartOverrideRow extends QuartPricingRow {
  location_id: string
  notes: string | null
  updated_at: string
}

export function useMenuBoardQuartPricing() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [defaults, setDefaults] = useState<QuartPricingRow[]>([])
  const [overrides, setOverrides] = useState<QuartOverrideRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [d, o] = await Promise.all([
      sb().schema('marketing').from('menu_board_quart_defaults').select('*').eq('company_id', companyId),
      sb().schema('marketing').from('menu_board_quart_overrides').select('*').eq('company_id', companyId).order('updated_at', { ascending: false }),
    ])
    if (!d.error) setDefaults((d.data ?? []) as QuartPricingRow[])
    if (!o.error) setOverrides((o.data ?? []) as QuartOverrideRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const saveDefault = useCallback(async (packageKey: string, patch: { price_per_quart: number | null; included_quarts: number | null }) => {
    if (!companyId) return false
    const { error } = await sb().schema('marketing').from('menu_board_quart_defaults')
      .upsert({ company_id: companyId, package_key: packageKey, ...patch, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,package_key' })
    if (error) { toast.error(`Couldn't save default: ${error.message}`); return false }
    toast.success('Default saved')
    await load()
    return true
  }, [companyId, profile?.id, load])

  const saveOverride = useCallback(async (
    row: { id?: string; location_id: string; package_key: string; price_per_quart: number | null; included_quarts: number | null; notes: string | null },
  ) => {
    if (!companyId) return false
    const { error } = await sb().schema('marketing').from('menu_board_quart_overrides')
      .upsert({ ...row, company_id: companyId, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,location_id,package_key' })
    if (error) { toast.error(`Couldn't save override: ${error.message}`); return false }
    toast.success('Custom pricing saved')
    await load()
    return true
  }, [companyId, profile?.id, load])

  const removeOverride = useCallback(async (id: string) => {
    const { error } = await sb().schema('marketing').from('menu_board_quart_overrides').delete().eq('id', id)
    if (error) { toast.error(`Couldn't delete: ${error.message}`); return }
    setOverrides((prev) => prev.filter((r) => r.id !== id))
  }, [])

  // What a specific location actually charges per extra quart for a
  // package — its own override if one's been set, otherwise the company
  // default. Falls back to nulls (rendered as "—") rather than 0, since an
  // unset price is "not configured," not "free."
  const resolve = useCallback((locationId: string, packageKey: string): { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean } => {
    const o = overrides.find((r) => r.location_id === locationId && r.package_key === packageKey)
    if (o) return { pricePerQuart: o.price_per_quart, includedQuarts: o.included_quarts, isCustom: true }
    const d = defaults.find((r) => r.package_key === packageKey)
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [defaults, overrides])

  return { defaults, overrides, loading, saveDefault, saveOverride, removeOverride, resolve, reload: load }
}
