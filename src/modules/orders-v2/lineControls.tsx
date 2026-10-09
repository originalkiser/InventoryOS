// Shared Orders v2 line-editing controls (direct ask 2026-10-02): the Qty
// stepper (− box +, beside the box instead of the browser's inside-the-box
// spinner arrows) and the optional "why did we zero this?" reason buttons.
// One implementation used by the classic review table, the beta table, and
// both shop-product lists so they can't drift.
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { DraftLineRow } from './useOrdersV2'

// ── Qty stepper ─────────────────────────────────────────────────────────

// Same height as the number box (the row is items-stretch) and twice the old 20px width, so they're easy to hit.
// Fluid variant (the Review table's Order Qty column): the box and both buttons shrink with the column instead of
// spilling over their neighbors — buttons share 1 part each, the box 2 parts, with small floors.
const FLUID_BTN = 'flex-1 basis-0 min-w-[0.9rem] max-w-[2.5rem] flex items-center justify-center overflow-hidden rounded-lg border-[1.5px] border-navy/30 bg-cream text-navy text-base leading-none font-semibold hover:bg-sky hover:text-sb-navy hover:border-inky active:scale-90 transition-[background,transform] select-none disabled:opacity-30 disabled:hover:bg-cream disabled:hover:text-navy disabled:active:scale-100'
// Compact variant (the Review table's Order Qty column): fixed, narrower buttons so every row's box lines up.
const COMPACT_BTN = 'w-7 flex-shrink-0 flex items-center justify-center rounded-lg border-[1.5px] border-navy/30 bg-cream text-navy text-base leading-none font-semibold hover:bg-sky hover:text-sb-navy hover:border-inky active:scale-90 transition-[background,transform] select-none disabled:opacity-30 disabled:hover:bg-cream disabled:hover:text-navy disabled:active:scale-100'
const STEP_BTN = 'w-10 flex-shrink-0 flex items-center justify-center rounded-lg border-[1.5px] border-navy/30 bg-cream text-navy text-base leading-none font-semibold hover:bg-sky hover:text-sb-navy hover:border-inky active:scale-90 transition-[background,transform] select-none disabled:opacity-30 disabled:hover:bg-cream disabled:hover:text-navy disabled:active:scale-100'

/**
 * Faint "+1" drifting up / "−1" drifting down from where the cursor clicked (see .qty-float-* in index.css). Plain DOM
 * appended to <body> and removed after the animation: the Review table re-renders (and re-creates its cells) the instant a
 * quantity changes, which used to throw away a React-state-driven float before it could be seen.
 */
function spawnFloat(dir: 1 | -1, x: number, y: number) {
  const el = document.createElement('span')
  el.textContent = dir > 0 ? '+1' : '−1'
  el.setAttribute('aria-hidden', 'true')
  el.className = `pointer-events-none rounded-full px-2 py-px font-heading text-[13px] font-bold tracking-wide shadow-[0_3px_8px_rgba(0,0,0,0.25)] ${dir > 0 ? 'bg-sb-green text-sb-navy sb-float-up' : 'bg-sb-red text-white sb-float-down'}`
  el.style.cssText = `position:fixed;left:${x - 8}px;top:${y - 10}px;z-index:500`
  document.body.appendChild(el)
  window.setTimeout(() => el.remove(), 800)
}

/** Enter in a qty box moves to the next row's qty box (Shift+Enter goes back up) within the same table. */
function moveToNextQty(el: HTMLInputElement, backwards: boolean) {
  const scope: ParentNode = el.closest('table') ?? document
  const inputs = Array.from(scope.querySelectorAll<HTMLInputElement>('input[data-qty-input]'))
  const next = inputs[inputs.indexOf(el) + (backwards ? -1 : 1)]
  if (next) { next.focus(); next.select() } else el.blur()
}
// Hides the native spinner arrows — the − / + buttons replace them.
const NO_SPINNER = '[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none'

/**
 * − [qty] + : minus on the left, plus on the right, each stepping by 1.
 * Keeps its own text state and only resyncs from `value` when it changed for
 * a reason other than its own last commit — a plain `value={qty}` controlled
 * input eats half-typed numbers like "0." when the parent re-renders (the
 * same bug Procurement Deck's DecimalMiniInput and the beta table's old
 * QtyInput were written to avoid).
 *
 * commitOn 'blur' is for a not-yet-ordered candidate row: typing a number
 * adds the product only once focus leaves the box (adding mid-typing would
 * swap the row out from under the cursor), while a + click adds immediately.
 */
