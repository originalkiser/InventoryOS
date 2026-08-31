// Client for the Droptop usage/on-hands sync — a server-side Supabase Edge
// Function (droptop-sync-usage), authenticated via Supabase secrets
// (DROPTOP_PUBLIC_KEY / DROPTOP_PRIVATE_KEY). There is no client-side
// Droptop API key — VITE_DROPTOP_API_KEY (still in .env.example) belongs to
// an earlier, never-finished attempt at this integration and isn't used
// anywhere anymore.
//
// A full-company sync ("every location") is chunked into several smaller
// Edge Function invocations rather than one big one — a single invocation
// covering 200+ locations, each requiring one or more Droptop API round
// trips, can run long enough to hit the platform's execution time limit.
// When that happens the platform kills the invocation and returns a
// non-2xx status with no useful body — supabase-js surfaces that as the
// generic "Edge Function returned a non-2xx status code" regardless of what
// actually went wrong. Chunking keeps each invocation's location count
// bounded so it reliably finishes well inside the limit; a chunk that fails
// is recorded as a warning rather than aborting the whole sync.

import { supabase } from '@/lib/supabase'
import type { DroptopSyncResult, DroptopSyncLog } from '@/types/integrations'

const CHUNK_SIZE = 20

type SyncMode = 'both' | 'inventory' | 'usage'

export interface DroptopSyncOptions {
  mode: SyncMode
  daysBack: number
  categories?: string[]
  locationId?: string // sync a single location — skips chunking entirely
  // Sync exactly this set of locations, chunked the same way "every
  // location" is — for callers (e.g. the one-time historical backfill)
  // that need an explicit, caller-chosen subset rather than every
  // Droptop-mapped location in the company.
  locationIds?: string[]
  // Opt-in: also feed this pull's on-hands into inventory.count_products for
  // the given Month End period (YYYY-MM-01) — see droptop-sync-usage's own
  // doc comment for why this is scoped-delete-then-insert, not additive.
  // Only Month End's Daily Pull panel should set this.
  countMonth?: string
  // Opt-in: also write each change event into inventory.daily_product_activity
  // (the day-by-day sold/adjusted/other ledger) — see droptop-sync-usage's own
  // doc comment. Set by the Data Connections tab's "Run Now" for the Usage
  // connection, matching what its scheduled daily run does.
  logDailyActivity?: boolean
}

export interface DroptopSyncProgress {
  batch: number
  totalBatches: number
}

async function invokeSync(body: Record<string, unknown>): Promise<DroptopSyncResult> {
  const { data, error } = await supabase.functions.invoke('droptop-sync-usage', { body })
  if (error) throw new Error(error.message)
  if (data?.error) {
    throw new Error(
      data.error === 'credentials_not_configured'
        ? 'Droptop API keys not configured — add DROPTOP_PUBLIC_KEY and DROPTOP_PRIVATE_KEY to Supabase secrets.'
        : data.error
    )
  }
  return {
    operations_synced: data.operations_synced ?? 0,
    products_upserted: data.products_upserted ?? 0,
    ...(data.rolling_usage_applied ? { rolling_usage_applied: data.rolling_usage_applied as number } : {}),
    ...(data.warnings ? { warnings: data.warnings as string[] } : {}),
  }
}

