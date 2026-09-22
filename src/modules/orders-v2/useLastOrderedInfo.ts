// Backs the "Last Ordered"/"Last Delivered" columns + on-hand plausibility
// flag added to Review/Final Review (2026-09-22 request). Shared between
// both pages since neither's own data pipeline (Review's live fetchInputs,
// Final Review's simpler persisted-lines read) already carries this.
//
// "Last Ordered" (date/qty/ETA) is vendor-agnostic — inventory.
// ov2_order_history_lines exists for every vendor already. "Last
// Delivered" and the on-hand check are RelaDyne-only for now (explicit
// scope decision, 2026-09-22): RelaDyne's own uploaded Open Invoice ledger
// (rd_delivery_ledger) has real, vendor-confirmed quantities; there's no
// equivalently-trustworthy receiving source for other vendors yet (the
// Droptop PO items table treats its own product_id column two different,
// contradictory ways elsewhere in this codebase depending on which
// feature reads it — see get_ov2_last_ordered_by_shop_product's own
// migration comment — not resolved here).
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { isReladyne } from './useOrdersV2'
import { resolveDeliveryDate, nextDeliveryDate } from './engine'
import type { DeliverySchedule, WeekCalendar } from './types'
import { parseWeekday, orderDayFromDelivery } from '@/lib/orderDay'
import { computeOnHandPlausibility, deliveredQtyToQuarts, isRecentDelivery, type OnHandCheckResult } from './onHandCheck'

const sb = () => supabase as any
const key = (locationId: string, productId: string) => `${locationId}|${productId}`

interface LastOrderedRow {
  order_date: string
  qty: number
  uom: string | null
  order_type: 'bulk' | 'package'
  quarts_per_unit: number | null
  po_number: string | null
  on_hand: number | null
}

interface DeliveredRow {
  invoice_date: string
  qty_shipped: number | null
  gallons_shipped: number | null
}

export interface LastOrderedInfo {
  lastOrderDate: string | null
  lastOrderQty: number | null
  lastOrderUom: string | null
  eta: string | null
  lastDeliveredDate: string | null
  lastDeliveredAmount: number | null
  lastDeliveredUnit: 'gal' | null
  onHandCheck: OnHandCheckResult | null
}

const EMPTY_INFO: LastOrderedInfo = {
  lastOrderDate: null, lastOrderQty: null, lastOrderUom: null, eta: null,
  lastDeliveredDate: null, lastDeliveredAmount: null, lastDeliveredUnit: null, onHandCheck: null,
}

