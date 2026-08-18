// Shared types + constants for Exception Reporting.
// Defaults live here in code; "add to list" customs persist to inventory.exception_issue_option.

export interface ExceptionReport {
  id: string
  company_id: string
  location_id: string | null
  area_manager: string | null
  date_of_finding: string | null
  date_of_shop_action: string | null
  report_type: string | null
  issue: string | null
  details: string | null
  contacted: boolean
  contacted_date: string | null
  response: string | null
  rd_if_no: string | null
  response_notes: string | null
  status: string | null
  metadata: Record<string, unknown> | null
  updated_by: string | null
  last_change_source: string | null
  created_at: string
  updated_at: string
}

export interface ExceptionIssueOption {
  id: string
  company_id: string
  report_type: string
  value: string
  created_at: string
}

export const REPORT_TYPES = ['PO Match', 'Activity', 'Current On Hand'] as const

// Default ER Issue options per report type. Customs are merged in from the DB.
export const DEFAULT_ISSUES: Record<string, string[]> = {
  'PO Match': ['Receipt <> Invoice', 'Missing Receipt', 'Missing Invoice(s)', 'Received before Delivered'],
  'Activity': ['Large (>50) Positive Adjustment', 'Large (<-50) Negative Adjustment'],
  'Current On Hand': ['Higher than Expected', 'Lower than Expected', 'Duplicate Case Types'],
}

export const EXCEPTION_STATUSES = [
  'Pending Shop/AM Response',
  'Pending RelaDyne Response',
  'Pending Procurement Action',
  'Tentatively Closed',
  'Closed',
] as const

export const DEFAULT_STATUS = 'Pending Shop/AM Response'

// Editable config persisted per-company in platform.app_settings (key 'exception_config').
export interface ExceptionConfig {
  types: string[]
  issues: Record<string, string[]>
  responseDays: number
  statuses: string[]
  // "Needs action" highlighting — separate from responseDays (RD escalation).
  // A non-closed row older than staleDays highlights red and counts toward
  // the nav badge, unless bumped (deferred bumpDays via the Bump action).
  staleDays: number
  bumpDays: number
}
export const DEFAULT_EXCEPTION_CONFIG: ExceptionConfig = {
  types: [...REPORT_TYPES],
  issues: { ...DEFAULT_ISSUES },
  responseDays: 3,
  statuses: [...EXCEPTION_STATUSES],
  staleDays: 3,
  bumpDays: 3,
}

// Fixed response values (the table renders these as buttons).
export const RESPONSE_YES = 'Yes'
export const RESPONSE_YES_RD = 'Yes (after RD added)'
export const RESPONSE_NO = 'No'
export const RESPONSE_OPTIONS = [RESPONSE_YES, RESPONSE_YES_RD, RESPONSE_NO] as const

// A response counts as "yes" when affirmative (covers both Yes variants + legacy "Yes 8/5").
export function isYesResponse(response: string | null | undefined): boolean {
  return /^(y|yes|true|1)\b/i.test((response ?? '').trim())
}

// Business days (Mon–Fri) strictly after `start` through today.
export function businessDaysSince(startISO: string | null | undefined): number {
  if (!startISO) return 0
  const start = new Date(startISO + 'T00:00:00')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  let count = 0
  const d = new Date(start); d.setDate(d.getDate() + 1)
  while (d <= today) { const wd = d.getDay(); if (wd !== 0 && wd !== 6) count++; d.setDate(d.getDate() + 1) }
  return count
}

// Was the regional director escalated? Explicit "Yes (after RD added)"/"No", or an
// overdue no-response (response window passed with no yes).
export function isRdAdded(
  r: { response: string | null; contacted: boolean; contacted_date: string | null; date_of_finding: string | null },
  responseDays: number,
): boolean {
  if (!r.contacted) return false
  if (r.response === RESPONSE_YES_RD || r.response === RESPONSE_NO) return true
  if (isYesResponse(r.response)) return false
  return businessDaysSince(r.contacted_date || r.date_of_finding) > responseDays
}

// What the "Regional Director" cell should show:
//  - 'none' : responded plainly / no start date
//  - 'left' : still inside the window — daysLeft business days remaining
//  - 'rd'   : window passed (or escalated) — show the RD name
export interface RdCell { mode: 'none' | 'left' | 'rd'; daysLeft?: number }
export function rdCell(
  r: { response: string | null; contacted: boolean; contacted_date: string | null; date_of_finding: string | null },
  responseDays: number,
): RdCell {
  if (!r.contacted) return { mode: 'none' }
  if (r.response === RESPONSE_YES) return { mode: 'none' }
  if (r.response === RESPONSE_YES_RD || r.response === RESPONSE_NO) return { mode: 'rd' }
  const start = r.contacted_date || r.date_of_finding
  if (!start) return { mode: 'none' }
  const left = responseDays - businessDaysSince(start)
  return left > 0 ? { mode: 'left', daysLeft: left } : { mode: 'rd' }
}

// When to check back on this finding. Stored in metadata alongside
// impacted_products rather than as its own column, so it needs no migration.
export function followUpDate(r: { metadata?: Record<string, unknown> | null } | null | undefined): string | null {
  const v = (r?.metadata as any)?.follow_up_date
  return typeof v === 'string' && v ? v : null
}

// A follow-up is overdue once its date has passed and the report isn't closed.
export function isFollowUpOverdue(r: { metadata?: Record<string, unknown> | null; status: string | null }): boolean {
  const d = followUpDate(r)
  if (!d) return false
  if ((r.status ?? '').toLowerCase().includes('closed')) return false
  return new Date(d + 'T00:00:00').getTime() < new Date().setHours(0, 0, 0, 0)
}

// Products the finding affects — stored in metadata (not a dedicated column)
// since it's an optional, recently-added field. Selected from the shop's
// configured products, mirroring Location Comms' product picker.
export function impactedProducts(r: { metadata?: Record<string, unknown> | null } | null | undefined): string[] {
  const v = (r?.metadata as any)?.impacted_products
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

// Parse the sheet's "Contacted?" cell ("Yes 8/5", "Yes 8/4") into a flag + date.
// Returns { contacted, contacted_date(YYYY-MM-DD | null) }.
export function parseContacted(raw: string, fallbackYear: number): { contacted: boolean; contacted_date: string | null } {
  const t = (raw ?? '').trim()
  if (!t) return { contacted: false, contacted_date: null }
  const contacted = /^(y|yes|true|1)\b/i.test(t) || /\byes\b/i.test(t)
  const m = t.match(/(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/)
  if (!m) return { contacted, contacted_date: null }
  const mo = Number(m[1]), day = Number(m[2])
  let yr = m[3] ? Number(m[3]) : fallbackYear
  if (yr < 100) yr += 2000
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return { contacted, contacted_date: null }
  return { contacted, contacted_date: `${yr}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}` }
}
