import { useEffect, useMemo, useRef, useState } from 'react'
import type { Column } from '@tanstack/react-table'
import { filterActiveCount, normalizeFilter, packFilter, type NumOp } from '@/lib/columnFilterValue'

// Excel-style column filter: a searchable checkbox list of the column's distinct
// values. Checkboxes add/remove (multi-select); "Only" replaces the filter with a
// single value; search supports bulk "Add shown" / "Only shown".
//
// A column can opt into more through its `meta` (see lib/columnFilterValue.ts):
//   numeric: true        -> a "less than / greater than / between" number filter
//   colorOf(row)         -> filter by the conditional-formatting color of the cell (with colorLabels / colorSwatch)
//   multiValue(row)      -> the row has several values (e.g. a set of flags); the list is of those values
export interface ColFilterMeta {
  numeric?: boolean
  multiValue?: (row: any) => string[]
  colorOf?: (row: any) => string | null
  colorLabels?: Record<string, string>
  colorSwatch?: Record<string, string>
}

const NUM_OPS: { value: NumOp; label: string }[] = [
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'between', label: 'Between' },
]

export function ColumnFilter<T>({ column }: { column: Column<T, unknown> }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const meta = (column.columnDef.meta ?? {}) as ColFilterMeta

  function openMenu(e: React.MouseEvent) {
    e.stopPropagation()
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setCoords({ top: r.bottom + 4, left: Math.max(8, Math.min(r.left - 180, window.innerWidth - 240)) })
    setOpen((v) => !v)
  }

  const filterValue = column.getFilterValue()
  const norm = normalizeFilter(filterValue)
  const selected = norm.list
  const activeCount = filterActiveCount(filterValue)
  const active = activeCount > 0
  const setParts = (next: Partial<typeof norm>) => column.setFilterValue(packFilter({ ...norm, ...next }))

  // Number filter inputs (local until Apply).
  const [numOp, setNumOp] = useState<NumOp>(norm.num?.op ?? 'gt')
  const [numA, setNumA] = useState(norm.num ? String(norm.num.a) : '')
  const [numB, setNumB] = useState(norm.num?.b != null ? String(norm.num.b) : '')
  useEffect(() => {
    if (!open) return
    setNumOp(norm.num?.op ?? 'gt'); setNumA(norm.num ? String(norm.num.a) : ''); setNumB(norm.num?.b != null ? String(norm.num.b) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  function applyNum() {
    const a = Number(numA)
    if (numA.trim() === '' || !Number.isFinite(a)) return
    const b = Number(numB)
    if (numOp === 'between') {
      if (numB.trim() === '' || !Number.isFinite(b)) return
      setParts({ num: { op: 'between', a, b } })
    } else setParts({ num: { op: numOp, a } })
  }

  // Distinct values (and, for color filters, the colors present) from the faceted — other-filters-applied — rows.
  const uniqueValues = useMemo(() => {
    const entries: { value: string; count: number }[] = []
    if (meta.multiValue) {
      const counts = new Map<string, number>()
      for (const r of column.getFacetedRowModel().rows) for (const v of meta.multiValue(r.original)) counts.set(v, (counts.get(v) ?? 0) + 1)
      counts.forEach((count, value) => entries.push({ value, count }))
    } else {
      column.getFacetedUniqueValues().forEach((count, raw) => {
        const value = raw === null || raw === undefined || raw === '' ? '(blank)' : String(raw)
        entries.push({ value, count })
      })
    }
    return entries.sort((a, b) => a.value.localeCompare(b.value, undefined, { numeric: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column, open])

  const colorEntries = useMemo(() => {
    if (!meta.colorOf) return []
    const counts = new Map<string, number>()
    for (const r of column.getFacetedRowModel().rows) {
      const c = meta.colorOf(r.original)
      if (c) counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    return [...counts.entries()].map(([key, count]) => ({ key, count }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setParts({ list: Array.from(set) })
  }
  const setOnly = (value: string) => setParts({ list: [value] })
  const clear = () => column.setFilterValue(undefined)
  const addShown = () => setParts({ list: Array.from(new Set([...selected, ...shown.map((v) => v.value)])) })
  const onlyShown = () => setParts({ list: shown.map((v) => v.value) })
  const toggleColor = (key: string) => {
    const set = new Set(norm.colors)
    if (set.has(key)) set.delete(key); else set.add(key)
    setParts({ colors: Array.from(set) })
  }

  return (
    <div ref={ref} className="relative inline-flex items-center">
      <button
        ref={btnRef}
        onClick={openMenu}
        title={active ? `Filtered — ${activeCount} active` : 'Filter column'}
        // Found live 2026-09-25: the plain filter glyph alone was too small
        // and too subtle a cue that a column was actively filtered — bumped
        // the icon size up, tightened the margin so it sits right under the
        // header label instead of floating in extra blue space, and added a
        // "(N)" count next to it whenever a filter is actually applied.
        className={['ml-0.5 inline-flex items-center gap-0.5 align-middle rounded px-0.5', active ? 'text-[#00e5ff]' : 'text-[#F2F1E6]/60 hover:text-[#F2F1E6]'].join(' ')}
      >
        <svg className="w-4 h-4" fill={active ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18l-7 8v6l-4 2v-8L3 4z" />
        </svg>
        {active && <span className="text-[10px] font-mono normal-case tracking-normal">({activeCount})</span>}
      </button>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: coords.top, left: coords.left }}
          className="z-50 w-60 bg-pop border border-navy/25 rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.28)] flex flex-col normal-case tracking-normal font-normal"
        >
          {meta.numeric && (
            <div className="p-2 border-b border-navy/30 flex flex-col gap-1.5">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Number filter</span>
              <div className="flex items-center gap-1.5">
                <select value={numOp} onChange={(e) => setNumOp(e.target.value as NumOp)}
                  className="bg-cream border border-navy/30 rounded px-1 py-1 text-xs font-mono text-navy">
                  {NUM_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input value={numA} onChange={(e) => setNumA(e.target.value)} inputMode="decimal" placeholder={numOp === 'between' ? 'from' : 'value'}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyNum() }}
                  className="w-14 bg-cream border border-navy/30 rounded px-1.5 py-1 text-xs font-mono text-navy" />
                {numOp === 'between' && (
                  <input value={numB} onChange={(e) => setNumB(e.target.value)} inputMode="decimal" placeholder="to"
                    onKeyDown={(e) => { if (e.key === 'Enter') applyNum() }}
                    className="w-14 bg-cream border border-navy/30 rounded px-1.5 py-1 text-xs font-mono text-navy" />
                )}
              </div>
              <div className="flex items-center gap-2 text-[10px] font-mono">
                <button onClick={applyNum} className="rounded border border-navy/40 px-2 py-0.5 text-navy hover:bg-navy/5">Apply</button>
                {norm.num && <button onClick={() => setParts({ num: null })} className="text-red-400 hover:underline">Clear number filter</button>}
              </div>
            </div>
          )}

          {colorEntries.length > 0 && (
            <div className="p-2 border-b border-navy/30 flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Conditional formatting</span>
              {colorEntries.map((c) => (
                <label key={c.key} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={norm.colors.includes(c.key)} onChange={() => toggleColor(c.key)} className="accent-inky" />
                  <span className="inline-block w-3 h-3 rounded-sm border border-navy/30" style={{ background: meta.colorSwatch?.[c.key] ?? c.key }} />
                  <span className="text-xs font-mono text-navy truncate">{meta.colorLabels?.[c.key] ?? c.key}</span>
                  <span className="text-[10px] font-mono text-inky/70">{c.count}</span>
                </label>
              ))}
            </div>
          )}

          <div className="p-2 border-b border-navy/30">
            <input
              autoFocus={!meta.numeric}
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
                <button onClick={() => setParts({ list: uniqueValues.map((v) => v.value) })} className="text-inky hover:text-navy">Select all</button>
              )}
              {active && <button onClick={clear} className="text-red-400 hover:underline ml-auto">Clear all</button>}
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
