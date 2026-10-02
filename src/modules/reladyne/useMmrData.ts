// Supabase-facing hooks for the RelaDyne MMR page — fetch (scoped by a
// period range) and upload (chunked upsert with ignoreDuplicates, see
// migration 20260930by's own header comment for why "skip existing, only
// add new" is implemented this way instead of a custom RPC).
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { VolumeDataRow, ItemFillRow, OtifRow, CommitmentRow } from './mmrParsers'

const sb = () => supabase as any
const CHUNK = 500

async function upsertChunked<T extends object>(table: string, onConflict: string, rows: T[], companyId: string) {
  let inserted = 0
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, company_id: companyId }))
    const { error, count } = await sb().schema('inventory').from(table)
      .upsert(chunk, { onConflict, ignoreDuplicates: true, count: 'exact' })
    if (error) throw new Error(`${table}: ${error.message}`)
    // PostgREST's own count with ignoreDuplicates reflects rows actually
    // written (skipped duplicates don't count) — best-effort only, falls
    // back to the chunk size if the count comes back null for any reason.
    inserted += count ?? chunk.length
  }
  return inserted
}

export function useMmrUpload() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null

  const uploadVolumeData = useCallback(async (rows: VolumeDataRow[]) => {
    if (!companyId) throw new Error('No company on profile')
    return upsertChunked('reladyne_volume_data', 'company_id,customer_no,ship_to_code,product_code,period', rows, companyId)
  }, [companyId])

  const uploadItemFillStats = useCallback(async (rows: ItemFillRow[]) => {
    if (!companyId) throw new Error('No company on profile')
    return upsertChunked('reladyne_item_fill_stats', 'company_id,product_desc,period', rows, companyId)
  }, [companyId])

  const uploadOtifStats = useCallback(async (rows: OtifRow[]) => {
    if (!companyId) throw new Error('No company on profile')
    return upsertChunked('reladyne_otif_stats', 'company_id,segment,period', rows, companyId)
  }, [companyId])

  const uploadCommitment = useCallback(async (rows: CommitmentRow[]) => {
    if (!companyId) throw new Error('No company on profile')
    return upsertChunked('reladyne_volume_commitment', 'company_id,year,month', rows, companyId)
  }, [companyId])

  // Delete-all for the 2 tables affected by the blanket-year bug (direct ask
  // 2026-10-01) — lets a bad upload be cleared before re-importing with
  // correct per-month years, same "type REMOVE" ClearTableButton pattern
  // used elsewhere in the app. Volume Data/Commitment aren't offered here:
  // Volume Data has no year-assignment step to get wrong in the first
  // place, and Commitment reads its year straight from the source sheet.
  const clearItemFillStats = useCallback(async () => {
    if (!companyId) return
    await sb().schema('inventory').from('reladyne_item_fill_stats').delete().eq('company_id', companyId)
  }, [companyId])
  const clearOtifStats = useCallback(async () => {
    if (!companyId) return
    await sb().schema('inventory').from('reladyne_otif_stats').delete().eq('company_id', companyId)
  }, [companyId])

  return {
    uploadVolumeData, uploadItemFillStats, uploadOtifStats, uploadCommitment,
    clearItemFillStats, clearOtifStats, ready: !!companyId,
  }
}

// ── Fetch hooks — each loads its own table in full (all of these are small/
// moderate at real volume: tens of thousands of rows at most for volume
// data after a couple of years, a few hundred for the other three) and
// lets the tab component do its own client-side grouping/filtering. ───────

interface VolumeDataDb extends VolumeDataRow { id: string }
export function useReladyneVolumeData() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<VolumeDataDb[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setRows([]); setLoading(false); return }
    setLoading(true)
    const PAGE = 1000
    const out: VolumeDataDb[] = []
    let from = 0
    for (;;) {
      const { data, error } = await sb().schema('inventory').from('reladyne_volume_data')
        .select('id, customer_name, customer_no, ship_to_name, ship_to_code, product_code, product_desc, package_group, gallons_ordered, gallons_billed, revenue, revenue_per_gallon, period, store_type, year')
        .eq('company_id', companyId).order('period', { ascending: true }).range(from, from + PAGE - 1)
      if (error || !data || data.length === 0) break
      out.push(...(data as VolumeDataDb[]))
      if (data.length < PAGE) break
      from += PAGE
    }
    setRows(out)
    setLoading(false)
  }, [companyId])

  useEffect(() => { reload() }, [reload])
  return { rows, loading, reload }
}

interface ItemFillDb extends ItemFillRow { id: string }
export function useReladyneItemFillStats() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<ItemFillDb[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setRows([]); setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('reladyne_item_fill_stats')
      .select('id, product_desc, period, order_count, fill_count, item_fill_pct')
      .eq('company_id', companyId).order('period', { ascending: true })
    setRows((data ?? []) as ItemFillDb[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { reload() }, [reload])
  return { rows, loading, reload }
}

interface OtifDb extends OtifRow { id: string }
export function useReladyneOtifStats() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<OtifDb[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setRows([]); setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('reladyne_otif_stats')
      .select('id, segment, period, otif_pct, on_time_pct, in_full_pct')
      .eq('company_id', companyId).order('period', { ascending: true })
    setRows((data ?? []) as OtifDb[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { reload() }, [reload])
  return { rows, loading, reload }
}

interface CommitmentDb extends CommitmentRow { id: string }
export function useReladyneVolumeCommitment() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<CommitmentDb[]>([])
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setRows([]); setLoading(false); return }
    setLoading(true)
    const { data } = await sb().schema('inventory').from('reladyne_volume_commitment')
      .select('id, year, month, period, volume_commitment_gal, volume_actual_gal, pct')
      .eq('company_id', companyId).order('period', { ascending: true })
    setRows((data ?? []) as CommitmentDb[])
    setLoading(false)
  }, [companyId])

  useEffect(() => { reload() }, [reload])
  return { rows, loading, reload }
}

// Explicit per-product Bulk/Package/Drum overrides for the Product Gallons
// tab (migration 20260930cd) — absence of a row means "use the default".
export function useReladyneProductGroupMap() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [overrides, setOverrides] = useState<Map<string, 'bulk' | 'package' | 'drum'>>(new Map())
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const { data } = await sb().schema('inventory').from('reladyne_product_group_map')
      .select('product_desc, group_key').eq('company_id', companyId)
    setOverrides(new Map((data ?? []).map((r: { product_desc: string; group_key: 'bulk' | 'package' | 'drum' }) => [r.product_desc, r.group_key])))
    setLoading(false)
  }, [companyId])
  useEffect(() => { reload() }, [reload])

  async function setGroup(productDesc: string, group: 'bulk' | 'package' | 'drum' | null) {
    if (!companyId) return
    if (group == null) {
      const { error } = await sb().schema('inventory').from('reladyne_product_group_map')
        .delete().eq('company_id', companyId).eq('product_desc', productDesc)
      if (error) throw new Error(error.message)
      setOverrides((prev) => { const n = new Map(prev); n.delete(productDesc); return n })
      return
    }
    const { error } = await sb().schema('inventory').from('reladyne_product_group_map')
      .upsert({ company_id: companyId, product_desc: productDesc, group_key: group, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() },
        { onConflict: 'company_id,product_desc' })
    if (error) throw new Error(error.message)
    setOverrides((prev) => new Map(prev).set(productDesc, group))
  }

  return { overrides, loading, setGroup, reload }
}
