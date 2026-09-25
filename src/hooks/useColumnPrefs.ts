import { useEffect, useRef, useState } from 'react'
import type { Table, VisibilityState } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

export interface ColumnPrefs {
  order: string[]
  hidden: string[]
  // Added 2026-09-25 for Exception Reporting's own table redesign — read
  // and written via the table instance's own setColumnSizing/
  // setColumnPinning/setPageSize methods (TanStack Table exposes these
  // directly), so every EXISTING caller of this hook (LocationsPage,
  // ProductUsageTab, MenuBoardPage) gets width/pin/page-size persistence
  // for free with no call-site change — these fields are simply undefined
  // (and skipped) until a table's own columns actually support resizing/
  // pinning/pagination in the first place.
  sizing?: Record<string, number>
  pinnedLeft?: string[]
  pageSize?: number
}

const STORAGE_PREFIX = 'sbnet:'

function localKey(tableKey: string) {
  return `${STORAGE_PREFIX}${tableKey}:column_prefs`
}

/**
 * Persists column ORDER and VISIBILITY for a table to localStorage (fast) and
 * platform.user_profiles.column_prefs (cross-device).
 *
 * Usage:
 *   const { table, columnVisibility, columnOrder, setColumnOrder } = useTable(data, columns)
 *   useColumnPrefs('core.locations', table, columnVisibility, columnOrder, setColumnOrder)
 */
export function useColumnPrefs(
  tableKey: string,
  table: Table<any>,
  columnVisibility: VisibilityState,
  columnOrder: string[],
  setColumnOrder: (order: string[]) => void,
) {
  const { user } = useAuthStore()

  const allPrefsRef = useRef<Record<string, unknown>>({})
  const lastSavedRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // 1. localStorage — instant
      const raw = localStorage.getItem(localKey(tableKey))
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as ColumnPrefs
          applyPrefs(parsed)
          lastSavedRef.current = raw
        } catch {}
      }

      // 2. DB — authoritative
      if (!user) return
      const { data } = await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .select('column_prefs')
        .eq('id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (data?.column_prefs) {
        allPrefsRef.current = data.column_prefs as Record<string, unknown>
      }

      const dbPrefs = data?.column_prefs?.[tableKey]
      if (dbPrefs && typeof dbPrefs === 'object') {
        const str = JSON.stringify(dbPrefs)
        applyPrefs(dbPrefs as ColumnPrefs)
        localStorage.setItem(localKey(tableKey), str)
        lastSavedRef.current = str
      }
    }

    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  function applyPrefs(prefs: ColumnPrefs) {
    if (prefs.order?.length) {
      setColumnOrder(prefs.order)
    }
    if (prefs.hidden) {
      const vis: VisibilityState = {}
      for (const id of prefs.hidden) vis[id] = false
      table.setColumnVisibility(vis)
    }
    if (prefs.sizing) table.setColumnSizing(prefs.sizing)
    if (prefs.pinnedLeft) table.setColumnPinning({ left: prefs.pinnedLeft, right: [] })
    if (prefs.pageSize) table.setPageSize(prefs.pageSize)
  }

  // Read straight off the table's own state (already reactive — a resize
  // drag, a pin toggle, or a page-size change all flow through the same
  // state TanStack Table already re-renders on) rather than requiring
  // extra props threaded through from the caller.
  const columnSizing = table.getState().columnSizing
  const pinnedLeft = table.getState().columnPinning.left ?? []
  const pageSize = table.getState().pagination.pageSize

  // ── Save on change (debounced 800 ms) ────────────────────────────────────
  useEffect(() => {
    const hidden = Object.entries(columnVisibility)
      .filter(([, v]) => v === false)
      .map(([k]) => k)
    const prefs: ColumnPrefs = { order: columnOrder, hidden, sizing: columnSizing, pinnedLeft, pageSize }
    const str = JSON.stringify(prefs)
    if (str === lastSavedRef.current) return

    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      lastSavedRef.current = str
      localStorage.setItem(localKey(tableKey), str)

      if (!user) return
      const merged = { ...allPrefsRef.current, [tableKey]: prefs }
      allPrefsRef.current = merged
      await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .update({ column_prefs: merged })
        .eq('id', user.id)
    }, 800)

    return () => clearTimeout(saveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnVisibility, columnOrder, columnSizing, pinnedLeft, pageSize])
}

