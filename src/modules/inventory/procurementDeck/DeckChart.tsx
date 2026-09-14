import { BarChart, Bar, LineChart, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { GridCell } from './types'
import { formatValue, type ValueFormat } from './formatting'

// Brand tokens only (see CLAUDE.md's palette + the 3 allowed exception
// colors) -- cycled across series so a 6-row grid (e.g. Valvoline's Corp/
// FZ/Cumulative/3 targets) still gets a distinct color per line without a
// new hex value.
const PALETTE = ['#B7E0DE', '#4F7489', '#2ECC71', '#E67E22', '#C0392B', '#F2F1E6']
const tooltipStyle = { background: '#002745', border: '1px solid rgba(183,224,222,0.3)', borderRadius: '4px', fontFamily: '"DM Mono", monospace', fontSize: '11px', color: '#F2F1E6' }
const axisTickProps = { fill: '#F2F1E6', fontSize: 10, fontFamily: '"DM Mono", monospace' }
const legendStyle = { fontFamily: '"DM Mono", monospace', fontSize: '11px', color: '#F2F1E6' }

export interface DeckChartProps {
  title: string
  cells: GridCell[]
  rows: string[]           // row_labels to plot, in series order
  stacked?: boolean
  lineRows?: string[]      // subset of `rows` rendered as a Line instead of a Bar (combo charts)
  format: ValueFormat
  height?: number
}

export function DeckChart({ title, cells, rows, stacked, lineRows, format, height = 280 }: DeckChartProps) {
  const cols = [...new Map(cells.map((c) => [c.col_key, { key: c.col_key, label: c.col_label, sort: c.col_sort }])).values()]
    .sort((a, b) => a.sort - b.sort)
  if (cols.length === 0) {
    return (
      <div className="rounded-lg bg-navy px-6 py-10 text-center">
        <p className="text-xs font-mono text-[#F2F1E6]/60">No data yet — add rows below or upload a file to see this chart.</p>
      </div>
    )
  }
  const data = cols.map((col) => {
    const point: Record<string, string | number> = { name: col.label }
    for (const r of rows) {
      const cell = cells.find((c) => c.row_label === r && c.col_key === col.key)
      point[r] = cell?.value_num ?? 0
    }
    return point
  })
  const fmt = (v: number) => formatValue(v, format)
  const lineSet = new Set(lineRows ?? [])
  const hasCombo = lineSet.size > 0 && lineSet.size < rows.length

  return (
    <div className="rounded-lg bg-navy px-4 py-4">
      <div className="text-center text-sm font-heading text-[#F2F1E6] mb-2">{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        {hasCombo ? (
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.filter((r) => !lineSet.has(r)).map((r, i) => <Bar key={r} dataKey={r} stackId={stacked ? 'a' : undefined} fill={PALETTE[i % PALETTE.length]} radius={stacked ? 0 : [3, 3, 0, 0]} />)}
            {rows.filter((r) => lineSet.has(r)).map((r, i) => <Line key={r} type="monotone" dataKey={r} stroke={PALETTE[(i + 3) % PALETTE.length]} strokeWidth={2} dot={{ r: 3 }} strokeDasharray={r.toLowerCase().includes('target') ? '5 4' : undefined} />)}
          </ComposedChart>
        ) : lineRows && lineRows.length === rows.length ? (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.map((r, i) => <Line key={r} type="monotone" dataKey={r} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} dot={{ r: 3 }} />)}
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.map((r, i) => <Bar key={r} dataKey={r} stackId={stacked ? 'a' : undefined} fill={PALETTE[i % PALETTE.length]} radius={stacked ? 0 : [3, 3, 0, 0]} />)}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
