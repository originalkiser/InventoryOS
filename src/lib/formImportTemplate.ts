import * as XLSX from 'xlsx'
import type { DraftField } from '@/types/forms'
import type { FieldType } from '@/types/forms'

export interface ImportPreviewRow {
  id: string
  label: string
  description: string
  fieldType: FieldType | null
  rawType: string
  options: { label: string; score: number }[]
  isRequired: boolean
  isUnknownType: boolean
  selected: boolean
}

const VALID_TYPES = new Set<FieldType>([
  'short_answer', 'long_answer', 'multiple_choice', 'multi_select',
  'dropdown', 'date', 'number', 'file_upload', 'text_block', 'calculation',
])

export function downloadFormImportTemplate() {
  const wb = XLSX.utils.book_new()

  const templateData = [
    ['Field Label', 'Description / Helper Text', 'Field Type', 'Response Options (comma separated)', 'Response Values / Scores', 'Required (yes/no)'],
    ['Customer Name', "Enter the customer's full name", 'short_answer', '', '', 'yes'],
    ['Satisfaction Rating', 'How satisfied were you overall?', 'multiple_choice', 'Very Satisfied,Satisfied,Neutral,Dissatisfied', '4,3,2,1', 'yes'],
    ['Issues Experienced', 'Select all that apply', 'multi_select', 'Wait time,Staff attitude,Cleanliness,Price', '', 'no'],
    ['Visit Date', 'Date of your visit', 'date', '', '', 'no'],
    ['Additional Comments', "Any other feedback you'd like to share", 'long_answer', '', '', 'no'],
    ['Upload Receipt', 'Optional — attach your receipt', 'file_upload', '', '', 'no'],
    ['Welcome', 'Please complete all required fields marked with *', 'text_block', '', '', 'no'],
  ]

  const typeCodes = [
    ['Type Code', 'Description'],
    ['short_answer', 'Single line text input'],
    ['long_answer', 'Multi-line text area'],
    ['multiple_choice', 'Single select — radio buttons'],
    ['multi_select', 'Multiple select — checkboxes'],
    ['dropdown', 'Dropdown select menu'],
    ['date', 'Date picker'],
    ['number', 'Numeric input'],
    ['file_upload', 'File attachment upload'],
    ['text_block', 'Static text / instructions (no response collected)'],
    ['calculation', 'Auto-calculated score total (no user input)'],
  ]

  const ws1 = XLSX.utils.aoa_to_sheet(templateData)
  const ws2 = XLSX.utils.aoa_to_sheet(typeCodes)
  XLSX.utils.book_append_sheet(wb, ws1, 'Form Template')
  XLSX.utils.book_append_sheet(wb, ws2, 'Type Codes')
  XLSX.writeFile(wb, 'SBNet_Form_Import_Template.xlsx')
}

export function downloadAssignmentTemplate() {
  const wb = XLSX.utils.book_new()
  const data = [
    ['Assignee Email', 'Due Date (YYYY-MM-DD)', 'Location (optional)', 'Notes (optional)'],
    ['user@example.com', '2026-07-01', '', 'First assignment'],
    ['another@example.com', '2026-07-15', 'Location 47', ''],
  ]
  const ws = XLSX.utils.aoa_to_sheet(data)
  XLSX.utils.book_append_sheet(wb, ws, 'Assignments')
  XLSX.writeFile(wb, 'SBNet_Assignment_Import_Template.xlsx')
}

export async function parseFormImportFile(file: File): Promise<ImportPreviewRow[]> {
  const buffer = await file.arrayBuffer()
  const wb = XLSX.read(buffer, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })

  // Skip header row
  const dataRows = rows.slice(1)
  const result: ImportPreviewRow[] = []

  for (const row of dataRows) {
    const label = String(row[0] ?? '').trim()
    if (!label) continue

    const description = String(row[1] ?? '').trim()
    const rawType = String(row[2] ?? '').trim().toLowerCase()
    const optionsRaw = String(row[3] ?? '').trim()
    const scoresRaw = String(row[4] ?? '').trim()
    const requiredRaw = String(row[5] ?? '').trim().toLowerCase()

    const isUnknownType = rawType !== '' && !VALID_TYPES.has(rawType as FieldType)
    const fieldType = VALID_TYPES.has(rawType as FieldType) ? (rawType as FieldType) : null

    const optionLabels = optionsRaw ? optionsRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
    const scoreValues = scoresRaw ? scoresRaw.split(',').map((s) => Number(s.trim()) || 0) : []
    const options = optionLabels.map((label, i) => ({ label, score: scoreValues[i] ?? 0 }))

    result.push({
      id: crypto.randomUUID(),
      label,
      description,
      fieldType,
      rawType,
      options,
      isRequired: requiredRaw === 'yes' || requiredRaw === 'true' || requiredRaw === '1',
      isUnknownType,
      selected: !isUnknownType,
    })
  }

  return result
}

export function importRowToField(row: ImportPreviewRow, order: number): DraftField {
  const type = row.fieldType ?? 'short_answer'
  return {
    id: crypto.randomUUID(),
    field_type: type,
    label: row.label,
    placeholder: null,
    helper_text: row.description || null,
    is_required: row.isRequired,
    sort_order: order,
    options: row.options.map((o) => ({ ...o, id: crypto.randomUUID() })),
    calculation_config: { source_fields: [], operation: 'sum', label: 'Total Score' },
    file_types_allowed: null,
    max_file_size_mb: 25,
    content: type === 'text_block' ? row.description : null,
  }
}
