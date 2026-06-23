// TODO: [DROPTOP] Requires VITE_DROPTOP_API_KEY in .env
// Base URL: https://droptop-app.com  (confirm exact endpoint paths with vendor)
// Expected response shape TBD — update DroptopInventoryItem once confirmed

import { supabase } from '@/lib/supabase'
import { isMonthEndPeriod } from '@/utils/monthEndUtils'
import type { DroptopInventoryItem, MonthEndPullResult, MonthEndPullLog, MonthEndSnapshot } from '@/types/integrations'

export async function fetchDroptopOnHands(
  shopIds: string[],
  date: Date = new Date()
): Promise<DroptopInventoryItem[]> {
  const apiKey = import.meta.env.VITE_DROPTOP_API_KEY
  if (!apiKey) throw new Error('Droptop integration not yet configured. Set VITE_DROPTOP_API_KEY in .env')

  // TODO: [DROPTOP] Implement API call once endpoint paths are confirmed
  // POST or GET to /api/inventory/onhands or similar
  // Include shopIds and date param to get snapshot for specific day
  void shopIds; void date // suppress unused-var warnings until implemented
  throw new Error('Droptop API endpoint paths are TBD — implement once confirmed with vendor')
}

export async function runDailyMonthEndPull(): Promise<MonthEndPullResult> {
  if (!isMonthEndPeriod()) {
    throw new Error('Not currently in month-end period (runs only during last 10 days of month)')
  }

  const today = new Date()
  const dateStr = today.toISOString().slice(0, 10)

  const { data: locations } = await (supabase as any)
    .schema('core').from('locations')
    .select('location_id')
    .eq('is_active', true)
  const shopIds = ((locations ?? []) as { location_id: string }[]).map((l) => l.location_id)

  let recordsWritten = 0
  let status: 'success' | 'error' = 'success'
  let errorMsg: string | null = null

  try {
    const items = await fetchDroptopOnHands(shopIds, today)

    for (const item of items) {
      const { error } = await (supabase as any).schema('inventory').from('count_snapshots').upsert(
        {
          snapshot_date: dateStr,
          location_id: item.shopId,
          product_name: item.productName,
          sku: item.sku ?? null,
          on_hand_qty: item.onHandQty,
          ending_balance: item.endingBalance ?? null,
          uom: item.uom ?? null,
          pulled_at: new Date().toISOString(),
          source: 'droptop',
        },
        { onConflict: 'snapshot_date,location_id,product_name' }
      )
      if (!error) recordsWritten++
    }
  } catch (err) {
    status = 'error'
    errorMsg = err instanceof Error ? err.message : String(err)
  }

  await (supabase as any).schema('inventory').from('pull_log').insert({
    pull_date: dateStr,
    pulled_at: new Date().toISOString(),
    locations_pulled: shopIds.length,
    records_written: recordsWritten,
    status,
    error_message: errorMsg,
  })

  if (status === 'error') throw new Error(errorMsg ?? 'Pull failed')
  return { date: dateStr, recordsWritten, status }
}

export async function getMonthEndSnapshots(date: string): Promise<MonthEndSnapshot[]> {
  const { data, error } = await (supabase as any)
    .from('month_end_snapshots')
    .select('*')
    .eq('snapshot_date', date)
    .order('location_id')
    .order('product_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as MonthEndSnapshot[]
}

export async function getPullHistory(limit = 10): Promise<MonthEndPullLog[]> {
  const { data } = await (supabase as any)
    .from('month_end_pull_log')
    .select('*')
    .order('pulled_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as MonthEndPullLog[]
}

export async function getLastPullLog(): Promise<MonthEndPullLog | null> {
  const { data } = await (supabase as any)
    .from('month_end_pull_log')
    .select('*')
    .order('pulled_at', { ascending: false })
    .limit(1)
  return ((data ?? []) as MonthEndPullLog[])[0] ?? null
}
