import { create } from 'zustand'
import { startOfWeek, format } from 'date-fns'
import type { WeeklyCount } from '@/types'

interface WeeklyState {
  // Sunday-start week (Sunday–Saturday), stored as the week-start date ('YYYY-MM-DD')
  selectedWeek: string
  loadedData: WeeklyCount[]

  setSelectedWeek: (week: string) => void
  setLoadedData: (data: WeeklyCount[]) => void
}

const thisWeekStart = format(startOfWeek(new Date(), { weekStartsOn: 0 }), 'yyyy-MM-dd')

export const useWeeklyStore = create<WeeklyState>((set) => ({
  selectedWeek: thisWeekStart,
  loadedData: [],

  setSelectedWeek: (selectedWeek) => set({ selectedWeek }),
  setLoadedData: (loadedData) => set({ loadedData }),
}))
