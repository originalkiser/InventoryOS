// Home — the landing page: a bento grid of cards (stats, exceptions, orders, late POs, data health, quick links...). "Customize" turns on drag and
// resize for every card and an "Add card" menu for the hidden ones; the layout is saved to the user's profile and follows them across devices.
import { useCallback, useMemo, useState } from 'react'
import * as RGL from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'
import { Plus, RotateCcw, SlidersHorizontal, Check } from 'lucide-react'
import { usePersistedJson } from '@/hooks/useColumnPrefs'
import { useMediaQuery } from '@/hooks/useMediaQuery'
import { HOME_CARDS } from './homeCards'
import { HomeCardCtx } from './HomeCard'

// `import * as RGL` does not hand back the real GridLayout class under Vite's CJS interop — the class lives at RGL.default (same note as the
// Location Lookup page, which hit this as a blank page after tsc and the build both passed).
const RGLGridLayout = (RGL as unknown as { default: typeof RGL }).default
const ReactGridLayout = RGL.WidthProvider(RGLGridLayout)
const COLS = 12
// A fine row pitch (4px, no vertical margin; each card sits in a wrapper with 14px of bottom padding) so a card's row span can follow its content
// height closely instead of snapping to 70px steps.
const ROW_H = 4
const MARGIN: [number, number] = [14, 0]
const GAP = 14

type Box = { i: string; x: number; y: number; w: number }

/** Where each card starts (left to right, top to bottom). `y` only orders things — the grid compacts upward. */
const DEFAULT_BOXES: Box[] = [
  { i: 'welcome', x: 0, y: 0, w: 6 }, { i: 'pulse', x: 6, y: 0, w: 6 },
  { i: 'attention', x: 0, y: 10, w: 4 }, { i: 'exceptions', x: 4, y: 10, w: 4 }, { i: 'orders', x: 8, y: 10, w: 4 }, { i: 'latepo', x: 8, y: 11, w: 4 },
  { i: 'links', x: 0, y: 20, w: 6 }, { i: 'health', x: 6, y: 20, w: 3 }, { i: 'recent', x: 9, y: 20, w: 3 },
  { i: 'zeroonhand', x: 0, y: 30, w: 4 }, { i: 'soldordered', x: 4, y: 30, w: 8 }, { i: 'gallons', x: 0, y: 40, w: 6 },
]
const defaultLayout = (): Box[] => DEFAULT_BOXES.map((b) => ({ ...b }))

export default function HomePage() {
  const mobile = useMediaQuery('(max-width: 720px)')
  const [layout, setLayout] = usePersistedJson<Box[]>('home.layout2', defaultLayout())
  const [hidden, setHidden] = usePersistedJson<string[]>('home.hidden', [])
  const [edit, setEdit] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // Each card reports its natural content height; the grid row span follows it.
  const [natural, setNatural] = useState<Record<string, number>>({})
  const report = useCallback((id: string, px: number) => setNatural((n) => (Math.abs((n[id] ?? 0) - px) > 1 ? { ...n, [id]: px } : n)), [])
  const hOf = (id: string, fallbackRows: number) => (natural[id] ? Math.ceil((natural[id] + GAP) / ROW_H) : fallbackRows)

  const visible = useMemo(() => HOME_CARDS.filter((c) => !hidden.includes(c.id)), [hidden])
  // A card with no saved box yet (added later in a release, or just re-added) goes under everything else.
  const boxes = useMemo(() => {
    const have = new Map(layout.map((b) => [b.i, b]))
    const defaults = new Map(DEFAULT_BOXES.map((b) => [b.i, b]))
    const bottom = visible.reduce((m, c) => { const b = have.get(c.id); return b ? Math.max(m, b.y + hOf(c.id, c.h * 17)) : m }, 0)
    let extra = 0
    return visible.map((c) => {
      const b = have.get(c.id) ?? defaults.get(c.id)
      if (b && have.has(c.id)) return { i: c.id, x: b.x, y: b.y, w: Math.max(c.minW, b.w), h: hOf(c.id, c.h * 17), minW: c.minW, isResizable: true }
      const box = { i: c.id, x: b?.x ?? 0, y: bottom + 1000 + extra, w: b?.w ?? c.w, h: hOf(c.id, c.h * 17), minW: c.minW, isResizable: true }
      extra += 1
      return box
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, layout, natural])

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
      {edit && <p className="-mt-2 text-[11px] font-body text-inky">Drag a card by its handle, widen or narrow it from its right edge (cards size to their content in height), or remove it with the X. Changes save as you go.</p>}

      {mobile ? (
        // Phones: one column, in the order the cards sit on the desktop grid.
        <div className="flex flex-col gap-3.5">
          {[...boxes].sort((a, b) => a.y - b.y || a.x - b.x).map((b) => {
            const c = visible.find((v) => v.id === b.i)!
            return <div key={b.i}><c.Component edit={false} onRemove={() => remove(b.i)} /></div>
          })}
        </div>
      ) : (
        <ReactGridLayout
          className="layout"
          layout={boxes}
          cols={COLS}
          rowHeight={ROW_H}
          margin={MARGIN}
          resizeHandles={['e']}
          isDraggable={edit}
          isResizable={edit}
          draggableHandle=".home-drag"
          compactType="vertical"
          onLayoutChange={(l) => { if (edit) setLayout(l.map((b) => ({ i: b.i, x: b.x, y: b.y, w: b.w }))) }}
        >
          {visible.map((c) => (
            <div key={c.id}>
              <HomeCardCtx.Provider value={{ id: c.id, report }}>
                <div className="h-full" style={{ paddingBottom: GAP }}><c.Component edit={edit} onRemove={() => remove(c.id)} /></div>
              </HomeCardCtx.Provider>
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  )
}
