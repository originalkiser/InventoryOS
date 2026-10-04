// Live Flags/Tags per Review line, recomputed whenever any line, the DOS thresholds or the order minimums change.
// Shared by the Review page (legend counts / quick filters) and every Review-style table.
import { useMemo } from 'react'
import type { DraftLineRow } from './useOrdersV2'
import { computeLineTags, rowToneOf, type DosThresholds, type LineTags, type RowTone } from './lineFlags'

const NO_THRESHOLDS: DosThresholds = { target: 0, minTrigger: 0, max: Number.POSITIVE_INFINITY }

export type LineTagMap = Map<string, { tags: LineTags; tone: RowTone | null }>

export function useLineTagMap(
  lines: DraftLineRow[],
  thresholds: DosThresholds | null,
  onHandAfterAtDelivery: (l: DraftLineRow) => number,
  groupMinimumStatus: Map<string, boolean>,
): LineTagMap {
  return useMemo(() => {
    const ctx = {
      thresholds: thresholds ?? NO_THRESHOLDS,
      onHandAfter: (l: DraftLineRow) => onHandAfterAtDelivery(l),
      belowMinimum: (l: DraftLineRow) => groupMinimumStatus.get(`${l.location_id}|${l.order_type}`) === false,
    }
    const m: LineTagMap = new Map()
    for (const l of lines) {
      const tags = computeLineTags(l as any, ctx)
      m.set(l.id, { tags, tone: rowToneOf(l, tags) })
    }
    return m
  }, [lines, thresholds, onHandAfterAtDelivery, groupMinimumStatus])
}
