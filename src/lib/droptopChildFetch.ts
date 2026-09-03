// Shared chunked+paginated fetch for Droptop order child tables
// (droptop_order_packages/_products/_services/_vehicles, all keyed by
// order_id) — extracted from DroptopOrdersPage.tsx so the Customer Heatmap
// and Vehicles pages can reuse the exact same, already-debugged fetch shape
// instead of re-deriving it. See the two correctness properties this
// depends on, both learned the hard way on DroptopOrdersPage:
//
// 1. This project's Supabase "Max Rows" API setting silently caps EVERY
//    response at 1000 regardless of what .limit() requests, and a chunk of
//    order ids can produce more result rows than input ids (an order can
//    have multiple packages/products/services) — so an unpaginated .in()
//    can silently drop rows past 1000 with no error. Paginate by (id)
//    cursor per chunk until a genuinely empty page comes back.
// 2. A single chunk/page timing out used to throw immediately and discard
//    every row fetched so far for that table — retry a page a couple times
//    before giving up.
import { supabase } from '@/lib/supabase'

// Order-id chunk size — module-level so a caller's own progress tracking
// (how many chunks are left) can compute the same total without drifting.
export const ORDER_ID_CHUNK = 200

// How many order-id chunks to fetch at once, per table. Chunks are
// independent of each other (each is its own `order_id IN (...)` scope,
// unlike the pages WITHIN a chunk which depend on each other's cursor), so
// running several concurrently is free correctness-wise.
export const CHUNK_CONCURRENCY = 4

// Fetch rows for a batch of order ids, chunking the input AND paginating
// each chunk's output.
export async function fetchByOrderIds<T>(table: string, orderIds: string[], select: string, onChunk?: () => void): Promise<T[]> {
  const sb = supabase as any
  const CHUNK = ORDER_ID_CHUNK
  const PAGE = 1000
  const MAX_PAGE_RETRIES = 2

  async function fetchChunk(slice: string[]): Promise<T[]> {
    const out: T[] = []
    let cursor: string | null = null
    for (;;) {
      let data: ({ id: string } & T)[] | null = null
      let lastErr: string | null = null
      for (let attempt = 0; attempt <= MAX_PAGE_RETRIES; attempt++) {
        let q = sb.schema('inventory').from(table).select(`id, ${select}`)
          .in('order_id', slice).order('id', { ascending: true }).limit(PAGE)
        if (cursor) q = q.gt('id', cursor)
        const { data: pageData, error } = await q
        if (!error) { data = (pageData ?? []) as ({ id: string } & T)[]; break }
        lastErr = error.message
        if (attempt < MAX_PAGE_RETRIES) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
      }
      if (data === null) throw new Error(`${table}: ${lastErr ?? 'Failed to load'}`)
      out.push(...data)
      if (data.length === 0) break
      cursor = data[data.length - 1].id
    }
    onChunk?.()
    return out
  }

  const chunks: string[][] = []
  for (let i = 0; i < orderIds.length; i += CHUNK) chunks.push(orderIds.slice(i, i + CHUNK))

  // Bounded worker pool — CHUNK_CONCURRENCY chunks in flight at once,
  // pulling the next one off the queue as each finishes, rather than firing
  // every chunk at once.
  const results: T[][] = new Array(chunks.length)
  let nextIndex = 0
  async function worker() {
    for (;;) {
      const i = nextIndex++
      if (i >= chunks.length) return
      results[i] = await fetchChunk(chunks[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(CHUNK_CONCURRENCY, chunks.length) }, worker))
  return results.flat()
}
