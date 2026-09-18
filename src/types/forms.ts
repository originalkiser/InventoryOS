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
  | 'formula'
  | 'package_pricing'

export interface FieldOption {
  id: string
  label: string
  score: number
}

// `calculation` (score-total, unchanged) keeps `operation: 'sum'` — its
// runtime value is actually a blanket sum of every scored choice field on
// the form (FormCanvas's calcScore()), not scoped by `source_fields` at
// all; this config only ever fed the builder's own picker UI. `formula`
// (2026-09-16, general-purpose calculating field) is a distinct field type
// that DOES use `source_fields`/`operation` for real, plus the additional
// `formula` operator: a free-text expression referencing other fields as
// `{Field Label}` tokens, evaluated by src/lib/formulaEval.ts (no eval()).
// Both types share this one jsonb config shape/column since it was already
// a flexible bag with no fixed shape at the DB level.
export interface CalculationConfig {
  source_fields: string[]
  operation: 'sum' | 'average' | 'difference' | 'product' | 'formula'
  formula?: string
  label: string
}

// One row of a `package_pricing` field's response (2026-09-16, acquisition
// pricing worksheets) — see src/lib/packagePricing.ts for the shared
// OTD-default/penetration-auto-split math. Stored as an ARRAY on
// FormResponse.value_json for that (submission, field) — package_pricing
// is the one field type whose response isn't a single scalar.
export interface PackagePricingRow {
  id: string
  package_name: string
  oil_type: string
  oil_brand: string | null
  package_price: number | null
  quarts_included: number | null
  price_per_quart_after: number | null
  tax_mode: 'included' | 'added' | null
  // 'premium_only' (2026-09-18) — the filter is only added on top for the
  // premium tier, not every sale; paired with avg_filter_price the same way
  // 'added' is, just a distinct label so the two aren't conflated on the
  // results table.
  filter_mode: 'included' | 'added' | 'premium_only' | null
  // Average filter price entered only when filter_mode is 'added' or
  // 'premium_only' — omitted (null) for 'included', where there's no
  // separate filter charge to average.
  avg_filter_price: number | null
  // Out-the-door price: auto-fills from package_price until the analyst
  // types their own number, at which point otd_price_is_manual flips true
  // and it stops following package_price.
  otd_price: number | null
  otd_price_is_manual: boolean
  // Penetration % of total volume for this package — null means "not yet
  // entered," in which case it splits the remaining percentage evenly with
  // every other not-yet-entered row (see effectivePenetrationPct()); a
  // non-null value is the seller/analyst's own explicit figure.
  penetration_pct: number | null
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
  category: string | null
  visibility: 'private' | 'org' | 'departments' | 'public'
  created_by: string | null
  share_token: string
  // Customizable, memorable public URL segment — forms.sboc.app/:slug —
  // set from the Share modal's Custom URL field. Globally unique (not just
  // per-company): the subdomain path has no company qualifier in it.
  slug: string | null
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
  // Generic structured-value escape hatch (migration
  // 20260930x_forms_formula_package_pricing.sql) — currently only used by
  // `package_pricing` fields, holding a PackagePricingRow[].
  value_json?: PackagePricingRow[] | null
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

export interface FormDepartmentShare {
  id: string
  form_id: string
  department: string
  created_by: string | null
  created_at: string
}

export interface SubmissionAccessRule {
  id: string
  form_id: string
  principal_type: 'user' | 'department' | 'role' | 'org'
  principal_value: string | null
  can_read: boolean
  can_write: boolean
  created_by: string | null
  created_at: string
}

// Non-login share link for a form's Results/submissions table (2026-09-18)
// — a token grants either 'read' (view only) or 'edit' (same override +
// tracking-column editing an internal canWrite user already has) access to
// ONE form's submissions, with an optional expiration. Public reads/writes
// go through SECURITY DEFINER RPCs (get_submission_share_data,
// submission_share_save_override/_revert_override/_save_column_value —
// see migration 20260930ag_forms_submission_shares.sql), never a direct
// anon table read, since a submissions table can carry real respondent
// business data.
export interface SubmissionShare {
  token: string
  form_id: string
  company_id: string
  label: string | null
  permission: 'read' | 'edit'
  expires_at: string | null
  active: boolean
  created_by: string | null
  created_at: string
}

export interface SubmissionColumn {
  id: string
  form_id: string
  label: string
  column_type: 'text' | 'number' | 'date' | 'status' | 'checkbox' | 'select' | 'user'
  options: { label: string; color?: string }[]
  sort_order: number
  created_by: string | null
  created_at: string
}

export interface SubmissionColumnValue {
  id: string
  submission_id: string
  column_id: string
  value: string | null
  updated_by: string | null
  updated_at: string
}

export interface ResponseOverride {
  id: string
  response_id: string
  submission_id: string
  field_id: string
  original_value_text: string | null
  original_value_array: string[] | null
  original_value_option_id: string | null
  override_value_text: string | null
  override_value_array: string[] | null
  override_value_option_id: string | null
  overridden_by: string | null
  overridden_at: string
  override_note: string | null
}

export interface AssignmentRule {
  id: string
  form_id: string
  rule_name: string
  rule_type: 'interval' | 'set_dates' | 'file_import'
  interval_unit: 'day' | 'week' | 'month' | 'quarter' | 'year' | null
  interval_value: number | null
  interval_start_date: string | null
  set_dates: string[] | null
  assign_to_type: 'users' | 'locations' | 'department' | null
  assign_to_users: string[] | null
  assign_to_locations: string[] | null
  assign_to_department: string | null
  due_offset_days: number
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface AssignmentRuleLog {
  id: string
  rule_id: string
  assignment_id: string | null
  fired_at: string
  due_date: string | null
}

// Draft type used in the builder (before DB save)
export type DraftField = Omit<FormField, 'created_at' | 'form_id'> & { form_id?: string }
