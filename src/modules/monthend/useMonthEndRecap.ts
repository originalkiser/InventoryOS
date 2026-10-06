// Data hook for the Month End "Recap" tab — same generic grid-cell pattern
// as Procurement Deck's useProcurementDeck.ts (see migration 20260930ca's
// own header comment for why this is a separate table rather than reusing
// procurement_deck_grid_cells directly), reusing that module's GridCell/
// ListItemRow TYPES and its GridSection/ListSection/DeckChart UI components
// as-is — they're genuinely generic, parameterized by slideKey/tableKey,
// with no procurement-specific logic baked in.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'
import type { GridCell, ListItemRow } from '@/modules/inventory/procurementDeck/types'
import { ownerBucket } from '@/hooks/useLocationExclusions'
import { isRealShopLocation } from '@/hooks/useLocations'
import { ALLOWABLE_TYPE_RULES_KEY, isAllowedCountType, type TypeRule } from './countsShared'
import { areaCells, computeRecap, dailyCells, dailyNotes, dailyTableKey, trendsCells, type CellRow, type RecapResult } from './monthEndRecapCompute'

const SLIDE_KEY = 'monthend_recap'

async function fetchAll<T>(table: string, companyId: string): Promise<T[]> {
  const sb = supabase as any
  const PAGE = 1000
  const out: T[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb.schema('inventory').from(table).select('*')
      .eq('company_id', companyId).order('id', { ascending: true }).range(from, from + PAGE - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

export function useMonthEndRecap() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const [cells, setCells] = useState<GridCell[]>([])
  const [items, setItems] = useState<ListItemRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [c, l] = await Promise.all([
        fetchAll<GridCell>('monthend_recap_grid_cells', companyId),
        fetchAll<ListItemRow>('monthend_recap_list_items', companyId),
      ])
      setCells(c); setItems(l)
    } catch (e) {
      const msg = e instanceof Error ? e.message : (e as { message?: string } | null)?.message
      toast.error(msg || 'Failed to load Month End Recap data')
    } finally {
      setLoading(false)
    }
  }, [companyId])
  useEffect(() => { load() }, [load])

  const gridOf = useCallback((tableKey: string) => cells.filter((c) => c.table_key === tableKey), [cells])
  const listOf = useCallback((tableKey: string) =>
    items.filter((i) => i.table_key === tableKey).sort((a, b) => a.sort_order - b.sort_order), [items])

  async function saveCell(tableKey: string, rowLabel: string, rowSort: number, colKey: string, colLabel: string, colSort: number, value: number | null) {
    if (!companyId) return
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('monthend_recap_grid_cells')
      .upsert({
        company_id: companyId, slide_key: SLIDE_KEY, table_key: tableKey,
        row_label: rowLabel, row_sort: rowSort, col_key: colKey, col_label: colLabel, col_sort: colSort,
        value_num: value, updated_by: userId, updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,slide_key,table_key,row_label,col_key' })
      .select().single()
    if (error) { toast.error(error.message); return }
    setCells((prev) => [...prev.filter((c) => !(c.table_key === tableKey && c.row_label === rowLabel && c.col_key === colKey)), data as GridCell])
  }

  async function deleteGridRow(tableKey: string, rowLabel: string) {
    if (!companyId) return
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('monthend_recap_grid_cells')
      .delete().eq('company_id', companyId).eq('slide_key', SLIDE_KEY).eq('table_key', tableKey).eq('row_label', rowLabel)
    if (error) { toast.error(error.message); return }
    setCells((prev) => prev.filter((c) => !(c.table_key === tableKey && c.row_label === rowLabel)))
    toast.success('Row removed')
  }

  async function addListItem(tableKey: string, text: string) {
    if (!companyId) return
    const sortOrder = Math.max(0, ...listOf(tableKey).map((i) => i.sort_order)) + 1
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('monthend_recap_list_items')
      .insert({ company_id: companyId, slide_key: SLIDE_KEY, table_key: tableKey, item_text: text, sort_order: sortOrder, updated_by: userId })
      .select().single()
    if (error) { toast.error(error.message); return }
    setItems((prev) => [...prev, data as ListItemRow])
  }

  async function saveListItem(id: string, text: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('monthend_recap_list_items')
      .update({ item_text: text, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, item_text: text } : i)))
  }

  async function deleteListItem(id: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('monthend_recap_list_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function moveListItem(tableKey: string, id: string, dir: -1 | 1) {
    const rows = listOf(tableKey)
    const idx = rows.findIndex((r) => r.id === id)
    const swapIdx = idx + dir
    if (idx === -1 || swapIdx < 0 || swapIdx >= rows.length) return
    const a = rows[idx], b = rows[swapIdx]
    const sb = supabase as any
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      sb.schema('inventory').from('monthend_recap_list_items').update({ sort_order: b.sort_order }).eq('id', a.id),
      sb.schema('inventory').from('monthend_recap_list_items').update({ sort_order: a.sort_order }).eq('id', b.id),
    ])
    if (e1 || e2) { toast.error('Failed to reorder'); return }
    setItems((prev) => prev.map((i) => (i.id === a.id ? { ...i, sort_order: b.sort_order } : i.id === b.id ? { ...i, sort_order: a.sort_order } : i)))
  }

  // Upload: same shape as Procurement Deck's own uploadGrid (first column =
  // row label, every other header = a col_key/col_label pair, month-header
  // parsing so a re-upload lines up with existing seeded columns) — this is
  // the "edit/upload a file with more historical data later" path.
  async function uploadGrid(tableKey: string, headers: string[], rows: Record<string, string>[]) {
    if (!companyId || headers.length < 2) { toast.error('File needs a row-label column plus at least one data column'); return }
    const rowLabelHeader = headers[0]
    const colHeaders = headers.slice(1)
    const existing = gridOf(tableKey)
    const maxRowSort = Math.max(0, ...existing.map((c) => c.row_sort))
    const knownRowSort = new Map(existing.map((c) => [c.row_label, c.row_sort]))
    let nextRowSort = maxRowSort
    const sb = supabase as any
    const upserts: Record<string, unknown>[] = []
    for (const r of rows) {
      const rowLabel = (r[rowLabelHeader] ?? '').trim()
      if (!rowLabel) continue
      if (!knownRowSort.has(rowLabel)) { nextRowSort += 1; knownRowSort.set(rowLabel, nextRowSort) }
      const rowSort = knownRowSort.get(rowLabel)!
      for (const h of colHeaders) {
        const raw = (r[h] ?? '').trim()
        if (raw === '') continue
        const num = Number(raw.replace(/[$,%]/g, ''))
        if (Number.isNaN(num)) continue
        const value = raw.includes('%') ? num / 100 : num
        const parsed = parseMonthHeader(h)
        upserts.push({
          company_id: companyId, slide_key: SLIDE_KEY, table_key: tableKey,
          row_label: rowLabel, row_sort: rowSort,
          col_key: parsed?.key ?? h, col_label: parsed?.label ?? h, col_sort: parsed?.sort ?? colHeaders.indexOf(h),
          value_num: value, updated_by: userId, updated_at: new Date().toISOString(),
        })
      }
    }
    if (upserts.length === 0) { toast.error('No recognizable numeric data found in that file'); return }
    const { error } = await sb.schema('inventory').from('monthend_recap_grid_cells')
      .upsert(upserts, { onConflict: 'company_id,slide_key,table_key,row_label,col_key' })
    if (error) { toast.error(error.message); return }
    toast.success(`Updated ${upserts.length} cell(s)`)
    await load()
  }

  /**
   * Computes a month's recap from the app's own data (see monthEndRecapCompute.ts for the definitions) and writes it into the
   * grids — a new column in Compliance Trends and Recount Compliance by Area, and that month's own Daily Compliance cycle.
   * Everything written is an ordinary editable cell afterwards. Returns what it computed (and any area managers that needed a
   * new row) for the caller to report.
   */
  async function fillMonth(countMonth: string): Promise<{ result: RecapResult; added: string[]; cycleKey: string } | null> {
    if (!companyId) return null
    const sb = supabase as any
    const lo = new Date(countMonth + 'T00:00:00'); lo.setDate(lo.getDate() - 7)
    const hi = new Date(countMonth + 'T00:00:00'); hi.setDate(hi.getDate() + 50)
    const d = (x: Date) => x.toISOString().slice(0, 10)
    const [locRes, countRes, manualRes, ruleRes, exclRes, recRes] = await Promise.all([
      sb.schema('core').from('locations').select('id, name, region, director, area_manager, owner, metadata, location_type').eq('company_id', companyId).eq('active', true),
      sb.schema('inventory').from('counts').select('location_id, count_date, count_type, total_adjustments').eq('company_id', companyId).eq('count_month', countMonth),
      sb.schema('inventory').from('manual_count_entries').select('location_id, created_at').eq('company_id', companyId).eq('count_period', countMonth),
      sb.schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', ALLOWABLE_TYPE_RULES_KEY).maybeSingle(),
      sb.schema('platform').from('app_settings').select('value').eq('company_id', companyId).eq('key', 'monthend_shop_exclusions').maybeSingle(),
      sb.schema('inventory').from('recount_requests').select('location_id, recount_type, requested_products, request_date, recount_status, completed_flags, completed_dates, updated_at')
        .eq('company_id', companyId).gte('request_date', d(lo)).lte('request_date', d(hi)),
    ])
    for (const r of [locRes, countRes, manualRes, recRes]) if (r.error) { toast.error(r.error.message); return null }

    // The deck tracks the five corporate regions already in the Area grid.
    const areaRows = gridOf('area_compliance')
    const labels = new Map<string, number>()
    for (const c of areaRows) labels.set(c.row_label, c.row_sort)
    const rowList = [...labels.entries()].map(([label, sort]) => ({ label, sort }))
    const deckRegions = new Set(rowList.filter((x) => !x.label.startsWith(' ') && x.label !== 'Grand Total').map((x) => x.label.split(' - ')[0].trim().toLowerCase()))
    const excluded = new Set(((exclRes.data?.value ?? []) as { location_id: string; reason: string }[]).filter((e) => e.reason === 'everything').map((e) => e.location_id))
    const typeRules = (ruleRes.data?.value ?? {}) as Record<string, TypeRule>
    const shops = ((locRes.data ?? []) as any[])
      .filter((l) => isRealShopLocation(l) && l.location_type !== 'car_wash' && ownerBucket(String(l.owner ?? l.metadata?.owner ?? '')) === 'Corporate'
        && deckRegions.has(String(l.region ?? '').trim().toLowerCase()) && !excluded.has(l.id))
      .map((l) => ({ id: l.id as string, region: String(l.region).trim(), director: String(l.director ?? ''), areaManager: String(l.area_manager ?? '').trim() || 'Unassigned' }))
    const counts = ((countRes.data ?? []) as any[]).filter((c) => isAllowedCountType(c.count_type, c.total_adjustments, typeRules))

    const result = computeRecap({ countMonth, shops, counts, manual: (manualRes.data ?? []) as any[], recounts: (recRes.data ?? []) as any[] })
    if (!result) { toast.error('No counts found for that month yet'); return null }
    const { cells: areaC, added } = areaCells(result, rowList)
    // One row per conflict key — a repeat in a single upsert makes Postgres reject the whole statement.
    const dedup = new Map<string, CellRow>()
    for (const c of [...dailyCells(result), ...trendsCells(result), ...areaC]) dedup.set(`${c.table_key}|${c.row_label}|${c.col_key}`, c)
    const all: CellRow[] = [...dedup.values()]
    const now = new Date().toISOString()
    const rows = all.map((c) => ({ company_id: companyId, slide_key: SLIDE_KEY, ...c, updated_by: userId, updated_at: now }))
    for (let i = 0; i < rows.length; i += 400) {
      const { error } = await sb.schema('inventory').from('monthend_recap_grid_cells')
        .upsert(rows.slice(i, i + 400), { onConflict: 'company_id,slide_key,table_key,row_label,col_key' })
      if (error) { toast.error(error.message); return null }
    }
    // This cycle's notes are regenerated each time (the user can edit or add to them afterwards).
    const cycleKey = dailyTableKey(result.monthKey)
    await sb.schema('inventory').from('monthend_recap_list_items').delete().eq('company_id', companyId).eq('slide_key', SLIDE_KEY).eq('table_key', cycleKey)
    await sb.schema('inventory').from('monthend_recap_list_items').insert(
      dailyNotes(result).map((t, i) => ({ company_id: companyId, slide_key: SLIDE_KEY, table_key: cycleKey, item_text: t, sort_order: i + 1, updated_by: userId })))
    await load()
    return { result, added, cycleKey }
  }

  return {
    fillMonth,
    loading, cells, items,
    gridOf, listOf,
    saveCell, deleteGridRow,
    addListItem, saveListItem, deleteListItem, moveListItem,
    uploadGrid,
    reload: load,
  }
}

const MON_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
function parseMonthHeader(h: string): { key: string; label: string; sort: number } | null {
  const s = h.trim()
  let m = s.match(/^(\d{4})-(\d{2})$/)
  if (m) { const y = +m[1], mo = +m[2]; return { key: `${m[1]}-${m[2]}`, label: `${MON_NAMES[mo - 1].replace(/^./, (c) => c.toUpperCase())}-${String(y).slice(2)}`, sort: y * 100 + mo } }
  m = s.match(/^([A-Za-z]{3,})[.\s-]*'?(\d{2,4})$/)
  if (m) {
    const idx = MON_NAMES.indexOf(m[1].slice(0, 3).toLowerCase())
    if (idx !== -1) {
      const yRaw = m[2]; const y = yRaw.length === 4 ? +yRaw : 2000 + +yRaw
      return { key: `${y}-${String(idx + 1).padStart(2, '0')}`, label: `${MON_NAMES[idx].replace(/^./, (c) => c.toUpperCase())}-${String(y).slice(2)}`, sort: y * 100 + idx + 1 }
    }
  }
  return null
}
