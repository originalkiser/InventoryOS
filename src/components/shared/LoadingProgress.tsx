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

// Slide in (600ms) + hold at center (4000ms) + slide out (600ms) + wait
// off-screen (4000ms) = one full cycle. Matches the `loadingMessageCycle`
// keyframes in index.css — keep the two in sync if either changes.
const MESSAGE_CYCLE_MS = 9200

/**
 * Shared "big load in progress" block — branded spinner above a progress
 * bar, with a rotating line of fun status messages underneath so a long
 * pull (Heatmap orders, Droptop Orders, Orders v2 generation) doesn't read
 * as a single static spinner the whole time. Purely decorative rotation —
 * `messages` doesn't need to map 1:1 to real sub-steps, just read like it
 * could. Each message slides in from the right across the full bar width,
 * settles at center, then slides back out — see loadingMessageCycle in
 * index.css. The CSS animation loops continuously on its own; this only
 * swaps the text once per cycle, timed to land while it's off-screen so
 * nothing visibly pops mid-slide.
 */
export function LoadingProgress({ fraction, countText, messages }: LoadingProgressProps) {
  const [msgIndex, setMsgIndex] = useState(0)
  useEffect(() => {
    if (messages.length < 2) return
    const id = setInterval(() => setMsgIndex((i) => (i + 1) % messages.length), MESSAGE_CYCLE_MS)
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
        <div className="w-full max-w-md h-4 relative overflow-hidden">
          <p
            className="absolute inset-0 w-full text-center text-[10px] font-mono text-inky/50 italic"
            style={messages.length > 1 ? { animation: `loadingMessageCycle ${MESSAGE_CYCLE_MS}ms linear infinite` } : undefined}
          >
            {messages[msgIndex]}
          </p>
        </div>
      )}
    </div>
  )
}
