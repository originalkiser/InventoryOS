import { useProfilePref } from './useProfilePrefs'

// Which navigation the user wants: the sidebar (accordion), a mega menu in the top bar, or a floating dock. Profile-backed so it follows the
// user across devices. Phones always use the sidebar drawer regardless.
export type NavLayout = 'sidebar' | 'mega' | 'dock'
export const NAV_LAYOUTS: { id: NavLayout; label: string; sample: string }[] = [
  { id: 'sidebar', label: 'Sidebar', sample: 'Accordion sections down the left, collapses to an icon rail' },
  { id: 'mega', label: 'Mega menu', sample: 'Section buttons across the top; each opens a panel of page cards' },
  { id: 'dock', label: 'Floating dock', sample: 'A draggable icon toolbar that fans each section out' },
]

export function useNavLayout() {
  const [layout, setLayout] = useProfilePref<NavLayout>('nav:layout', 'sidebar')
  const safe: NavLayout = layout === 'mega' || layout === 'dock' ? layout : 'sidebar'
  return { layout: safe, setLayout }
}

/** Accordion (one open section at a time) for the sidebar. */
export function useNavAccordion() {
  return useProfilePref<boolean>('nav:accordion', true)
}

// ── Floating dock settings (Profile → Navigation, shown when the dock layout is picked) ─────────────────────────────────────────────────────
export type DockEdge = 'left' | 'right' | 'top' | 'bottom'
export interface DockPrefs {
  x: number | null
  y: number | null
  orient: 'v' | 'h'
  mini: boolean
  search: boolean
  /** Fixed to a screen edge (the workspace makes room for it) instead of floating where it was dragged. */
  snap: 'none' | DockEdge
  /** Collapse to the SB logo bubble when you click away from the dock and its pop-outs. */
  autoCollapse: boolean
}
export const DEFAULT_DOCK: DockPrefs = { x: null, y: null, orient: 'v', mini: false, search: true, snap: 'none', autoCollapse: false }

export function useDockPrefs() {
  const [raw, setRaw] = useProfilePref<Partial<DockPrefs>>('nav:dock', DEFAULT_DOCK)
  const prefs: DockPrefs = { ...DEFAULT_DOCK, ...raw }
  const update = (patch: Partial<DockPrefs>) => setRaw({ ...prefs, ...patch })
  return { prefs, update }
}

/** Space (px) a snapped dock takes from each side of the workspace: a 46px button + padding + a 12px gap to the screen edge. */
export const DOCK_THICKNESS = 76
export function dockReserve(layout: NavLayout, prefs: DockPrefs): { left: number; right: number; top: number; bottom: number } {
  const r = { left: 0, right: 0, top: 0, bottom: 0 }
  if (layout === 'dock' && prefs.snap !== 'none') r[prefs.snap] = DOCK_THICKNESS
  return r
}

// ── Mega menu: which sections show in the bar and in what order (Profile -> Navigation) ───────────────────────────────────────────────────
export function useMegaPrefs() {
  const [order, setOrder] = useProfilePref<string[]>('nav:megaOrder', [])
  const [hidden, setHidden] = useProfilePref<string[]>('nav:megaHidden', [])
  return { order, setOrder, hidden, setHidden }
}

/** The user's own order first (sections they haven't ordered yet follow in their normal order), minus the ones they turned off. */
export function applyMegaPrefs<T extends { key: string }>(items: T[], order: string[], hidden: string[]): T[] {
  const rank = new Map(order.map((k, i) => [k, i]))
  const sorted = items.map((it, i) => ({ it, i })).sort((a, b) => (rank.get(a.it.key) ?? 1000 + a.i) - (rank.get(b.it.key) ?? 1000 + b.i))
  return sorted.map((x) => x.it).filter((it) => !hidden.includes(it.key))
}
