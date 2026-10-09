import { useEffect } from 'react'
import { useProfilePref } from './useProfilePrefs'

// Per-user color theme. "sb26" is the new palette from the SB design concepts (layered surfaces, cream text in dark mode); "legacy" is the
// original one, kept as a fallback in case the new colors misbehave on some page. Applied as data-colors on <html>; index.css holds the
// token values for both. Light/dark is separate (useDarkMode) and works with either.
export type ColorTheme = 'sb26' | 'legacy'
export const COLOR_THEMES: { id: ColorTheme; label: string; sample: string }[] = [
  { id: 'sb26', label: 'SB 2026', sample: 'Layered surfaces, higher contrast text' },
  { id: 'legacy', label: 'Legacy', sample: 'The original colors' },
]
const KEY = 'SBNet:colorTheme'

export function useColorTheme() {
  const [theme, setTheme] = useProfilePref<ColorTheme>(KEY, 'sb26')
  const safe: ColorTheme = theme === 'legacy' ? 'legacy' : 'sb26'
  useEffect(() => { document.documentElement.setAttribute('data-colors', safe) }, [safe])
  return { theme: safe, setTheme }
}
