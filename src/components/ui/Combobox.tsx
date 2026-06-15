import React, { useState, useRef, useEffect } from 'react'

export interface ComboboxOption {
  value: string
  label: string
}

interface ComboboxProps {
  options: ComboboxOption[]
  value: string
  onChange: (value: string, label: string) => void
  placeholder?: string
  label?: string
  allowCreate?: boolean
  onCreateOption?: (label: string) => Promise<ComboboxOption> | ComboboxOption
  error?: string
}

export function Combobox({
  options,
  value,
  onChange,
  placeholder = 'Search or type...',
  label,
  allowCreate = false,
  onCreateOption,
  error,
}: ComboboxProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Only show a label when the value actually matches an option — otherwise the
  // field would falsely imply a selection (e.g. a stale/unlinked id).
  const matched = options.find((o) => o.value === value)
  const selectedLabel = matched?.label ?? ''

  const filtered = query
    ? options.filter((o) => String(o.label ?? '').toLowerCase().includes(query.toLowerCase()))
    : options

  const showCreate =
    allowCreate &&
    query.trim() &&
    !options.some((o) => String(o.label ?? '').toLowerCase() === query.toLowerCase())

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function handleCreate() {
    if (!onCreateOption || !query.trim()) return
    setCreating(true)
    try {
      const opt = await onCreateOption(query.trim())
      onChange(opt.value, opt.label)
      setQuery('')
      setOpen(false)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div ref={ref} className="relative flex flex-col gap-1">
      {label && (
        <label className="text-xs font-mono text-inky uppercase tracking-wide">{label}</label>
      )}
      <div
        className={[
          'w-full bg-cream border rounded px-3 py-2 text-sm font-mono text-navy cursor-pointer flex items-center justify-between',
          error
            ? 'border-red-500'
            : 'border-navy/30 focus-within:border-[#00e5ff]',
        ].join(' ')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value ? 'text-navy' : 'text-inky/70'}>
          {value ? selectedLabel : placeholder}
        </span>
        <svg className="w-4 h-4 text-inky" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 z-30 mt-1 bg-cream border border-navy/30 rounded shadow-xl max-h-60 overflow-auto">
          <div className="px-3 py-2 border-b border-navy/30">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search..."
              className="w-full bg-transparent text-sm font-mono text-navy placeholder-inky/50 focus:outline-none"
            />
          </div>
          {filtered.map((opt) => (
            <div
              key={opt.value}
              onClick={() => {
                onChange(opt.value, opt.label)
                setQuery('')
                setOpen(false)
              }}
              className={[
                'px-3 py-2 text-sm font-mono cursor-pointer hover:bg-[#00e5ff]/10 hover:text-inky',
                opt.value === value ? 'text-inky bg-[#00e5ff]/5' : 'text-navy',
              ].join(' ')}
            >
              {opt.label}
            </div>
          ))}
          {showCreate && (
            <div
              onClick={handleCreate}
              className="px-3 py-2 text-sm font-mono cursor-pointer text-green-700 hover:bg-[#39ff14]/10 flex items-center gap-2"
            >
              {creating ? (
                <span className="text-inky">Creating...</span>
              ) : (
                <>
                  <span className="text-green-700">+</span> Create "{query}"
                </>
              )}
            </div>
          )}
          {filtered.length === 0 && !showCreate && (
            <div className="px-3 py-2 text-xs text-inky font-mono">No results</div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
    </div>
  )
}
