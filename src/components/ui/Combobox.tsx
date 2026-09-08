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
  // Keyboard-arrow highlight, independent of `value` — lets Up/Down walk the
  // (possibly search-filtered) option list and Enter commit whichever one is
  // highlighted, without requiring a mouse click. -1 = nothing highlighted.
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

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

  // Highlightable rows = filtered options, plus the "Create ..." row (if
  // shown) as one extra trailing row at index filtered.length.
  const highlightCount = filtered.length + (showCreate ? 1 : 0)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Re-seed the highlight whenever the dropdown opens or the filtered list
  // changes underneath it (typing narrows/widens results) — land on the
  // current value if it's still in view, else the first row, so Up/Down
  // always starts somewhere sensible instead of requiring an extra press.
  useEffect(() => {
    if (!open) { setHighlightedIndex(-1); return }
    const matchedIdx = filtered.findIndex((o) => o.value === value)
    setHighlightedIndex(matchedIdx >= 0 ? matchedIdx : highlightCount > 0 ? 0 : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query])

  // Keep the highlighted row scrolled into view as it moves past the edge
  // of the dropdown's own scroll container.
  useEffect(() => {
    if (highlightedIndex < 0) return
    const el = listRef.current?.querySelector(`[data-combobox-index="${highlightedIndex}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlightedIndex])

  function selectOption(opt: ComboboxOption) {
    onChange(opt.value, opt.label)
    setQuery('')
    setOpen(false)
  }

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

  function handleTriggerKeyDown(e: React.KeyboardEvent) {
    // The closed trigger has no input inside it yet — Enter/Space/Down all
    // open it (standard combobox behavior) so it's reachable via Tab alone.
    if (open) return
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (highlightCount > 0) setHighlightedIndex((i) => Math.min(i + 1, highlightCount - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (highlightCount > 0) setHighlightedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex < 0) return
      if (highlightedIndex < filtered.length) selectOption(filtered[highlightedIndex])
      else if (showCreate) void handleCreate()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  }

  return (
    <div ref={ref} className="relative flex flex-col gap-1">
      {label && (
        <label className="text-xs font-mono text-inky uppercase tracking-wide">{label}</label>
      )}
      <div
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={0}
        className={[
          'w-full bg-cream border rounded px-3 py-2 text-sm font-mono text-navy cursor-pointer flex items-center justify-between',
          error
            ? 'border-red-500'
            : 'border-navy/30 focus-within:border-[#00e5ff]',
        ].join(' ')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={value ? 'text-navy' : 'text-inky/70'}>
          {value ? selectedLabel : placeholder}
        </span>
        <svg className="w-4 h-4 text-inky" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && (
        <div ref={listRef} role="listbox" className="absolute top-full left-0 right-0 z-30 mt-1 bg-cream border border-navy/30 rounded shadow-xl max-h-60 overflow-auto">
          <div className="px-3 py-2 border-b border-navy/30">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Type to search..."
              className="w-full bg-transparent text-sm font-mono text-navy placeholder-inky/50 focus:outline-none"
            />
          </div>
          {filtered.map((opt, idx) => (
            <div
              key={opt.value}
              data-combobox-index={idx}
              onClick={() => selectOption(opt)}
              onMouseEnter={() => setHighlightedIndex(idx)}
              className={[
                'px-3 py-2 text-sm font-mono cursor-pointer',
                idx === highlightedIndex
                  ? 'bg-[#00e5ff]/10 text-inky'
                  : opt.value === value
                    ? 'text-inky bg-[#00e5ff]/5'
                    : 'text-navy',
              ].join(' ')}
            >
              {opt.label}
            </div>
          ))}
          {showCreate && (
            <div
              data-combobox-index={filtered.length}
              onClick={handleCreate}
              onMouseEnter={() => setHighlightedIndex(filtered.length)}
              className={[
                'px-3 py-2 text-sm font-mono cursor-pointer text-green-700 flex items-center gap-2',
                filtered.length === highlightedIndex ? 'bg-[#39ff14]/10' : '',
              ].join(' ')}
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
