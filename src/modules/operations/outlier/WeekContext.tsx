import { createContext, useContext, useState, ReactNode } from 'react'
import {
  getThisWeekStart,
  getThisWeekEnd,
  getLastWeekStart,
  getLastWeekEnd,
  toDateString,
} from './lib/weekUtils'
import { WeekSelection } from './types'

interface WeekContextValue {
  selection: WeekSelection
  weekStart: Date
  weekEnd: Date
  weekStartStr: string
  weekEndStr: string
  setSelection: (s: WeekSelection) => void
  setCustomRange: (start: Date, end: Date) => void
}

const WeekContext = createContext<WeekContextValue | null>(null)

export function WeekProvider({ children }: { children: ReactNode }) {
  const [selection, setSelectionState] = useState<WeekSelection>('this')
  const [customStart, setCustomStart] = useState<Date>(getThisWeekStart())
  const [customEnd, setCustomEnd] = useState<Date>(getThisWeekEnd())

  const weekStart =
    selection === 'this' ? getThisWeekStart()
    : selection === 'last' ? getLastWeekStart()
    : customStart

  const weekEnd =
    selection === 'this' ? getThisWeekEnd()
    : selection === 'last' ? getLastWeekEnd()
    : customEnd

  function setSelection(s: WeekSelection) {
    setSelectionState(s)
  }

  function setCustomRange(start: Date, end: Date) {
    setCustomStart(start)
    setCustomEnd(end)
    setSelectionState('custom')
  }

  return (
    <WeekContext.Provider value={{
      selection,
      weekStart,
      weekEnd,
      weekStartStr: toDateString(weekStart),
      weekEndStr: toDateString(weekEnd),
      setSelection,
      setCustomRange,
    }}>
      {children}
    </WeekContext.Provider>
  )
}

export function useWeek() {
  const ctx = useContext(WeekContext)
  if (!ctx) throw new Error('useWeek must be used within WeekProvider')
  return ctx
}
