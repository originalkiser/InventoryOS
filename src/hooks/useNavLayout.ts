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
