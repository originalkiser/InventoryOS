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
