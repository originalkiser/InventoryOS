// Pure parsing functions for RelaDyne's 3 monthly spreadsheet exports — no
// React/Supabase, same separation convention as orders-v2/engine.ts. Each
// function takes a parsed XLSX.WorkBook (via the `xlsx` package, already a
// dependency) and returns plain row objects ready to upsert.
//
// All 3 source files are hand-exported reports with irregular, non-tabular
// layouts (title rows, side-by-side month blocks, embedded sub-tables at
// odd column offsets) — none of them fit this app's generic
// fileParser.ts/FileUploadZone (single header row + flat columns), so these
// read the raw sheet grid directly via `sheet_to_json(ws, {header:1})`
// rather than going through that shared parser.
import * as XLSX from 'xlsx'

function sheetGrid(wb: XLSX.WorkBook, sheetName: string): unknown[][] {
  const ws = wb.Sheets[sheetName]
  if (!ws) return []
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) as unknown[][]
}

function str(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
function numOrNull(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Finds the (row, col) of the first cell whose trimmed text matches `label`
// — used to locate a small embedded sub-table (OTIF stats, the Volume
// Commitment table) without hardcoding its exact position, since a
// regenerated report could shift columns slightly between months.
function findLabelCell(grid: unknown[][], label: string): { row: number; col: number } | null {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    for (let c = 0; c < row.length; c++) {
      if (str(row[c]) === label) return { row: r, col: c }
    }
  }
  return null
}

const MONTH_NUM: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
}
function monthToPeriod(monthName: string, year: number): string | null {
  const mm = MONTH_NUM[monthName.trim().toLowerCase()]
  return mm ? `${year}-${mm}` : null
}

// ── 1. Product Gallons workbook → StricklandData sheet (raw line items) ───

export interface VolumeDataRow {
  customer_name: string | null
  customer_no: string
  ship_to_name: string | null
  ship_to_code: string
  product_code: string
  product_desc: string
  package_group: string | null
  gallons_ordered: number | null
  gallons_billed: number | null
  revenue: number | null
  revenue_per_gallon: number | null
  period: string
  store_type: string | null
  year: number | null
}

/**
 * StricklandData's own header lives on row index 2 (0-based) — rows 0-1 are
 * a title line and a blank spacer. Columns (confirmed against a real
 * export): CustomerName, CustomerNo, ShipToName, ShipToCode, ProductCode,
 * ProductCodeDesc, PackageGroup, Gallons_Ordered, Gallons, Revenue,
 * Revenue_per_Gallon, Period ('YYYY-MM', already explicit), Store Type,
 * Year. Rows missing a customer_no/ship_to_code/product_code/period are
 * skipped (seen in practice: a stray "T5 LESS THAN MIN QTY DLV" summary
 * line with nulls in most columns).
 */
export function parseVolumeDataWorkbook(wb: XLSX.WorkBook): VolumeDataRow[] {
  const grid = sheetGrid(wb, 'StricklandData')
  const out: VolumeDataRow[] = []
  for (let i = 3; i < grid.length; i++) {
    const row = grid[i]
    if (!row) continue
    const customer_no = str(row[1])
    const ship_to_code = str(row[3])
    const product_code = str(row[4])
    const period = str(row[11])
    if (!customer_no || !ship_to_code || !product_code || !period) continue
    out.push({
      customer_name: str(row[0]),
      customer_no,
      ship_to_name: str(row[2]),
      ship_to_code,
      product_code,
      product_desc: str(row[5]) ?? product_code,
      package_group: str(row[6]),
      gallons_ordered: numOrNull(row[7]),
      gallons_billed: numOrNull(row[8]),
      revenue: numOrNull(row[9]),
      revenue_per_gallon: numOrNull(row[10]),
      period,
      store_type: str(row[12]),
      year: numOrNull(row[13]),
    })
  }
  return out
}

// ── 2. "SBI Item Fill Stat Trend Data" workbook → "Export" sheet ───────────

export interface ItemFillRow {
  product_desc: string
  period: string
  order_count: number | null
  fill_count: number | null
  item_fill_pct: number | null
}

/**
 * Side-by-side month blocks (June/July/August seen in the first real
 * export, but the block COUNT is detected dynamically, not hardcoded to 3,
 * since a future upload could cover a different span of months) — row
 * index 1 has the month label at each block's FIRST column, row index 2 is
 * the repeated sub-header (ProductCodeDesc/Order Count/Fill Count/Item
 * Fill %), data starts at row index 3. Each block runs until ITS OWN first
 * blank/"Total" row — blocks don't all have the same row count (a product
 * with orders in July but not August just stops appearing in August's
 * block earlier).
 */
