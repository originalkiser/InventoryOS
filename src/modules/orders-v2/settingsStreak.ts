// "Unchanged in N orders": how many consecutive orders for one vendor — ending at (and including) the given one —
// were generated with the same value of a setting. Pure so it can be tested.
export interface StreakDraft {
  id: string
  vendor_id: string | null
  order_date: string
  created_at: string
  status?: string
  settings_snapshot: Record<string, unknown> | null | undefined
}

const newestFirst = (a: StreakDraft, b: StreakDraft) =>
  b.order_date.localeCompare(a.order_date) || b.created_at.localeCompare(a.created_at)

/** 1 = only this order has that value; N = this and the N-1 orders before it (same vendor) all match. */
export function unchangedStreak(key: string, current: StreakDraft, all: StreakDraft[]): number {
  const same = all
    .filter((d) => d.vendor_id === current.vendor_id && d.status !== 'cancelled')
    .sort(newestFirst)
  const start = same.findIndex((d) => d.id === current.id)
  if (start < 0) return 1
  const value = JSON.stringify(current.settings_snapshot?.[key])
  let n = 1
  for (let i = start + 1; i < same.length; i++) {
    const v = same[i].settings_snapshot?.[key]
    if (v === undefined || JSON.stringify(v) !== value) break
    n++
  }
  return n
}