export function useLastOrderedInfo(vendorId: string | null, vendorName: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [loading, setLoading] = useState(false)
  const [lastOrdered, setLastOrdered] = useState<Map<string, LastOrderedRow>>(new Map())
  const [delivered, setDelivered] = useState<Map<string, DeliveredRow>>(new Map())
  const [soldSince, setSoldSince] = useState<Map<string, number>>(new Map())
  const [schedules, setSchedules] = useState<Map<string, DeliverySchedule>>(new Map())
  const [calendar, setCalendar] = useState<WeekCalendar>(new Map())
  const [deliveryDow, setDeliveryDow] = useState<Map<string, number | null>>(new Map())

  const load = useCallback(async () => {
    if (!companyId || !vendorId) {
      setLastOrdered(new Map()); setDelivered(new Map()); setSoldSince(new Map())
      setSchedules(new Map()); setCalendar(new Map()); setDeliveryDow(new Map())
      return
    }
    setLoading(true)
    try {
      const [{ data: loRows }, { data: schedRows }, { data: calRows }, { data: locRows }] = await Promise.all([
        sb().rpc('get_ov2_last_ordered_by_shop_product', { p_vendor_id: vendorId }),
        sb().schema('inventory').from('ov2_location_schedules').select('*').eq('company_id', companyId).eq('vendor_id', vendorId),
        sb().schema('inventory').from('ov2_delivery_calendar').select('week_start, week_label').eq('company_id', companyId).eq('vendor_id', vendorId),
        sb().schema('core').from('locations').select('id, reladyne_delivery_day').eq('company_id', companyId),
      ])

      const loMap = new Map<string, LastOrderedRow>()
      for (const r of (loRows ?? []) as any[]) {
        loMap.set(key(r.location_id, r.product_id), {
          order_date: r.order_date, qty: Number(r.qty), uom: r.uom, order_type: r.order_type,
          quarts_per_unit: r.quarts_per_unit != null ? Number(r.quarts_per_unit) : null,
          po_number: r.po_number, on_hand: r.on_hand != null ? Number(r.on_hand) : null,
        })
      }
      setLastOrdered(loMap)

      const schedMap = new Map<string, DeliverySchedule>()
      for (const r of (schedRows ?? []) as any[]) {
        schedMap.set(r.location_id, {
          type: r.schedule_type, delivery_dow: r.delivery_dow,
          week_a_dow: r.week_a_dow, week_b_dow: r.week_b_dow,
          lead_business_days: Number(r.lead_business_days ?? 4),
        })
      }
      setSchedules(schedMap)
      setCalendar(new Map((calRows ?? []).map((c: any) => [String(c.week_start).slice(0, 10), c.week_label as 'A' | 'B'])))
      const dowMap = new Map<string, number | null>()
      for (const l of (locRows ?? []) as any[]) dowMap.set(l.id, parseWeekday(l.reladyne_delivery_day))
      setDeliveryDow(dowMap)

      // RelaDyne-only: real delivered quantities from the uploaded Open
      // Invoice ledger, matched to each last-ordered line by its OWN
      // po_number (not just "whatever was most recently invoiced for this
      // product") so the on-hand check's baseline (on_hand at THIS order)
      // and its delivered qty (from THIS order's own PO) stay consistent.
      if (isReladyne(vendorName) && loMap.size) {
        const poNumbers = [...new Set([...loMap.values()].map((r) => r.po_number).filter((v): v is string => !!v))]
        const { data: vpRows } = await sb().schema('inventory').from('vendor_parts')
          .select('part_number, our_part_number').eq('company_id', companyId).eq('vendor_id', vendorId)
        const partNumberByProductId = new Map<string, string>()
        for (const vp of (vpRows ?? []) as any[]) if (vp.our_part_number && vp.part_number) partNumberByProductId.set(vp.our_part_number, vp.part_number)

        const deliveredMap = new Map<string, DeliveredRow>()
        if (poNumbers.length) {
          const { data: dRows } = await sb().schema('inventory').from('rd_delivery_ledger')
            .select('customer_po_no, product_code, invoice_date, qty_shipped, gallons_shipped')
            .eq('company_id', companyId).in('customer_po_no', poNumbers)
          const byPoAndCode = new Map<string, DeliveredRow>()
          for (const d of (dRows ?? []) as any[]) {
            if (!d.invoice_date) continue
            byPoAndCode.set(`${d.customer_po_no}|${d.product_code}`, {
              invoice_date: d.invoice_date, qty_shipped: d.qty_shipped, gallons_shipped: d.gallons_shipped,
            })
          }
          for (const [k, lo] of loMap) {
            if (!lo.po_number) continue
            const code = partNumberByProductId.get(k.split('|')[1])
            if (!code) continue
            const found = byPoAndCode.get(`${lo.po_number}|${code}`)
            if (found) deliveredMap.set(k, found)
          }
        }
        setDelivered(deliveredMap)

        // Real sold_qty since each order's own date, from the daily
        // ledger — see onHandCheck.ts's own header comment for why this
        // (not a historical on-hand snapshot) is the check's real basis.
        const pairs = [...deliveredMap.entries()].map(([k, _d]) => {
          const [locationId, productId] = k.split('|')
          return { location_id: locationId, product_id: productId, since_date: loMap.get(k)!.order_date }
        })
        if (pairs.length) {
          const { data: soldRows } = await sb().rpc('get_ov2_sold_since', { p_pairs: pairs })
          const soldMap = new Map<string, number>()
          for (const r of (soldRows ?? []) as any[]) {
            if (r.sold_since != null) soldMap.set(key(r.location_id, r.product_id), Number(r.sold_since))
          }
          setSoldSince(soldMap)
        } else {
          setSoldSince(new Map())
        }
      } else {
        setDelivered(new Map())
        setSoldSince(new Map())
      }
    } finally {
      setLoading(false)
    }
  }, [companyId, vendorId, vendorName])

  useEffect(() => { load() }, [load])

  const deliveryFor = useCallback((locationId: string, fromDate: string): string | null => {
    const sched = schedules.get(locationId)
    return sched ? resolveDeliveryDate(fromDate, sched, calendar) : nextDeliveryDate(fromDate, deliveryDow.get(locationId) ?? null)
  }, [schedules, calendar, deliveryDow])

  const infoFor = useCallback((locationId: string, productId: string, currentOnHand: number | null, currentDailyUsage: number | null): LastOrderedInfo => {
    const k = key(locationId, productId)
    const lo = lastOrdered.get(k)
    if (!lo) return EMPTY_INFO
    const eta = deliveryFor(locationId, lo.order_date)
    const d = delivered.get(k)
    const sold = soldSince.get(k)

    let onHandCheck: OnHandCheckResult | null = null
    if (d && sold != null && lo.on_hand != null && currentOnHand != null && currentDailyUsage != null
      && isRecentDelivery(d.invoice_date, new Date().toISOString().slice(0, 10))) {
      const deliveredQuarts = deliveredQtyToQuarts(lo.order_type, d.qty_shipped, d.gallons_shipped, lo.quarts_per_unit)
      if (deliveredQuarts != null) {
        onHandCheck = computeOnHandPlausibility({
          currentOnHand, onHandWhenOrdered: lo.on_hand, soldSinceOrder: sold,
          deliveredQtyQuarts: deliveredQuarts, dailyUsage: currentDailyUsage,
        })
      }
    }

    return {
      lastOrderDate: lo.order_date, lastOrderQty: lo.qty, lastOrderUom: lo.uom, eta,
      lastDeliveredDate: d?.invoice_date ?? null,
      lastDeliveredAmount: d ? (lo.order_type === 'bulk' ? d.gallons_shipped : d.qty_shipped) : null,
      lastDeliveredUnit: d && lo.order_type === 'bulk' ? 'gal' : null,
      onHandCheck,
    }
  }, [lastOrdered, delivered, soldSince, deliveryFor])

  return { loading, infoFor }
}
