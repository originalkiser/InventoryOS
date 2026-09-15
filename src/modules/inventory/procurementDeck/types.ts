export interface GridCell {
  id: string
  slide_key: string
  table_key: string
  row_label: string
  row_sort: number
  col_key: string
  col_label: string
  col_sort: number
  value_num: number | null
}

export interface KpiItem {
  id: string
  slide_key: string
  table_key: string
  kpi_key: string
  label: string
  value_text: string | null
  sort_order: number
}

export interface ListItemRow {
  id: string
  slide_key: string
  table_key: string
  item_text: string
  sort_order: number
}

export interface FieldHistoryEntry {
  id: string
  slide_key: string
  table_key: string
  field_kind: 'grid' | 'kpi'
  row_label: string | null
  col_key: string | null
  kpi_key: string | null
  old_value_num: number | null
  old_value_text: string | null
  changed_at: string
}

export interface PeriodConfig {
  id: string
  slide_key: string
  period_key: 'usage' | 'contract'
  start_col_key: string | null
  start_label: string | null
  end_col_key: string | null
  end_label: string | null
  target_num: number | null
}
