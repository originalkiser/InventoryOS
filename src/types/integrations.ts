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

// Integration 3 — Droptop month-end
export interface DroptopInventoryItem {
  shopId: string
  productName: string
  sku?: string
  onHandQty: number
  endingBalance?: number
  uom?: string
  // TODO: [DROPTOP] verify field names against actual Droptop API response
}

export interface MonthEndPullResult {
  date: string
  recordsWritten: number
  status: 'success' | 'error'
  error?: string
}

export interface MonthEndPullLog {
  id: string
  pull_date: string
  pulled_at: string
  locations_pulled: number
  records_written: number
  status: 'success' | 'error'
  error_message: string | null
}

export interface MonthEndSnapshot {
  id: string
  snapshot_date: string
  location_id: string
  product_name: string
  sku: string | null
  on_hand_qty: number
  ending_balance: number | null
  uom: string | null
  pulled_at: string
  source: string
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
