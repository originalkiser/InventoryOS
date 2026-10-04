// Quick filters for the Review tables — the clickable flag/tag buttons above the table and the DOS legend swatches
// under the target boxes. A quick-filter key is one of:
//   tag:<TagKey>      the line carries that Flag (before) or Flag (after)
//   tone:<RowTone>    the whole row has that tone (under order minimum, over capacity to reach DOS target, excluded)
//   cell:<DosTone>    DOS Now or DOS After is in that conditional-formatting tier
// With several selected, a line matching ANY of them is shown. Pure, so it can be tested.
import { dosTone, type DosThresholds, type LineTags, type RowTone } from './lineFlags'

export interface TaggedLine { tags: LineTags; tone: RowTone | null }
interface DosLine { id: string; dos_before: number | null; dos_after: number | null }

export const tagKey = (k: string) => `tag:${k}`
export const toneKey = (t: RowTone) => `tone:${t}`
export const cellKey = (t: string) => `cell:${t}`

/** The distinct quick-filter keys a single line satisfies. */
export function lineQuickKeys(l: DosLine, t: TaggedLine | undefined, thresholds: DosThresholds | null): Set<string> {
  const keys = new Set<string>()
  if (t) {
    for (const x of t.tags.before) keys.add(tagKey(x.key))
    for (const x of t.tags.after) keys.add(tagKey(x.key))
    if (t.tone) keys.add(toneKey(t.tone))
  }
  if (thresholds) {
    const a = dosTone(l.dos_before, thresholds)
    const b = dosTone(l.dos_after, thresholds)
    if (a) keys.add(cellKey(a))
    if (b) keys.add(cellKey(b))
  }
  return keys
}

/** How many lines satisfy each quick-filter key (only keys with at least one line appear). */
export function quickCounts(lines: DosLine[], tagMap: Map<string, TaggedLine>, thresholds: DosThresholds | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const l of lines) for (const k of lineQuickKeys(l, tagMap.get(l.id), thresholds)) counts.set(k, (counts.get(k) ?? 0) + 1)
  return counts
}

export function matchesAnyQuick(selected: Set<string>, l: DosLine, t: TaggedLine | undefined, thresholds: DosThresholds | null): boolean {
  if (selected.size === 0) return true
  const keys = lineQuickKeys(l, t, thresholds)
  for (const k of selected) if (keys.has(k)) return true
  return false
}
