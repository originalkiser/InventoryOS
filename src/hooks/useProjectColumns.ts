import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { ProjectColumnConfigEntry } from '@/types'

const sb = supabase as any
const LS_KEY = 'projects.columnConfig'

export interface ColumnDef {
  key: string
  label: string
  defaultWidth?: number
}

// Reconcile a saved layout against the canonical column list: keep saved
// order/width/pin/visibility, drop unknown keys, append newly-added columns.
function reconcile(defs: ColumnDef[], saved: ProjectColumnConfigEntry[] | null): ProjectColumnConfigEntry[] {
  const byKey = new Map((saved ?? []).map((e) => [e.key, e]))
  const known = new Set(defs.map((d) => d.key))
  const kept = (saved ?? [])
    .filter((e) => known.has(e.key))
    .map((e) => ({ ...e, label: defs.find((d) => d.key === e.key)!.label }))
  const maxOrder = kept.reduce((m, e) => Math.max(m, e.order), -1)
  let next = maxOrder + 1
  for (const d of defs) {
    if (!byKey.has(d.key)) {
      kept.push({ key: d.key, label: d.label, width: d.defaultWidth ?? 160, pinned: false, visible: true, order: next++ })
    }
  }
  return kept.sort((a, b) => a.order - b.order)
}

export function useProjectColumns(defs: ColumnDef[]) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const userId = profile?.id ?? null
  const defsRef = useRef(defs)
  defsRef.current = defs

  const [columns, setColumns] = useState<ProjectColumnConfigEntry[]>(() => {
    try {
      const ls = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
      if (Array.isArray(ls)) return reconcile(defs, ls)
    } catch { /* ignore */ }
    return reconcile(defs, null)
  })

  // Pull the cross-device layout from Supabase once we have a user.
  useEffect(() => {
    if (!companyId || !userId) return
    sb.from('projects_column_config').select('config').eq('company_id', companyId).eq('user_id', userId).maybeSingle()
      .then(({ data }: any) => { if (data?.config) setColumns(reconcile(defsRef.current, data.config)) })
  }, [companyId, userId])

  const persist = useCallback((next: ProjectColumnConfigEntry[]) => {
    localStorage.setItem(LS_KEY, JSON.stringify(next))
    if (companyId && userId) {
      void sb.from('projects_column_config')
        .upsert({ company_id: companyId, user_id: userId, config: next, updated_at: new Date().toISOString() }, { onConflict: 'company_id,user_id' })
    }
  }, [companyId, userId])

  const apply = useCallback((updater: (prev: ProjectColumnConfigEntry[]) => ProjectColumnConfigEntry[]) => {
    setColumns((prev) => {
      const next = updater(prev).map((c, i) => ({ ...c, order: i }))
      persist(next)
      return next
    })
  }, [persist])

  const setOrder = useCallback((keys: string[]) => {
    apply((prev) => keys.map((k) => prev.find((c) => c.key === k)!).filter(Boolean))
  }, [apply])

  const togglePin = useCallback((key: string) => {
    apply((prev) => prev.map((c) => (c.key === key ? { ...c, pinned: !c.pinned } : c)))
  }, [apply])

  const toggleVisible = useCallback((key: string) => {
    apply((prev) => prev.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c)))
  }, [apply])

  const setWidth = useCallback((key: string, width: number) => {
    apply((prev) => prev.map((c) => (c.key === key ? { ...c, width: Math.max(80, width) } : c)))
  }, [apply])

  return { columns, setOrder, togglePin, toggleVisible, setWidth }
}
