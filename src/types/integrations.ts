// Integration 1 — OneDrive Order Config
export interface OrderConfigRow {
  id?: string
  product_name: string
  sku: string | null
  uom: string
  trigger_qty: number
  min_order_qty: number
  shop_ids: string[]
  is_active: boolean
  last_updated_at?: string
  updated_by?: string | null
}

export interface UOMThreshold {
  uom: string
  trigger_qty: number
  min_order_qty: number
  display_label: string | null
  updated_at?: string
}

export interface ImportResult {
  added: number
  updated: number
  skipped: number
  errors: string[]
}

export interface ImportDiffRow {
  row: OrderConfigRow
  status: 'new' | 'changed' | 'removed' | 'unchanged'
  previous?: OrderConfigRow
}

// Integration 2 — monday.com
export interface MondayItem {
  id: string
  name: string
  column_values: MondayColumnValue[]
}

export interface MondayColumnValue {
  id: string
  text: string
  value: string
}

export interface SyncResult {
  added: number
  updated: number
  deactivated: number
  errors: string[]
}

export interface LocationSyncLog {
  id: string
  synced_at: string
  records_updated: number
  records_added: number
  records_deactivated: number
  status: 'success' | 'partial' | 'error'
  error_message: string | null
}

// Integration 3 — Droptop usage/on-hands sync. Runs server-side via the
// droptop-sync-usage Edge Function, authenticated with Supabase secrets
// (DROPTOP_PUBLIC_KEY / DROPTOP_PRIVATE_KEY) — not a client-side API key.
export type DroptopSyncMode = 'both' | 'inventory' | 'usage' | 'alerts'

export interface DroptopSyncResult {
  operations_synced: number
  products_upserted: number
  // Count of product_usage rows whose daily_usage got recomputed as a
  // rolling average from inventory.daily_product_activity instead of the
  // raw per-call window total — see droptop-sync-usage's step 5b.
  rolling_usage_applied?: number
  warnings?: string[]
}

// Mirrors inventory.droptop_sync_log, written by the Edge Function after
// every invocation (one row per invocation — a chunked full-company sync
// writes one row per chunk, not one combined row).
export interface DroptopSyncLog {
  id: string
  company_id: string
  synced_at: string
  operations_count: number | null
  products_upserted: number | null
  status: 'success' | 'partial' | 'error'
  error_message: string | null
}

// Mirrors inventory.data_connection_sync_log — connection-agnostic sync
// history (Droptop, SkyBitz tanks, ...) shown on the Inventory Alerts page's
// "Data Connection Updates" section. Additive alongside DroptopSyncLog
// above, which other panels keep reading directly.
export interface DataConnectionSyncLog {
  id: string
  company_id: string
  connection: string
  started_at: string
  finished_at: string
  duration_ms: number | null
  items_updated: number | null
  items_unchanged: number | null
  items_inserted: number | null
  status: 'success' | 'partial' | 'error'
  error_message: string | null
}

// Mirrors inventory.data_connection_schedules — per-connection automation
// config for the Data Connections config tab. The pg_cron job that fires
// data-connection-dispatcher on a fixed cadence never changes; editing a row
// here is the entire mechanism for changing what runs, how often, or at what
// time.
export interface DataConnectionSchedule {
  id: string
  company_id: string
  connection_key: string
  enabled: boolean
  schedule_mode: 'interval' | 'daily'
  interval_minutes: number | null
  daily_time: string | null
  last_run_at: string | null
  last_run_status: string | null
  last_run_message: string | null
  next_run_at: string | null
  // Written by manual "Run Now" clicks — last_run_* above is scheduled-run
  // only (written by the dispatcher). New column, may be null until a
  // manual run happens post-migration.
  last_manual_run_at?: string | null
  last_manual_run_status?: string | null
  last_manual_run_message?: string | null
  last_manual_run_by?: string | null
}

// Integration 4 — Placed Orders
export interface OrderSnapshot {
  location_id?: string
  location_name?: string
  items: Array<{
    product_name: string
    sku?: string
    uom?: string
    qty: number
  }>
  // TODO: [SCHEMA] Confirm order_data shape with Order module owner before hardening
  [key: string]: unknown
}

export interface PlacedOrder {
  id: string
  order_number: string
  location_id: string | null
  location_name: string | null
  placed_at: string
  placed_by: string | null
  order_data: OrderSnapshot
  status: 'placed' | 'received' | 'cancelled' | 'archived'
  notes: string | null
  expires_at: string
  is_archived: boolean
  archived_at: string | null
}

export interface NewPlacedOrder {
  location_id: string | null
  location_name: string | null
  placed_by?: string | null
  order_data: OrderSnapshot
  notes?: string | null
}

export interface OrderFilters {
  locationId?: string
  startDate?: string
  endDate?: string
  status?: string
}
