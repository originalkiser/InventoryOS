import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

export interface DataCompleteness {
  completeFrom: string | null
  status: string | null
  monthsPulled: number | null
}

// "Confirmed complete" boundary from the historical backfill's own
// month-walk guarantee (get_droptop_backfill_completeness, migration
// 20260930ar) — every shop is verified to have data from this date
// forward. Distinct from useEarliestOrderDate's "any data exists before
// this at all" floor: a date range starting before completeFrom may still
// be missing some shops for the earliest months in that range even though
// SOME data exists there.
export function useDroptopDataCompleteness(
  connectionKey: 'droptop_orders' | 'droptop_time_clock',
): DataCompleteness & { loading: boolean } {
  const [state, setState] = useState<DataCompleteness & { loading: boolean }>({
    completeFrom: null, status: null, monthsPulled: null, loading: true,
  })

  useEffect(() => {
    let cancelled = false
    ;(supabase as any).rpc('get_droptop_backfill_completeness', { p_connection_key: connectionKey })
      .then(({ data }: any) => {
        if (cancelled) return
        const row = Array.isArray(data) ? data[0] : data
        setState({
          completeFrom: row?.complete_from ?? null,
          status: row?.status ?? null,
          monthsPulled: row?.months_pulled ?? null,
          loading: false,
        })
      })
    return () => { cancelled = true }
  }, [connectionKey])

  return state
}
