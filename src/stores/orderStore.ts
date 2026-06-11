import { create } from 'zustand'
import type { GeneratedLineItem, GenerationParams, InventoryRow } from '@/lib/orderEngine'
import type { ColumnMapping } from '@/types'

export type SourceMode = 'manual' | 'file' | 'live'

const DEFAULT_PARAMS: GenerationParams = {
  targetDays: 14,
  orderMode: 'min_max',
  zeroUsageFill: 'none',
  triggerOverride: null,
  limitOverride: null,
}

interface OrderState {
  sessionId: string | null // set once persisted
  sessionName: string
  sourceMode: SourceMode
  inputRows: InventoryRow[] // resolved inventory input
  params: GenerationParams
  mapping: ColumnMapping[] // file column mapping (snapshotted by profiles)
  lineItems: GeneratedLineItem[] // generated + edited
  selectedMinRuleIds: string[]
  dirty: boolean

  setSessionId: (id: string | null) => void
  setSessionName: (name: string) => void
  setSourceMode: (m: SourceMode) => void
  setInputRows: (rows: InventoryRow[]) => void
  setParams: (p: Partial<GenerationParams>) => void
  setMapping: (m: ColumnMapping[]) => void
  setLineItems: (items: GeneratedLineItem[]) => void
  setSelectedMinRuleIds: (ids: string[]) => void
  updateFinalQty: (index: number, qty: number) => void // flips manual_override semantics in UI
  reset: () => void
}

export const useOrderStore = create<OrderState>((set) => ({
  sessionId: null,
  sessionName: '',
  sourceMode: 'file',
  inputRows: [],
  params: { ...DEFAULT_PARAMS },
  mapping: [],
  lineItems: [],
  selectedMinRuleIds: [],
  dirty: false,

  setSessionId: (sessionId) => set({ sessionId }),
  setSessionName: (sessionName) => set({ sessionName, dirty: true }),
  setSourceMode: (sourceMode) => set({ sourceMode }),
  setInputRows: (inputRows) => set({ inputRows, dirty: true }),
  setParams: (p) => set((s) => ({ params: { ...s.params, ...p }, dirty: true })),
  setMapping: (mapping) => set({ mapping, dirty: true }),
  setLineItems: (lineItems) => set({ lineItems, dirty: true }),
  setSelectedMinRuleIds: (selectedMinRuleIds) => set({ selectedMinRuleIds, dirty: true }),
  updateFinalQty: (index, qty) => set((s) => ({
    lineItems: s.lineItems.map((li, i) => (i === index ? { ...li, final_qty: Math.max(0, qty) } : li)),
    dirty: true,
  })),
  reset: () => set({
    sessionId: null,
    sessionName: '',
    sourceMode: 'file',
    inputRows: [],
    params: { ...DEFAULT_PARAMS },
    mapping: [],
    lineItems: [],
    selectedMinRuleIds: [],
    dirty: false,
  }),
}))
