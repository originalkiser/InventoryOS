// TODO: [ONEDRIVE] Auto-sync from shared OneDrive XLSX
// Graph API endpoint: GET /me/drive/items/{item-id}/content
// Requires: VITE_ONEDRIVE_CLIENT_ID, VITE_ONEDRIVE_TENANT_ID in .env

import { supabase } from '@/lib/supabase'
import type { OrderConfigRow, UOMThreshold, ImportResult, ImportDiffRow } from '@/types/integrations'

export async function fetchOrderConfigFromOneDrive(): Promise<void> {
  // TODO: [ONEDRIVE] Implement OAuth + Graph API pull
  // GET https://graph.microsoft.com/v1.0/me/drive/items/{VITE_ONEDRIVE_FILE_ITEM_ID}/content
  throw new Error('OneDrive integration not yet configured. Use manual XLSX upload instead.')
}

export async function parseXLSXToOrderConfig(file: File): Promise<OrderConfigRow[]> {
  const XLSX = await import('xlsx')
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

  return raw
    .map((r) => ({
      product_name: String(r['Product Name'] ?? r['product_name'] ?? '').trim(),
      sku: r['SKU'] != null ? String(r['SKU']).trim() || null : null,
      uom: String(r['UOM'] ?? r['uom'] ?? '').trim().toLowerCase(),
      trigger_qty: 0,
      min_order_qty: 0,
      shop_ids: r['Shop ID'] ? [String(r['Shop ID']).trim()] : [],
      is_active: true,
    }))
    .filter((r) => r.product_name && r.uom)
}

export async function diffOrderConfig(incoming: OrderConfigRow[]): Promise<ImportDiffRow[]> {
  const { data: existing } = await (supabase as any).schema('inventory').from('order_config').select('*')
  const existingMap = new Map<string, OrderConfigRow>(
    ((existing ?? []) as OrderConfigRow[]).map((r) => [r.product_name.toLowerCase(), r])
  )
  const incomingKeys = new Set(incoming.map((r) => r.product_name.toLowerCase()))

  const diff: ImportDiffRow[] = incoming.map((row) => {
    const prev = existingMap.get(row.product_name.toLowerCase())
    if (!prev) return { row, status: 'new' as const }
    const changed =
      prev.uom !== row.uom ||
      JSON.stringify([...(prev.shop_ids ?? [])].sort()) !== JSON.stringify([...row.shop_ids].sort())
    return changed
      ? { row, status: 'changed' as const, previous: prev }
      : { row, status: 'unchanged' as const }
  })

  for (const prev of (existing ?? []) as OrderConfigRow[]) {
    if (!incomingKeys.has(prev.product_name.toLowerCase())) {
      diff.push({ row: prev, status: 'removed' })
    }
  }

  return diff
}

export async function applyOrderConfigImport(diff: ImportDiffRow[]): Promise<ImportResult> {
  const result: ImportResult = { added: 0, updated: 0, skipped: 0, errors: [] }

  const thresholds = await getUOMThresholds()
  const thresholdMap = new Map(thresholds.map((t) => [t.uom, t]))

  for (const item of diff) {
    if (item.status === 'unchanged') { result.skipped++; continue }

    if (item.status === 'removed') {
      await (supabase as any).schema('inventory').from('order_config').update({ is_active: false }).eq('product_name', item.row.product_name)
      continue
    }

    const threshold = thresholdMap.get(item.row.uom)
    const row = {
      ...item.row,
      trigger_qty: threshold?.trigger_qty ?? 0,
      min_order_qty: threshold?.min_order_qty ?? 0,
      last_updated_at: new Date().toISOString(),
    }

    if (item.status === 'new') {
      const { error } = await (supabase as any).schema('inventory').from('order_config').insert(row)
      if (error) result.errors.push(`${item.row.product_name}: ${error.message}`)
      else result.added++
    } else {
      const { error } = await (supabase as any).schema('inventory').from('order_config').update(row).eq('product_name', item.row.product_name)
      if (error) result.errors.push(`${item.row.product_name}: ${error.message}`)
      else result.updated++
    }
  }

  return result
}

export async function getUOMThresholds(): Promise<UOMThreshold[]> {
  const { data, error } = await (supabase as any).schema('inventory').from('uom_thresholds').select('*').order('uom')
  if (error) throw new Error(error.message)
  return (data ?? []) as UOMThreshold[]
}

export async function saveUOMThreshold(threshold: UOMThreshold): Promise<void> {
  const { error } = await (supabase as any)
    .from('uom_thresholds')
    .upsert({ ...threshold, updated_at: new Date().toISOString() }, { onConflict: 'uom' })
  if (error) throw new Error(error.message)
}

export async function getOrderConfig(filters?: { uom?: string; activeOnly?: boolean }): Promise<OrderConfigRow[]> {
  let q = (supabase as any).schema('inventory').from('order_config').select('*')
  if (filters?.uom) q = q.eq('uom', filters.uom)
  if (filters?.activeOnly !== false) q = q.eq('is_active', true)
  const { data, error } = await q.order('product_name')
  if (error) throw new Error(error.message)
  return (data ?? []) as OrderConfigRow[]
}
