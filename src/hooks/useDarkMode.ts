import { useEffect, useState } from 'react'

const KEY = 'SBNet:darkMode'

export function useDarkMode() {
  const [dark, setDark] = useState(() => {
    try { return localStorage.getItem(KEY) === 'true' } catch { return false }
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    try { localStorage.setItem(KEY, String(dark)) } catch { /* ignore */ }
  }, [dark])

  return { dark, toggle: () => setDark((d) => !d) }
}
