import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// Shared inline-editable table cells (used by Exception Reporting + Location Comms).
// Transparent bg so row banding shows through.
const cellBase = 'bg-transparent rounded px-1.5 py-1 text-xs font-mono text-navy focus:outline-none focus:ring-1 focus:ring-sky'
export const inputCls = `${cellBase} border border-navy/30`
// Borderless variant for constrained fields (date/select) — a subtle border
// appears on hover so the cell still reads as editable.
export const bareCls = `${cellBase} border border-transparent hover:border-navy/20`

export function EditText({ value, onSave, placeholder, className = '' }: { value: string | null; onSave: (v: string | null) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value ?? '')
  return (
    <input value={v} onChange={(e) => setV(e.target.value)} onFocus={() => setV(value ?? '')}
      onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
      placeholder={placeholder} className={`${inputCls} ${className}`} />
  )
}

export function EditDate({ value, onSave, bare }: { value: string | null; onSave: (v: string | null) => void; bare?: boolean }) {
  return <input type="date" value={value ?? ''} onChange={(e) => onSave(e.target.value || null)} className={bare ? bareCls : inputCls} />
}

export function EditSelect({ value, options, onSave, placeholder, allowCurrent, className = '', bare }: {
  value: string | null; options: string[]; onSave: (v: string | null) => void; placeholder?: string; allowCurrent?: boolean; className?: string; bare?: boolean
}) {
  const opts = allowCurrent && value && !options.includes(value) ? [value, ...options] : options
  return (
    <select value={value ?? ''} onChange={(e) => onSave(e.target.value || null)} className={`${bare ? bareCls : inputCls} ${className}`}>
      <option value="">{placeholder ?? '—'}</option>
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// Fixed compact height (keeps rows small); user can drag taller. Scrolls internally.
export function CappedTextarea({ value, onSave, rows = 2 }: { value: string; onSave: (v: string | null) => void; rows?: number }) {
  const [v, setV] = useState(value)
  useEffect(() => { setV(value) }, [value])
  return (
    <textarea value={v} rows={rows} onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
      className={`${inputCls} w-52 resize-y max-h-24 overflow-auto leading-snug align-top`} />
  )
}

// Auto-grows to fit its content (row height expands); width is user-resizable.
export function AutoTextarea({ value, onSave }: { value: string; onSave: (v: string | null) => void }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setV(value) }, [value])
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [v])
  return (
    <textarea ref={ref} value={v} rows={1}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if ((v.trim() || '') !== (value ?? '')) onSave(v.trim() || null) }}
      className={`${inputCls} resize-x w-48 min-w-[8rem] overflow-hidden leading-snug align-top`} />
  )
}
