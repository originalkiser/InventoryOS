import { useState, useRef, useEffect } from 'react'

interface Option {
  value: string
  count?: number
}

interface Props {
  options: Option[]
  selected: string[]
  onChange: (selected: string[]) => void
  placeholder?: string
  // Filter-style pickers use a top "All" checkbox where 0-selected == every
  // option. Pure multi-select pickers (e.g. "which products") don't have
  // that meaning for an empty selection, so they opt out.
  showAllOption?: boolean
  // Word used for the "N ___" summary label when 2+ are selected (e.g.
  // "products" instead of the default "selected").
  countNoun?: string
  // Adds a text filter above the checklist — for option lists too long to
  // scan (e.g. every product ID in the catalog).
  searchable?: boolean
  // 'right' anchors the open panel to the trigger's right edge instead of
  // its left — for a dropdown near the right side of a narrow container,
  // where left-anchoring pushes the panel (and the page) past the viewport
  // edge instead of opening back over the page.
  align?: 'left' | 'right'
}

export function MultiSelectDropdown({ options, selected, onChange, placeholder = 'All', showAllOption = true, countNoun = 'selected', searchable = false, align = 'left' }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const visibleOptions = searchable && query.trim()
    ? options.filter((o) => o.value.toLowerCase().includes(query.trim().toLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const label =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? selected[0]
        : `${selected.length} ${countNoun}`

  function toggle(value: string) {
    if (selected.includes(value)) onChange(selected.filter(v => v !== value))
    else onChange([...selected, value])
  }

  return (
    <div className="relative min-w-[120px] max-w-[180px]" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 w-full rounded border px-2 py-1 text-xs font-body text-navy dark:text-[#F2F1E6] bg-cream dark:bg-[#122b40] focus:outline-none transition-colors ${
          open || selected.length > 0 ? 'border-sky' : 'border-navy/30'
        }`}
      >
        <span className="flex-1 text-left truncate">{label}</span>
        <svg
          className={`w-3 h-3 shrink-0 text-inky/50 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className={`absolute top-full ${align === 'right' ? 'right-0' : 'left-0'} mt-1 z-40 bg-cream dark:bg-[#0e2638] border border-navy/30 rounded shadow-xl overflow-hidden min-w-[160px] max-w-[240px]`}>
          {searchable && (
            <div className="p-1 border-b border-navy/10">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search…"
                className="w-full rounded border border-navy/20 bg-cream dark:bg-[#0e2638] px-2 py-1 text-xs font-mono text-navy dark:text-[#F2F1E6] focus:outline-none focus:border-sky"
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto p-1 flex flex-col gap-px">
            {showAllOption && (
              <label className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-navy/5 select-none">
                <input
                  type="checkbox"
                  checked={selected.length === 0}
                  onChange={() => onChange([])}
                  className="accent-navy w-3.5 h-3.5 shrink-0"
                />
                <span className="text-xs font-mono text-inky/60">All</span>
              </label>
            )}
            {visibleOptions.length === 0 && (
              <span className="px-2 py-1 text-[11px] font-mono text-inky/40 italic">{options.length === 0 ? 'No options' : 'No matches'}</span>
            )}
            {visibleOptions.map(opt => (
              <label
                key={opt.value}
                className="flex items-center gap-2 px-2 py-1 rounded cursor-pointer hover:bg-navy/5 select-none"
              >
                <input
                  type="checkbox"
                  checked={selected.includes(opt.value)}
                  onChange={() => toggle(opt.value)}
                  className="accent-navy w-3.5 h-3.5 shrink-0"
                />
                <span className="text-xs font-mono text-navy dark:text-[#F2F1E6] flex-1 truncate">
                  {opt.value}
                </span>
                {opt.count != null && (
                  <span className="text-[10px] font-mono text-inky/40 shrink-0 ml-auto pl-2">
                    {opt.count}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
