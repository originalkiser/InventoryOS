import { useEffect, useMemo, useRef, useState } from 'react'
import type { Column } from '@tanstack/react-table'

// Excel-style column filter: a searchable checkbox list of the column's distinct
// values. Checkboxes add/remove (multi-select); "Only" replaces the filter with a
// single value; search supports bulk "Add shown" / "Only shown".
export function ColumnFilter<T>({ column }: { column: Column<T, unknown> }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  function openMenu(e: React.MouseEvent) {
    e.stopPropagation()
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setCoords({ top: r.bottom + 4, left: Math.max(8, r.left - 180) })
    setOpen((v) => !v)
  }

  const selected = (column.getFilterValue() as string[] | undefined) ?? []
  const active = selected.length > 0

  // Distinct values from the faceted (other-filters-applied) rows.
  const uniqueValues = useMemo(() => {
    const map = column.getFacetedUniqueValues()
    const entries: { value: string; count: number }[] = []
    map.forEach((count, raw) => {
      const value = raw === null || raw === undefined || raw === '' ? '(blank)' : String(raw)
      entries.push({ value, count })
    })
    return entries.sort((a, b) => a.value.localeCompare(b.value))
  }, [column, open])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const shown = query
    ? uniqueValues.filter((v) => v.value.toLowerCase().includes(query.toLowerCase()))
    : uniqueValues

  function toggle(value: string) {
    const set = new Set(selected)
    if (set.has(value)) set.delete(value)
    else set.add(value)
    column.setFilterValue(set.size ? Array.from(set) : undefined)
  }
  const setOnly = (value: string) => column.setFilterValue([value])
  const clear = () => column.setFilterValue(undefined)
  const addShown = () => column.setFilterValue(Array.from(new Set([...selected, ...shown.map((v) => v.value)])))
  const onlyShown = () => column.setFilterValue(shown.length ? shown.map((v) => v.value) : undefined)

  return (
    <div ref={ref} className="relative inline-block">
      <button
        ref={btnRef}
        onClick={openMenu}
        title="Filter column"
        className={['ml-1 align-middle', active ? 'text-inky' : 'text-inky/70 hover:text-navy'].join(' ')}
      >
        <svg className="w-3 h-3 inline" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
        </svg>
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: coords.top, left: coords.left }}
          className="z-50 w-56 bg-cream border border-navy/30 rounded shadow-xl flex flex-col"
        >
          <div className="p-2 border-b border-navy/30">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search values…"
              className="w-full bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy placeholder-inky/50 focus:outline-none focus:border-[#00e5ff]"
            />
            <div className="flex gap-2 mt-1.5 text-[10px] font-mono">
              {query ? (
                <>
                  <button onClick={addShown} className="text-green-700 hover:underline">Add shown</button>
                  <button onClick={onlyShown} className="text-inky hover:underline">Only shown</button>
                </>
              ) : (
                <button onClick={() => column.setFilterValue(uniqueValues.map((v) => v.value))} className="text-inky hover:text-navy">Select all</button>
              )}
              {active && <button onClick={clear} className="text-red-400 hover:underline ml-auto">Clear</button>}
            </div>
          </div>
          <div className="max-h-56 overflow-auto py-1">
            {shown.length === 0 ? (
              <div className="px-3 py-2 text-xs text-inky/70 font-mono">No values</div>
            ) : shown.map((v) => (
              <div key={v.value} className="group flex items-center gap-2 px-2 py-1 hover:bg-navy/5">
                <label className="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
                  <input type="checkbox" checked={selected.includes(v.value)} onChange={() => toggle(v.value)} className="accent-inky" />
                  <span className="text-xs font-mono text-navy truncate">{v.value}</span>
                  <span className="text-[10px] font-mono text-inky/70">{v.count}</span>
                </label>
                <button onClick={() => setOnly(v.value)} className="text-[10px] font-mono text-inky/70 hover:text-inky opacity-0 group-hover:opacity-100">only</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
