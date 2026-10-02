// Custom Packages — direct ask 2026-10-02, the per-shop package layout
// system intended to replace Custom Shop Config's JOB going forward (not
// its data — that feature's own tables/page are left untouched per
// explicit instruction). Bundled per PACKAGE (price, included quarts,
// price/quart, fees, casual items all on one row) rather than Custom Shop
// Config's per-FIELD shape, matching how a real custom arrangement is
// actually described ("this shop's Premium package is $X with 5 quarts
// included and a $2 supply fee" — one thing, not four separate fields).
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'

export interface CustomPackage {
  id: string
  location_id: string
  package_name: string
  internal_package_name: string | null
  price: number | null
  included_quarts: number | null
  price_per_quart: number | null
  supply_fee: number | null
  oil_inflation_surcharge: number | null
  sort_order: number
}

export interface CustomPackageCasualItem {
  id: string
  custom_package_id: string
  item_name: string
  price: number | null
  sort_order: number
}

const sb = () => supabase as any

export function useCustomPackages() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const [packages, setPackages] = useState<CustomPackage[]>([])
  const [casualItems, setCasualItems] = useState<CustomPackageCasualItem[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [pkgRes, itemRes] = await Promise.all([
      sb().schema('inventory').from('custom_packages').select('*').eq('company_id', companyId).order('sort_order'),
      sb().schema('inventory').from('custom_package_casual_items').select('*').eq('company_id', companyId).order('sort_order'),
    ])
    setPackages((pkgRes.data ?? []) as CustomPackage[])
    setCasualItems((itemRes.data ?? []) as CustomPackageCasualItem[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const packagesFor = useCallback((locationId: string) => packages.filter((p) => p.location_id === locationId), [packages])
  const casualItemsFor = useCallback((customPackageId: string) => casualItems.filter((i) => i.custom_package_id === customPackageId), [casualItems])
  // Distinct shop ids that already have at least one custom package — the
  // "Matches other shop" source list.
  const locationIdsWithPackages = Array.from(new Set(packages.map((p) => p.location_id)))

  async function addPackage(locationId: string, packageName: string): Promise<string | null> {
    if (!companyId) return null
    const maxSort = Math.max(0, ...packagesFor(locationId).map((p) => p.sort_order))
    const { data, error } = await sb().schema('inventory').from('custom_packages')
      .insert({ company_id: companyId, location_id: locationId, package_name: packageName, sort_order: maxSort + 1, created_by: userId, updated_by: userId })
      .select().single()
    if (error) { toast.error(error.message); return null }
    setPackages((prev) => [...prev, data as CustomPackage])
    return (data as CustomPackage).id
  }

  async function savePackage(id: string, patch: Partial<Omit<CustomPackage, 'id' | 'location_id'>>) {
    const { data, error } = await sb().schema('inventory').from('custom_packages')
      .update({ ...patch, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
      .select().single()
    if (error) { toast.error(error.message); return }
    setPackages((prev) => prev.map((p) => (p.id === id ? (data as CustomPackage) : p)))
  }

  async function deletePackage(id: string) {
    const { error } = await sb().schema('inventory').from('custom_packages').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setPackages((prev) => prev.filter((p) => p.id !== id))
    setCasualItems((prev) => prev.filter((i) => i.custom_package_id !== id))
  }

  async function addCasualItem(customPackageId: string, itemName: string) {
    if (!companyId) return
    const maxSort = Math.max(0, ...casualItemsFor(customPackageId).map((i) => i.sort_order))
    const { data, error } = await sb().schema('inventory').from('custom_package_casual_items')
      .insert({ company_id: companyId, custom_package_id: customPackageId, item_name: itemName, sort_order: maxSort + 1 })
      .select().single()
    if (error) { toast.error(error.message); return }
    setCasualItems((prev) => [...prev, data as CustomPackageCasualItem])
  }

  async function saveCasualItem(id: string, patch: Partial<Pick<CustomPackageCasualItem, 'item_name' | 'price'>>) {
    const { data, error } = await sb().schema('inventory').from('custom_package_casual_items').update(patch).eq('id', id).select().single()
    if (error) { toast.error(error.message); return }
    setCasualItems((prev) => prev.map((i) => (i.id === id ? (data as CustomPackageCasualItem) : i)))
  }

  async function deleteCasualItem(id: string) {
    const { error } = await sb().schema('inventory').from('custom_package_casual_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setCasualItems((prev) => prev.filter((i) => i.id !== id))
  }

  // "Matches other shop" — a ONE-TIME copy (fresh ids, independent rows),
  // not a live link: editing the source shop's packages afterward never
  // propagates to a shop that copied from it, matching "sometimes multiple
  // shops get the same layout" as a starting point, not an ongoing sync.
  async function cloneFromShop(sourceLocationId: string, targetLocationId: string) {
    if (!companyId) return
    const sourcePackages = packagesFor(sourceLocationId)
    if (!sourcePackages.length) { toast.error('That shop has no custom packages to copy'); return }
    for (const pkg of sourcePackages) {
      const { data: newPkg, error } = await sb().schema('inventory').from('custom_packages')
        .insert({
          company_id: companyId, location_id: targetLocationId, package_name: pkg.package_name,
          internal_package_name: pkg.internal_package_name, price: pkg.price, included_quarts: pkg.included_quarts,
          price_per_quart: pkg.price_per_quart, supply_fee: pkg.supply_fee, oil_inflation_surcharge: pkg.oil_inflation_surcharge,
          sort_order: pkg.sort_order, created_by: userId, updated_by: userId,
        })
        .select().single()
      if (error) { toast.error(`Copy failed: ${error.message}`); continue }
      const newPackage = newPkg as CustomPackage
      setPackages((prev) => [...prev, newPackage])
      const items = casualItemsFor(pkg.id)
      if (items.length) {
        const { data: newItems, error: itemErr } = await sb().schema('inventory').from('custom_package_casual_items')
          .insert(items.map((i) => ({ company_id: companyId, custom_package_id: newPackage.id, item_name: i.item_name, price: i.price, sort_order: i.sort_order })))
          .select()
        if (!itemErr) setCasualItems((prev) => [...prev, ...((newItems ?? []) as CustomPackageCasualItem[])])
      }
    }
    toast.success(`Copied ${sourcePackages.length} package(s)`)
  }

  return {
    loading, packages, casualItems,
    packagesFor, casualItemsFor, locationIdsWithPackages,
    addPackage, savePackage, deletePackage,
    addCasualItem, saveCasualItem, deleteCasualItem,
    cloneFromShop,
    reload: load,
  }
}
