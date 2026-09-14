// Custom Shop Config — the per-shop exceptions that don't fit anywhere
// else: a shop with its own price-per-quart, its own included-quarts
// count, a custom shop supply fee, an oil inflation surcharge, etc. Field
// *types* (custom_shop_config_fields) are admin-extensible — "create-able
// dropdown options" — rather than a fixed column set; each shop then gets
// a value per field it actually has a custom arrangement for, plus which
// Menu Board package(s) that arrangement applies to. See the migration's
// own header comment (20260919b_custom_shop_config.sql) for the full shape.

import { useCallback, useEffect, useMemo, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

export type FieldValueKind = 'currency' | 'number' | 'percent' | 'text'
export const VALUE_KIND_LABELS: Record<FieldValueKind, string> = {
  currency: 'Currency ($)', number: 'Number', percent: 'Percent (%)', text: 'Text',
}

export interface CustomShopConfigField {
  id: string
  name: string
  value_kind: FieldValueKind
  sort_order: number
  active: boolean
  // Price Per Quart/Included Quarts vary by which package a shop's custom
  // pricing is flagged for (a shop can price two packages' oil
  // differently) — Shop Supply Fee/Oil Inflation Surcharge don't, they're
  // one value for the whole shop regardless of how many packages are
  // flagged. See migration 20260930m for the full reasoning.
  per_package: boolean
}
export interface CustomShopConfigValue {
  id: string
  location_id: string
  field_id: string
  // '' for a shop-wide field's value; set to one of the shop's flagged
  // package keys for a per_package field's own per-package value. NOT NULL
  // in the DB (see migration 20260930m for why an empty-string sentinel
  // was used instead of a nullable column).
  package_key: string
  value: string | null
  notes: string | null
}
export interface CustomShopConfigPackage {
  id: string
  location_id: string
  package_key: string
  notes: string | null
}

/** Format a stored value per its field's kind, for display in a summary list. */
export function formatFieldValue(value: string | null, kind: FieldValueKind): string {
  if (value == null || value === '') return '—'
  if (kind === 'currency') { const n = Number(value); return Number.isFinite(n) ? `$${n.toFixed(2)}` : value }
  if (kind === 'percent') { const n = Number(value); return Number.isFinite(n) ? `${n}%` : value }
  return value
}

export function useCustomShopConfig() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [fields, setFields] = useState<CustomShopConfigField[]>([])
  const [values, setValues] = useState<CustomShopConfigValue[]>([])
  const [packages, setPackages] = useState<CustomShopConfigPackage[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [f, v, p] = await Promise.all([
      sb().schema('inventory').from('custom_shop_config_fields').select('*').eq('company_id', companyId).order('sort_order'),
      sb().schema('inventory').from('custom_shop_config_values').select('*').eq('company_id', companyId),
      sb().schema('inventory').from('custom_shop_config_packages').select('*').eq('company_id', companyId),
    ])
    const err = f.error || v.error || p.error
    if (err) toast.error(`Custom shop config didn't load: ${err.message}`)
    if (!f.error) setFields((f.data ?? []) as CustomShopConfigField[])
    if (!v.error) setValues((v.data ?? []) as CustomShopConfigValue[])
    if (!p.error) setPackages((p.data ?? []) as CustomShopConfigPackage[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const addField = useCallback(async (name: string, value_kind: FieldValueKind, per_package: boolean) => {
    if (!companyId) return false
    const trimmed = name.trim()
    if (!trimmed) return false
    const maxOrder = fields.reduce((m, f) => Math.max(m, f.sort_order), 0)
    const { error } = await sb().schema('inventory').from('custom_shop_config_fields')
      .insert({ company_id: companyId, name: trimmed, value_kind, per_package, sort_order: maxOrder + 1, created_by: profile?.id ?? null })
    if (error) { toast.error(error.message); return false }
    toast.success('Field type added')
    await load()
    return true
  }, [companyId, fields, profile?.id, load])

  const removeField = useCallback(async (id: string) => {
    // Cascades to every shop's stored value for this field (ON DELETE
    // CASCADE) — matches "delete the column, its data goes with it".
    const { error } = await sb().schema('inventory').from('custom_shop_config_fields').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success('Field type removed')
    await load()
  }, [load])

  /**
   * Clearing a value (null/empty) removes the row — the custom list is just
   * every row that exists. packageKey is a real package key for a
   * per_package field (one row per flagged package) and left at its '''
   * default for a shop-wide field (one row for the whole shop) — the
   * unique constraint (company_id, location_id, field_id, package_key) is
   * what makes both shapes upsert correctly through the same onConflict
   * target.
   */
  const setValue = useCallback(async (locationId: string, fieldId: string, value: string | null, packageKey: string = '') => {
    if (!companyId) return false
    if (value == null || value.trim() === '') {
      const existing = values.find((x) => x.location_id === locationId && x.field_id === fieldId && x.package_key === packageKey)
      if (existing) {
        const { error } = await sb().schema('inventory').from('custom_shop_config_values').delete().eq('id', existing.id)
        if (error) { toast.error(error.message); return false }
      }
      return true
    }
    const { error } = await sb().schema('inventory').from('custom_shop_config_values')
      .upsert(
        { company_id: companyId, location_id: locationId, field_id: fieldId, package_key: packageKey, value: value.trim(), updated_by: profile?.id ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'company_id,location_id,field_id,package_key' },
      )
    if (error) { toast.error(error.message); return false }
    return true
  }, [companyId, values, profile?.id])

  const togglePackage = useCallback(async (locationId: string, packageKey: string, on: boolean) => {
    if (!companyId) return false
    if (!on) {
      const existing = packages.find((x) => x.location_id === locationId && x.package_key === packageKey)
      if (existing) {
        const { error } = await sb().schema('inventory').from('custom_shop_config_packages').delete().eq('id', existing.id)
        if (error) { toast.error(error.message); return false }
      }
      return true
    }
    const { error } = await sb().schema('inventory').from('custom_shop_config_packages')
      .upsert({ company_id: companyId, location_id: locationId, package_key: packageKey, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'company_id,location_id,package_key' })
    if (error) { toast.error(error.message); return false }
    return true
  }, [companyId, packages, profile?.id])

  // Every shop with at least one custom value or flagged package — same
  // "the custom list IS every row that exists" shape as the Menu Board's
  // Custom Pricing tab and ov2_product_exceptions.
  const customLocationIds = useMemo(() => new Set([
    ...values.map((v) => v.location_id),
    ...packages.map((p) => p.location_id),
  ]), [values, packages])

  const valuesFor = useCallback((locationId: string) => values.filter((v) => v.location_id === locationId), [values])
  const packagesFor = useCallback((locationId: string) => packages.filter((p) => p.location_id === locationId), [packages])

  return {
    fields, values, packages, loading,
    addField, removeField, setValue, togglePackage,
    customLocationIds, valuesFor, packagesFor,
    reload: load,
  }
}

/**
 * Package options for the "which package(s)" checklist — Menu Board's own
 * package registry (marketing.menu_board_packages) UNIONED with every
 * package Package Mapping has classified as Oil Change
 * (inventory.droptop_package_classification). Originally Menu Board only,
 * which meant only the ~5 canonical menu tiers were selectable — Package
 * Mapping's oil-change list is the more complete, current one (it also
 * covers the cryptic legacy SKU codes and "<Tier> Oil Change - <oil type>"
 * naming eras Menu Board never listed; see that migration's own comment).
 * Deduped by normalized display name so a package present in both (e.g.
 * "Economy") doesn't show up twice — the Menu Board entry wins on a
 * collision since its package_key is the nicer, curated one; a Package-
 * Mapping-only entry is keyed by its own raw name instead (this column has
 * always been a loose text tag, never a hard FK to menu_board_packages, so
 * mixing key spaces here is safe).
 */
export function useCustomShopConfigPackageOptions() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [menuBoard, setMenuBoard] = useState<{ package_key: string; display_name: string }[]>([])
  const [oilChangeNames, setOilChangeNames] = useState<string[]>([])

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    sb().schema('marketing').from('menu_board_packages')
      .select('package_key, display_name').eq('company_id', companyId).eq('active', true).order('sort_order')
      .then(({ data, error }: any) => { if (!cancelled && !error) setMenuBoard((data ?? []) as { package_key: string; display_name: string }[]) })
    sb().schema('inventory').from('droptop_package_classification')
      .select('package_name').eq('company_id', companyId).eq('classification', 'oil_change')
      .then(({ data, error }: any) => { if (!cancelled && !error) setOilChangeNames((data ?? []).map((r: { package_name: string }) => r.package_name)) })
    return () => { cancelled = true }
  }, [companyId])

  return useMemo(() => {
    const seen = new Set(menuBoard.map((p) => p.display_name.trim().toLowerCase()))
    const extra = oilChangeNames
      .filter((name) => !seen.has(name.trim().toLowerCase()))
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ package_key: name, display_name: name }))
    return [...menuBoard, ...extra]
  }, [menuBoard, oilChangeNames])
}
