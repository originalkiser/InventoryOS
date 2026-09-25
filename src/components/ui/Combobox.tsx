import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'

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
  // Added 2026-09-25 for Exception Reporting's Area Manager cell — a
  // smaller, denser trigger/panel matching this app's other inline table
  // dropdowns (EditSelect's own text-xs), so more of a long name is
  // readable in a narrow column instead of this component's normal
  // text-sm form-field sizing. Purely visual — every existing caller
  // (form fields elsewhere in the app) is unaffected by omitting it.
  compact?: boolean
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
  compact = false,
}: ComboboxProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  // Keyboard-arrow highlight, independent of `value` — lets Up/Down walk the
  // (possibly search-filtered) option list and Enter commit whichever one is
  // highlighted, without requiring a mouse click. -1 = nothing highlighted.
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Found live 2026-09-20 (Package Mapping's price-column cell, the first
  // real use of this component inside a scrollable table body): the
  // dropdown panel used to be a plain `absolute` child positioned via
  // `top-full`/`min-w-full`, which any ancestor with `overflow: auto/
  // hidden/scroll` (DataTable's own scrolling wrapper, in particular)
  // clips the instant it extends past that ancestor's visible bounds —
  // z-index cannot fix this, overflow clipping happens regardless of
  // stacking order. Portaling the open panel to `document.body` and
  // positioning it with `fixed` + the trigger's own `getBoundingClientRect()`
  // escapes every such ancestor entirely; `menuRect` is recomputed on open
  // and kept in sync with `scroll`/`resize` while open (capture-phase scroll
  // listener, since scroll events don't bubble but DO fire in capture on
  // any ancestor, including whichever scrollable container the trigger
  // happens to sit inside).
  const [menuRect, setMenuRect] = useState<{ top: number; left: number; width: number } | null>(null)

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
      const target = e.target as Node
      // listRef's own panel is portaled to document.body now, so it's no
      // longer a DOM descendant of `ref` — without this second check, a
      // mousedown on an option would itself count as "outside" and close
      // the menu before the option's own click handler ever ran.
      if (ref.current?.contains(target)) return
      if (listRef.current?.contains(target)) return
      setOpen(false)
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

  const updateMenuRect = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    setMenuRect({ top: r.bottom + 4, left: r.left, width: r.width })
  }, [])

  // Position (and keep repositioned) the portaled panel while it's open —
  // computed fresh right before paint so it never flashes at a stale
  // position on open, and kept in sync on scroll (capture phase — scroll
  // events don't bubble, but DO fire in capture on every ancestor, so this
  // one listener covers the trigger scrolling inside ANY scrollable
  // container, not just the window) and on resize.
  useLayoutEffect(() => {
    if (!open) return
    updateMenuRect()
    window.addEventListener('scroll', updateMenuRect, true)
    window.addEventListener('resize', updateMenuRect)
    return () => {
      window.removeEventListener('scroll', updateMenuRect, true)
      window.removeEventListener('resize', updateMenuRect)
    }
  }, [open, updateMenuRect])

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
        ref={triggerRef}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        tabIndex={0}
        className={[
          'w-full bg-cream border rounded cursor-pointer flex items-center justify-between',
          compact ? 'px-1.5 py-1 text-xs font-mono' : 'px-3 py-2 text-sm font-mono',
          error
            ? 'border-red-500'
            : 'border-navy/30 focus-within:border-[#00e5ff]',
        ].join(' ')}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKeyDown}
      >
        <span className={`min-w-0 truncate ${value ? 'text-navy' : 'text-inky/70'}`}>
          {value ? selectedLabel : placeholder}
        </span>
        <svg className={`text-inky flex-shrink-0 ${compact ? 'w-3 h-3' : 'w-4 h-4'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {open && menuRect && createPortal(
        <div
          ref={listRef}
          role="listbox"
          style={{ position: 'fixed', top: menuRect.top, left: menuRect.left, minWidth: menuRect.width }}
          className="z-[100] w-max max-w-[min(88vw,640px)] bg-cream border border-navy/30 rounded shadow-xl max-h-60 overflow-auto"
        >
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
                compact ? 'px-2 py-1.5 text-xs font-mono cursor-pointer whitespace-nowrap' : 'px-3 py-2 text-sm font-mono cursor-pointer whitespace-nowrap',
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
        </div>,
        document.body,
      )}
      {error && <p className="text-xs text-red-400 font-mono">{error}</p>}
    </div>
  )
}
