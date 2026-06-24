import type { FormTheme } from '@/lib/resolveThemeColors'

export type FieldType =
  | 'text_block'
  | 'short_answer'
  | 'long_answer'
  | 'multiple_choice'
  | 'multi_select'
  | 'dropdown'
  | 'file_upload'
  | 'date'
  | 'number'
  | 'calculation'

export interface FieldOption {
  id: string
  label: string
  score: number
}

export interface CalculationConfig {
  source_fields: string[]
  operation: 'sum'
  label: string
}

export interface FormField {
  id: string
  form_id: string
  field_type: FieldType
  label: string
  placeholder: string | null
  helper_text: string | null
  is_required: boolean
  sort_order: number
  options: FieldOption[]
  calculation_config: Partial<CalculationConfig>
  file_types_allowed: string[] | null
  max_file_size_mb: number
  content: string | null
  created_at: string
}

export interface FormDefinition {
  id: string
  company_id: string | null
  title: string
  description: string | null
  department: string
  created_by: string | null
  share_token: string
  is_published: boolean
  is_accepting_responses: boolean
  show_score_to_respondent: boolean
  allow_multiple_submissions: boolean
  requires_login: boolean
  theme: FormTheme
  created_at: string
  updated_at: string
}

export interface ConditionRule {
  id: string
  condition_id: string
  source_field_id: string
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'greater_than' | 'less_than' | 'is_answered' | 'is_empty'
  value: string | null
}

export interface FieldCondition {
  id: string
  form_id: string
  target_field_id: string
  action: 'show' | 'hide'
  logic_operator: 'and' | 'or'
  rules: ConditionRule[]
}

export interface FormAssignment {
  id: string
  form_id: string
  assigned_to: string | null
  assigned_to_location: string | null
  due_date: string | null
  assigned_by: string | null
  is_completed: boolean
  completed_at: string | null
  created_at: string
}

export interface FormSubmission {
  id: string
  form_id: string
  submitted_by: string | null
  respondent_email: string | null
  respondent_name: string | null
  location_id: string | null
  assignment_id: string | null
  total_score: number | null
  max_possible_score: number | null
  submitted_at: string
}

export interface FormResponse {
  id: string
  submission_id: string
  field_id: string
  value_text: string | null
  value_array: string[] | null
  value_option_id: string | null
  value_score: number | null
  file_paths: string[] | null
}

export interface ScoreStreak {
  id: string
  form_id: string
  field_id: string
  location_id: string | null
  streak_score: number | null
  streak_count: number
  last_submission_id: string | null
  updated_at: string
}

// Draft type used in the builder (before DB save)
export type DraftField = Omit<FormField, 'created_at' | 'form_id'> & { form_id?: string }
