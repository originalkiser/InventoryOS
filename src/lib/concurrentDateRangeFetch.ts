// Shared concurrency helper for the two pages that page through a big,
// date-filtered droptop_orders pull (Customer Heatmap, Droptop Orders) —
// both used to run one long sequential keyset-pagination loop (page N+1
// can't start until page N's cursor is known), which is correct but leaves
// real latency on the table: the whole load is bottlenecked on round-trip
// time × page count, even though the underlying table can easily serve
// several requests at once.
//
// The fix keeps the SAME keyset pagination each page relies on for its
// index-friendly seek (see both callers' own comments on why plain OFFSET
// paging was rejected) — it just runs N of those loops concurrently, each
// scoped to its own slice of the date range, rather than one loop covering
// the whole range serially. Slices are non-overlapping calendar-day
// windows, so merging every worker's results at the end can never produce
// a duplicate or a gap at a boundary.
//
// Worker count scales with how much there actually is to fetch (from the
// caller's own COUNT-only query) — a small pull runs on a single worker
// exactly as before; splitting a 200-row range into 6 concurrent slices
// would just add overhead for no benefit.

export interface DateCursor { date: string; id: string }

export interface ConcurrentFetchOptions<T> {
  rangeStart: string // 'YYYY-MM-DD'
  rangeEnd: string   // 'YYYY-MM-DD'
  totalCount: number | null
  /** Rows per worker per COUNT bucket before another worker is added — e.g. 2000 means a 10,000-row pull gets ~5 workers. */
  rowsPerWorker?: number
  maxWorkers?: number
  /** Fetches one page within [subStart, subEnd] after `cursor` (or from the start of the slice if null). Must return rows sorted by (date, id) ascending, and an empty array to signal the slice is exhausted. */
  fetchPage: (subStart: string, subEnd: string, cursor: DateCursor | null) => Promise<T[]>
  /** Pulls the (date, id) cursor fields off a row — whatever the caller's own OrderRow shape calls them. */
  cursorOf: (row: T) => DateCursor
  onProgress?: (loadedSoFar: number) => void
  isCancelled?: () => boolean
}

/** Splits [start, end] (inclusive, 'YYYY-MM-DD') into `n` contiguous, non-overlapping day-count slices. */
function splitDateRange(start: string, end: string, n: number): { start: string; end: string }[] {
  const startDate = new Date(`${start}T00:00:00.000Z`)
  const endDate = new Date(`${end}T00:00:00.000Z`)
  const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1
  const workers = Math.max(1, Math.min(n, totalDays))
  const base = Math.floor(totalDays / workers)
  const extra = totalDays % workers
  const slices: { start: string; end: string }[] = []
  let cursorDays = 0
  for (let i = 0; i < workers; i++) {
    const len = base + (i < extra ? 1 : 0) // spread the remainder over the first few slices
    if (len <= 0) continue
    const sliceStart = new Date(startDate); sliceStart.setUTCDate(sliceStart.getUTCDate() + cursorDays)
    const sliceEnd = new Date(startDate); sliceEnd.setUTCDate(sliceEnd.getUTCDate() + cursorDays + len - 1)
    slices.push({ start: sliceStart.toISOString().slice(0, 10), end: sliceEnd.toISOString().slice(0, 10) })
    cursorDays += len
  }
  return slices
}

/**
 * Runs `fetchPage` concurrently across date-range slices, keyset-paginating
 * each slice independently, and returns every row from every slice merged
 * together (order across slices is not guaranteed — callers that need a
 * specific order should sort the result themselves).
 */
export async function fetchDateRangeConcurrent<T>(opts: ConcurrentFetchOptions<T>): Promise<T[]> {
  const rowsPerWorker = opts.rowsPerWorker ?? 2000
  const maxWorkers = opts.maxWorkers ?? 6
  const workerCount = Math.max(1, Math.min(maxWorkers, Math.ceil((opts.totalCount ?? rowsPerWorker) / rowsPerWorker)))
  const slices = splitDateRange(opts.rangeStart, opts.rangeEnd, workerCount)

  const all: T[] = []
  let loaded = 0

  async function runSlice(slice: { start: string; end: string }) {
    let cursor: DateCursor | null = null
    for (;;) {
      if (opts.isCancelled?.()) return
      const page = await opts.fetchPage(slice.start, slice.end, cursor)
      if (page.length === 0) return
      all.push(...page)
      loaded += page.length
      opts.onProgress?.(loaded)
      cursor = opts.cursorOf(page[page.length - 1])
    }
  }

  await Promise.all(slices.map(runSlice))
  return all
}
