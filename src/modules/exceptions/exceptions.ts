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
}
export const DEFAULT_EXCEPTION_CONFIG: ExceptionConfig = {
  types: [...REPORT_TYPES],
  issues: { ...DEFAULT_ISSUES },
  responseDays: 3,
}

// A response counts as "yes" when it starts affirmatively (matches the sheet's "Yes 8/5").
export function isYesResponse(response: string | null | undefined): boolean {
  return /^(y|yes|true|1)\b/i.test((response ?? '').trim())
}

// Response state given the response-days window: 'yes' | 'no' (overdue, no yes) | 'pending'.
export function responseState(
  r: { response: string | null; contacted_date: string | null; date_of_finding: string | null },
  responseDays: number,
): 'yes' | 'no' | 'pending' {
  if (isYesResponse(r.response)) return 'yes'
  const start = r.contacted_date || r.date_of_finding
  if (!start) return 'pending'
  const days = Math.floor((Date.now() - new Date(start + 'T00:00:00').getTime()) / 86400000)
  return days > responseDays ? 'no' : 'pending'
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
