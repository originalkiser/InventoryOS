// Nav search: find a page or a function (open a panel, switch the theme) and jump to it. One hook + list shared by the sidebar's search box, the
// Ctrl+K palette and the floating dock, so they all rank and behave the same.
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { CornerDownLeft, Search, X } from 'lucide-react'
import { useDarkMode } from '@/hooks/useDarkMode'
import { ICONS } from './navIcons'
import { NAV_ACTIONS, searchNav, useNavModel, type NavEntry } from './useNavModel'

export function useNavSearch(query: string, onDone?: () => void) {
  const { entries } = useNavModel()
  const navigate = useNavigate()
  const { toggle } = useDarkMode()
  const all = useMemo(() => [...entries, ...NAV_ACTIONS], [entries])
  const results = useMemo(() => searchNav(all, query), [all, query])
  const [hl, setHl] = useState(0)
  useEffect(() => { setHl(0) }, [query])

  const run = (e: NavEntry) => {
    if (e.to) navigate(e.to)
    else if (e.action === 'dark') toggle()
    else if (e.action) window.dispatchEvent(new CustomEvent('sb-quick-access', { detail: e.action }))
    onDone?.()
  }
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setHl((h) => Math.min(results.length - 1, h + 1)) }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); setHl((h) => Math.max(0, h - 1)) }
    else if (ev.key === 'Enter' && results[hl]) { ev.preventDefault(); run(results[hl]) }
    else if (ev.key === 'Escape') { ev.stopPropagation(); onDone?.() }
  }
  return { results, hl, setHl, run, onKeyDown }
}

/** The results, grouped under their section name. `tone` picks colors for a dark sidebar vs. a light popover. */
export function NavResultList({ results, hl, setHl, run, query, tone }: {
  results: NavEntry[]; hl: number; setHl: (i: number) => void; run: (e: NavEntry) => void; query: string; tone: 'chrome' | 'pop'
}) {
  if (!query.trim()) return null
  const chrome = tone === 'chrome'
  if (results.length === 0) {
    return <div className={`px-3 py-6 text-center text-xs font-body ${chrome ? 'text-chrome-fg/60' : 'text-inky'}`}>Nothing matches “{query}”</div>
  }
  let lastGroup = ''
  return (
    <ul role="listbox" className="flex flex-col gap-0.5 p-1.5">
      {results.map((e, i) => {
        const header = e.group !== lastGroup
        lastGroup = e.group
        const on = hl === i
        return (
          <Fragment key={e.id}>
            {header && <li className={`px-2.5 pt-2.5 pb-1 text-[10px] font-heading uppercase tracking-[0.18em] ${chrome ? 'text-sky' : 'text-inky'}`}>{e.group}</li>}
            <li>
              <button type="button" role="option" aria-selected={on} onMouseEnter={() => setHl(i)} onClick={() => run(e)}
                className={`w-full flex items-center gap-2.5 text-left rounded-[10px] px-2.5 py-2 transition-colors ${on
                  ? (chrome ? 'bg-chrome-fg/15 text-chrome-fg' : 'bg-navy text-cream')
                  : (chrome ? 'text-chrome-fg/85 hover:bg-chrome-fg/10' : 'text-navy hover:bg-soft')}`}>
                <span className="flex-shrink-0 opacity-90">{e.itemKey ? (ICONS[e.itemKey] ?? ICONS.dashboard) : <CornerDownLeft className="w-4 h-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-body truncate">{e.label}</span>
                  {e.desc && <span className={`block text-[11px] font-body truncate ${on ? (chrome ? 'text-sky' : 'text-sky') : (chrome ? 'text-chrome-fg/55' : 'text-inky')}`}>{e.desc}</span>}
                </span>
                {on && <CornerDownLeft className="w-3.5 h-3.5 flex-shrink-0 opacity-80" />}
              </button>
            </li>
          </Fragment>
        )
      })}
    </ul>
  )
}

/** The search field that sits at the top of the sidebar. */
export function NavSearchInput({ value, onChange, onKeyDown, inputRef, onClear }: {
  value: string; onChange: (v: string) => void; onKeyDown: (e: KeyboardEvent) => void; inputRef?: React.RefObject<HTMLInputElement>; onClear: () => void
}) {
  return (
    <label className="mx-2 mt-2 mb-1 flex items-center gap-2 rounded-full border border-chrome-fg/25 bg-chrome-fg/5 px-3 py-1.5 focus-within:border-sky focus-within:bg-chrome-fg/10 transition-colors">
      <Search className="w-3.5 h-3.5 flex-shrink-0 text-chrome-fg/60" />
      <input ref={inputRef} type="text" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
        placeholder="Search pages & actions" aria-label="Search pages and actions"
        className="w-full bg-transparent outline-none text-xs font-body text-chrome-fg placeholder:text-chrome-fg/45" />
      {value ? (
        <button type="button" onClick={onClear} aria-label="Clear search" className="text-chrome-fg/60 hover:text-chrome-fg"><X className="w-3.5 h-3.5" /></button>
      ) : (
        <kbd className="hidden sm:inline text-[9px] font-body text-chrome-fg/50 border border-chrome-fg/25 rounded px-1">Ctrl K</kbd>
      )}
    </label>
  )
}

/** Ctrl+K palette — available in every nav layout. */
export function NavPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const close = () => { setQ(''); onClose() }
  const { results, hl, setHl, run, onKeyDown } = useNavSearch(q, close)
  useEffect(() => { if (open) setTimeout(() => inputRef.current?.focus(), 0) }, [open])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[200] flex items-start justify-center bg-black/50 px-4 pt-[12vh] animate-[fadeIn_120ms_ease-out]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div role="dialog" aria-modal="true" aria-label="Search pages and actions" onKeyDown={onKeyDown}
        className="w-full max-w-lg rounded-2xl border border-navy/20 bg-pop text-navy shadow-[0_24px_60px_rgba(0,0,0,0.45)] overflow-hidden flex flex-col max-h-[70vh] animate-[panelIn_160ms_ease-out]">
        <div className="flex items-center gap-2.5 border-b border-navy/15 px-4 py-3">
          <Search className="w-4 h-4 text-inky" />
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a page, section or action" aria-label="Search pages and actions"
            className="flex-1 bg-transparent outline-none text-sm font-body text-navy placeholder:text-inky/70" />
          <kbd className="text-[10px] font-body text-inky border border-navy/25 rounded px-1.5">Esc</kbd>
        </div>
        <div className="overflow-y-auto">
          {q.trim() ? <NavResultList results={results} hl={hl} setHl={setHl} run={run} query={q} tone="pop" />
            : <div className="px-4 py-8 text-center text-xs font-body text-inky">Start typing to find a page, or something you can do from anywhere (open the Tasks panel, switch to dark mode…)</div>}
        </div>
        <div className="flex gap-4 border-t border-navy/15 px-4 py-2 text-[11px] font-body text-inky"><span>↑ ↓ to move</span><span>Enter to open</span><span>Esc to close</span></div>
      </div>
    </div>
  )
}
