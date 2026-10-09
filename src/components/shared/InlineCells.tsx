import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { NumberStepper } from './NumberStepper'
import { useStagedCell, type StageInfo } from './StagedEdits'

// Shared inline-editable table cells (used by Exception Reporting + Location Comms).
// Transparent bg so row banding shows through.
// Padding widened 2026-09-25 (px-1.5 py-1 → px-2 py-1.5, direct feedback) —
// a close-but-not-quite click near a small dropdown/button used to land on
// the row underneath and open the full-edit modal instead of the control
// the user meant to use; a bigger control gives a bigger safe target.
const cellBase = 'bg-transparent rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky max-w-full truncate'
export const inputCls = `${cellBase} border border-navy/30`
// Borderless variant for constrained fields (date/select) — a subtle border
// appears on hover so the cell still reads as editable.
export const bareCls = `${cellBase} border border-transparent hover:border-navy/20`
// An edit that is staged (inside <StagedEdits>) but not saved yet.
const dirtyCls = '!border-[#E67E22] !bg-[#E67E22]/10'

// Every cell takes an optional `stage` ({ row, rowLabel, field }): inside a <StagedEdits> the change is held for review instead of saved at once.

export function EditText({ value, onSave, placeholder, className = '', stage }: { value: string | null; onSave: (v: string | null) => void; placeholder?: string; className?: string; stage?: StageInfo }) {
  const st = useStagedCell<string | null>(value, onSave, stage, (x) => x ?? '')
  const [v, setV] = useState(st.shown ?? '')
  useEffect(() => { setV(st.shown ?? '') }, [st.shown])
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onFocus={() => setV(st.shown ?? '')}
      onBlur={() => { if ((v.trim() || '') !== (st.shown ?? '')) st.save(v.trim() || null) }}
      placeholder={placeholder} className={`${inputCls} ${st.dirty ? dirtyCls : ''} ${className}`} />
  )
}

export function EditDate({ value, onSave, bare, className = '', title, stage }: { value: string | null; onSave: (v: string | null) => void; bare?: boolean; className?: string; title?: string; stage?: StageInfo }) {
  const st = useStagedCell<string | null>(value, onSave, stage, (x) => x ?? '')
  return <input type="date" value={st.shown ?? ''} title={title} onChange={(e) => st.save(e.target.value || null)} className={`${bare ? bareCls : inputCls} ${st.dirty ? dirtyCls : ''} ${className}`} />
}

export function EditSelect({ value, options, onSave, placeholder, allowCurrent, className = '', bare, stage }: {
  value: string | null; options: string[]; onSave: (v: string | null) => void; placeholder?: string; allowCurrent?: boolean; className?: string; bare?: boolean; stage?: StageInfo
}) {
  const st = useStagedCell<string | null>(value, onSave, stage, (x) => x ?? '')
  const shown = st.shown
  const opts = allowCurrent && shown && !options.includes(shown) ? [shown, ...options] : options
  // `truncate` (from cellBase, via inputCls/bareCls) keeps a native <select>'s
  // own rendered ellipsis fully inside the control's box as a column gets
  // resized narrow — found live 2026-09-25, a resize near a dropdown could
  // otherwise show "…" poking out past the control's own right edge.
  return (
    <select value={shown ?? ''} onChange={(e) => st.save(e.target.value || null)} className={`${bare ? bareCls : inputCls} ${st.dirty ? dirtyCls : ''} ${className}`}>
      <option value="">{placeholder ?? '—'}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// Fixed compact height (keeps rows small); user can drag taller. Scrolls internally.
export function CappedTextarea({ value, onSave, rows = 2, stage }: { value: string; onSave: (v: string | null) => void; rows?: number; stage?: StageInfo }) {
  const st = useStagedCell<string | null>(value, onSave, stage, (x) => x ?? '')
  const [v, setV] = useState(st.shown ?? '')
  useEffect(() => { setV(st.shown ?? '') }, [st.shown])
  return (
    <textarea value={v} rows={rows} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((v.trim() || '') !== (st.shown ?? '')) st.save(v.trim() || null) }}
      className={`${inputCls} ${st.dirty ? dirtyCls : ''} w-52 resize-y max-h-24 overflow-auto leading-snug align-top`} />
  )
}

// Auto-grows to fit its content (row height expands); width and height are
// also user-resizable via the corner handle. Typing only ever grows the box
// (never shrinks a height the user dragged taller) so a manual vertical
// resize survives further edits.
export function AutoTextarea({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setV(value) }, [value])
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const prevPx = parseFloat(el.style.height || '0')
    el.style.height = 'auto'
    el.style.height = `${Math.max(el.scrollHeight, prevPx)}px`
  }, [v])
  return (
    <textarea ref={ref} value={v} rows={1}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
      className={`${inputCls} resize w-48 min-w-[8rem] overflow-hidden leading-snug align-top`} />
  )
}

/** − [number] + for counts and quantities (see NumberStepper). Stages its change inside <StagedEdits>, saves after a short pause otherwise. */
export function EditNumber({ value, onSave, step = 1, min, max, decimals = 0, className = '', stage }: {
  value: number | null; onSave: (v: number | null) => void; step?: number; min?: number; max?: number; decimals?: number; className?: string; stage?: StageInfo
}) {
  const st = useStagedCell<number | null>(value, onSave, stage, (x) => (x == null ? '' : String(x)))
  return <NumberStepper value={st.shown} onCommit={st.save} step={step} min={min} max={max} decimals={decimals} dirty={st.dirty} className={className} />
}
