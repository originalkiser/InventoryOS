import type { TankDims, TankShape } from './tankMath'

export type TankArea = 'basement' | 'back_room' | 'bay'
export const AREAS: { key: TankArea; label: string }[] = [
  { key: 'basement', label: 'Basement' },
  { key: 'back_room', label: 'Back Room' },
  { key: 'bay', label: 'Bay' },
]
export const areaLabel = (a: string) => AREAS.find((x) => x.key === a)?.label ?? a

export interface TankLastLog { depth_in: number; volume_qts: number; logged_at: string; status: string }
export interface ShopTank {
  id: string
  name: string
  product_label: string | null
  area: TankArea
  /** null until the shape is known — a tank pre-loaded from a tank monitor starts without one. */
  shape: TankShape | null
  dims: TankDims
  capacity_qts: number | null
  monitor_serial: string | null
  sort_order: number
  baseline_variance_qts: number | null
  /** What the tank monitor reports (pre-loaded tanks): capacity in quarts and inside height in inches. */
  monitor_capacity_qts: number | null
  monitor_height_in: number | null
  monitor_product: string | null
  source: 'manual' | 'monitor'
  last_log: TankLastLog | null
}
export interface ShareShop { name: string | null; shop_city: string | null; address: string | null; city: string | null; state: string | null; zip: string | null }

/** What the server says about a measurement (see inventory._tank_eval). */
export interface TankEval {
  monitor_found: boolean
  online: boolean
  monitor_qts: number | null
  monitor_read_at: string | null
  sales_adjust_qts: number | null
  expected_qts: number | null
  variance_qts: number | null
  baseline_variance_qts: number | null
  needs_confirm: boolean
  hold_reasons: string[]
  error?: string
  log_id?: string
  status?: 'ok' | 'held'
  new_baseline?: boolean
  previous_baseline_qts?: number | null
}

export const HOLD_REASON_LABEL: Record<string, string> = {
  zero: 'A zero reading',
  sudden_change: 'A sudden change from the last count',
  repeat: 'A repeated submission',
  variance_shift: 'A sudden change in variance (more than 50 qts)',
}
