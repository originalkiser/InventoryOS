import { create } from 'zustand'

// Direct ask 2026-09-30: modals were rendering BEHIND a docked side panel
// (Location Lookup/Inventory/Today's Tasks/Quick Meeting, each pushable to
// 'docked' via AppShell.tsx) — its z-index (65) is higher than Modal's own
// (50), and Modal centers itself across the FULL viewport with no
// awareness that a docked panel has already claimed the right edge of it.
// AppShell is the one place that already knows whether anything is docked
// and how wide it is (`pushWidth`, used to margin-shift the page content) —
// this store just mirrors that single number so Modal (far from AppShell
// in the tree) can read it without new prop drilling, matching this app's
// existing small-Zustand-store convention (weeklyStore, orderStore, etc.).
interface PinnedPanelState {
  // 0 when nothing is docked. AppShell writes this from its own `pushWidth`.
  dockedWidth: number
  setDockedWidth: (width: number) => void
}

export const usePinnedPanelStore = create<PinnedPanelState>((set) => ({
  dockedWidth: 0,
  setDockedWidth: (dockedWidth) => set({ dockedWidth }),
}))
