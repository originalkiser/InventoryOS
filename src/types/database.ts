// Minimal hand-typed DB types — replace with `supabase gen types typescript` after linking project

export type Json = string | number | boolean | null | { [key: string]: Json } | Json[]

export interface Database {
  public: {
    Tables: {
      companies: { Row: Company; Insert: Partial<Company>; Update: Partial<Company> }
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> }
      locations: { Row: Location; Insert: Partial<Location>; Update: Partial<Location> }
      vendors: { Row: Vendor; Insert: Partial<Vendor>; Update: Partial<Vendor> }
      vendor_parts: { Row: VendorPart; Insert: Partial<VendorPart>; Update: Partial<VendorPart> }
      product_id_mappings: { Row: ProductIdMapping; Insert: Partial<ProductIdMapping>; Update: Partial<ProductIdMapping> }
      global_products: { Row: GlobalProduct; Insert: Partial<GlobalProduct>; Update: Partial<GlobalProduct> }
      location_order_configs: { Row: LocationOrderConfig; Insert: Partial<LocationOrderConfig>; Update: Partial<LocationOrderConfig> }
      monthly_ending_balances: { Row: MonthlyEndingBalance; Insert: Partial<MonthlyEndingBalance>; Update: Partial<MonthlyEndingBalance> }
      data_source_links: { Row: DataSourceLink; Insert: Partial<DataSourceLink>; Update: Partial<DataSourceLink> }
      monthly_counts: { Row: MonthlyCount; Insert: Partial<MonthlyCount>; Update: Partial<MonthlyCount> }
      monthly_count_products: { Row: MonthlyCountProduct; Insert: Partial<MonthlyCountProduct>; Update: Partial<MonthlyCountProduct> }
      recount_requests: { Row: RecountRequest; Insert: Partial<RecountRequest>; Update: Partial<RecountRequest> }
      recount_config: { Row: RecountConfig; Insert: Partial<RecountConfig>; Update: Partial<RecountConfig> }
      weekly_counts: { Row: WeeklyCount; Insert: Partial<WeeklyCount>; Update: Partial<WeeklyCount> }
      order_sessions: { Row: OrderSession; Insert: Partial<OrderSession>; Update: Partial<OrderSession> }
      order_line_items: { Row: OrderLineItem; Insert: Partial<OrderLineItem>; Update: Partial<OrderLineItem> }
      issue_categories: { Row: IssueCategory; Insert: Partial<IssueCategory>; Update: Partial<IssueCategory> }
      issue_statuses: { Row: IssueStatus; Insert: Partial<IssueStatus>; Update: Partial<IssueStatus> }
      issues: { Row: Issue; Insert: Partial<Issue>; Update: Partial<Issue> }
      schedule_events: { Row: ScheduleEvent; Insert: Partial<ScheduleEvent>; Update: Partial<ScheduleEvent> }
      count_upload_batches: { Row: CountUploadBatch; Insert: Partial<CountUploadBatch>; Update: Partial<CountUploadBatch> }
      count_mapping_templates: { Row: CountMappingTemplate; Insert: Partial<CountMappingTemplate>; Update: Partial<CountMappingTemplate> }
      order_profiles: { Row: OrderProfile; Insert: Partial<OrderProfile>; Update: Partial<OrderProfile> }
      order_min_rules: { Row: OrderMinRule; Insert: Partial<OrderMinRule>; Update: Partial<OrderMinRule> }
      order_documents: { Row: OrderDocument; Insert: Partial<OrderDocument>; Update: Partial<OrderDocument> }
      custom_field_definitions: { Row: CustomFieldDefinition; Insert: Partial<CustomFieldDefinition>; Update: Partial<CustomFieldDefinition> }
    }
  }
}

export type CustomFieldSection = 'locations' | 'order_config' | 'ending_balance' | 'vendor_parts' | 'vendors'

