// Client for the vin-decode Edge Function — fills in Trim/Engine for VINs
// Droptop itself never sends them for (see that function's own header
// comment). Used by the Droptop Vehicles page's "Decode Engine/Trim"
// button, on whatever VINs are currently in view.
//
// Chunks the VIN list client-side (CHUNK_SIZE per call) and loops until
// every chunk has been sent — same "many small invocations" reasoning as
// runGeocoding, so one big filtered view doesn't risk a single Edge
// Function call timing out.

import { supabase } from '@/lib/supabase'

export interface VinDecodeProgress {
  processed: number
  total: number
}

export interface VinDecodeSummary {
  requested: number
  cachedHits: number
  newlyDecoded: number
  warnings: string[]
}

const CHUNK_SIZE = 300

export interface AutoVinDecodeProgress {
  processedSoFar: number
}

// Auto-discover mode, looped until nothing's left — same "many small
// invocations until remaining is 0" shape as runGeocoding. Each call finds
// up to AUTO_MAX_VINS undecoded VINs itself (see vin-decode's own header
// comment) rather than the caller supplying a list, so this is what a big
// Historical Backfill's "now decode whatever new vehicles that just
// brought in" follow-up uses, instead of requiring the caller to know
// which VINs are new.
export async function runAutoVinDecode(
  onProgress?: (p: AutoVinDecodeProgress) => void,
): Promise<VinDecodeSummary> {
  let cachedHits = 0
  let newlyDecoded = 0
  const warnings: string[] = []

  for (;;) {
    const { data, error } = await supabase.functions.invoke('vin-decode', { body: {} })
    if (error) throw new Error(error.message)
    if (data?.error) throw new Error(data.error)

    cachedHits += data.cached_hits ?? 0
    newlyDecoded += data.newly_decoded ?? 0
    if (data.warnings?.length) warnings.push(...data.warnings)
    onProgress?.({ processedSoFar: cachedHits + newlyDecoded })

    // Nothing found at all (attempted === 0 and no cache hits either) means
    // the backlog is genuinely empty right now — stop rather than looping
    // forever on a zero-VIN response.
    if (!data.more_remaining || ((data.attempted ?? 0) === 0 && (data.cached_hits ?? 0) === 0)) break
  }

  return { requested: cachedHits + newlyDecoded, cachedHits, newlyDecoded, warnings }
}

export async function runVinDecode(
  vins: string[],
  onProgress?: (p: VinDecodeProgress) => void,
): Promise<VinDecodeSummary> {
  const unique = [...new Set(vins)]
  let cachedHits = 0
  let newlyDecoded = 0
  const warnings: string[] = []

  for (let i = 0; i < unique.length; i += CHUNK_SIZE) {
    const chunk = unique.slice(i, i + CHUNK_SIZE)
    const { data, error } = await supabase.functions.invoke('vin-decode', { body: { vins: chunk } })
    if (error) throw new Error(error.message)
    if (data?.error) throw new Error(data.error)

    cachedHits += data.cached_hits ?? 0
    newlyDecoded += data.newly_decoded ?? 0
    if (data.warnings?.length) warnings.push(...data.warnings)

    onProgress?.({ processed: Math.min(i + chunk.length, unique.length), total: unique.length })
  }

  return { requested: unique.length, cachedHits, newlyDecoded, warnings }
}
