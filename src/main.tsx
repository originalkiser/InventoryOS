import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'react-hot-toast'
import './index.css'
import App from './App'

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
