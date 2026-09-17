import { useCallback, useState } from 'react'

const MAX_HISTORY = 50

/**
 * Drop-in replacement for `useState` that also tracks undo/redo history —
 * built for Form Builder's field list (2026-09-16 request: "undo changes,
 * like if seeding locations wrong"), but generic. `set` has the exact same
 * value-or-updater signature as React's own setter, so every existing call
 * site keeps working unchanged; every call it makes is automatically
 * undoable, including a bad Location Seeder batch, since that flows through
 * the same `setFields` the rest of the builder already uses.
 *
 * History is plain in-memory state (not persisted) — nothing here is meant
 * to survive a reload, only to protect an in-progress edit before Save
 * commits it, matching how this app's forms are already saved (whole-form
 * delete-and-reinsert on Save, nothing durable before that).
 */
export function useUndoableState<T>(initial: T) {
  const [state, setState] = useState<T>(initial)
  const [undoStack, setUndoStack] = useState<T[]>([])
  const [redoStack, setRedoStack] = useState<T[]>([])

  const set = useCallback((updater: T | ((prev: T) => T)) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? (updater as (p: T) => T)(prev) : updater
      setUndoStack((u) => [...u.slice(-(MAX_HISTORY - 1)), prev])
      setRedoStack([])
      return next
    })
  }, [])

  /** Replaces the value AND clears history — for loading fresh data (e.g. opening an existing form) that shouldn't itself be an undoable step. */
  const reset = useCallback((value: T) => {
    setUndoStack([])
    setRedoStack([])
    setState(value)
  }, [])

  const undo = useCallback(() => {
    setUndoStack((u) => {
      if (!u.length) return u
      const previous = u[u.length - 1]
      setState((curr) => { setRedoStack((r) => [...r, curr]); return previous })
      return u.slice(0, -1)
    })
  }, [])

  const redo = useCallback(() => {
    setRedoStack((r) => {
      if (!r.length) return r
      const next = r[r.length - 1]
      setState((curr) => { setUndoStack((u) => [...u, curr]); return next })
      return r.slice(0, -1)
    })
  }, [])

  return { value: state, set, reset, undo, redo, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }
}
