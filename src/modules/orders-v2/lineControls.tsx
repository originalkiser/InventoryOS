// Shared Orders v2 line-editing controls (direct ask 2026-10-02): the Qty
// stepper (− box +, beside the box instead of the browser's inside-the-box
// spinner arrows) and the optional "why did we zero this?" reason buttons.
// One implementation used by the classic review table, the beta table, and
// both shop-product lists so they can't drift.
import { useEffect, useRef, useState } from 'react'
import type { DraftLineRow } from './useOrdersV2'

// ── Qty stepper ─────────────────────────────────────────────────────────

// Same height as the number box (the row is items-stretch) and twice the old 20px width, so they're easy to hit.
const STEP_BTN = 'w-10 flex-shrink-0 flex items-center justify-center rounded border border-navy/25 text-inky text-base leading-none hover:border-navy hover:text-navy disabled:opacity-30 disabled:hover:border-navy/25 select-none'

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
export function QtyStepper({ value, onChange, bulk = false, commitOn = 'change', inputClassName = 'w-14', align = 'text-center', muted = false }: {
  value: number
  onChange: (n: number) => void
  bulk?: boolean
  commitOn?: 'change' | 'blur'
  inputClassName?: string
  align?: 'text-center' | 'text-right'
  muted?: boolean
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
  const bump = (delta: number) => commit(Math.max(0, Math.round(((Number(text) || 0) + delta) * 100) / 100))

  return (
    <div className="inline-flex items-stretch gap-0.5">
      <button type="button" title="Decrease by 1" disabled={(Number(text) || 0) <= 0} onClick={() => bump(-1)} className={STEP_BTN}>−</button>
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
        className={`${inputClassName} ${align} ${NO_SPINNER} bg-transparent border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-sky ${muted ? 'border-navy/20 text-inky/60' : 'border-navy/25 text-navy'}`} />
      <button type="button" title="Increase by 1" onClick={() => bump(1)} className={STEP_BTN}>+</button>
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
