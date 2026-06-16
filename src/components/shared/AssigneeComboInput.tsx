import { useEffect, useRef, useState } from 'react'
import type { Profile } from '@/types'

interface Props {
  label?: string
  value: string
  profiles: Profile[]
  onChange: (name: string) => void
  placeholder?: string
}

// Free-text input with org-user suggestions. Selecting a profile fills the
// name string; typing anything else is accepted as-is (for non-org people).
export function AssigneeComboInput({ label, value, profiles, onChange, placeholder = 'Unassigned' }: Props) {
  const [text, setText] = useState(value)
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => { setText(value) }, [value])

  const filtered = profiles.filter((p) =>
    text ? (p.full_name ?? p.email ?? '').toLowerCase().includes(text.toLowerCase()) : true
  ).slice(0, 8)

  function pick(p: Profile) {
    const name = p.full_name ?? p.email ?? ''
    setText(name)
    onChange(name)
    setOpen(false)
  }

  function handleBlur(e: React.FocusEvent) {
    if (containerRef.current?.contains(e.relatedTarget as Node)) return
    onChange(text)
    setOpen(false)
  }

  function clear() {
    setText('')
    onChange('')
    setOpen(false)
  }

  return (
    <div className="flex flex-col gap-1">
      {label && <label className="text-xs font-mono text-inky uppercase tracking-wide">{label}</label>}
      <div ref={containerRef} className="relative" onBlur={handleBlur}>
        <input
          value={text}
          placeholder={placeholder}
          onChange={(e) => { setText(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          className="w-full rounded border border-navy/30 bg-cream px-2 py-1.5 text-sm font-body text-navy placeholder-inky/40 focus:border-sky focus:ring-1 focus:ring-sky focus:outline-none"
        />
        {open && (
          <div className="absolute z-50 mt-0.5 w-full rounded border border-navy/30 bg-cream shadow-lg overflow-hidden max-h-44 overflow-y-auto">
            {filtered.map((p) => (
              <button
                key={p.id}
                tabIndex={0}
                onMouseDown={(e) => { e.preventDefault(); pick(p) }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-navy/5"
              >
                <span className="text-xs font-mono font-medium text-navy">{p.full_name ?? p.email}</span>
                {p.full_name && p.email && (
                  <span className="text-[10px] font-mono text-inky/40 truncate">{p.email}</span>
                )}
              </button>
            ))}
            {text.trim() && !profiles.find(p => (p.full_name ?? p.email ?? '').toLowerCase() === text.trim().toLowerCase()) && (
              <div className="px-3 py-1.5 text-[10px] font-mono text-inky/50 border-t border-navy/10">
                Press Tab or click away to use "{text.trim()}"
              </div>
            )}
            {text && (
              <button
                tabIndex={0}
                onMouseDown={(e) => { e.preventDefault(); clear() }}
                className="flex w-full items-center px-3 py-1.5 text-left text-[10px] font-mono text-inky/50 hover:bg-navy/5 border-t border-navy/10"
              >
                Clear assignee
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