export function QtyStepper({ value, onChange, bulk = false, commitOn = 'change', inputClassName = 'w-14', align = 'text-center', muted = false, zeroReason, fluid = false, compact = false }: {
  value: number
  onChange: (n: number) => void
  bulk?: boolean
  commitOn?: 'change' | 'blur'
  inputClassName?: string
  align?: 'text-center' | 'text-right'
  muted?: boolean
  /**
   * When given, a line that was suggested (> 0) and then set to 0 swaps its "−" button for a "0?" button that
   * pops up the optional "why did you zero this?" reasons right beside it (instead of a row of buttons elsewhere).
   */
  zeroReason?: { line: ReasonFields; onChange: (reason: ZeroReason | null, note: string | null) => void }
  /** Shrinks the box/buttons with the available width (and never wraps) — for a resizable table column. */
  fluid?: boolean
  /** Narrower, fixed-width +/- buttons. */
  compact?: boolean
}) {
  const [text, setText] = useState(() => String(value))
  const lastCommittedRef = useRef<number>(Number(value))
  useEffect(() => {
    if (Number(value) !== lastCommittedRef.current) {
      setText(String(value))
      lastCommittedRef.current = Number(value)
    }
  }, [value])

  function commit(n: number) {
    setText(String(n))
    lastCommittedRef.current = n
    onChange(n)
  }
  const bump = (delta: number, e: React.MouseEvent) => {
    const next = Math.max(0, Math.round(((Number(text) || 0) + delta) * 100) / 100)
    if (next === (Number(text) || 0)) return
    spawnFloat(delta > 0 ? 1 : -1, e.clientX, e.clientY)
    commit(next)
  }
  const showZeroReason = !!zeroReason && (Number(text) || 0) === 0 && Number(zeroReason.line.system_qty) > 0

  return (
    <div className={fluid ? 'relative flex items-stretch gap-0.5 w-full min-w-0 flex-nowrap' : 'relative inline-flex items-stretch gap-0.5'}>
      {showZeroReason && zeroReason
        ? <ZeroReasonPopoverButton line={zeroReason.line} onChange={zeroReason.onChange} fluid={fluid} compact={compact} />
        : <button type="button" title="Decrease by 1" disabled={(Number(text) || 0) <= 0} onClick={(e) => bump(-1, e)} className={fluid ? FLUID_BTN : compact ? COMPACT_BTN : STEP_BTN}>−</button>}
      <input
        type="number" min={0} step={bulk ? 0.1 : 1} value={text} placeholder="0" data-qty-input
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); moveToNextQty(e.currentTarget, e.shiftKey) } }}
        onChange={(e) => {
          setText(e.target.value)
          if (commitOn === 'change') {
            const n = Number(e.target.value) || 0
            lastCommittedRef.current = n
            onChange(n)
          }
        }}
        onBlur={() => {
          if (commitOn === 'blur' && (Number(text) || 0) !== lastCommittedRef.current) commit(Number(text) || 0)
        }}
        className={`${fluid ? 'flex-[2] w-0 min-w-[1.4rem]' : inputClassName} ${align} ${NO_SPINNER} bg-transparent border-[1.5px] rounded-lg px-1 py-0.5 focus:outline-none focus:ring-2 focus:ring-sky ${muted ? 'border-navy/20 text-inky/60' : 'border-navy/30 hover:border-inky text-navy'}`} />
      <button type="button" title="Increase by 1" onClick={(e) => bump(1, e)} className={fluid ? FLUID_BTN : compact ? COMPACT_BTN : STEP_BTN}>+</button>
    </div>
  )
}

// ── Zero-qty reason ─────────────────────────────────────────────────────

export type ZeroReason = 'on_order' | 'inaccurate_on_hand' | 'not_needed' | 'other'

export const ZERO_REASONS: { key: ZeroReason; label: string }[] = [
  { key: 'on_order', label: 'On order' },
  { key: 'inaccurate_on_hand', label: 'Inaccurate on hands' },
  { key: 'not_needed', label: 'Not needed' },
  { key: 'other', label: 'Other' },
]

export const zeroReasonLabel = (key: string | null | undefined): string | null =>
  ZERO_REASONS.find((r) => r.key === key)?.label ?? null

type ReasonFields = Pick<DraftLineRow, 'qty' | 'system_qty'> & { zero_reason?: string | null; zero_reason_note?: string | null }

/** A suggested product (engine proposed > 0) that someone then adjusted to 0. */
export const isZeroAdjusted = (l: Pick<DraftLineRow, 'qty' | 'system_qty'>) => Number(l.qty) === 0 && Number(l.system_qty) > 0

/** "On order" / "Other: <note>" — the reason as plain text, or null when none was given. */
export function zeroReasonText(l: ReasonFields): string | null {
  const label = zeroReasonLabel(l.zero_reason)
  if (!label) return null
  return l.zero_reason === 'other' && l.zero_reason_note?.trim() ? `Other: ${l.zero_reason_note.trim()}` : label
}

/**
 * "0?" button (stands in for the minus when a suggested line was zeroed). Opens a small interactive popover up and
 * to the right of the button with the optional reasons. Closing: click outside, Escape, or picking a reason.
 */
