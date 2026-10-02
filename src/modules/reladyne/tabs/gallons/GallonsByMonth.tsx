// Per-month trend table (direct ask 2026-10-02: "need these totals to be per
// month") — rows = Product / Package Type / Market / Shop, columns = each
// month in the selected period plus a period total. Hand-rolled matrix
// (months are dynamic columns, same precedent as Staffing Report's rollup)
// with its own CSV export.
import { useMemo } from 'react'
import { Download } from 'lucide-react'
import { Select, Button } from '@/components/ui'
import { GROUP_LABELS, periodLabel, num0, pct1, money, billedPct } from '../../mmrShared'
import {
  GROUP_BY_OPTIONS, MONTH_METRIC_OPTIONS, dimKey, monthlyBreakdown, downloadCsv,
  type GRow, type GroupByDim, type MonthMetric, type Agg,
} from './gallonsData'

interface Props {
  rows: GRow[]
  groupBy: GroupByDim
  onGroupByChange: (g: GroupByDim) => void
  metric: MonthMetric
  onMetricChange: (m: MonthMetric) => void
  /** Billed % cells under this render red (shared with the Underperformers tab). */
  threshold: number
}

function metricText(metric: MonthMetric, a: Agg | undefined): string {
  if (!a) return '—'
  switch (metric) {
    case 'ordered': return num0(a.ordered)
    case 'billed': return num0(a.billed)
    case 'billed_pct': return pct1(billedPct(a.ordered, a.billed))
    case 'revenue': return money(a.revenue)
    case 'both': return `${num0(a.ordered)} / ${num0(a.billed)}`
  }
}

export function GallonsByMonth({ rows, groupBy, onGroupByChange, metric, onMetricChange, threshold }: Props) {
  const months = useMemo(() => [...new Set(rows.map((r) => r.period))].sort(), [rows])
  const data = useMemo(() => monthlyBreakdown(rows, dimKey(groupBy, (g) => GROUP_LABELS[g])), [rows, groupBy])
  const dimLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? ''

  function exportCsv() {
    const header = [dimLabel, ...months.flatMap((m) => (metric === 'both' ? [`${periodLabel(m)} Ordered`, `${periodLabel(m)} Billed`] : [periodLabel(m)])),
      ...(metric === 'both' ? ['Total Ordered', 'Total Billed', 'Total Billed %'] : ['Total'])]
    const raw = (a: Agg | undefined): (string | number | null)[] => {
      if (!a) return metric === 'both' ? ['', ''] : ['']
      switch (metric) {
        case 'ordered': return [Math.round(a.ordered)]
        case 'billed': return [Math.round(a.billed)]
        case 'billed_pct': { const p = billedPct(a.ordered, a.billed); return [p == null ? '' : Number(p.toFixed(1))] }
        case 'revenue': return [Math.round(a.revenue)]
        case 'both': return [Math.round(a.ordered), Math.round(a.billed)]
      }
    }
    const lines: (string | number | null)[][] = [header]
    for (const r of data) {
      const tail = metric === 'both'
        ? [...raw(r.total), (() => { const p = billedPct(r.total.ordered, r.total.billed); return p == null ? '' : Number(p.toFixed(1)) })()]
        : raw(r.total)
      lines.push([r.key, ...months.flatMap((m) => raw(r.byMonth.get(m))), ...tail])
    }
    downloadCsv(`RelaDyne Gallons by Month - ${dimLabel}.csv`, lines)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-44"><Select label="Rows" value={groupBy} onChange={(e) => onGroupByChange(e.target.value as GroupByDim)} options={GROUP_BY_OPTIONS} /></div>
        <div className="w-52"><Select label="Show" value={metric} onChange={(e) => onMetricChange(e.target.value as MonthMetric)} options={MONTH_METRIC_OPTIONS} /></div>
        <Button size="sm" variant="secondary" onClick={exportCsv}><Download className="w-3.5 h-3.5 mr-1" /> Export CSV</Button>
        {metric === 'both' && <span className="text-[10px] font-mono text-inky/60 pb-2">Each cell: ordered / billed gallons</span>}
      </div>

      {data.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-8 text-center">No data for the current filters.</p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10">
              <tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
                <th className="text-left px-3 py-2 sticky left-0 bg-cream z-20 whitespace-nowrap">{dimLabel}</th>
                {months.map((m) => <th key={m} className="text-right px-3 py-2 whitespace-nowrap">{periodLabel(m)}</th>)}
                <th className="text-right px-3 py-2 whitespace-nowrap font-bold border-l border-navy/20">Period Total</th>
                {metric === 'both' && <th className="text-right px-3 py-2 whitespace-nowrap font-bold">Billed %</th>}
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.key} className="border-b border-navy/10 hover:bg-navy/5">
                  <td className="px-3 py-1.5 text-navy sticky left-0 bg-cream whitespace-nowrap max-w-[280px] truncate" title={r.key}>{r.key}</td>
                  {months.map((m) => {
                    const a = r.byMonth.get(m)
                    const p = a ? billedPct(a.ordered, a.billed) : null
                    const low = (metric === 'billed_pct' || metric === 'both') && p != null && p < threshold
                    return (
                      <td key={m} className={`px-3 py-1.5 text-right whitespace-nowrap ${low ? 'text-[#C0392B] font-bold' : 'text-inky'}`}
                        title={a ? `Billed ${pct1(p)} of ordered` : undefined}>
                        {metricText(metric, a)}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right text-navy font-bold whitespace-nowrap border-l border-navy/20">{metricText(metric, r.total)}</td>
                  {metric === 'both' && (
                    <td className={`px-3 py-1.5 text-right whitespace-nowrap font-bold ${(billedPct(r.total.ordered, r.total.billed) ?? 100) < threshold ? 'text-[#C0392B]' : 'text-navy'}`}>
                      {pct1(billedPct(r.total.ordered, r.total.billed))}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
