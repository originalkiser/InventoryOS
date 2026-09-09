// Orders v2 — shop+product exception rows (Config: floor & ceiling
// overrides). See ExceptionRow's own comment in useOrdersV2.ts for what
// floor/ceiling mean to the generation engine; this file is purely the CRUD
// layer the Product Exceptions page uses, plus the "which products are
// configured for this shop" lookup its dynamic dropdown needs.

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

export interface ProductExceptionRow {
  id: string
  location_id: string
  product_id: string
  floor_qty: number | null
  ceiling_qty: number | null
  ceiling_unit: 'cases' | 'gallons' | null
  notes: string | null
  updated_at: string
}

export function useProductExceptions() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<ProductExceptionRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data, error } = await sb().schema('inventory').from('ov2_product_exceptions')
      .select('id, location_id, product_id, floor_qty, ceiling_qty, ceiling_unit, notes, updated_at')
      .eq('company_id', companyId).order('updated_at', { ascending: false })
    if (!error) setRows((data ?? []) as ProductExceptionRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const save = useCallback(async (
    row: { id?: string; location_id: string; product_id: string; floor_qty: number | null; ceiling_qty: number | null; ceiling_unit: 'cases' | 'gallons' | null; notes: string | null },
  ) => {
    if (!companyId) return false
    const { error } = await sb().schema('inventory').from('ov2_product_exceptions')
      .upsert({
        ...row, company_id: companyId, updated_by: profile?.id ?? null, updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,location_id,product_id' })
    if (error) { toast.error(`Couldn't save: ${error.message}`); return false }
    toast.success('Exception saved')
    await load()
    return true
  }, [companyId, profile?.id, load])

  const remove = useCallback(async (id: string) => {
    const { error } = await sb().schema('inventory').from('ov2_product_exceptions').delete().eq('id', id)
    if (error) { toast.error(`Couldn't delete: ${error.message}`); return }
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  return { rows, loading, save, remove, reload: load }
}

/** Distinct products configured (location_order_config) for one shop — feeds the Product dropdown's second stage. */
export function useConfiguredProducts(locationId: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [products, setProducts] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!companyId || !locationId) { setProducts([]); return }
    let cancelled = false
    setLoading(true)
    sb().schema('inventory').from('location_order_config')
      .select('product_id').eq('company_id', companyId).eq('location_id', locationId)
      .then(({ data }: any) => {
        if (cancelled) return
        const distinct = [...new Set((data ?? []).map((r: { product_id: string }) => r.product_id))].sort()
        setProducts(distinct as string[])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [companyId, locationId])

  return { products, loading }
}
