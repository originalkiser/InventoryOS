import { parseISO, isValid, format } from 'date-fns'
import { ReportEntry, Week } from '../types'

export interface StreakResult {
  type: 'streak' | 'last_seen' | 'never'
  count?: number          // weeks in streak
  lastDate?: string       // ISO date string of week_start
  lastWeekId?: string
}

/**
 * Given all historical entries (all weeks BEFORE current week) for a specific
 * row_key + report_id, and the list of those weeks sorted descending, compute
 * the streak/last-seen value.
 */
export function computeStreak(
  rowKey: string,
  currentWeekId: string,
  allEntries: ReportEntry[],
  allWeeks: Week[]
): StreakResult {
  // Sort weeks descending by week_start, excluding current week
  const sortedWeeks = [...allWeeks]
    .filter(w => w.id !== currentWeekId)
    .sort((a, b) => {
      const da = parseISO(a.week_start)
      const db = parseISO(b.week_start)
      return db.getTime() - da.getTime()
    })

  if (sortedWeeks.length === 0) return { type: 'never' }

  // Build a set of week IDs where this row_key appeared
  const weekIdsWithEntry = new Set(
    allEntries
      .filter(e => e.row_key === rowKey && e.week_id !== currentWeekId)
      .map(e => e.week_id)
  )

  if (weekIdsWithEntry.size === 0) return { type: 'never' }

  // Find most recent appearance
  const mostRecentWeek = sortedWeeks.find(w => weekIdsWithEntry.has(w.id))
  if (!mostRecentWeek) return { type: 'never' }

  // Count consecutive streak going back from most recent
  let streak = 0
  for (const week of sortedWeeks) {
    if (weekIdsWithEntry.has(week.id)) {
      streak++
    } else {
      break
    }
  }

  if (streak >= 2) {
    return {
      type: 'streak',
      count: streak,
      lastDate: mostRecentWeek.week_start,
      lastWeekId: mostRecentWeek.id,
    }
  }

  return {
    type: 'last_seen',
    lastDate: mostRecentWeek.week_start,
    lastWeekId: mostRecentWeek.id,
  }
}

export function formatStreakDate(isoDate: string): string {
  const d = parseISO(isoDate)
  if (!isValid(d)) return isoDate
  return format(d, 'MMM d, yyyy')
}
