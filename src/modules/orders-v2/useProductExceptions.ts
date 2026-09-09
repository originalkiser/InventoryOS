// Orders v2 — shop+product exception rows (Config: floor & ceiling
// overrides). See ExceptionRow's own comment in useOrdersV2.ts for what
// floor/ceiling mean to the generation engine; this file is purely the CRUD
// layer the Product Exceptions page (and the Location Lookup config
// table's own Exception cell) use, plus the "which products are configured
// for this shop" lookup the dynamic Product dropdown needs.

import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { CeilingUnit } from './useOrdersV2'

const sb = () => supabase as any

export interface ProductExceptionRow {
  id: string
  location_id: string
  product_id: string
  floor_qty: number | null
  ceiling_qty: number | null
  ceiling_unit: CeilingUnit | null
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
    row: { id?: string; location_id: string; product_id: string; floor_qty: number | null; ceiling_qty: number | null; ceiling_unit: CeilingUnit | null; notes: string | null },
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

export interface ConfiguredProduct { product_id: string; uom: string | null }

/** Distinct products configured (location_order_config) for one shop, with each one's own UOM — feeds the Product dropdown's second stage and the ceiling-unit picker's "this product's own unit" option. */
export function useConfiguredProducts(locationId: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [products, setProducts] = useState<ConfiguredProduct[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!companyId || !locationId) { setProducts([]); return }
    let cancelled = false
    setLoading(true)
    sb().schema('inventory').from('location_order_config')
      .select('product_id, metadata').eq('company_id', companyId).eq('location_id', locationId)
      .then(({ data }: any) => {
        if (cancelled) return
        const byId = new Map<string, string | null>()
        for (const r of (data ?? []) as { product_id: string; metadata: Record<string, unknown> | null }[]) {
          if (!byId.has(r.product_id)) byId.set(r.product_id, ((r.metadata as any)?.uom ?? null) as string | null)
        }
        setProducts([...byId.entries()].map(([product_id, uom]) => ({ product_id, uom })).sort((a, b) => a.product_id.localeCompare(b.product_id)))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [companyId, locationId])

  return { products, loading }
}

// Title-cases a raw config UOM value ("case" -> "Case", "bay_box" -> "Bay
// Box") for display as the ceiling-unit picker's "this product's own unit"
// option — falls back to "Cases" when nothing's configured, so the option
// is never blank.
export function caseTypeLabel(rawUom: string | null | undefined): string {
  const trimmed = (rawUom ?? '').trim().replace(/_/g, ' ')
  if (!trimmed) return 'Cases'
  return trimmed.replace(/\b\w/g, (c) => c.toUpperCase())
}
