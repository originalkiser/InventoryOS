import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import toast from 'react-hot-toast'
import type { GridCell, KpiItem, ListItemRow } from './types'

// Loads and edits every table this Procurement Deck page needs in one shot —
// 683 seeded grid cells + 34 KPIs + 16 list items today, comfortably under
// PostgREST's row cap, but paginated defensively anyway (this app has hit
// that silent-truncation bug more than once on tables that started small).
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

export function useProcurementDeck() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const [cells, setCells] = useState<GridCell[]>([])
  const [kpis, setKpis] = useState<KpiItem[]>([])
  const [items, setItems] = useState<ListItemRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [c, k, l] = await Promise.all([
        fetchAll<GridCell>('procurement_deck_grid_cells', companyId),
        fetchAll<KpiItem>('procurement_deck_kpis', companyId),
        fetchAll<ListItemRow>('procurement_deck_list_items', companyId),
      ])
      setCells(c); setKpis(k); setItems(l)
    } catch (e) {
      // Supabase-js's PostgrestError isn't a real Error instance, so check
      // for a .message string too -- otherwise a real DB error (bad column,
      // missing grant) silently degrades to this generic fallback text with
      // no way to tell what actually went wrong.
      const msg = e instanceof Error ? e.message : (e as { message?: string } | null)?.message
      toast.error(msg || 'Failed to load Procurement Deck data')
    } finally {
      setLoading(false)
    }
  }, [companyId])
  useEffect(() => { load() }, [load])

  const gridOf = useCallback((slideKey: string, tableKey: string) =>
    cells.filter((c) => c.slide_key === slideKey && c.table_key === tableKey), [cells])
  const kpisOf = useCallback((slideKey: string, tableKey: string) =>
    kpis.filter((k) => k.slide_key === slideKey && k.table_key === tableKey).sort((a, b) => a.sort_order - b.sort_order), [kpis])
  const listOf = useCallback((slideKey: string, tableKey: string) =>
    items.filter((i) => i.slide_key === slideKey && i.table_key === tableKey).sort((a, b) => a.sort_order - b.sort_order), [items])

  async function saveCell(slideKey: string, tableKey: string, rowLabel: string, rowSort: number, colKey: string, colLabel: string, colSort: number, value: number | null) {
    if (!companyId) return
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('procurement_deck_grid_cells')
      .upsert({
        company_id: companyId, slide_key: slideKey, table_key: tableKey,
        row_label: rowLabel, row_sort: rowSort, col_key: colKey, col_label: colLabel, col_sort: colSort,
        value_num: value, updated_by: userId, updated_at: new Date().toISOString(),
      }, { onConflict: 'company_id,slide_key,table_key,row_label,col_key' })
      .select().single()
    if (error) { toast.error(error.message); return }
    setCells((prev) => {
      const next = prev.filter((c) => !(c.slide_key === slideKey && c.table_key === tableKey && c.row_label === rowLabel && c.col_key === colKey))
      next.push(data as GridCell)
      return next
    })
  }

  async function deleteGridRow(slideKey: string, tableKey: string, rowLabel: string) {
    if (!companyId) return
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('procurement_deck_grid_cells')
      .delete().eq('company_id', companyId).eq('slide_key', slideKey).eq('table_key', tableKey).eq('row_label', rowLabel)
    if (error) { toast.error(error.message); return }
    setCells((prev) => prev.filter((c) => !(c.slide_key === slideKey && c.table_key === tableKey && c.row_label === rowLabel)))
    toast.success('Row removed')
  }

  async function saveKpi(slideKey: string, tableKey: string, kpiKey: string, label: string, valueText: string, sortOrder: number) {
    if (!companyId) return
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('procurement_deck_kpis')
      .upsert({ company_id: companyId, slide_key: slideKey, table_key: tableKey, kpi_key: kpiKey, label, value_text: valueText, sort_order: sortOrder, updated_by: userId, updated_at: new Date().toISOString() },
        { onConflict: 'company_id,slide_key,table_key,kpi_key' })
      .select().single()
    if (error) { toast.error(error.message); return }
    setKpis((prev) => [...prev.filter((k) => !(k.slide_key === slideKey && k.table_key === tableKey && k.kpi_key === kpiKey)), data as KpiItem])
  }

  async function addKpi(slideKey: string, tableKey: string, label: string) {
    const key = `kpi_${Date.now()}`
    const sortOrder = Math.max(0, ...kpisOf(slideKey, tableKey).map((k) => k.sort_order)) + 1
    await saveKpi(slideKey, tableKey, key, label, '', sortOrder)
  }

  async function deleteKpi(id: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('procurement_deck_kpis').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setKpis((prev) => prev.filter((k) => k.id !== id))
  }

  async function addListItem(slideKey: string, tableKey: string, text: string) {
    if (!companyId) return
    const sortOrder = Math.max(0, ...listOf(slideKey, tableKey).map((i) => i.sort_order)) + 1
    const sb = supabase as any
    const { data, error } = await sb.schema('inventory').from('procurement_deck_list_items')
      .insert({ company_id: companyId, slide_key: slideKey, table_key: tableKey, item_text: text, sort_order: sortOrder, updated_by: userId })
      .select().single()
    if (error) { toast.error(error.message); return }
    setItems((prev) => [...prev, data as ListItemRow])
  }

  async function saveListItem(id: string, text: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('procurement_deck_list_items')
      .update({ item_text: text, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, item_text: text } : i)))
  }

  async function deleteListItem(id: string) {
    const sb = supabase as any
    const { error } = await sb.schema('inventory').from('procurement_deck_list_items').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  async function moveListItem(slideKey: string, tableKey: string, id: string, dir: -1 | 1) {
    const rows = listOf(slideKey, tableKey)
    const idx = rows.findIndex((r) => r.id === id)
    const swapIdx = idx + dir
    if (idx === -1 || swapIdx < 0 || swapIdx >= rows.length) return
    const a = rows[idx], b = rows[swapIdx]
    const sb = supabase as any
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      sb.schema('inventory').from('procurement_deck_list_items').update({ sort_order: b.sort_order }).eq('id', a.id),
      sb.schema('inventory').from('procurement_deck_list_items').update({ sort_order: a.sort_order }).eq('id', b.id),
    ])
    if (e1 || e2) { toast.error('Failed to reorder'); return }
    setItems((prev) => prev.map((i) => (i.id === a.id ? { ...i, sort_order: b.sort_order } : i.id === b.id ? { ...i, sort_order: a.sort_order } : i)))
  }

  // Upload: first column = row label, every other column header = a col_key/
  // col_label pair. If a header parses as a month ("Jul-26", "2026-07",
  // "July 2026") the column is keyed/sorted by that month so it lines up
  // with existing seeded columns instead of appending as a stray new one;
  // otherwise the header text itself is both the key and the label (fine
  // for non-time grids like the PO Match Top/Bottom 3 tables).
  async function uploadGrid(slideKey: string, tableKey: string, headers: string[], rows: Record<string, string>[]) {
    if (!companyId || headers.length < 2) { toast.error('File needs a row-label column plus at least one data column'); return }
    const rowLabelHeader = headers[0]
    const colHeaders = headers.slice(1)
    const existing = gridOf(slideKey, tableKey)
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
          company_id: companyId, slide_key: slideKey, table_key: tableKey,
          row_label: rowLabel, row_sort: rowSort,
          col_key: parsed?.key ?? h, col_label: parsed?.label ?? h, col_sort: parsed?.sort ?? colHeaders.indexOf(h),
          value_num: value, updated_by: userId, updated_at: new Date().toISOString(),
        })
      }
    }
    if (upserts.length === 0) { toast.error('No recognizable numeric data found in that file'); return }
    const { error } = await sb.schema('inventory').from('procurement_deck_grid_cells')
      .upsert(upserts, { onConflict: 'company_id,slide_key,table_key,row_label,col_key' })
    if (error) { toast.error(error.message); return }
    toast.success(`Updated ${upserts.length} cell(s)`)
    await load()
  }

  return {
    loading, cells, kpis, items,
    gridOf, kpisOf, listOf,
    saveCell, deleteGridRow,
    saveKpi, addKpi, deleteKpi,
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
