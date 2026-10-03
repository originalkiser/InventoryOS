// Persisted decisions about overdue RelaDyne POs (inventory.rd_po_check_status, migration 20260930cp):
// ignored / emailed / skipped, one row per PO. Loaded once for the whole company (it only ever holds the
// handful-to-few-hundred POs someone has acted on) and kept in local state as changes are made.
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { PoCheckStatus, PoCheckStatusRow } from './rdPoCheck'

const sb = () => supabase as any
const CHUNK = 500

export interface PoStatusTarget { key: string; locationId: string | null; orderDate: string | null }

export function useRdPoCheckStatus() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [byKey, setByKey] = useState<Map<string, PoCheckStatusRow>>(new Map())
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const out: PoCheckStatusRow[] = []
    let from = 0
    for (;;) {
      const { data, error } = await sb().schema('inventory').from('rd_po_check_status')
        .select('po_key, status, skip_count, last_action_at').eq('company_id', companyId).order('po_key').range(from, from + 999)
      if (error) { toast.error(`Couldn't load PO statuses: ${error.message}`); break }
      const batch = (data ?? []) as PoCheckStatusRow[]
      out.push(...batch)
      if (batch.length === 0) break
      from += batch.length
    }
    setByKey(new Map(out.map((r) => [r.po_key, r])))
    setLoading(false)
  }, [companyId])
  useEffect(() => { reload() }, [reload])

  /**
   * Set (or, with status null, clear) the status of many POs at once. `incrementSkip` bumps the skip counter —
   * used when someone skips past a PO in the email flow.
   */
  const setStatus = useCallback(async (targets: PoStatusTarget[], status: PoCheckStatus | null, opts: { incrementSkip?: boolean } = {}) => {
    if (!companyId || !targets.length) return true
    const now = new Date().toISOString()
    if (status == null) {
      for (let i = 0; i < targets.length; i += CHUNK) {
        const { error } = await sb().schema('inventory').from('rd_po_check_status')
          .delete().eq('company_id', companyId).in('po_key', targets.slice(i, i + CHUNK).map((t) => t.key))
        if (error) { toast.error(error.message); return false }
      }
      setByKey((prev) => { const n = new Map(prev); for (const t of targets) n.delete(t.key); return n })
      return true
    }
    const rows = targets.map((t) => ({
      company_id: companyId, po_key: t.key, status, location_id: t.locationId, order_date: t.orderDate,
      skip_count: (byKey.get(t.key)?.skip_count ?? 0) + (opts.incrementSkip ? 1 : 0),
      last_action_at: now, last_action_by: profile?.id ?? null,
    }))
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error } = await sb().schema('inventory').from('rd_po_check_status').upsert(rows.slice(i, i + CHUNK), { onConflict: 'company_id,po_key' })
      if (error) { toast.error(error.message); return false }
    }
    setByKey((prev) => {
      const n = new Map(prev)
      for (const r of rows) n.set(r.po_key, { po_key: r.po_key, status, skip_count: r.skip_count, last_action_at: now })
      return n
    })
    return true
  }, [companyId, profile?.id, byKey])

  return { byKey, loading, reload, setStatus }
}
