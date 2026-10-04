// Runs the "possible VMI misses" check (see vmiMissCheck.ts) against live data and saves a small summary that the Inventory
// Alerts badge/page read, so they don't re-run the multi-query check themselves. Run after the afternoon Open Sales Order
// upload, or on demand.
import { useCallback, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useAppSetting } from '@/hooks/useAppSetting'
import { useGenerationData, buildGenerationInputs, useOrderSettings, isReladyne } from './useOrdersV2'
import { useVendors } from './useLookups'
import { daysOfSupply, nextDeliveryDate, resolveDeliveryDate } from './engine'
import { checkVmiMisses, isBulkPoNumber, type BulkOrderFact, type TimingMap, type VmiShop } from './vmiMissCheck'

const sb = () => supabase as any
export const VMI_MISS_KEY = 'vmi_miss_check_summary'
export const RD_TIMING_KEY = 'ov2_rd_distributor_timing'
const isoToday = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

export interface VmiMissSummary {
  date: string
  vendor_id: string | null
  count: number
  shops: { location_id: string; products: string[]; min_runway_days: number | null; next_delivery: string; warehouse_code: string | null }[]
  items: { location_id: string; product_id: string }[]
  checkedAt: string
}

export function useVmiMissCheck() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { fetchInputs } = useGenerationData()
  const { settings } = useOrderSettings()
  const vendors = useVendors()
  const [timing] = useAppSetting<TimingMap>(RD_TIMING_KEY, {})
  const [tankProductMap] = useAppSetting<Record<string, string>>('tank_product_map', {})
  const [running, setRunning] = useState(false)

  const run = useCallback(async (opts: { quiet?: boolean } = {}): Promise<VmiMissSummary | null> => {
    if (!companyId) return null
    const rd = vendors.options.find((o) => isReladyne(o.label))
    if (!rd) { if (!opts.quiet) toast.error('No RelaDyne vendor found'); return null }
    setRunning(true)
    try {
      const { configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, exceptions, days, schedules, calendar } =
        await fetchInputs(rd.value, settings.flag_cumulative_days)
      const inputs = buildGenerationInputs(configs, rules, usage, productMappings, vendorParts, uomMappings, globalProducts, tankOnHand, [], [], tankProductMap, exceptions)
      const today = isoToday()
      const dow = new Map(days.map((d) => [d.location_id, d.delivery_dow]))
      const deliveryFor = (loc: string, from: string) => {
        const s = schedules.get(loc)
        return s ? resolveDeliveryDate(from, s, calendar) : nextDeliveryDate(from, dow.get(loc) ?? null)
      }

      // Which distributor (warehouse) serves each shop, from its most recent open sales order line.
      const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
      const [openRes, ledgerRes, histRes] = await Promise.all([
        sb().schema('inventory').from('rd_open_orders').select('location_id, warehouse_code, order_date, customer_po_no').eq('company_id', companyId).order('order_date', { ascending: false }).limit(20000),
        sb().schema('inventory').from('rd_order_ledger').select('location_id, order_date, customer_po_no').eq('company_id', companyId).gte('order_date', since).limit(20000),
        sb().schema('inventory').from('ov2_order_history').select('id, order_date').eq('company_id', companyId).gte('order_date', since),
      ])
      const warehouse = new Map<string, string>()
      const bulk: BulkOrderFact[] = []
      for (const r of (openRes.data ?? []) as any[]) {
        if (r.location_id && r.warehouse_code && !warehouse.has(r.location_id)) warehouse.set(r.location_id, String(r.warehouse_code))
        if (r.location_id && r.order_date >= since && isBulkPoNumber(r.customer_po_no)) bulk.push({ location_id: r.location_id, order_date: String(r.order_date).slice(0, 10) })
      }
      for (const r of (ledgerRes.data ?? []) as any[]) if (r.location_id && isBulkPoNumber(r.customer_po_no)) bulk.push({ location_id: r.location_id, order_date: String(r.order_date).slice(0, 10) })
      const heads = new Map<string, string>(((histRes.data ?? []) as any[]).map((h) => [h.id, String(h.order_date).slice(0, 10)]))
      if (heads.size) {
        const ids = [...heads.keys()]
        for (let i = 0; i < ids.length; i += 100) {
          const { data } = await sb().schema('inventory').from('ov2_order_history_lines').select('location_id, order_id').eq('company_id', companyId).eq('order_type', 'bulk').in('order_id', ids.slice(i, i + 100))
          for (const r of (data ?? []) as any[]) if (r.location_id && heads.has(r.order_id)) bulk.push({ location_id: r.location_id, order_date: heads.get(r.order_id)! })
        }
      }

      const byLoc = new Map<string, VmiShop>()
      for (const i of inputs) {
        if (!i.rule.vmi_keepfill_enabled || i.on_hand == null) continue
        let s = byLoc.get(i.location_id)
        if (!s) {
          const d1 = deliveryFor(i.location_id, today)
          s = { location_id: i.location_id, warehouse_code: warehouse.get(i.location_id) ?? null, products: [], next_delivery: d1, delivery_after_next: d1 ? deliveryFor(i.location_id, d1) : null }
          byLoc.set(i.location_id, s)
        }
        s.products.push({ product_id: i.product_id, on_hand: i.on_hand, daily_usage: i.daily_usage, runway_days: daysOfSupply(i.on_hand, i.daily_usage) })
      }
      const misses = checkVmiMisses([...byLoc.values()], timing, bulk, today)
      const summary: VmiMissSummary = {
        date: today, vendor_id: rd.value, count: misses.length, checkedAt: new Date().toISOString(),
        shops: misses.map((m) => ({ location_id: m.location_id, products: m.products.map((p) => p.product_id), min_runway_days: m.min_runway_days, next_delivery: m.next_delivery, warehouse_code: m.warehouse_code })),
        items: misses.flatMap((m) => m.products.map((p) => ({ location_id: m.location_id, product_id: p.product_id }))),
      }
      await sb().schema('platform').from('app_settings')
        .upsert({ company_id: companyId, key: VMI_MISS_KEY, value: summary, updated_at: new Date().toISOString() }, { onConflict: 'company_id,key' })
      if (!opts.quiet) toast.success(misses.length ? `${misses.length} possible VMI miss${misses.length === 1 ? '' : 'es'} found` : 'No possible VMI misses')
      return summary
    } catch (e) {
      if (!opts.quiet) toast.error(e instanceof Error ? e.message : 'VMI check failed')
      return null
    } finally { setRunning(false) }
  }, [companyId, vendors.options, fetchInputs, settings.flag_cumulative_days, tankProductMap, timing])

  return { run, running }
}