function ZeroReasonPopoverButton({ line, onChange, fluid = false, compact = false }: {
  line: ReasonFields
  onChange: (reason: ZeroReason | null, note: string | null) => void
  fluid?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const reason = (line.zero_reason ?? null) as ZeroReason | null
  const [note, setNote] = useState(line.zero_reason_note ?? '')
  useEffect(() => { setNote(line.zero_reason_note ?? '') }, [line.zero_reason_note])

  function toggle() {
    const r = btnRef.current?.getBoundingClientRect()
    // Anchor the popover's bottom-left corner to the button's top-right corner.
    if (r) setPos({ left: Math.min(r.right + 4, window.innerWidth - 200), top: r.top - 4 })
    setOpen((v) => !v)
  }
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])

  const chip = (active: boolean) =>
    `text-[10px] rounded border px-1.5 py-0.5 whitespace-nowrap text-left ${active ? 'bg-[#B7E0DE] text-[#002745] border-[#B7E0DE] font-bold' : 'border-[#F2F1E6]/30 text-[#F2F1E6] hover:border-[#B7E0DE]'}`
  return (
    <>
      <button ref={btnRef} type="button" onClick={toggle}
        title={reason ? `Zeroed — ${zeroReasonText(line)}` : 'Why was this zeroed? (optional)'}
        className={`${fluid ? 'flex-1 basis-0 min-w-[0.9rem] max-w-[2.5rem] overflow-hidden' : compact ? 'w-7 flex-shrink-0' : 'w-10 flex-shrink-0'} flex items-center justify-center rounded border text-[11px] font-mono font-bold leading-none select-none ${reason ? 'border-[#B7E0DE] bg-[#B7E0DE]/30 text-navy' : 'border-[#E67E22]/60 text-[#E67E22] hover:border-[#E67E22]'}`}>
        0?
      </button>
      {open && createPortal(
        <div ref={popRef} style={{ position: 'fixed', left: pos.left, top: pos.top, transform: 'translateY(-100%)', zIndex: 450 }}
          className="rounded-lg border border-[#B7E0DE]/40 bg-[#002745] p-2 shadow-xl flex flex-col gap-1 w-44 animate-[fadeIn_100ms_ease-out]">
          <span className="text-[9px] font-mono uppercase tracking-wide text-[#F2F1E6]/60">Why zero? (optional)</span>
          {ZERO_REASONS.map((r) => (
            <button key={r.key} type="button" className={chip(reason === r.key)}
              onClick={() => {
                if (reason === r.key) onChange(null, null)
                else onChange(r.key, r.key === 'other' ? (note.trim() || null) : null)
                if (r.key !== 'other') setOpen(false)
              }}>
              {r.label}
            </button>
          ))}
          {reason === 'other' && (
            <input autoFocus value={note} onChange={(e) => setNote(e.target.value)}
              onBlur={() => { if ((note.trim() || null) !== (line.zero_reason_note ?? null)) onChange('other', note.trim() || null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { onChange('other', note.trim() || null); setOpen(false) } }}
              placeholder="Reason…"
              className="w-full bg-transparent border border-[#F2F1E6]/30 rounded px-1.5 py-0.5 text-[10px] font-mono text-[#F2F1E6] placeholder-[#F2F1E6]/40 focus:outline-none focus:border-[#B7E0DE]" />
          )}
        </div>,
        document.body,
      )}
    </>
  )
}

/**
 * Small button group offered on a line the user zeroed out. Optional — never
 * required — but suggested so changes to the order can be tracked. Clicking
 * the chosen reason again clears it; "Other" opens a text box for details.
 */
export function ZeroReasonButtons({ line, onChange }: {
  line: ReasonFields
  onChange: (reason: ZeroReason | null, note: string | null) => void
}) {
  const reason = (line.zero_reason ?? null) as ZeroReason | null
  const [note, setNote] = useState(line.zero_reason_note ?? '')
  useEffect(() => { setNote(line.zero_reason_note ?? '') }, [line.zero_reason_note])
  const btn = (active: boolean) =>
    `text-[9px] rounded border px-1 py-0.5 whitespace-nowrap ${active ? 'bg-sb-sky text-sb-navy border-sb-sky font-bold' : 'border-navy/25 text-inky hover:border-navy'}`
  return (
    <div className="flex flex-col gap-1 mt-1">
      <div className="flex items-center gap-1 flex-wrap">
        <span className="text-[9px] font-mono text-inky/50 uppercase tracking-wide">Why zero?</span>
        {ZERO_REASONS.map((r) => (
          <button key={r.key} type="button" className={btn(reason === r.key)}
            onClick={() => (reason === r.key ? onChange(null, null) : onChange(r.key, r.key === 'other' ? (note.trim() || null) : null))}>
            {r.label}
          </button>
        ))}
      </div>
      {reason === 'other' && (
        <input
          value={note} onChange={(e) => setNote(e.target.value)}
          onBlur={() => { if ((note.trim() || null) !== (line.zero_reason_note ?? null)) onChange('other', note.trim() || null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
          placeholder="Reason…"
          className="w-full min-w-[9rem] bg-transparent border border-navy/25 rounded px-1 py-0.5 text-[10px] font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
      )}
    </div>
  )
}