export function parseItemFillStatsWorkbook(wb: XLSX.WorkBook, year: number): ItemFillRow[] {
  const grid = sheetGrid(wb, 'Export')
  const monthRow = grid[1] ?? []
  const blockStarts: { col: number; period: string }[] = []
  for (let c = 0; c < monthRow.length; c++) {
    const label = str(monthRow[c])
    if (!label) continue
    const period = monthToPeriod(label, year)
    if (period) blockStarts.push({ col: c, period })
  }

  const out: ItemFillRow[] = []
  for (const block of blockStarts) {
    for (let r = 3; r < grid.length; r++) {
      const row = grid[r]
      if (!row) break
      const productDesc = str(row[block.col])
      if (!productDesc || productDesc.toLowerCase() === 'total') break
      out.push({
        product_desc: productDesc,
        period: block.period,
        order_count: numOrNull(row[block.col + 1]),
        fill_count: numOrNull(row[block.col + 2]),
        // Source stores this as a 0..1 fraction (e.g. 0.8512...) — stored
        // as a 0..100 percent for consistency with the OTIF stats table
        // below, which is what every % value in this module uses.
        item_fill_pct: numOrNull(row[block.col + 3]) != null ? (numOrNull(row[block.col + 3]) as number) * 100 : null,
      })
    }
  }
  return out
}

// ── 3. MMR workbook → 4 OTIF sheets + Volume Summary's commitment table ───

export interface OtifRow {
  segment: 'corp_bulk' | 'fz_bulk' | 'corp_package' | 'fz_package'
  period: string
  otif_pct: number | null
  on_time_pct: number | null
  in_full_pct: number | null
}
export interface CommitmentRow {
  year: number
  month: string
  period: string
  volume_commitment_gal: number | null
  volume_actual_gal: number | null
  pct: number | null
}

const OTIF_SHEETS: { sheet: string; segment: OtifRow['segment'] }[] = [
  { sheet: 'Corp OTIF 90 - Bulk', segment: 'corp_bulk' },
  { sheet: 'FZ OTIF 90 - Bulk', segment: 'fz_bulk' },
  { sheet: 'Corp OTIF 90 - Package', segment: 'corp_package' },
  { sheet: 'Fz OTIF 90 - Package', segment: 'fz_package' },
]

/**
 * Each OTIF sheet has its own small sub-table at a slightly different
 * column offset (found live: Corp/Fz Bulk and Fz Package start at column
 * 13, Corp Package at column 15) — located dynamically by searching for
 * the literal "Time Period" header cell rather than hardcoding a column
 * index, since a regenerated report could shift columns. Columns
 * immediately to its right are OTIF %/On Time %/In Full %. Stops at the
 * sheet's own "Total" row (a same-range rollup, not a real month — not
 * useful to store once periods have an explicit year, since it can always
 * be recomputed from the real months).
 */
export function parseOtifSheets(wb: XLSX.WorkBook, year: number): OtifRow[] {
  const out: OtifRow[] = []
  for (const { sheet, segment } of OTIF_SHEETS) {
    const grid = sheetGrid(wb, sheet)
    const header = findLabelCell(grid, 'Time Period')
    if (!header) continue
    for (let r = header.row + 1; r < grid.length; r++) {
      const row = grid[r]
      if (!row) break
      const monthLabel = str(row[header.col])
      if (!monthLabel || monthLabel.toLowerCase() === 'total') continue
      const period = monthToPeriod(monthLabel, year)
      if (!period) continue
      const pct100 = (v: unknown) => (numOrNull(v) != null ? (numOrNull(v) as number) * 100 : null)
      out.push({
        segment, period,
        otif_pct: pct100(row[header.col + 1]),
        on_time_pct: pct100(row[header.col + 2]),
        in_full_pct: pct100(row[header.col + 3]),
      })
    }
  }
  return out
}

/**
 * Volume Summary's own embedded Year/Month/Volume Commitment (Gal)/Volume
 * Actual (Gal)/% table — located the same way as the OTIF sub-tables
 * (search for the "Year" header cell, same row also has "Month"/"Volume
 * Commitment (Gal)" to its right). Skips a rollup row like "YEAR 1" (Month
 * is null there) and any blank trailing rows.
 */
export function parseVolumeCommitment(wb: XLSX.WorkBook): CommitmentRow[] {
  const grid = sheetGrid(wb, 'Volume Summary')
  const header = findLabelCell(grid, 'Year')
  if (!header) return []
  const out: CommitmentRow[] = []
  for (let r = header.row + 1; r < grid.length; r++) {
    const row = grid[r]
    if (!row) continue
    const year = numOrNull(row[header.col])
    const month = str(row[header.col + 1])
    if (!year || !month) continue
    const period = monthToPeriod(month, year)
    if (!period) continue
    out.push({
      year, month, period,
      volume_commitment_gal: numOrNull(row[header.col + 2]),
      volume_actual_gal: numOrNull(row[header.col + 3]),
      // Already a 0..1-ish ratio in the source (e.g. 1.015... = 101.5%) —
      // stored as a real percent (x100) for consistency with the other
      // stored %s in this module.
      pct: numOrNull(row[header.col + 4]) != null ? (numOrNull(row[header.col + 4]) as number) * 100 : null,
    })
  }
  return out
}
