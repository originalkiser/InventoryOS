import { useEffect, useRef } from 'react'
import type { Table, VisibilityState } from '@tanstack/react-table'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

/**
 * Persists column visibility for a read-only table to both localStorage
 * (instant restore) and the user's DB prefs (cross-device sync).
 *
 * Call after useTable:
 *   const { table, columnVisibility, ... } = useTable(data, columns)
 *   useColumnVisibility('locations', table, columnVisibility)
 */
export function useColumnVisibility(
  tableKey: string,
  table: Table<any>,
  columnVisibility: VisibilityState,
) {
  const { user } = useAuthStore()
  const localKey = `col_vis_${tableKey}`

  // All column_visibility keys from DB — kept so we can merge on save
  // without clobbering other tables stored in the same JSON column.
  const allVisRef = useRef<Record<string, unknown>>({})

  // Track the last value we wrote so we don't echo-save after loading.
  const lastSavedRef = useRef<string | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>()

  // ── Load on mount ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function load() {
      // 1. localStorage — instant (may be overridden by DB below)
      const raw = localStorage.getItem(localKey)
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as VisibilityState
          table.setColumnVisibility(parsed)
          lastSavedRef.current = raw
        } catch {}
      }

      // 2. DB — authoritative; overwrites localStorage if present
      if (!user) return
      const { data } = await (supabase as any)
        .schema('core')
        .from('user_sidebar_prefs')
        .select('column_visibility')
        .eq('user_id', user.id)
        .maybeSingle()

      if (cancelled) return

      if (data?.column_visibility) {
        allVisRef.current = data.column_visibility as Record<string, unknown>
      }

      const dbVis = data?.column_visibility?.[tableKey]
      if (dbVis && typeof dbVis === 'object') {
        const str = JSON.stringify(dbVis)
        table.setColumnVisibility(dbVis as VisibilityState)
        localStorage.setItem(localKey, str)
        lastSavedRef.current = str
      }
    }

    load()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  // ── Save on change (debounced 800 ms) ────────────────────────────────────
  useEffect(() => {
    const str = JSON.stringify(columnVisibility)
    // Skip if unchanged from last save (prevents echo-save on load)
    if (str === lastSavedRef.current) return

    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      lastSavedRef.current = str
      localStorage.setItem(localKey, str)

      if (!user) return
      const merged = { ...allVisRef.current, [tableKey]: columnVisibility }
      allVisRef.current = merged
      await (supabase as any)
        .schema('core')
        .from('user_sidebar_prefs')
        .upsert(
          { user_id: user.id, updated_at: new Date().toISOString(), column_visibility: merged },
          { onConflict: 'user_id' },
        )
    }, 800)

    return () => clearTimeout(saveTimerRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnVisibility])
}
