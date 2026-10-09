// The Location Lookup shop picker (from the SB Location Picker concept): a navy dropdown with a search box, three ways to order the list (store
// number, area manager, director — the latter two group the stores under the person's name), a filter chip per exception type, an exception
// icon row beside each store, and a cascading open. Always navy, whatever the app theme, like the sidebar.
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { TYPE_META, TYPE_ORDER, type ShopExceptionType } from '@/modules/exceptions/shopExceptions/shopExceptionTypes'

export interface PickerShop { id: string; num: string; name: string; am: string; director: string; types: ShopExceptionType[] }
type ListBy = 'num' | 'am' | 'director'
const LIST_BY: [ListBy, string][] = [['num', '#'], ['am', 'Area Manager'], ['director', 'Director']]
const SORT_KEY = 'sbnet-loc-sort'
const loadBy = (): ListBy => { try { const v = localStorage.getItem(SORT_KEY); return v === 'am' || v === 'director' ? v : 'num' } catch { return 'num' } }

// The type colors for a navy surface (the light variants from the exception icon set).
const TYPE_COLOR: Record<ShopExceptionType, string> = { po_late: '#74b9ff', zero_sales: '#ff8a5c', adj_positive: '#5fdca0', adj_negative: '#f06595', duplicate_case: '#9d7bff' }

function Badge({ type, size, colored, onSelected }: { type: ShopExceptionType; size: number; colored: boolean; onSelected?: boolean }) {
  const color = onSelected ? '#F2F1E6' : colored ? TYPE_COLOR[type] : '#B7E0DE'
  return (
    <span title={TYPE_META[type].label} className="inline-grid place-items-center flex-none rounded-full"
      style={{ width: size, height: size, color, background: `color-mix(in srgb, ${color} 16%, transparent)`, border: `1.5px solid color-mix(in srgb, ${color} 60%, transparent)` }}>
      <svg viewBox="0 0 24 24" width={Math.round(size * 0.62)} height={Math.round(size * 0.62)} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: TYPE_META[type].small }} />
    </span>
  )
}
const Icons = ({ types, size, colored, onSelected }: { types: ShopExceptionType[]; size: number; colored: boolean; onSelected?: boolean }) =>
  types.length ? <span className="inline-flex gap-1 flex-none">{TYPE_ORDER.filter((t) => types.includes(t)).map((t) => <Badge key={t} type={t} size={size} colored={colored} onSelected={onSelected} />)}</span> : null

const numCmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true })

