// Client for the address-level geocoding Edge Function (geocode-orders) —
// resolves Droptop orders' street addresses to real lat/lng via the free
// US Census Geocoding Services API, as an optional alternative to the
// existing zip-centroid heatmap plotting (see CustomerHeatmapPage.tsx's
// geocoding toggle). Not a replacement — zip-centroid stays the default.
//
// Loops the Edge Function call (each invocation processes a bounded
// number of orders, ORDERS_PER_RUN server-side) until it reports no more
// ungeocoded orders remain — same "many small invocations, not one big
// one" reasoning as every other Droptop sync in this app.

import { supabase } from '@/lib/supabase'

export interface GeocodeProgress {
  processed: number
  matched: number
  noMatch: number
  cachedHits: number
  remaining: number
  totalProcessed: number
}

export interface GeocodeSummary {
  totalProcessed: number
  totalMatched: number
  totalNoMatch: number
  totalCachedHits: number
  warnings: string[]
}

export async function runGeocoding(
  companyId: string,
  onProgress?: (p: GeocodeProgress) => void,
): Promise<GeocodeSummary> {
  if (!companyId) throw new Error('No company loaded')
  let totalProcessed = 0
  let totalMatched = 0
  let totalNoMatch = 0
  let totalCachedHits = 0
  const warnings: string[] = []

  for (;;) {
    const { data, error } = await supabase.functions.invoke('geocode-orders', { body: {} })
    if (error) throw new Error(error.message)
    if (data?.error) throw new Error(data.error)

    const processed = data.processed ?? 0
    const matched = data.matched ?? 0
    const noMatch = data.no_match ?? 0
    const cachedHits = data.cached_hits ?? 0
    const remaining = data.remaining ?? 0
    if (data.warnings?.length) warnings.push(...data.warnings)

    totalProcessed += processed
    totalMatched += matched
    totalNoMatch += noMatch
    totalCachedHits += cachedHits

    onProgress?.({ processed, matched, noMatch, cachedHits, remaining, totalProcessed })

    if (processed === 0 || remaining === 0) break
  }

  return { totalProcessed, totalMatched, totalNoMatch, totalCachedHits, warnings }
}
