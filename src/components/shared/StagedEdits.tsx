// Staged edits: for tables where changes are made now and then (not Orders-style constant tweaking). Instead of saving each cell the moment it
// is edited, the table's inline cells (InlineCells.tsx) hand their change to the nearest <StagedEdits>; a bar above the table then shows
// "N unsaved changes" with Review, Discard and Save. Review lists every change (row, field, before -> after) so it can be checked, undone one at
// a time, saved or thrown away. Nothing is written until Save.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import toast from 'react-hot-toast'
import { Button, Modal } from '@/components/ui'

export interface StagedChange {
  /** Stable per cell: "<row id>|<field>". Staging the same cell again replaces its earlier change. */
  id: string
  rowLabel: string
  field: string
  /** The current (saved) value and the new one, as shown in the review. */
  before: string
  after: string
  /** The raw new value (what the cell shows while staged). */
  value: unknown
  /** Writes the change. Runs on Save; may be async and may throw / resolve false to report a failure. */
  apply: () => Promise<boolean | void> | boolean | void
}

interface StagedApi {
  get: (id: string) => StagedChange | undefined
  stage: (c: StagedChange) => void
  undo: (id: string) => void
}
const Ctx = createContext<StagedApi | null>(null)
/** The nearest staged-edits scope, or null when the table saves instantly. */
export const useStaged = () => useContext(Ctx)

type ReviewMode = 'review' | 'discard' | null

export function StagedEdits({ children, noun = 'change' }: { children: ReactNode; noun?: string }) {
  const [changes, setChanges] = useState<Map<string, StagedChange>>(new Map())
  const [mode, setMode] = useState<ReviewMode>(null)
  const [saving, setSaving] = useState(false)
  const changesRef = useRef(changes)
  changesRef.current = changes

  const api = useMemo<StagedApi>(() => ({
    get: (id) => changesRef.current.get(id),
    stage: (c) => setChanges((m) => { const n = new Map(m); n.set(c.id, c); return n }),
    undo: (id) => setChanges((m) => { const n = new Map(m); n.delete(id); return n }),
  }), [])
  // `get` reads a ref, so consumers need to re-render when changes move: the provider value changes with the map.
  const ctxValue = useMemo(() => ({ ...api, get: (id: string) => changes.get(id) }), [api, changes])

  const list = [...changes.values()]
  const n = list.length

  useEffect(() => {
    if (n === 0) return
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [n])

  const saveAll = useCallback(async () => {
    setSaving(true)
    let ok = 0, failed = 0
    for (const c of [...changesRef.current.values()]) {
      try {
        const r = await c.apply()
        if (r === false) throw new Error('not saved')
        ok++
        setChanges((m) => { const next = new Map(m); next.delete(c.id); return next })
      } catch { failed++ }
    }
    setSaving(false)
    if (failed === 0) { toast.success(`Saved ${ok} ${noun}${ok === 1 ? '' : 's'}`); setMode(null) }
    else toast.error(`${failed} ${noun}${failed === 1 ? '' : 's'} couldn't be saved — still staged`)
  }, [noun])
  const discardAll = () => { setChanges(new Map()); setMode(null); toast(`Discarded ${n} ${noun}${n === 1 ? '' : 's'}`, { icon: '↩️' }) }

  return (
    <Ctx.Provider value={ctxValue}>
      {n > 0 && (
        <div className="sticky top-0 z-30 mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-[#E67E22]/60 bg-[#E67E22]/15 px-3 py-2 text-xs font-body text-navy backdrop-blur-sm">
          <span className="inline-block h-2 w-2 rounded-full bg-[#E67E22]" />
          <b>{n}</b> unsaved {noun}{n === 1 ? '' : 's'}
          <span className="flex-1" />
          <Button size="sm" variant="secondary" onClick={() => setMode('review')} disabled={saving}>Review</Button>
          <Button size="sm" variant="secondary" onClick={() => setMode('discard')} disabled={saving}>Discard…</Button>
          <Button size="sm" onClick={() => void saveAll()} disabled={saving}>{saving ? 'Saving…' : `Save ${n}`}</Button>
        </div>
      )}
      {children}
      <Modal open={mode !== null && n > 0} onClose={() => setMode(null)} title={mode === 'discard' ? `Discard ${n} ${noun}${n === 1 ? '' : 's'}?` : `Review ${n} ${noun}${n === 1 ? '' : 's'}`} size="lg">
        <div className="flex flex-col gap-3">
          <p className="text-xs font-body text-inky">
            {mode === 'discard' ? 'These edits have not been saved. Discarding puts every cell back to what is saved.' : 'Nothing is saved yet. Undo any you don’t want, then save the rest.'}
          </p>
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-navy/20">
            <table className="w-full text-xs font-body">
              <thead className="sticky top-0 bg-sb-navy text-sb-cream">
                <tr><th className="px-3 py-2 text-left font-heading uppercase tracking-wide text-[11px]">Row</th><th className="px-3 py-2 text-left font-heading uppercase tracking-wide text-[11px]">Field</th><th className="px-3 py-2 text-left font-heading uppercase tracking-wide text-[11px]">Was</th><th className="px-3 py-2 text-left font-heading uppercase tracking-wide text-[11px]">Now</th><th className="w-14" /></tr>
              </thead>
              <tbody>
                {list.map((c, i) => (
                  <tr key={c.id} className={i % 2 ? 'bg-band' : 'bg-cream'}>
                    <td className="px-3 py-1.5 text-navy font-semibold">{c.rowLabel}</td>
                    <td className="px-3 py-1.5 text-inky">{c.field}</td>
                    <td className="px-3 py-1.5 text-inky line-through decoration-[#C0392B]/60">{c.before || '—'}</td>
                    <td className="px-3 py-1.5 text-navy font-semibold">{c.after || '—'}</td>
                    <td className="px-2 py-1.5 text-right">{mode !== 'discard' && <button type="button" onClick={() => api.undo(c.id)} className="text-[11px] text-inky underline hover:text-navy">Undo</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setMode(null)} disabled={saving}>Back</Button>
            {mode === 'discard'
              ? <Button size="sm" variant="danger" onClick={discardAll}>Discard {n}</Button>
              : (<><Button size="sm" variant="secondary" onClick={() => setMode('discard')} disabled={saving}>Discard all</Button><Button size="sm" onClick={() => void saveAll()} disabled={saving}>{saving ? 'Saving…' : `Save ${n}`}</Button></>)}
          </div>
        </div>
      </Modal>
    </Ctx.Provider>
  )
}

/** Where a cell reports itself to the review: its row's id and label, and the field name. */
export interface StageInfo { row: string; rowLabel: string; field: string }

/**
 * What an inline cell needs: the value to show (the staged one if there is one), a save that stages instead of writing when inside a
 * <StagedEdits>, and whether the cell has an unsaved change. Outside a staged scope it just passes everything through.
 */
export function useStagedCell<T>(value: T, onSave: (v: T) => void, stage: StageInfo | undefined, fmt: (v: T) => string = (v) => String(v ?? '')) {
  const api = useStaged()
  if (!api || !stage) return { shown: value, save: onSave, dirty: false }
  const id = `${stage.row}|${stage.field}`
  const staged = api.get(id)
  return {
    shown: staged ? (staged.value as T) : value,
    dirty: !!staged,
    save: (v: T) => {
      if (fmt(v) === fmt(value)) { api.undo(id); return } // edited back to what is saved
      api.stage({ id, rowLabel: stage.rowLabel, field: stage.field, before: fmt(value), after: fmt(v), value: v, apply: () => onSave(v) })
    },
  }
}
