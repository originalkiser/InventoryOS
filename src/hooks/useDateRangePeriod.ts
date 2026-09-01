import { useEffect, useState } from 'react'
import { type DatePeriod, type DateRange, computeRange } from '@/lib/datePeriods'

interface Stored { period: DatePeriod; customStart?: string; customEnd?: string }

// Persists the chosen period (and custom start/end, if that's what's
// chosen) to localStorage under `storageKey` so it's remembered next time
// this page loads — each caller uses its own key, so Customer Heatmap and
// Droptop Orders remember their own selection independently.
export function useDateRangePeriod(storageKey: string, defaultPeriod: DatePeriod = 'last_week') {
  const initial = (() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const parsed = JSON.parse(raw) as Stored
        const fallback = computeRange(defaultPeriod)
        return {
          period: parsed.period ?? defaultPeriod,
          customStart: parsed.customStart ?? fallback.start,
          customEnd: parsed.customEnd ?? fallback.end,
        }
      }
    } catch { /* ignore */ }
    const fallback = computeRange(defaultPeriod)
    return { period: defaultPeriod, customStart: fallback.start, customEnd: fallback.end }
  })()

  const [period, setPeriod] = useState<DatePeriod>(initial.period)
  const [customStart, setCustomStart] = useState(initial.customStart)
  const [customEnd, setCustomEnd] = useState(initial.customEnd)

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify({ period, customStart, customEnd })) } catch { /* ignore */ }
  }, [storageKey, period, customStart, customEnd])

  const range: DateRange = period === 'custom' ? { start: customStart, end: customEnd } : computeRange(period)

  return { period, setPeriod, customStart, setCustomStart, customEnd, setCustomEnd, range }
}
