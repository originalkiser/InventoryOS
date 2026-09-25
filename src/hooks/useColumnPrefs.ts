import { useEffect, useRef } from 'react'
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
