import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

// Earliest order_finalized_at on record for this company — powers the
// "no data before X" callout on a custom date range. A single cheap
// query (order by ascending, limit 1), not a full scan.
export function useEarliestOrderDate(companyId: string | null): string | null {
  const [earliest, setEarliest] = useState<string | null>(null)

  useEffect(() => {
    if (!companyId) return
    let cancelled = false
    const sb = supabase as any
    sb.schema('inventory').from('droptop_orders')
      .select('order_finalized_at')
      .eq('company_id', companyId)
      .not('order_finalized_at', 'is', null)
      .order('order_finalized_at', { ascending: true })
      .limit(1).maybeSingle()
      .then(({ data }: any) => {
        if (cancelled) return
        setEarliest(data?.order_finalized_at ? String(data.order_finalized_at).slice(0, 10) : null)
      })
    return () => { cancelled = true }
  }, [companyId])

  return earliest
}
