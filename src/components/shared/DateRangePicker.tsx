// Date range picker — the "cream ticket" (option A) from the SB Date Range Picker design: navy ink on a cream card with a dashed tear-off
// divider in light mode, the same ticket in navy with cream ink in dark mode. Square navy end caps, a Sky Blue range band, a dashed stamp
// ring on today. Static sb-* tokens + `dark:` variants so it matches the design exactly instead of flipping with the dynamic navy/cream pair.
//
// Selection rules: the first click sets the start, the second sets the end (a single-day range is allowed - click the same day twice), a date
// before the start becomes the new start, and any click after a finished range starts over. Arrow keys move between days.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import iconNavy from '@/assets/SBOC-IconNavy.png'
import iconCream from '@/assets/SBOC-IconCream.png'

export interface RangePreset { key: string; label: string; range: () => { start: string; end: string } }

// ---------- date helpers (dates are 'YYYY-MM-DD' keys, so a string compare is a date compare) ----------
const mk = (y: number, m: number, d: number) => new Date(y, m, d, 12)
const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parse = (k: string) => { const [y, m, d] = k.split('-').map(Number); return mk(y, m - 1, d) }
const addDays = (d: Date, n: number) => mk(d.getFullYear(), d.getMonth(), d.getDate() + n)
const diffDays = (a: string, b: string) => Math.round((parse(b).getTime() - parse(a).getTime()) / 864e5)
const monthIndex = (y: number, m: number) => y * 12 + m
export const localTodayKey = () => key(new Date())
const fShort = (k: string) => parse(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
export const formatRangeEnd = (k: string) => parse(k).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const fLong = (k: string) => parse(k).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const PANEL_WIDTH = 384

interface RangeState { start: string | null; end: string | null }

function Panel({ initial, initialPreset, presets, maxDate, title, sub, onApply, onClose }: {
  initial: RangeState
  initialPreset: string | null
  presets?: RangePreset[]
  maxDate?: string
  title: string
  sub: string
  onApply: (start: string, end: string, preset: string | null) => void
  onClose: () => void
}) {
  const today = localTodayKey()
  const [st, setSt] = useState<RangeState>(initial)
  const [preset, setPreset] = useState<string | null>(initialPreset)
  const [hover, setHover] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const anchor = st.start ? parse(st.start) : new Date()
  const [view, setView] = useState({ y: anchor.getFullYear(), m: anchor.getMonth() })
  const [focusKey, setFocusKey] = useState(st.start ?? today)
  const rootRef = useRef<HTMLDivElement>(null)
  const pending = useRef(false)

  const previewEnd = st.start && !st.end && hover && hover > st.start ? hover : null
  const effEnd = st.end ?? previewEnd
  const viewMi = monthIndex(view.y, view.m)

  // Arrow keys move focus to a day that may live in another month — focus it once that month has rendered.
  useEffect(() => {
    if (!pending.current || !rootRef.current) return
    const el = rootRef.current.querySelector<HTMLElement>(`[data-k="${focusKey}"]`)
    if (el) { el.focus(); pending.current = false }
  })

  const shift = (n: number) => { const d = new Date(view.y, view.m + n, 1); setView({ y: d.getFullYear(), m: d.getMonth() }) }
  const showMonthOf = (k: string) => { const d = parse(k); setView({ y: d.getFullYear(), m: d.getMonth() }) }

  const pick = (k: string) => {
    if (maxDate && k > maxDate) return
    setFocusKey(k); setPreset(null)
    const { start, end } = st
    if (!start || end) { setSt({ start: k, end: null }); setNote('') }
    else if (k < start) { setSt({ start: k, end: null }); setNote('That date is earlier than your start, so it is now the start. Pick a new end date.') }
    else { setSt({ start, end: k }); setNote('') }
  }
  const onKey = (ev: ReactKeyboardEvent, k: string) => {
    if (ev.key === 'Escape') { ev.stopPropagation(); onClose(); return }
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[ev.key]
    if (!step) return
    ev.preventDefault()
    let nk = key(addDays(parse(k), step))
    if (maxDate && nk > maxDate) nk = maxDate
    pending.current = true; setFocusKey(nk); showMonthOf(nk)
  }
  const applyPreset = (p: RangePreset) => {
    const r = p.range()
    const end = maxDate && r.end > maxDate ? maxDate : r.end
    setSt({ start: r.start, end }); setPreset(p.key); setNote(''); setHover(null)
    showMonthOf(r.start); setFocusKey(r.start)
  }
  const clear = () => { setSt({ start: null, end: null }); setPreset(null); setNote(''); setHover(null) }

  const done = !!(st.start && st.end)
  let status: string
  if (note) status = note
  else if (!st.start) status = 'Pick a start date.'
  else if (!st.end) status = `Pick an end date on or after ${fShort(st.start)}.`
  else status = `${fShort(st.start)} to ${fShort(st.end)} · ${diffDays(st.start, st.end) + 1} day${diffDays(st.start, st.end) === 0 ? '' : 's'}`

  // Which day gets the tab stop: the focused one when it's on screen, else the first of the month.
  const fd = parse(focusKey)
  const tabKey = monthIndex(fd.getFullYear(), fd.getMonth()) === viewMi ? focusKey : key(new Date(view.y, view.m, 1))

  const lead = new Date(view.y, view.m, 1).getDay()
  const days = new Date(view.y, view.m + 1, 0).getDate()
  const title2 = new Date(view.y, view.m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
  const cells: ReactNode[] = []
  for (let i = 0; i < lead; i++) cells.push(<span key={`b${i}`} className="h-10" />)
  for (let d = 1; d <= days; d++) {
    const k = key(mk(view.y, view.m, d))
    const col = (lead + d - 1) % 7
    const isStart = k === st.start
    const isEnd = k === st.end
    const isPreviewEnd = !st.end && k === previewEnd
    const single = !!st.start && st.start === effEnd
    const inRange = !!(st.start && effEnd && k > st.start && k < effEnd)
    const capStart = isStart && !!effEnd && !single
    const capEnd = k === effEnd && !!st.start && !single
    const disabled = !!maxDate && k > maxDate
    const selected = isStart || isEnd
    const isToday = k === today
    const bandOn = inRange || capStart || capEnd
    const band = [
      'absolute top-[3px] bottom-[3px] bg-sb-sky dark:bg-sb-inky/60',
      capStart ? 'left-1/2 right-0' : capEnd ? 'left-0 right-1/2' : 'left-0 right-0',
      inRange && col === 0 ? 'rounded-l-[3px]' : '', inRange && col === 6 ? 'rounded-r-[3px]' : '',
    ].join(' ')
    const dayCls = [
      'relative z-10 w-9 h-9 grid place-items-center rounded font-mono text-sm tabular-nums p-0 border-0',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sb-inky dark:focus-visible:outline-sb-sky',
      disabled ? 'opacity-30 cursor-not-allowed' : 'cursor-pointer',
      selected ? 'bg-sb-navy text-sb-cream font-bold dark:bg-sb-cream dark:text-sb-navy'
        : isPreviewEnd ? 'bg-transparent ring-2 ring-inset ring-sb-navy dark:ring-sb-cream'
        : `bg-transparent ${disabled ? '' : 'hover:bg-sb-sky/55 dark:hover:bg-sb-inky/50'}`,
      isToday ? `font-bold after:content-[''] after:absolute after:pointer-events-none after:border-2 after:border-dashed ${selected ? 'after:inset-[3px] after:rounded-sm after:border-sb-cream dark:after:border-sb-navy' : 'after:inset-0 after:rounded-full after:border-sb-navy dark:after:border-sb-sky'}` : '',
    ].join(' ')
    const role = isStart ? ', start date' : isEnd ? ', end date' : inRange ? ', in range' : ''
    cells.push(
      <span key={k} className="relative h-10 grid place-items-center">
        {bandOn && <span aria-hidden className={band} />}
        <button type="button" className={dayCls} data-k={k} disabled={disabled} tabIndex={k === tabKey ? 0 : -1}
          aria-label={fLong(k) + role} aria-pressed={selected}
          onClick={() => pick(k)} onMouseEnter={() => setHover(k)} onFocus={() => setHover(k)} onKeyDown={(ev) => onKey(ev, k)}>{d}</button>
      </span>,
    )
  }

  const fieldBase = 'border-2 border-current rounded px-2.5 py-1.5 min-w-0'
  const fieldOn = 'ring-[3px] ring-sb-sky dark:ring-sb-sky/45'
  const fieldLabel = 'block font-mono text-[10px] uppercase tracking-[0.14em] opacity-80'
  const fieldValue = 'block font-heading font-semibold text-base leading-tight tracking-wide whitespace-nowrap overflow-hidden text-ellipsis'
  const navBtn = 'w-9 h-9 grid place-items-center rounded border-[1.5px] border-current bg-transparent cursor-pointer flex-none hover:bg-sb-sky/55 dark:hover:bg-sb-inky/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sb-inky dark:focus-visible:outline-sb-sky'
  const btnBase = 'font-heading font-semibold text-[13px] uppercase tracking-[0.09em] px-3.5 py-2 rounded border-[1.5px] border-current bg-transparent cursor-pointer hover:bg-sb-sky/55 dark:hover:bg-sb-inky/50 disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent'

  return (
    <div ref={rootRef} role="dialog" aria-label={title} className="w-full rounded-md border-2 border-sb-navy bg-sb-cream text-sb-navy dark:border-sb-cream dark:bg-sb-navy dark:text-sb-cream shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-3 mb-3 border-b-2 border-dashed border-current">
        <img src={iconNavy} alt="" className="h-9 w-auto flex-none dark:hidden" />
        <img src={iconCream} alt="" className="h-9 w-auto flex-none hidden dark:block" />
        <div>
          <div className="font-heading font-semibold text-[17px] leading-none tracking-[0.09em] uppercase">{title}</div>
          <div className="font-mono italic font-medium text-[11px] tracking-[0.08em] uppercase opacity-80 mt-1">{sub}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 px-4">
        <div className={`${fieldBase} ${!st.start ? fieldOn : ''}`}>
          <small className={fieldLabel}>Start</small>
          <b className={`${fieldValue} ${st.start ? '' : 'opacity-55 font-medium'}`}>{st.start ? formatRangeEnd(st.start) : 'Select date'}</b>
        </div>
        <div className={`${fieldBase} ${st.start && !st.end ? fieldOn : ''}`}>
          <small className={fieldLabel}>End</small>
          <b className={`${fieldValue} ${st.end ? '' : previewEnd ? 'opacity-70 italic' : 'opacity-55 font-medium'}`}>{st.end ? formatRangeEnd(st.end) : previewEnd ? formatRangeEnd(previewEnd) : 'Select date'}</b>
        </div>
      </div>

      {presets && presets.length > 0 && (
        <div role="group" aria-label="Quick ranges" className="flex flex-wrap gap-1.5 px-4 pt-3">
          {presets.map((p) => (
            <button key={p.key} type="button" onClick={() => applyPreset(p)}
              className={`font-mono text-xs tracking-wide px-2.5 py-1 rounded border-[1.5px] cursor-pointer ${preset === p.key
                ? 'bg-sb-navy text-sb-cream border-sb-navy dark:bg-sb-cream dark:text-sb-navy dark:border-sb-cream'
                : 'bg-transparent border-current hover:bg-sb-sky/55 dark:hover:bg-sb-inky/50'}`}>{p.label}</button>
          ))}
        </div>
      )}

      <div className="px-4 pt-2.5 pb-1" onMouseLeave={() => setHover(null)}>
        <div className="flex items-center justify-between gap-2 min-h-[38px]">
          <button type="button" className={navBtn} onClick={() => shift(-1)} aria-label="Previous month"><ChevronLeft className="w-[18px] h-[18px]" strokeWidth={2.4} /></button>
          <h3 className="flex-1 text-center font-heading font-semibold text-[15px] tracking-[0.1em] uppercase m-0" aria-live="polite">{title2}</h3>
          <button type="button" className={navBtn} onClick={() => shift(1)} aria-label="Next month"><ChevronRight className="w-[18px] h-[18px]" strokeWidth={2.4} /></button>
        </div>
        <div className="grid grid-cols-7" aria-hidden="true">
          {DOW.map((w) => <span key={w} className="font-mono text-[10px] uppercase tracking-[0.08em] text-center opacity-75 pt-1.5 pb-1">{w}</span>)}
        </div>
        <div className="grid grid-cols-7" role="group" aria-label={title2}>{cells}</div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2.5 px-4 pt-3 pb-4 mt-2 border-t-2 border-dashed border-current">
        <div role="status" aria-live="polite" className="flex-1 basis-[200px] min-h-[2.8em] flex items-center font-mono text-[12.5px] leading-snug">{status}</div>
        <div className="flex gap-2">
          <button type="button" className={btnBase} onClick={clear} disabled={!st.start}>Clear</button>
          <button type="button" disabled={!done}
            className={`${btnBase} bg-sb-navy text-sb-cream border-sb-navy hover:bg-sb-navy hover:brightness-110 dark:bg-sb-cream dark:text-sb-navy dark:border-sb-cream dark:hover:bg-sb-cream`}
            onClick={() => { if (st.start && st.end) onApply(st.start, st.end, preset) }}>Apply</button>
        </div>
      </div>
    </div>
  )
}

export function DateRangePicker({ label, triggerText, start, end, selectedPreset = null, presets, maxDate, title = 'Date range', sub = 'SB Net', onApply }: {
  /** Small caption above the trigger, like the other filter fields. */
  label?: string
  /** What the trigger button says (e.g. "Last Week (08/30-09/05/2026)"). */
  triggerText: ReactNode
  start: string | null
  end: string | null
  selectedPreset?: string | null
  presets?: RangePreset[]
  /** Days after this can't be picked (defaults to no limit). */
  maxDate?: string
  title?: string
  sub?: string
  onApply: (start: string, end: string, preset: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; maxH: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), top: r.bottom + 6, maxH: Math.max(280, window.innerHeight - r.bottom - 14) })
  }, [])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => {
      const t = e.target as Node
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', esc)
    window.addEventListener('resize', place)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', esc); window.removeEventListener('resize', place) }
  }, [open, place])

  const toggle = () => { if (!open) place(); setOpen((o) => !o) }
  const width = typeof window === 'undefined' ? PANEL_WIDTH : Math.min(PANEL_WIDTH, window.innerWidth - 16)

  return (
    <div className="flex flex-col gap-0.5">
      {label && <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">{label}</span>}
      <button ref={triggerRef} type="button" onClick={toggle} aria-haspopup="dialog" aria-expanded={open}
        className="inline-flex items-center gap-2 bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy hover:border-navy focus:outline-none focus:border-sky">
        <Calendar className="w-3.5 h-3.5 flex-none text-inky" />
        <span className="whitespace-nowrap">{triggerText}</span>
        <ChevronDown className={`w-3.5 h-3.5 flex-none text-inky transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && pos && createPortal(
        <div ref={panelRef} style={{ position: 'fixed', left: pos.left, top: pos.top, width, maxHeight: pos.maxH, zIndex: 9999 }} className="overflow-y-auto rounded-md">
          <Panel initial={{ start, end }} initialPreset={selectedPreset} presets={presets} maxDate={maxDate} title={title} sub={sub}
            onClose={() => { setOpen(false); triggerRef.current?.focus() }}
            onApply={(s, e, p) => { setOpen(false); onApply(s, e, p) }} />
        </div>,
        document.body,
      )}
    </div>
  )
}
