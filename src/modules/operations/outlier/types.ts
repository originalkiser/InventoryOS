export type UserRole = 'admin' | 'department' | 'area_manager' | 'director'

export interface UserProfile {
  id: string
  auth_user_id: string | null
  work_email: string
  full_name: string | null
  role: UserRole
  region: string | null
  area: string | null
  is_active: boolean
  created_at: string
  last_login_at: string | null
}

export interface AMLocation {
  id: string
  user_id: string
  location_id: string
  location_name: string | null
}

export interface Department {
  id: string
  name: string
  slug: string
  sort_order: number
}

export type ColumnType = 'location' | 'employee' | 'number' | 'percent' | 'text' | 'date'

export interface ColumnDef {
  key: string
  label: string
  type: ColumnType
  required?: boolean
  editable_by?: 'area_manager' | 'department'
}

export interface Report {
  id: string
  department_id: string
  name: string
  slug: string
  description: string | null
  columns: ColumnDef[]
  is_employee_report: boolean
  sort_order: number
  created_at: string
  department?: Department
}

export interface Week {
  id: string
  week_start: string
  week_end: string
  label: string
  created_at: string
}

export interface ReportEntry {
  id: string
  report_id: string
  week_id: string
  row_key: string
  row_label: string
  row_type: 'data' | 'total'
  data: Record<string, unknown>
  am_comment: string | null
  am_comment_updated_at: string | null
  am_comment_updated_by: string | null
  due_date: string | null
  is_complete: boolean
  submitted_by: string | null
  location_id: string | null
  area_manager_name: string | null
  rdo_name: string | null
  created_at: string
  updated_at: string
}

export interface PasteLog {
  id: string
  report_id: string
  week_id: string
  raw_text: string | null
  parsed_row_count: number
  submitted_by: string | null
  created_at: string
}

export interface ParsedRow {
  row_key: string
  row_label: string
  row_type: 'data' | 'total'
  data: Record<string, unknown>
  matched: boolean
  originalText: string
}

export type WeekSelection = 'this' | 'last' | 'custom'

export interface WeekRange {
  start: Date
  end: Date
}
