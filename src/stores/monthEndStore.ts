import { create } from 'zustand'
import type { CountUploadBatch, RecountConfig } from '@/types'

export type MonthEndTab = 'summary' | 'products' | 'recounts' | 'missing' | 'balances'

interface MonthEndState {
  // Selected period
  month: number // 1-12
  year: number
  activeTab: MonthEndTab

  // Caches
  loadedBatches: CountUploadBatch[]
  recountConfig: RecountConfig | null

  setPeriod: (month: number, year: number) => void
  setActiveTab: (tab: MonthEndTab) => void
  setLoadedBatches: (batches: CountUploadBatch[]) => void
  setRecountConfig: (config: RecountConfig | null) => void
  // First-of-month 'YYYY-MM-DD' string for the selected period
  getCountMonth: () => string
}

const now = new Date()

export const useMonthEndStore = create<MonthEndState>((set, get) => ({
  month: now.getMonth() + 1,
  year: now.getFullYear(),
  activeTab: 'summary',

  loadedBatches: [],
  recountConfig: null,

  setPeriod: (month, year) => set({ month, year }),
  setActiveTab: (activeTab) => set({ activeTab }),
  setLoadedBatches: (loadedBatches) => set({ loadedBatches }),
  setRecountConfig: (recountConfig) => set({ recountConfig }),
  getCountMonth: () => {
    const { month, year } = get()
    return `${year}-${String(month).padStart(2, '0')}-01`
  },
}))
