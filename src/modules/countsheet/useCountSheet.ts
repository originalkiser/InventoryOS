// Data layer for the Count Sheet (proof of concept — nothing here is pushed to Droptop). A shop's catalog is every Droptop product in
// inventory.product_usage; a sheet adds user-defined places and count entries on top.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any

export interface CatalogProduct {
  product_id: string; category: string | null; on_hand: number | null; daily_usage: number | null
  unit_cost: number | null; count_sequence: number | null
}
export interface ActivityHint { receipt?: { date: string; qty: number }; adjustment?: { date: string; qty: number } }
export interface Sheet { id: string; label: string; count_date: string; created_at: string }
export interface Place { id: string; name: string; sort_order: number }
export interface Entry { id: string; product_id: string; place_id: string | null; qty: number | null; sort_order: number }

async function pageAll<T>(build: () => any, pageSize = 1000): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await build().range(from, from + pageSize - 1)
    if (error) throw error
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length < pageSize) break
  }
  return out
}

export function useCountSheet(locationId: string | null) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const [catalog, setCatalog] = useState<CatalogProduct[]>([])
  const [hints, setHints] = useState<Map<string, ActivityHint>>(new Map())
  const [loadingCatalog, setLoadingCatalog] = useState(false)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [sheetId, setSheetId] = useState<string | null>(null)
  const [places, setPlaces] = useState<Place[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [loadingSheet, setLoadingSheet] = useState(false)

  // ── the shop's Droptop products, and what happened to them lately ────────────────────────────────────────────────────
  useEffect(() => {
    if (!locationId || !companyId) { setCatalog([]); setHints(new Map()); return }
    let cancelled = false
    setLoadingCatalog(true)
    ;(async () => {
      try {
        const rows = await pageAll<any>(() => sb().schema('inventory').from('product_usage')
          .select('product_id, category, on_hands, daily_usage, unit_cost, count_sequence').eq('company_id', companyId).eq('location_id', locationId).order('product_id', { ascending: true }))
        if (cancelled) return
        setCatalog(rows.map((r) => ({ product_id: r.product_id, category: r.category, on_hand: r.on_hands == null ? null : Number(r.on_hands), daily_usage: r.daily_usage == null ? null : Number(r.daily_usage), unit_cost: r.unit_cost == null ? null : Number(r.unit_cost), count_sequence: r.count_sequence })))
        // Last receipt / last adjustment per product from the day-by-day ledger (a missed receipt or a rogue adjustment shows up here).
        const since = new Date(); since.setDate(since.getDate() - 120)
        const led = await pageAll<any>(() => sb().schema('inventory').from('daily_product_activity')
          .select('product_id, activity_date, adjusted_qty, other_qty, raw_change_types')
          .eq('company_id', companyId).eq('location_id', locationId).gte('activity_date', since.toISOString().slice(0, 10))
          .or('other_qty.gt.0,adjusted_qty.neq.0').order('activity_date', { ascending: false }).order('id', { ascending: true }))
        if (cancelled) return
        const h = new Map<string, ActivityHint>()
        for (const r of led) {
          const cur = h.get(r.product_id) ?? {}
          const types: string[] = r.raw_change_types ?? []
          if (!cur.receipt && Number(r.other_qty) > 0 && types.some((t) => /receiv/i.test(t))) cur.receipt = { date: r.activity_date, qty: Number(r.other_qty) }
          if (!cur.adjustment && Number(r.adjusted_qty) !== 0) cur.adjustment = { date: r.activity_date, qty: Number(r.adjusted_qty) }
          h.set(r.product_id, cur)
        }
        setHints(h)
      } catch (e: any) { if (!cancelled) toast.error(e?.message ?? 'Could not load the shop\'s products') }
      if (!cancelled) setLoadingCatalog(false)
    })()
    return () => { cancelled = true }
  }, [locationId, companyId])

  // ── sheets ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const loadSheets = useCallback(async (select?: string | null) => {
    if (!locationId || !companyId) { setSheets([]); setSheetId(null); return }
    const { data, error } = await sb().schema('inventory').from('count_sheets').select('id, label, count_date, created_at')
      .eq('company_id', companyId).eq('location_id', locationId).order('count_date', { ascending: false }).order('created_at', { ascending: false })
    if (error) { toast.error(error.message); return }
    const list = (data ?? []) as Sheet[]
    setSheets(list)
    setSheetId((cur) => (select !== undefined ? select : cur && list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null))
  }, [locationId, companyId])
  useEffect(() => { setSheetId(null); void loadSheets() }, [loadSheets])

  const loadSheetData = useCallback(async (id: string) => {
    setLoadingSheet(true)
    try {
      const [p, e] = await Promise.all([
        pageAll<Place>(() => sb().schema('inventory').from('count_sheet_places').select('id, name, sort_order').eq('sheet_id', id).order('sort_order', { ascending: true }).order('id', { ascending: true })),
        pageAll<any>(() => sb().schema('inventory').from('count_sheet_entries').select('id, product_id, place_id, qty, sort_order').eq('sheet_id', id).order('id', { ascending: true })),
      ])
      setPlaces(p)
      setEntries(e.map((r) => ({ id: r.id, product_id: r.product_id, place_id: r.place_id, qty: r.qty == null ? null : Number(r.qty), sort_order: r.sort_order })))
    } catch (e: any) { toast.error(e?.message ?? 'Could not load the sheet') }
    setLoadingSheet(false)
  }, [])
  useEffect(() => { if (sheetId) void loadSheetData(sheetId); else { setPlaces([]); setEntries([]) } }, [sheetId, loadSheetData])

  async function createSheet(label: string, copyPrevious: boolean): Promise<void> {
    if (!locationId || !companyId) return
    const { data, error } = await sb().schema('inventory').from('count_sheets').insert({ company_id: companyId, location_id: locationId, label, created_by: userId }).select('id').single()
    if (error) { toast.error(error.message); return }
    const newId = (data as { id: string }).id
    const prev = sheets[0]
    if (copyPrevious && prev) {
      // Start from the last sheet's places and product order (uncounted) so a repeat count is ready to go.
      const [pp, ee] = await Promise.all([
        pageAll<Place>(() => sb().schema('inventory').from('count_sheet_places').select('id, name, sort_order').eq('sheet_id', prev.id).order('sort_order', { ascending: true })),
        pageAll<any>(() => sb().schema('inventory').from('count_sheet_entries').select('product_id, place_id, sort_order').eq('sheet_id', prev.id).order('sort_order', { ascending: true }).order('id', { ascending: true })),
      ])
      const idMap = new Map<string, string>()
      for (const p of pp) {
        const { data: np } = await sb().schema('inventory').from('count_sheet_places').insert({ sheet_id: newId, company_id: companyId, name: p.name, sort_order: p.sort_order }).select('id').single()
        if (np) idMap.set(p.id, (np as { id: string }).id)
      }
      // One blank entry per product per place (the previous sheet's extra entry spots aren't carried over).
      const seen = new Set<string>()
      const rows = ee.filter((r) => { const k = `${r.place_id}|${r.product_id}`; if (seen.has(k)) return false; seen.add(k); return r.place_id && idMap.has(r.place_id) })
        .map((r) => ({ sheet_id: newId, company_id: companyId, product_id: r.product_id, place_id: idMap.get(r.place_id), qty: null, sort_order: r.sort_order }))
      for (let i = 0; i < rows.length; i += 500) await sb().schema('inventory').from('count_sheet_entries').insert(rows.slice(i, i + 500))
    }
    toast.success('Count sheet created')
    await loadSheets(newId)
  }

  async function deleteSheet() {
    if (!sheetId) return
    for (const t of ['count_sheet_entries', 'count_sheet_places']) await sb().schema('inventory').from(t).delete().eq('sheet_id', sheetId)
    const { error } = await sb().schema('inventory').from('count_sheets').delete().eq('id', sheetId)
    if (error) { toast.error(error.message); return }
    toast.success('Count sheet deleted')
    await loadSheets(null)
    await loadSheets()
  }

  // ── places ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  async function addPlace(name: string): Promise<string | null> {
    if (!sheetId || !companyId || !name.trim()) return null
    const { data, error } = await sb().schema('inventory').from('count_sheet_places')
      .insert({ sheet_id: sheetId, company_id: companyId, name: name.trim(), sort_order: Math.max(-1, ...places.map((p) => p.sort_order)) + 1 }).select('id, name, sort_order').single()
    if (error) { toast.error(error.message); return null }
    setPlaces((ps) => [...ps, data as Place])
    return (data as Place).id
  }
  async function renamePlace(id: string, name: string) {
    if (!name.trim()) return
    const { error } = await sb().schema('inventory').from('count_sheet_places').update({ name: name.trim() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setPlaces((ps) => ps.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)))
  }
  /** Removing a place keeps its counts — they just become unassigned. */
  async function deletePlace(id: string) {
    await sb().schema('inventory').from('count_sheet_entries').update({ place_id: null }).eq('place_id', id)
    const { error } = await sb().schema('inventory').from('count_sheet_places').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setPlaces((ps) => ps.filter((p) => p.id !== id))
    setEntries((es) => es.map((e) => (e.place_id === id ? { ...e, place_id: null } : e)))
  }

  // ── entries ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  const entriesRef = useRef(entries); entriesRef.current = entries
  const timers = useRef(new Map<string, number>())
  useEffect(() => () => { for (const t of timers.current.values()) window.clearTimeout(t) }, [])

  async function addEntry(productId: string, placeId: string | null, qty: number | null): Promise<string | null> {
    if (!sheetId || !companyId) return null
    const inPlace = entriesRef.current.filter((e) => e.place_id === placeId)
    const sort = Math.max(-1, ...inPlace.map((e) => e.sort_order)) + 1
    const { data, error } = await sb().schema('inventory').from('count_sheet_entries')
      .insert({ sheet_id: sheetId, company_id: companyId, product_id: productId, place_id: placeId, qty, sort_order: sort, updated_by: userId }).select('id').single()
    if (error) { toast.error(error.message); return null }
    const id = (data as { id: string }).id
    setEntries((es) => [...es, { id, product_id: productId, place_id: placeId, qty, sort_order: sort }])
    return id
  }

  /** Counts save a moment after the last tap/keystroke (the stepper fires on every change). */
  function setQty(id: string, qty: number) {
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, qty } : e)))
    const t = timers.current.get(id)
    if (t) window.clearTimeout(t)
    timers.current.set(id, window.setTimeout(async () => {
      timers.current.delete(id)
      const { error } = await sb().schema('inventory').from('count_sheet_entries').update({ qty, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
      if (error) toast.error(error.message)
    }, 350))
  }

  async function setEntryPlace(id: string, placeId: string | null) {
    const { error } = await sb().schema('inventory').from('count_sheet_entries').update({ place_id: placeId, updated_by: userId, updated_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, place_id: placeId } : e)))
  }

  async function removeEntry(id: string) {
    const { error } = await sb().schema('inventory').from('count_sheet_entries').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    setEntries((es) => es.filter((e) => e.id !== id))
  }

  /** Persist a new product order inside one place (all of a product's entries in the place keep together). */
  async function reorderPlace(placeId: string, productIds: string[]) {
    const order = new Map(productIds.map((p, i) => [p, i * 10]))
    const updates: { id: string; sort_order: number }[] = []
    const next = entriesRef.current.map((e) => {
      if (e.place_id !== placeId || !order.has(e.product_id)) return e
      const idx = entriesRef.current.filter((x) => x.place_id === placeId && x.product_id === e.product_id).findIndex((x) => x.id === e.id)
      const so = order.get(e.product_id)! + idx
      updates.push({ id: e.id, sort_order: so })
      return { ...e, sort_order: so }
    })
    setEntries(next)
    await Promise.all(updates.map((u) => sb().schema('inventory').from('count_sheet_entries').update({ sort_order: u.sort_order }).eq('id', u.id)))
  }

  const byProduct = useMemo(() => {
    const m = new Map<string, Entry[]>()
    for (const e of entries) { const a = m.get(e.product_id); if (a) a.push(e); else m.set(e.product_id, [e]) }
    for (const a of m.values()) a.sort((x, y) => x.sort_order - y.sort_order)
    return m
  }, [entries])

  return {
    catalog, hints, loadingCatalog, sheets, sheetId, setSheetId, places, entries, byProduct, loadingSheet,
    createSheet, deleteSheet, addPlace, renamePlace, deletePlace, addEntry, setQty, setEntryPlace, removeEntry, reorderPlace,
  }
}