/**
 * Same persistence shape/behavior as useColumnPrefs above — localStorage
 * (instant) + platform.user_profiles.column_prefs (cross-device, 800ms
 * debounced) — but for a caller that isn't driving a TanStack `Table`
 * instance. Added 2026-09-25 for LocationLookupPage's hand-rolled
 * order-config table and its sidebar field list, both of which predate
 * this app's useTable/DataTable convergence and weren't worth a full
 * rewrite onto TanStack just to get persisted column order/hidden/width.
 * Owns order/hidden/sizing as its own React state (rather than reading them
 * off a table object), so any caller with a plain list of {id, label}
 * items — table columns or not — gets the same persisted-order/hidden/
 * width behavior useColumnPrefs gives a real TanStack table, and both
 * share the exact same `column_prefs` jsonb column/shape (just a different
 * top-level key per caller), so no new migration is needed.
 *
 * Usage:
 *   const layout = usePersistedColumnLayout('location_lookup.sidebar_fields')
 *   layout.order / layout.hidden / layout.sizing, plus their setters
 */
export function usePersistedColumnLayout(tableKey: string) {
  const { user } = useAuthStore()

  const [order, setOrder] = useState<string[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const [sizing, setSizing] = useState<Record<string, number>>({})

  const allPrefsRef = useRef<Record<string, unknown>>({})
  const lastSavedRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // 1. localStorage — instant
      const raw = localStorage.getItem(localKey(tableKey))
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as ColumnPrefs
          if (parsed.order) setOrder(parsed.order)
          if (parsed.hidden) setHidden(parsed.hidden)
          if (parsed.sizing) setSizing(parsed.sizing)
          lastSavedRef.current = raw
        } catch { /* ignore */ }
      }

      // 2. DB — authoritative
      if (!user) return
      const { data } = await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .select('column_prefs')
        .eq('id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (data?.column_prefs) {
        allPrefsRef.current = data.column_prefs as Record<string, unknown>
      }

      const dbPrefs = data?.column_prefs?.[tableKey]
      if (dbPrefs && typeof dbPrefs === 'object') {
        const p = dbPrefs as ColumnPrefs
        if (p.order) setOrder(p.order)
        if (p.hidden) setHidden(p.hidden)
        if (p.sizing) setSizing(p.sizing)
        const str = JSON.stringify(p)
        localStorage.setItem(localKey(tableKey), str)
        lastSavedRef.current = str
      }
    }

    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, tableKey])

  // ── Save on change (debounced 800 ms) ────────────────────────────────────
  useEffect(() => {
    const prefs: ColumnPrefs = { order, hidden, sizing }
    const str = JSON.stringify(prefs)
    if (str === lastSavedRef.current) return

    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      lastSavedRef.current = str
      localStorage.setItem(localKey(tableKey), str)

      if (!user) return
      const merged = { ...allPrefsRef.current, [tableKey]: prefs }
      allPrefsRef.current = merged
      await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .update({ column_prefs: merged })
        .eq('id', user.id)
    }, 800)

    return () => clearTimeout(saveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, order, hidden, sizing])

  return { order, setOrder, hidden, setHidden, sizing, setSizing }
}

/**
 * Same persistence shape/behavior as usePersistedColumnLayout above —
 * localStorage (instant) + platform.user_profiles.column_prefs (cross-device,
 * 800ms debounced) — but for an arbitrary JSON value rather than the fixed
 * order/hidden/sizing shape. Added 2026-09-25 for Location Lookup's full-page
 * drag/resize grid layout (an array of react-grid-layout `{i,x,y,w,h}`
 * entries), which doesn't fit ColumnPrefs' column-oriented shape at all.
 *
 * Usage:
 *   const [layout, setLayout] = usePersistedJson('location_lookup.page_grid', DEFAULT_LAYOUT)
 */
export function usePersistedJson<T>(tableKey: string, defaultValue: T) {
  const { user } = useAuthStore()
  const [value, setValue] = useState<T>(defaultValue)

  const allPrefsRef = useRef<Record<string, unknown>>({})
  const lastSavedRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const raw = localStorage.getItem(localKey(tableKey))
      if (raw) {
        try { setValue(JSON.parse(raw) as T); lastSavedRef.current = raw } catch { /* ignore */ }
      }

      if (!user) { loadedRef.current = true; return }
      const { data } = await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .select('column_prefs')
        .eq('id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (data?.column_prefs) allPrefsRef.current = data.column_prefs as Record<string, unknown>

      const dbVal = data?.column_prefs?.[tableKey]
      if (dbVal !== undefined) {
        setValue(dbVal as T)
        const str = JSON.stringify(dbVal)
        localStorage.setItem(localKey(tableKey), str)
        lastSavedRef.current = str
      }
      loadedRef.current = true
    }

    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, tableKey])

  useEffect(() => {
    const str = JSON.stringify(value)
    if (str === lastSavedRef.current) return

    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      lastSavedRef.current = str
      localStorage.setItem(localKey(tableKey), str)

      if (!user) return
      const merged = { ...allPrefsRef.current, [tableKey]: value }
      allPrefsRef.current = merged
      await (supabase as any)
        .schema('platform')
        .from('user_profiles')
        .update({ column_prefs: merged })
        .eq('id', user.id)
    }, 800)

    return () => clearTimeout(saveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableKey, value])

  return [value, setValue] as const
}
