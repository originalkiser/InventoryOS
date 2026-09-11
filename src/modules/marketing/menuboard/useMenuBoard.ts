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
    if (error) toast.error(`Menu board packages didn't load: ${error.message}`)
    else setPackages((data ?? []) as MenuBoardPackage[])
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
// One row per shop (not per package) — but that row holds a price per
// PACKAGE (package_key -> price_per_quart), so a shop can customize any
// subset of its packages without needing a separate row for each. A
// package_key absent from `prices` just uses that package's company
// default. Included quarts stays a company-wide constant per package
// (QuartPricingRow above), never shop-customizable.
export interface QuartOverrideRow {
  id: string
  location_id: string
  prices: Record<string, number>
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
    if (d.error) toast.error(`Quart pricing didn't load: ${d.error.message}`)
    else setDefaults((d.data ?? []) as QuartPricingRow[])
    if (o.error) toast.error(`Custom quart pricing didn't load: ${o.error.message}`)
    else setOverrides((o.data ?? []) as QuartOverrideRow[])
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
    row: { id?: string; location_id: string; prices: Record<string, number | null | undefined>; notes: string | null },
  ) => {
    if (!companyId) return false
    // Drop null/undefined entries — a blank price means "no override for
    // that package" (falls back to the default), not "override to null."
    const prices = Object.fromEntries(Object.entries(row.prices).filter(([, v]) => v != null))
    const { error } = await sb().schema('marketing').from('menu_board_quart_overrides')
      .upsert({ location_id: row.location_id, notes: row.notes, prices, company_id: companyId, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,location_id' })
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
  // package — that shop's own override price for THIS package if it has
  // one, otherwise the company default for the package. Included quarts
  // always comes from the package's company default, since it's never
  // shop-customizable. Falls back to nulls (rendered as "—") rather than 0,
  // since an unset price is "not configured," not "free."
  const resolve = useCallback((locationId: string, packageKey: string): { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean } => {
    const d = defaults.find((r) => r.package_key === packageKey)
    const customPrice = overrides.find((r) => r.location_id === locationId)?.prices?.[packageKey]
    if (customPrice != null) return { pricePerQuart: customPrice, includedQuarts: d?.included_quarts ?? null, isCustom: true }
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [defaults, overrides])

  return { defaults, overrides, loading, saveDefault, saveOverride, removeOverride, resolve, reload: load }
}
