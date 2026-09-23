// Routes a draft to the right review page based on its vendor — Mighty has
// no location_order_config-driven engine path at all (see mightyEngine.ts's
// own header comment), so it gets its own, much simpler review page
// instead of branching inside OrdersV2Review.tsx: that page's rendering,
// not just its generation, is pervasively coupled to engine.ts concepts
// (capacity, bulk/package smoothing, delivery schedules, keep-fill) that
// don't apply to Mighty at all.
//
// A lightweight vendor_id-only fetch, kept separate from each review
// page's own full useDraft() (draft + every line) call, so this routing
// check doesn't double the real load.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SbLoader } from '@/components/ui'
import { useVendors } from './useLookups'
import { OrdersV2Review } from './OrdersV2Review'
import { MightyOrderReview } from './MightyOrderReview'

const sb = () => supabase as any

export function OrdersV2DraftPage() {
  const { draftId = '' } = useParams()
  const vendors = useVendors()
  const [vendorId, setVendorId] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    setVendorId(undefined)
    sb().schema('inventory').from('ov2_order_drafts').select('vendor_id').eq('id', draftId).maybeSingle()
      .then(({ data }: any) => { if (!cancelled) setVendorId(data?.vendor_id ?? null) })
    return () => { cancelled = true }
  }, [draftId])

  // vendors.loading matters here as much as vendorId itself — isMighty()
  // reads vendors.byId(vendorId)?.vendor_code, which is null/undefined
  // (so isMighty reads false) until useVendors()'s own fetch resolves.
  // Found live 2026-09-23 chasing a related race (RelaDyne's order-day
  // restriction silently disabled the same way, see OrdersV2Review.tsx's
  // runGeneration) — this is the same bug one level up: routing a genuine
  // Mighty draft to OrdersV2Review (the wrong engine entirely) instead of
  // MightyOrderReview for whichever page load raced ahead of this fetch.
  if (vendorId === undefined || vendors.loading) return <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
  return vendors.isMighty(vendorId) ? <MightyOrderReview /> : <OrdersV2Review />
}
