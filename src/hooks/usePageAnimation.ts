import { useProfilePref } from './useProfilePrefs'

// How a page change animates (Profile → Appearance → Page animation). "push" slides the old page out as the new one slides in, "flip" turns the
// page over, "cascade" drops the new page's blocks in one after another, "shuffle" picks one of those at random each time.
export type PageAnimation = 'push' | 'cascade' | 'flip' | 'shuffle' | 'off'
export type PageAnimMode = 'push' | 'cascade' | 'flip'
export const PAGE_ANIMATIONS: { id: PageAnimation; label: string; sample: string }[] = [
  { id: 'push', label: 'Slide push', sample: 'The old page slides out as the new one slides in' },
  { id: 'cascade', label: 'Drop-in cascade', sample: 'The new page\'s blocks drop in one after another' },
  { id: 'flip', label: 'Flip', sample: 'The page turns over to the next one' },
  { id: 'shuffle', label: 'Shuffle', sample: 'A different one of the three every time' },
  { id: 'off', label: 'None', sample: 'No page animation' },
]

export function usePageAnimation() {
  const [pref, setPref] = useProfilePref<PageAnimation>('nav:pageAnim', 'push')
  const safe: PageAnimation = PAGE_ANIMATIONS.some((a) => a.id === pref) ? pref : 'push'
  return { animation: safe, setAnimation: setPref }
}

const MODES: PageAnimMode[] = ['push', 'cascade', 'flip']
/** The animation to use for one navigation (null = none). Honors the OS "reduce motion" setting. */
export function resolvePageAnimMode(pref: PageAnimation): PageAnimMode | null {
  if (pref === 'off') return null
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null
  return pref === 'shuffle' ? MODES[Math.floor(Math.random() * MODES.length)] : pref
}
