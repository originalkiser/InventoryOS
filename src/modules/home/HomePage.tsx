// Home — the landing page: a bento grid of cards (stats, exceptions, orders, late POs, data health, quick links...). "Customize" turns on drag and
// resize for every card and an "Add card" menu for the hidden ones; the layout is saved to the user's profile and follows them across devices.
import { useMemo, useState } from 'react'
import * as RGL from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { Plus, RotateCcw, SlidersHorizontal, Check } from 'lucide-react'
import { usePersistedJson } from '@/hooks/useColumnPrefs'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { HOME_CARDS } from './homeCards'

// `import * as RGL` does not hand back the real GridLayout class under Vite's CJS interop — the class lives at RGL.default (same note as the
// Location Lookup page, which hit this as a blank page after tsc and the build both passed).
const RGLGridLayout = (RGL as unknown as { default: typeof RGL }).default
const ReactGridLayout = RGL.WidthProvider(RGLGridLayout)
const COLS = 12
const ROW_H = 56
const MARGIN: [number, number] = [14, 14]

type Box = { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }

/** The out-of-the-box arrangement: left to right, top to bottom, wrapping at 12 columns. */
function defaultLayout(): Box[] {
  const placed: Box[] = []
  let x = 0, y = 0, rowH = 0
  const order = ['welcome', 'pulse', 'attention', 'exceptions', 'orders', 'latepo', 'links', 'health', 'recent']
  for (const id of order) {
    const c = HOME_CARDS.find((d) => d.id === id)
    if (!c) continue
    if (x + c.w > COLS) { x = 0; y += rowH; rowH = 0 }
    placed.push({ i: c.id, x, y, w: c.w, h: c.h, minW: c.minW, minH: c.minH })
    x += c.w; rowH = Math.max(rowH, c.h)
  }
  // 'attention' and 'exceptions' are tall, so 'orders' / 'latepo' tuck beside them: stack those two in the third column.
  const set = (id: string, patch: Partial<Box>) => { const b = placed.find((p) => p.i === id); if (b) Object.assign(b, patch) }
  set('welcome', { x: 0, y: 0 }); set('pulse', { x: 6, y: 0 })
  set('attention', { x: 0, y: 3 }); set('exceptions', { x: 4, y: 3 }); set('orders', { x: 8, y: 3 }); set('latepo', { x: 8, y: 6 })
  set('links', { x: 0, y: 9 }); set('health', { x: 6, y: 9 }); set('recent', { x: 9, y: 9 })
  return placed
}

export default function HomePage() {
  const mobile = useMediaQuery('(max-width: 720px)')
  const [layout, setLayout] = usePersistedJson<Box[]>('home.layout', defaultLayout())
  const [hidden, setHidden] = usePersistedJson<string[]>('home.hidden', [])
  const [edit, setEdit] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const visible = useMemo(() => HOME_CARDS.filter((c) => !hidden.includes(c.id)), [hidden])
  // A card with no saved box yet (added later in a release, or just re-added) goes under everything else.
  const boxes = useMemo(() => {
    const have = new Map(layout.map((b) => [b.i, b]))
    const bottom = layout.reduce((m, b) => Math.max(m, b.y + b.h), 0)
    let extra = 0
    return visible.map((c) => {
      const b = have.get(c.id)
      if (b) return { ...b, minW: c.minW, minH: c.minH }
      const box: Box = { i: c.id, x: 0, y: bottom + extra, w: c.w, h: c.h, minW: c.minW, minH: c.minH }
      extra += c.h
      return box
    })
  }, [visible, layout])

  const remove = (id: string) => setHidden([...hidden, id])
  const add = (id: string) => { setHidden(hidden.filter((h) => h !== id)); setLayout(layout.filter((b) => b.i !== id)); setMenuOpen(false) }
  const reset = () => { setLayout(defaultLayout()); setHidden([]) }
  const hiddenCards = HOME_CARDS.filter((c) => hidden.includes(c.id))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-heading font-bold uppercase tracking-[0.06em] text-navy">Home</h1>
        <div className="flex-1" />
        {edit && (
          <>
            <div className="relative">
              <button type="button" onClick={() => setMenuOpen((o) => !o)} disabled={hiddenCards.length === 0}
                className="inline-flex items-center gap-1.5 rounded-full border border-navy px-3.5 py-1.5 text-xs font-heading font-semibold uppercase tracking-[0.09em] text-navy hover:bg-navy/10 disabled:opacity-40">
                <Plus className="w-3.5 h-3.5" /> Add card{hiddenCards.length ? ` (${hiddenCards.length})` : ''}
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-navy/20 bg-pop p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.28)]">
                  {hiddenCards.map((c) => (
                    <button key={c.id} type="button" onClick={() => add(c.id)} className="flex w-full flex-col rounded-lg px-3 py-2 text-left hover:bg-soft">
                      <span className="text-[13px] font-heading font-semibold uppercase tracking-wide text-navy">{c.title}</span>
                      <span className="text-[11px] font-body text-inky">{c.blurb}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" onClick={reset} className="inline-flex items-center gap-1.5 rounded-full border border-navy/40 px-3.5 py-1.5 text-xs font-heading font-semibold uppercase tracking-[0.09em] text-navy hover:bg-navy/10">
              <RotateCcw className="w-3.5 h-3.5" /> Reset
            </button>
          </>
        )}
        <button type="button" onClick={() => { setEdit((e) => !e); setMenuOpen(false) }}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-heading font-semibold uppercase tracking-[0.09em] ${edit ? 'border-sb-navy bg-sb-navy text-sb-cream' : 'border-navy text-navy hover:bg-navy/10'}`}>
          {edit ? <><Check className="w-3.5 h-3.5" /> Done</> : <><SlidersHorizontal className="w-3.5 h-3.5" /> Customize</>}
        </button>
      </div>
      {edit && <p className="-mt-2 text-[11px] font-body text-inky">Drag a card by its handle, resize it from its bottom-right corner, or remove it with the X. Changes save as you go.</p>}

      {mobile ? (
        // Phones: one column, in the order the cards sit on the desktop grid.
        <div className="flex flex-col gap-3.5">
          {[...boxes].sort((a, b) => a.y - b.y || a.x - b.x).map((b) => {
            const c = visible.find((v) => v.id === b.i)!
            return <div key={b.i} style={{ minHeight: Math.max(150, b.h * 52) }}><c.Component edit={false} onRemove={() => remove(b.i)} /></div>
          })}
        </div>
      ) : (
        <ReactGridLayout
          className="layout"
          layout={boxes}
          cols={COLS}
          rowHeight={ROW_H}
          margin={MARGIN}
          isDraggable={edit}
          isResizable={edit}
          draggableHandle=".home-drag"
          compactType="vertical"
          onLayoutChange={(l) => { if (edit) setLayout(l.map((b) => ({ i: b.i, x: b.x, y: b.y, w: b.w, h: b.h }))) }}
        >
          {visible.map((c) => (
            <div key={c.id}><c.Component edit={edit} onRemove={() => remove(c.id)} /></div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  )
}