async function fetchDroptopLocationIds(companyId: string): Promise<string[]> {
  const { data, error } = await (supabase as any)
    .schema('core').from('locations')
    .select('id')
    .eq('company_id', companyId)
    .not('droptop_operation_id', 'is', null)
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: { id: string }) => r.id)
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Syncs a single location directly (small, no chunking needed), or every
// location in the company with a Droptop Operation ID set, chunked into
// CHUNK_SIZE-location batches run one after another.
export async function runDroptopSync(
  companyId: string,
  opts: DroptopSyncOptions,
  onProgress?: (p: DroptopSyncProgress) => void,
): Promise<DroptopSyncResult> {
  const { mode, daysBack, categories = [], locationId, locationIds, countMonth, logDailyActivity } = opts
  const writeToCountProducts = !!countMonth

  if (locationId) {
    return invokeSync({ mode, daysBack, categories, locationId, writeToCountProducts, countMonth, logDailyActivity })
  }

  const ids = locationIds?.length ? locationIds : await fetchDroptopLocationIds(companyId)
  if (!ids.length) {
    throw new Error('No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.')
  }
  const batches = chunk(ids, CHUNK_SIZE)

  let operationsSynced = 0
  let productsUpserted = 0
  let rollingUsageApplied = 0
  const warnings: string[] = []

  for (let i = 0; i < batches.length; i++) {
    onProgress?.({ batch: i + 1, totalBatches: batches.length })
    try {
      const result = await invokeSync({ mode, daysBack, categories, locationIds: batches[i], writeToCountProducts, countMonth, logDailyActivity })
      operationsSynced += result.operations_synced
      productsUpserted += result.products_upserted
      rollingUsageApplied += result.rolling_usage_applied ?? 0
      if (result.warnings?.length) warnings.push(...result.warnings)
    } catch (err) {
      warnings.push(`Batch ${i + 1}/${batches.length}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (operationsSynced === 0 && warnings.length > 0) {
    throw new Error(warnings.join(' | '))
  }
  return {
    operations_synced: operationsSynced,
    products_upserted: productsUpserted,
    ...(rollingUsageApplied ? { rolling_usage_applied: rollingUsageApplied } : {}),
    ...(warnings.length ? { warnings } : {}),
  }
}

// Purchase Orders — separate edge function, separate tables
// (inventory.droptop_purchase_orders / _items), but same dual-auth/sig
// conventions as the on-hand/usage sync above. DOES need the same chunking
// as usage/inventory below — wrongly assumed at first that low per-shop PO
// volume meant one invocation covering every location would stay inside the
// platform's execution time limit; in practice, hundreds of locations each
// making at least one Droptop call (plus 429 backoff/retries) adds up the
// same way it does for the usage sync, and a real run confirmed it:
// "Edge Function returned a non-2xx status code" after ~3 minutes.
export interface DroptopPOSyncResult {
  locations_synced: number
  pos_upserted: number
  items_written: number
  warnings?: string[]
}

async function invokePOSync(body: Record<string, unknown>): Promise<DroptopPOSyncResult> {
  const { data, error } = await supabase.functions.invoke('droptop-sync-purchase-orders', { body: { mode: 'sync', ...body } })
  if (error) throw new Error(error.message)
  if (data?.error) {
    throw new Error(
      data.error === 'credentials_not_configured'
        ? 'Droptop API keys not configured — add DROPTOP_PUBLIC_KEY and DROPTOP_PRIVATE_KEY to Supabase secrets.'
        : data.error
    )
  }
  return data as DroptopPOSyncResult
}

export async function runDroptopPurchaseOrderSync(
  opts: { daysBack?: number; poStatus?: string; locationId?: string } = {},
  companyId?: string,
  onProgress?: (p: DroptopSyncProgress) => void,
): Promise<DroptopPOSyncResult> {
  const { locationId, ...rest } = opts
  if (locationId) return invokePOSync({ ...rest, locationId })
  if (!companyId) return invokePOSync(rest) // no company to chunk by — single shot (e.g. inspect-adjacent callers)

  const ids = await fetchDroptopLocationIds(companyId)
  if (!ids.length) {
    throw new Error('No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.')
  }
  const batches = chunk(ids, CHUNK_SIZE)

  let locationsSynced = 0
  let posUpserted = 0
  let itemsWritten = 0
  const warnings: string[] = []

  for (let i = 0; i < batches.length; i++) {
    onProgress?.({ batch: i + 1, totalBatches: batches.length })
    try {
      const result = await invokePOSync({ ...rest, locationIds: batches[i] })
      locationsSynced += result.locations_synced
      posUpserted += result.pos_upserted
      itemsWritten += result.items_written
      if (result.warnings?.length) warnings.push(...result.warnings)
    } catch (err) {
      warnings.push(`Batch ${i + 1}/${batches.length}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (locationsSynced === 0 && warnings.length > 0) throw new Error(warnings.join(' | '))
  return { locations_synced: locationsSynced, pos_upserted: posUpserted, items_written: itemsWritten, ...(warnings.length ? { warnings } : {}) }
}

// Customers — separate edge function, separate table
// (inventory.droptop_customers), same dual-auth/sig/chunking conventions as
// the PO sync above. Feeds the Customer Heatmap (marketing module).
export interface DroptopCustomerSyncResult {
  locations_synced: number
  customers_upserted: number
  customers_with_coordinates: number
  customers_missing_zip_match: number
  warnings?: string[]
}

async function invokeCustomerSync(body: Record<string, unknown>): Promise<DroptopCustomerSyncResult> {
  const { data, error } = await supabase.functions.invoke('droptop-sync-customers', { body: { mode: 'sync', ...body } })
  if (error) throw new Error(error.message)
  if (data?.error) {
    throw new Error(
      data.error === 'credentials_not_configured'
        ? 'Droptop API keys not configured — add DROPTOP_PUBLIC_KEY and DROPTOP_PRIVATE_KEY to Supabase secrets.'
        : data.error
    )
  }
  return data as DroptopCustomerSyncResult
}

export async function runDroptopCustomerSync(
  companyId: string,
  onProgress?: (p: DroptopSyncProgress) => void,
): Promise<DroptopCustomerSyncResult> {
  const ids = await fetchDroptopLocationIds(companyId)
  if (!ids.length) {
    throw new Error('No locations have a Droptop Operation ID set. Add them under Config → Locations → Integrations tab.')
  }
  const batches = chunk(ids, CHUNK_SIZE)

  let locationsSynced = 0
  let customersUpserted = 0
  let withCoords = 0
  let missingZip = 0
  const warnings: string[] = []

  for (let i = 0; i < batches.length; i++) {
    onProgress?.({ batch: i + 1, totalBatches: batches.length })
    try {
      const result = await invokeCustomerSync({ locationIds: batches[i] })
      locationsSynced += result.locations_synced
      customersUpserted += result.customers_upserted
      withCoords += result.customers_with_coordinates
      missingZip += result.customers_missing_zip_match
      if (result.warnings?.length) warnings.push(...result.warnings)
    } catch (err) {
      warnings.push(`Batch ${i + 1}/${batches.length}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (locationsSynced === 0 && warnings.length > 0) throw new Error(warnings.join(' | '))
  return {
    locations_synced: locationsSynced, customers_upserted: customersUpserted,
    customers_with_coordinates: withCoords, customers_missing_zip_match: missingZip,
    ...(warnings.length ? { warnings } : {}),
  }
}

export async function getLastDroptopSyncLog(companyId: string): Promise<DroptopSyncLog | null> {
  const { data } = await (supabase as any)
    .schema('inventory').from('droptop_sync_log')
    .select('*')
    .eq('company_id', companyId)
    .order('synced_at', { ascending: false })
    .limit(1)
  return ((data ?? []) as DroptopSyncLog[])[0] ?? null
}

export async function getDroptopSyncHistory(companyId: string, limit = 10): Promise<DroptopSyncLog[]> {
  const { data } = await (supabase as any)
    .schema('inventory').from('droptop_sync_log')
    .select('*')
    .eq('company_id', companyId)
    .order('synced_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as DroptopSyncLog[]
}
