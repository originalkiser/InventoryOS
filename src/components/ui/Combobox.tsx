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

  const selectedLabel = options.find((o) => o.value === value)?.label ?? value

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
        <label className="text-xs font-mono text-gray-400 uppercase tracking-wide">{label}</label>
      )}
      <div
        className={[
          'w-full bg-[#0f1117] border rounded px-3 py-2 text-sm font-mono text-white cursor-pointer flex items-center justify-between',
          error
            ? 'border-red-500'
            : 'border-[#2a2d3e] focus-within:border-[#00e5ff]',
        ].join(' ')}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={value ? 'text-white' : 'text-gray-600'}>
          {value ? selectedLabel : placeholder}
        </span>
        <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && (
        <div className="absolute top-full left-0 right-0 z-30 mt-1 bg-[#161820] border border-[#2a2d3e] rounded shadow-xl max-h-60 overflow-auto">
          <div className="px-3 py-2 border-b border-[#2a2d3e]">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type to search..."
              className="w-full bg-transparent text-sm font-mono text-white placeholder-gray-600 focus:outline-none"
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
                'px-3 py-2 text-sm font-mono cursor-pointer hover:bg-[#00e5ff]/10 hover:text-[#00e5ff]',
                opt.value === value ? 'text-[#00e5ff] bg-[#00e5ff]/5' : 'text-gray-300',
              ].join(' ')}
            >
              {opt.label}
            </div>
          ))}
          {showCreate && (
            <div
              onClick={handleCreate}
              className="px-3 py-2 text-sm font-mono cursor-pointer text-[#39ff14] hover:bg-[#39ff14]/10 flex items-center gap-2"
            >
              {creating ? (
                <span className="text-gray-400">Creating...</span>
              ) : (
                <>
                  <span className="text-[#39ff14]">+</span> Create "{query}"
                </>
              )}
            </div>
          )}
          {filtered.length === 0 && !showCreate && (
            <div className="px-3 py-2 text-xs text-gray-500 font-mono">No results</div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
    </div>
  )
}
