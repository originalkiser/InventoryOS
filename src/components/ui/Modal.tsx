import React, { useEffect } from 'react'
import { usePinnedPanelStore } from '@/stores/pinnedPanelStore'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl' | '2xl' | 'wide' | 'wide90'
}

const sizeClasses = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  '2xl': 'max-w-6xl',
  // Direct ask 2026-09-30 — "up to 60% of the available width of the
  // workspace" (Add Non-Configured Product's own product-list modal, and
  // any future modal that needs real column room rather than a fixed
  // max-w-* step): a viewport-relative cap rather than another fixed
  // breakpoint, since "workspace width" varies by sidebar state/window size.
  wide: 'max-w-[60vw]',
  // 90% of the visible width — for a modal that's really a working table (Orders v2's shop product list).
  wide90: 'max-w-[90vw]',
}

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  // Direct ask 2026-09-30: a modal used to render BEHIND a docked side
  // panel (Location Lookup/Inventory/Today's Tasks/Quick Meeting — z-index
  // 65, see FloatingPanel.tsx) since Modal's own z-50 lost that fight.
  // z-[100] (below) fixes the overlap outright; insetting the whole
  // overlay's right edge by the panel's own width (read from
  // pinnedPanelStore, written by AppShell from the same number it already
  // uses to margin-shift the page content) additionally keeps the modal
  // centered in the remaining work area — and keeps the backdrop from
  // darkening the panel — instead of spanning across/behind it, so both
  // stay fully visible side by side rather than just no-longer-
  // overlapping. Read unconditionally (before the early return below) —
  // Hooks can't be called after a conditional return.
  const dockedWidth = usePinnedPanelStore((s) => s.dockedWidth)

  if (!open) return null

  return (
    <div className="fixed top-0 left-0 bottom-0 z-[100] flex items-center justify-center" style={{ right: dockedWidth }}>
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        className={[
          'relative w-full mx-2 sm:mx-4 max-h-[90vh] flex flex-col bg-cream border border-navy rounded-xl shadow-2xl',
          sizeClasses[size],
        ].join(' ')}
      >
        {title && (
          <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-navy/20 flex-shrink-0">
            <h2 className="text-sm font-heading font-bold text-navy tracking-wide uppercase">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="text-inky hover:text-navy transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div className="px-4 sm:px-6 py-4 overflow-y-auto">{children}</div>
      </div>
    </div>
  )
}
