import { useEffect } from 'react'
import { useProfilePref } from './useProfilePrefs'

// Per-user font group. The brand fonts (Chakra Petch + DM Mono) are great for marketing, but small monospace text reads machine-like at the
// density SB Net runs at, so a user can pick a more readable group. Applied as data-font on <html>; index.css maps it to the --font-* variables
// that Tailwind's font-heading / font-body / font-mono use. Follows the user across devices, same as dark mode.
export type FontGroup = 'brand' | 'clean' | 'plain'
export const FONT_GROUPS: { id: FontGroup; label: string; sample: string }[] = [
  { id: 'brand', label: 'Brand', sample: 'Chakra Petch headings, DM Mono text' },
  { id: 'clean', label: 'Clean', sample: 'Chakra Petch headings, system sans text' },
  { id: 'plain', label: 'Plain', sample: 'System sans everywhere' },
]
const KEY = 'SBNet:fontGroup'

export function useFontGroup() {
  const [group, setGroup] = useProfilePref<FontGroup>(KEY, 'brand')
  const safe: FontGroup = group === 'clean' || group === 'plain' ? group : 'brand'
  useEffect(() => {
    if (safe === 'brand') document.documentElement.removeAttribute('data-font')
    else document.documentElement.setAttribute('data-font', safe)
  }, [safe])
  return { group: safe, setGroup }
}
