// Pure logic for the GM Warranty & Dexos Oil Check page (no React/Supabase).
//
// The real counting happens in SQL (inventory.get_gm_dexos_summary / get_gm_dexos_detail,
// migration 20261010z_gm_dexos_check.sql); the helpers here mirror its bucket rules so they can be unit
// tested, validate/normalize the editable settings, and do the client-side roll-ups (compliance %,
// totals, month chunking). Keep `classifyVehicle` and `isApprovedOilId` in step with the SQL.

export const DEFAULT_APPROVED_IDS = ['DEXOS-SYN-5W30', 'DEXOS-SYN-0W20', '0W40-MBL1-DEXOSR']
// Droptop stores the vehicle make as the plain brand name (Chevrolet, GMC, Buick, Cadillac ...). Pontiac,
// Saturn, Hummer, Oldsmobile, Saab and Geo also appear in real data but are defunct brands; they are not
// counted as GM by default (add them in settings if wanted).
export const DEFAULT_GM_MAKES = ['Chevrolet', 'GMC', 'Buick', 'Cadillac']

export interface GmDexosSettings {
  maxAgeYears: number
  maxMiles: number
  approvedIds: string[]
  gmMakes: string[]
}

export const DEFAULT_SETTINGS: GmDexosSettings = {
  maxAgeYears: 5,
  maxMiles: 60000,
  approvedIds: DEFAULT_APPROVED_IDS,
  gmMakes: DEFAULT_GM_MAKES,
}

/** First month of the report. */
export const REPORT_START = '2026-08-01'

export type Bucket =
  | 'gm_warranty_dexos'
  | 'gm_warranty_miss'
  | 'gm_out_of_warranty'
  | 'gm_unknown'
  | 'nongm_dexos'
  | 'nongm_no_dexos'

export const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: 'gm_warranty_dexos', label: 'GM in warranty - Dexos', hint: 'GM make, under the age AND mileage limits, used an approved Dexos oil' },
  { key: 'gm_warranty_miss', label: 'GM in warranty - NOT Dexos', hint: 'The compliance miss: GM make, under the age AND mileage limits, no approved oil' },
  { key: 'gm_out_of_warranty', label: 'GM out of warranty', hint: 'GM make, at/over the age limit OR the mileage limit' },
  { key: 'gm_unknown', label: 'GM - year/mileage missing', hint: 'GM make but the model year or mileage is missing/zero, so warranty cannot be judged' },
  { key: 'nongm_dexos', label: 'Non-GM - Dexos', hint: 'Any other make that got an approved Dexos oil' },
  { key: 'nongm_no_dexos', label: 'Non-GM - not Dexos', hint: 'Any other make (or unknown make) without an approved Dexos oil' },
]

export function bucketLabel(b: string): string {
  return BUCKETS.find((x) => x.key === b)?.label ?? b
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────

function cleanList(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of v) {
    const s = String(x ?? '').trim()
    if (!s || seen.has(s.toLowerCase())) continue
    seen.add(s.toLowerCase())
    out.push(s)
  }
  return out
}

/** Defensive read of the stored app_settings value (older/partial/garbled values fall back to defaults). */
export function normalizeSettings(raw: Partial<GmDexosSettings> | null | undefined): GmDexosSettings {
  const age = Number(raw?.maxAgeYears)
  const miles = Number(raw?.maxMiles)
  return {
    maxAgeYears: Number.isFinite(age) && age > 0 ? age : DEFAULT_SETTINGS.maxAgeYears,
    maxMiles: Number.isFinite(miles) && miles > 0 ? miles : DEFAULT_SETTINGS.maxMiles,
    approvedIds: cleanList(raw?.approvedIds, DEFAULT_SETTINGS.approvedIds),
    gmMakes: cleanList(raw?.gmMakes, DEFAULT_SETTINGS.gmMakes),
  }
}

/** Stable string for a settings object - used as part of cache keys. */
export function settingsKey(s: GmDexosSettings): string {
  return [s.maxAgeYears, s.maxMiles, [...s.approvedIds].map((x) => x.toUpperCase()).sort().join(','), [...s.gmMakes].map((x) => x.toLowerCase()).sort().join(',')].join('|')
}

// ── Classification (mirrors the SQL) ────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')

/**
 * Does a product id count as an approved oil? An approved id matches itself or itself plus a 1-3 letter
 * case-type suffix (D = drum, BB = bay box, C = case ...), case-insensitive: DEXOS-SYN-5W30 approves
 * DEXOS-SYN-5W30D and DEXOS-SYN-5W30BB.
 */
export function isApprovedOilId(productId: string | null | undefined, approvedIds: string[]): boolean {
  const id = (productId ?? '').trim()
  if (!id) return false
  return approvedIds.some((a) => {
    const t = a.trim()
    return !!t && new RegExp(`^${escapeRe(t)}[A-Z]{0,3}$`, 'i').test(id)
  })
}

/** Model-year age at the service date: service year minus model year (a 2023 model serviced in 2026 is 3). */
export function vehicleAge(serviceDate: string, modelYear: number): number {
  return Number(serviceDate.slice(0, 4)) - modelYear
}

