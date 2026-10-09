// − [number] + : the data-grid entry control for counts and quantities. Click − / + to step (a faint +1 / −1 drifts up or down from the button),
// or type; arrow keys step too. Keeps its own text while typing (a controlled number box eats "12." mid-entry) and commits after a short pause or
// on blur, so rapid clicking is one save, not ten. Same look as the Orders v2 quantity stepper; Orders keeps its own (QtyStepper) because it
// has table-specific behavior (Enter moves to the next row, zero-reason buttons).
import { useEffect, useRef, useState } from 'react'

function spawnFloat(dir: 1 | -1, label: string, x: number, y: number) {
  const el = document.createElement('span')
  el.textContent = label
  el.setAttribute('aria-hidden', 'true')
  el.className = `pointer-events-none text-xs font-mono font-bold ${dir > 0 ? 'text-sb-green qty-float-up' : 'text-sb-red qty-float-down'}`
  el.style.cssText = `position:fixed;left:${x - 8}px;top:${y - 10}px;z-index:500`
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 1100)
}

const BTN = 'w-6 h-7 flex-shrink-0 flex items-center justify-center rounded-lg border-[1.5px] border-navy/30 bg-cream text-navy text-base leading-none select-none hover:bg-sky hover:text-sb-navy hover:border-inky active:scale-90 disabled:opacity-30 disabled:hover:bg-cream'
const NO_SPIN = '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'

const fmt = (n: number | null, decimals: number) => (n == null ? '' : String(Number(n.toFixed(decimals))))

export function NumberStepper({ value, onCommit, step = 1, min, max, decimals = 0, dirty, disabled, className = '' }: {
  value: number | null
  onCommit: (n: number | null) => void
  step?: number
  min?: number
  max?: number
  decimals?: number
  /** Shows the "unsaved" orange marker. */
  dirty?: boolean
  disabled?: boolean
  className?: string
}) {
  const [text, setText] = useState(fmt(value, decimals))
  const lastCommitted = useRef<number | null>(value)
  const timer = useRef<number | undefined>(undefined)
  // Resync from the outside only when `value` changed for a reason other than our own last commit.
  useEffect(() => {
    if (value !== lastCommitted.current) { setText(fmt(value, decimals)); lastCommitted.current = value }
  }, [value, decimals])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
  const parse = (t: string): number | null => { if (t.trim() === '') return null; const n = Number(t); return Number.isFinite(n) ? clamp(n) : null }
  const commit = (t: string) => {
    window.clearTimeout(timer.current)
    const n = parse(t)
    if (n === lastCommitted.current) return
    lastCommitted.current = n
    onCommit(n)
  }
  const bump = (dir: 1 | -1, e?: React.MouseEvent) => {
    const base = parse(text) ?? 0
    const next = clamp(Number((base + dir * step).toFixed(decimals)))
    if (next === base) return
    setText(fmt(next, decimals))
    if (e) spawnFloat(dir, `${dir > 0 ? '+' : '−'}${fmt(step, decimals)}`, e.clientX, e.clientY)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commit(fmt(next, decimals)), 450)
  }

  return (
    <div className={`inline-flex items-center gap-1 ${className}`}>
      <button type="button" className={BTN} disabled={disabled || (min != null && (parse(text) ?? 0) <= min)} onClick={(e) => bump(-1, e)} aria-label="Decrease" tabIndex={-1}>−</button>
      <input
        type="text" inputMode="decimal" value={text} disabled={disabled}
        onChange={(e) => { const t = e.target.value; if (/^-?\d*\.?\d*$/.test(t)) setText(t) }}
        onBlur={() => { commit(text); setText(fmt(parse(text), decimals)) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { (e.target as HTMLInputElement).blur() }
          else if (e.key === 'ArrowUp') { e.preventDefault(); bump(1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1) }
        }}
        className={`h-7 w-14 min-w-0 rounded-lg border-[1.5px] bg-cream px-1.5 text-center text-xs font-mono tabular-nums text-navy focus:outline-none focus:ring-2 focus:ring-sky ${dirty ? 'border-[#E67E22] bg-[#E67E22]/10' : 'border-navy/30 hover:border-inky'} ${NO_SPIN}`}
      />
      <button type="button" className={BTN} disabled={disabled || (max != null && (parse(text) ?? 0) >= max)} onClick={(e) => bump(1, e)} aria-label="Increase" tabIndex={-1}>+</button>
    </div>
  )
}
