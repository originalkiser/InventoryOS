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
