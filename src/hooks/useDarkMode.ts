import { useEffect } from 'react'
import { useProfilePref } from './useProfilePrefs'

const KEY = 'SBNet:darkMode'

// Dark mode preference — follows the user across devices (profile-backed, with
// a localStorage cache so the theme applies instantly on load).
export function useDarkMode() {
  const [dark, setDark] = useProfilePref<boolean>(KEY, false)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  return { dark, toggle: () => setDark(!dark) }
}