export function LocationPicker({ shops, value, onChange, showIcons = true, showFilters = true, colored = true, className = '' }: {
  shops: PickerShop[]
  value: string
  onChange: (id: string) => void
  showIcons?: boolean
  showFilters?: boolean
  colored?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [casc, setCasc] = useState(false)
  const [q, setQ] = useState('')
  const [by, setBy] = useState<ListBy>(loadBy)
  const [types, setTypes] = useState<ShopExceptionType[]>([])
  const [act, setAct] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const trigRef = useRef<HTMLButtonElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const kbd = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const uid = useRef(`lp-${Math.random().toString(36).slice(2, 7)}`).current

  const cur = shops.find((s) => s.id === value)
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase()
    return shops.filter((x) =>
      (!s || x.num.toLowerCase().includes(s) || x.name.toLowerCase().includes(s) || x.am.toLowerCase().includes(s) || x.director.toLowerCase().includes(s))
      && (!types.length || x.types.some((t) => types.includes(t)))).sort((a, b) => numCmp(a.num, b.num))
  }, [shops, q, types])
  const groups = useMemo(() => {
    if (by === 'num') return [{ key: 'all', label: null as string | null, rows: visible }]
    const m = new Map<string, PickerShop[]>()
    for (const s of visible) { const k = (by === 'am' ? s.am : s.director) || (by === 'am' ? 'No area manager' : 'No director'); if (!m.has(k)) m.set(k, []); m.get(k)!.push(s) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([label, rows]) => ({ key: label, label, rows }))
  }, [visible, by])
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups])
  const typeCount = (t: ShopExceptionType) => shops.filter((s) => s.types.includes(t)).length

  useEffect(() => { setAct(0) }, [q, types, by])
  useEffect(() => {
    if (!open || !kbd.current) return
    const v = ordered[act]
    document.getElementById(`${uid}-${v?.id}`)?.scrollIntoView({ block: 'nearest' })
    kbd.current = false
  }, [act, open, ordered, uid])
  useEffect(() => {
    if (!open) return
    const f = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [open])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const openPanel = () => {
    setOpen(true); setQ(''); setCasc(true)
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setCasc(false), 1100)
    const i = ordered.findIndex((x) => x.id === value)
    setAct(i < 0 ? 0 : i)
    setTimeout(() => inputRef.current?.focus(), 0)
  }
  const choose = (id: string) => { onChange(id); setOpen(false); setQ(''); trigRef.current?.focus() }
  const onKey = (e: React.KeyboardEvent) => {
    const n = ordered.length
    if (e.key === 'ArrowDown') { e.preventDefault(); kbd.current = true; setAct(Math.min(act + 1, n - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); kbd.current = true; setAct(Math.max(act - 1, 0)) }
    else if (e.key === 'Home') { e.preventDefault(); kbd.current = true; setAct(0) }
    else if (e.key === 'End') { e.preventDefault(); kbd.current = true; setAct(Math.max(n - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (ordered[act]) choose(ordered[act].id) }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigRef.current?.focus() }
  }
  const pickBy = (v: ListBy) => { setBy(v); try { localStorage.setItem(SORT_KEY, v) } catch { /* ignore */ } }
  const toggleType = (t: ShopExceptionType) => setTypes(types.includes(t) ? types.filter((x) => x !== t) : [...types, t])

  const pill = 'rounded-full border-[1.5px] px-2.5 py-1 text-xs font-heading font-semibold uppercase tracking-[0.07em] transition-colors'
  let n = 0, ri = 0
  const body: React.ReactNode[] = []
  if (!ordered.length) body.push(<li key="empty" role="presentation" className="px-3.5 py-6 text-center text-[13px] opacity-80">No locations match. Clear the search or filters.</li>)
  groups.forEach((g) => {
    if (g.label) {
      const rv = g.rows.filter((x) => x.types.length).length
      body.push(
        <li key={`g${g.key}`} role="presentation" style={{ ['--i' as string]: Math.min(n, 14) }}
          className="sb-picker-row sticky top-0 z-[1] flex items-center justify-between gap-2 bg-sb-navy px-2.5 pt-2.5 pb-2 text-xs font-heading font-semibold uppercase tracking-[0.16em] text-sb-sky">
          <span className="flex min-w-0 items-baseline gap-2"><span className="truncate">{g.label}</span><small className="text-[10px] font-body tracking-[0.08em] opacity-75">{g.rows.length} {g.rows.length === 1 ? 'store' : 'stores'}</small></span>
          {rv > 0 && <span className="flex-none rounded-full bg-sb-sky px-2 py-0.5 text-[10px] font-body tracking-[0.08em] text-sb-navy">{rv} to review</span>}
        </li>,
      )
      n++
    }
    g.rows.forEach((s) => {
      const i = ri++
      const sel = s.id === value
      body.push(
        <li key={s.id} id={`${uid}-${s.id}`} role="option" aria-selected={sel} style={{ ['--i' as string]: Math.min(n, 14) }}
          onMouseEnter={() => setAct(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(s.id)}
          className={`sb-picker-row relative flex min-h-[46px] cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-[7px] ${sel ? 'bg-inky pl-[26px]' : i === act ? 'bg-inky/40' : ''}`}>
          {sel && <span aria-hidden className="absolute left-[9px] top-1/2 -mt-[5px] h-[9px] w-[9px] rotate-45 rounded-[0_50%_50%_50%] bg-sb-sky" />}
          <span className="w-[2.7em] flex-none text-xs tabular-nums opacity-85">{s.num}</span>
          <span className="min-w-0 flex-1 truncate font-heading text-sm font-semibold uppercase tracking-[0.04em]">{s.name}</span>
          {showIcons && <Icons types={s.types} size={24} colored={colored} onSelected={sel} />}
        </li>,
      )
      n++
    })
  })

  return (
    <div ref={boxRef} className={`relative w-[min(100%,380px)] font-body text-sb-cream ${className}`}>
      <button ref={trigRef} type="button" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${uid}-list`}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(e) => { if (e.key === 'ArrowDown' && !open) { e.preventDefault(); openPanel() } }}
        className="flex min-h-[46px] w-full items-center gap-2.5 rounded-[14px] border-2 border-sb-cream/40 bg-sb-navy px-3 py-2 text-left hover:border-sb-cream/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sb-sky">
        {cur ? (<><span className="flex-none text-xs opacity-80">{cur.num}</span><span className="min-w-0 flex-1 truncate font-heading text-[15px] font-semibold uppercase tracking-[0.05em]">{cur.name}</span>{showIcons && <Icons types={cur.types} size={22} colored={colored} />}</>)
          : <span className="flex-1 font-heading text-[15px] font-semibold uppercase tracking-[0.05em] opacity-70">Pick a shop</span>}
        <ChevronDown className={`h-[18px] w-[18px] flex-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`} strokeWidth={2.6} />
      </button>
      {open && (
        <div className={`absolute left-0 right-0 top-[calc(100%+6px)] z-50 flex max-h-[560px] flex-col overflow-hidden rounded-[14px] border-2 border-sb-cream/40 bg-sb-navy shadow-[0_18px_40px_rgba(0,0,0,0.3)] ${casc ? 'sb-picker-panel-in' : ''}`}>
          <input ref={inputRef} type="text" placeholder="Search store, director or manager" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
            role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-label="Search locations"
            className="mx-2.5 mb-2 mt-2.5 block w-[calc(100%-20px)] rounded-lg border-2 border-sb-cream/40 bg-transparent px-3 py-2 text-sm text-sb-cream placeholder:text-sb-cream/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sb-sky" />
          <div role="group" aria-label="List order" className="flex flex-wrap gap-1 px-2.5 pb-2">
            {LIST_BY.map(([v, label]) => (
              <button key={v} type="button" aria-pressed={by === v} onClick={() => pickBy(v)}
                className={`${pill} ${by === v ? 'border-sb-sky bg-sb-sky text-sb-navy' : 'border-sb-cream/40 hover:bg-inky/45'}`}>{label}</button>
            ))}
          </div>
          {showFilters && (
            <div role="group" aria-label="Filter by exception" className="flex flex-wrap gap-1.5 px-2.5 pb-2">
              {TYPE_ORDER.map((t) => {
                const on = types.includes(t)
                return (
                  <button key={t} type="button" aria-pressed={on} onClick={() => toggleType(t)} title={TYPE_META[t].label} aria-label={TYPE_META[t].label}
                    className={`inline-flex items-center gap-1.5 rounded-full border-[1.5px] py-1 pl-1.5 pr-2.5 text-xs transition-colors ${on ? 'border-sb-sky bg-sb-sky text-sb-navy' : 'border-sb-cream/40 hover:bg-inky/45'}`}>
                    <Badge type={t} size={20} colored={colored} onSelected={on} />
                    <span className="tabular-nums opacity-85">{typeCount(t)}</span>
                  </button>
                )
              })}
            </div>
          )}
          <ul id={`${uid}-list`} role="listbox" aria-label="Locations" className={`sb-picker-scroll min-h-0 flex-1 list-none overflow-auto py-0 pl-2 pr-1 pb-2 m-0 ${casc ? 'sb-picker-casc' : ''}`}>{body}</ul>
          <div className="flex justify-between gap-2 border-t-[1.5px] border-sb-cream/25 px-3.5 py-2 text-[11px] uppercase tracking-[0.08em] opacity-90">
            <span>{ordered.length} of {shops.length} locations</span>
          </div>
        </div>
      )}
    </div>
  )
}
