import { useEffect, useState } from 'react'
import { SbLoader } from '@/components/ui'

interface LoadingProgressProps {
  /** How far along the load is — pass `null` for an indeterminate pulse instead of a filled bar. */
  fraction: number | null
  /** Count/percentage line under the bar, e.g. "Loading orders — 4,200 of 86,000 (5%)". */
  countText: string
  /** Rotates through these underneath the count line, one at a time, for the duration of the load. */
  messages: string[]
}

/**
 * Shared "big load in progress" block — branded spinner above a progress
 * bar, with a rotating line of fun status messages underneath so a long
 * pull (Heatmap orders, Droptop Orders, Orders v2 generation) doesn't read
 * as a single static spinner the whole time. Purely decorative rotation —
 * `messages` doesn't need to map 1:1 to real sub-steps, just read like it
 * could.
 */
export function LoadingProgress({ fraction, countText, messages }: LoadingProgressProps) {
  const [msgIndex, setMsgIndex] = useState(0)
  useEffect(() => {
    if (messages.length < 2) return
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), 1800)
    return () => clearInterval(id)
  }, [messages.length])

  return (
    <div className="py-16 flex flex-col items-center gap-3">
      <SbLoader size={40} />
      <div className="w-full max-w-md h-2 bg-navy/10 rounded-full overflow-hidden">
        {fraction != null ? (
          <div
            className="h-full bg-sky transition-[width] duration-300 ease-out"
            style={{ width: `${Math.min(100, Math.round(fraction * 100))}%` }}
          />
        ) : (
          <div className="h-full w-full bg-sky/40 animate-pulse" />
        )}
      </div>
      <p className="text-[11px] font-mono text-inky/70">{countText}</p>
      {messages.length > 0 && (
        <p key={msgIndex} className="text-[10px] font-mono text-inky/50 italic animate-[swipeRight_220ms_ease-out]">
          {messages[msgIndex]}
        </p>
      )}
    </div>
  )
}