export type WarrantyStatus = 'in' | 'out' | 'unknown'

export function warrantyStatus(
  v: { modelYear: number | null | undefined; mileage: number | null | undefined; serviceDate: string },
  s: Pick<GmDexosSettings, 'maxAgeYears' | 'maxMiles'>,
): WarrantyStatus {
  if (v.modelYear == null || v.mileage == null || !(v.mileage > 0)) return 'unknown'
  return vehicleAge(v.serviceDate, v.modelYear) < s.maxAgeYears && v.mileage < s.maxMiles ? 'in' : 'out'
}

export function isGmMake(make: string | null | undefined, gmMakes: string[]): boolean {
  const m = (make ?? '').trim().toLowerCase()
  return !!m && gmMakes.some((g) => g.trim().toLowerCase() === m)
}

export function classifyVehicle(
  v: { make: string | null | undefined; modelYear: number | null | undefined; mileage: number | null | undefined; serviceDate: string; usesDexos: boolean },
  s: GmDexosSettings,
): Bucket {
  if (!isGmMake(v.make, s.gmMakes)) return v.usesDexos ? 'nongm_dexos' : 'nongm_no_dexos'
  const w = warrantyStatus(v, s)
  if (w === 'unknown') return 'gm_unknown'
  if (w === 'out') return 'gm_out_of_warranty'
  return v.usesDexos ? 'gm_warranty_dexos' : 'gm_warranty_miss'
}

// ── Roll-ups ───────────────────────────────────────────────────────────────────────────────────

export interface SummaryRow {
  location_id: string
  /** 'YYYY-MM-01' */
  month: string
  total_vehicles: number
  total_orders: number
  gm_warranty_dexos: number
  gm_warranty_miss: number
  gm_out_of_warranty: number
  gm_unknown: number
  nongm_dexos: number
  nongm_no_dexos: number
}

export function parseSummaryRow(r: Record<string, unknown>): SummaryRow {
  const n = (v: unknown) => Number(v ?? 0)
  return {
    location_id: String(r.location_id),
    month: String(r.month).slice(0, 10),
    total_vehicles: n(r.total_vehicles), total_orders: n(r.total_orders),
    gm_warranty_dexos: n(r.gm_warranty_dexos), gm_warranty_miss: n(r.gm_warranty_miss),
    gm_out_of_warranty: n(r.gm_out_of_warranty), gm_unknown: n(r.gm_unknown),
    nongm_dexos: n(r.nongm_dexos), nongm_no_dexos: n(r.nongm_no_dexos),
  }
}

/** Compliance = GM-in-warranty vehicles on Dexos / all GM-in-warranty vehicles, as 0-100; null with no GM-in-warranty vehicles. */
export function compliancePct(dexos: number, miss: number): number | null {
  const t = dexos + miss
  return t > 0 ? (dexos / t) * 100 : null
}

export interface Totals {
  vehicles: number
  orders: number
  gmWarrantyDexos: number
  gmWarrantyMiss: number
  gmOutOfWarranty: number
  gmUnknown: number
  nonGmDexos: number
  nonGmNoDexos: number
  compliance: number | null
}

export function totalsOf(rows: SummaryRow[]): Totals {
  const t: Totals = { vehicles: 0, orders: 0, gmWarrantyDexos: 0, gmWarrantyMiss: 0, gmOutOfWarranty: 0, gmUnknown: 0, nonGmDexos: 0, nonGmNoDexos: 0, compliance: null }
  for (const r of rows) {
    t.vehicles += r.total_vehicles; t.orders += r.total_orders
    t.gmWarrantyDexos += r.gm_warranty_dexos; t.gmWarrantyMiss += r.gm_warranty_miss
    t.gmOutOfWarranty += r.gm_out_of_warranty; t.gmUnknown += r.gm_unknown
    t.nonGmDexos += r.nongm_dexos; t.nonGmNoDexos += r.nongm_no_dexos
  }
  t.compliance = compliancePct(t.gmWarrantyDexos, t.gmWarrantyMiss)
  return t
}

// ── Month chunking ─────────────────────────────────────────────────────────────────────────────

export interface MonthChunk { month: string; start: string; end: string }

const pad = (n: number) => String(n).padStart(2, '0')

/** Splits an inclusive 'YYYY-MM-DD' range into calendar-month chunks (each clipped to the range). */
export function monthChunks(start: string, end: string): MonthChunk[] {
  if (!start || !end || start > end) return []
  const out: MonthChunk[] = []
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7))
  const endY = Number(end.slice(0, 4)), endM = Number(end.slice(5, 7))
  while (y < endY || (y === endY && m <= endM)) {
    const first = `${y}-${pad(m)}-01`
    const last = `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`
    out.push({ month: first, start: first < start ? start : first, end: last > end ? end : last })
    m++
    if (m > 12) { m = 1; y++ }
  }
  return out
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export function monthLabel(month: string): string {
  const d = new Date(`${month.slice(0, 7)}-01T00:00:00Z`)
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
}