export interface CustomFieldDefinition {
  id: string
  company_id: string
  section: CustomFieldSection
  field_key: string
  label: string
  field_type: 'text' | 'number' | 'date'
  position: number
  linked_section: string | null
  linked_match_key: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export interface Company {
  id: string
  name: string
  created_at: string
}

export interface Profile {
  id: string
  company_id: string | null
  full_name: string | null
  email: string | null
  role: 'admin' | 'user'
  avatar_url: string | null
  created_at: string
  updated_at: string
}

export interface Location {
  id: string
  company_id: string
  location_code: string
  name: string
  region: string | null
  active: boolean
  metadata: Json | null
  created_at: string
  updated_at: string
}

export interface Vendor {
  id: string
  company_id: string
  vendor_code: string
  name: string
  created_at: string
  updated_at: string
}

export interface VendorPart {
  id: string
  company_id: string
  vendor_id: string | null
  part_number: string
  our_part_number: string | null
  description: string | null
  unit_of_measure: string | null
  package_type: string | null
  bulk_minimum: number | null
  individual_minimum: number | null
  metadata: Json | null
  created_at: string
  updated_at: string
}

export interface ProductIdMapping {
  id: string
  company_id: string
  old_product_id: string
  new_product_id: string
  notes: string | null
  created_at: string
  updated_at: string
}

export interface GlobalProduct {
  id: string
  company_id: string
  product_id: string
  unit_of_measure: string | null
  package_type: string | null
  bulk_minimum: number | null
  individual_minimum: number | null
  created_at: string
  updated_at: string
}

export interface LocationOrderConfig {
  id: string
  company_id: string
  location_id: string | null
  product_id: string
  capacity: number | null
  order_trigger: number | null
  order_limit: number | null
  active: boolean
  metadata: Json | null
  updated_by: string | null
  last_change_source: string | null
  created_at: string
  updated_at: string
}

export interface MonthlyEndingBalance {
  id: string
  company_id: string
  location_id: string | null
  month: string
  ending_balance: number
  metadata: Json | null
  updated_by: string | null
  last_change_source: string | null
  uploaded_at: string
  created_at: string
  updated_at: string
}

export interface DataSourceLink {
  id: string
  company_id: string
  config_type: string
  source_type: 'api' | 'google_sheets' | 'onedrive' | 'sharepoint'
  url: string
  refresh_interval_minutes: number | null
  last_synced_at: string | null
  credentials_ref: string | null
  created_at: string
  updated_at: string
}

export interface MonthlyCount {
  id: string
  company_id: string
  location_id: string | null
  count_date: string
  count_month: string | null
  count_type: string | null
  total_adjustments: number | null
  adjustment_value: number | null
  abs_adjustment_value: number | null
  ending_inventory_cost: number | null
  uploaded_at: string
  upload_batch_id: string | null
  created_at: string
  updated_at: string
}

export interface MonthlyCountProduct {
  id: string
  company_id: string
  upload_batch_id: string | null
  count_month: string | null
  location_id: string | null
  product_id: string
  on_hand: number | null
  sold: number | null
  adjusted: number | null
  ending_value: number | null
  created_at: string
  updated_at: string
}

export interface RecountRequest {
  id: string
  company_id: string
  location_id: string | null
  recount_type: string | null
  requested_products: string[] | null
  request_date: string | null
  recount_fields: Json | null
  completed_flags: boolean[] | null
  completed_dates: string[] | null
  recount_status: 'open' | 'in_progress' | 'complete'
  created_at: string
  updated_at: string
}

export interface RecountConfig {
  id: string
  company_id: string
  low_adj_threshold: number | null
  high_adj_threshold: number | null
  low_balance_threshold: number | null
  high_balance_threshold: number | null
  variance_to_median_pct: number | null
  variance_to_last_month_pct: number | null
  median_months_lookback: number | null
  created_at: string
  updated_at: string
}

export interface WeeklyCount {
  id: string
  company_id: string
  location_id: string | null
  count_date: string
  count_type: string | null
  total_adjustments: number | null
  adjustment_value: number | null
  abs_adjustment_value: number | null
  ending_inventory_cost: number | null
  upload_batch_id: string | null
  created_at: string
  updated_at: string
}

export interface OrderSession {
  id: string
  company_id: string
  created_by: string | null
  name: string | null
  status: 'draft' | 'generated' | 'exported' | 'pending' | 'fulfilled'
  source_mode: 'manual' | 'file' | 'live' | null
  input_snapshot: Json | null
  generation_params: Json | null
  export_data: Json | null
  exported_at: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface OrderLineItem {
  id: string
  order_session_id: string
  company_id: string | null
  location_id: string | null
  product_id: string
  vendor_part_number: string | null
  suggested_qty: number | null
  final_qty: number | null
  quantity: number | null
  unit_of_measure: string | null
  package_type: string | null
  applied_min_rule: string | null
  trigger_reason: string | null
  manual_override: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

export interface OrderProfile {
  id: string
  company_id: string
  name: string
  scope: string | null
  config: Json
  created_by: string | null
  created_at: string
}

export interface OrderMinRule {
  id: string
  company_id: string
  name: string | null
  applies_to: Json // { scope, location, field, value }
  bulk_minimum: number | null
  individual_minimum: number | null
  uom: string | null
  package_type: string | null
  rule_logic: Json | null // { caseSize, maxQty, maxOnHandAfter }
  active: boolean
  created_at: string
}

export interface OrderDocument {
  id: string
  company_id: string
  order_session_id: string | null
  stage: 'start' | 'export'
  file_name: string
  storage_path: string
  uploaded_by: string | null
  created_at: string
}

export interface IssueCategory {
  id: string
  company_id: string
  name: string
  created_at: string
}

export interface IssueStatus {
  id: string
  company_id: string
  name: string
  created_at: string
}

export interface Issue {
  id: string
  company_id: string
  location_id: string | null
  category_id: string | null
  status_id: string | null
  start_date: string | null
  target_resolution_date: string | null
  resolved_date: string | null
  resolution_notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ScheduleEvent {
  id: string
  company_id: string
  title: string
  event_type: string
  start_date: string
  end_date: string | null
  recurrence: Json | null
  is_checklist: boolean
  completed: boolean
  completed_at: string | null
  completed_by: string | null
  assigned_to: string[] | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface CountUploadBatch {
  id: string
  company_id: string
  module: 'monthly' | 'weekly'
  count_month: string | null
  file_name: string | null
  source_type: 'file' | 'api' | 'google_sheets' | 'onedrive' | 'sharepoint'
  uploaded_by: string | null
  row_count: number
  created_at: string
}

export interface CountMappingTemplate {
  id: string
  company_id: string
  module: 'monthly_summary' | 'monthly_product' | 'weekly'
  name: string
  mappings: ColumnMappingJson[]
  created_by: string | null
  created_at: string
}

// Shape stored in count_mapping_templates.mappings (mirrors ColumnMapping in types/index.ts)
export interface ColumnMappingJson {
  fieldName: string
  sourceColumn: string
  invert: boolean
}
