import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import './index.css'
import App from './App'

// The update banner reloads with a `?_v=…` cache-buster. Strip it from the URL
// once we're loaded so it doesn't linger or confuse the router.
if (typeof window !== 'undefined' && window.location.search.includes('_v=')) {
  const url = new URL(window.location.href)
  url.searchParams.delete('_v')
  window.history.replaceState({}, '', url.toString())
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <Toaster
      position="bottom-right"
      toastOptions={{
        style: {
          background: '#161820',
          color: '#e5e7eb',
          border: '1px solid #2a2d3e',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: '12px',
        },
        success: { iconTheme: { primary: '#39ff14', secondary: '#0f1117' } },
        error: { iconTheme: { primary: '#ef4444', secondary: '#0f1117' } },
      }}
    />
  </StrictMode>
)
