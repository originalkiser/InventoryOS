// Product Gallons charts (direct ask 2026-10-02): Ordered vs Billed side by
// side per month, and a Bulk/Package/Drum stacked version of the same
// side-by-side. Always-dark card (static sb-navy, not the dark-mode-flipping
// navy token) — same look/convention as the Procurement Deck's DeckChart.
import { useMemo } from 'react'
import { ComposedChart, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { GROUP_KEYS, GROUP_LABELS, periodLabel, num0, type GroupKey } from '../../mmrShared'
import { groupRows, sumRows, type GRow } from './gallonsData'

const GROUP_COLORS: Record<GroupKey, string> = { bulk: '#B7E0DE', package: '#4F7489', drum: '#E67E22' }
const TEXT = '#F2F1E6'
const axisTick = { fill: TEXT, fontSize: 10, fontFamily: '"DM Mono", monospace' }
const tooltipStyle = { background: '#002745', border: '1px solid rgba(183,224,222,0.3)', borderRadius: '4px', fontFamily: '"DM Mono", monospace', fontSize: '11px', color: TEXT }
const legendStyle = { fontFamily: '"DM Mono", monospace', fontSize: '11px', color: TEXT }

function ChartCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-sb-navy px-4 py-4">
      <div className="text-center text-sm font-heading mb-0.5" style={{ color: TEXT }}>{title}</div>
      {subtitle && <div className="text-center text-[10px] font-mono mb-2" style={{ color: `${TEXT}99` }}>{subtitle}</div>}
      {children}
    </div>
  )
}

export function GallonsCharts({ rows }: { rows: GRow[] }) {
  const months = useMemo(() => [...new Set(rows.map((r) => r.period))].sort(), [rows])

  const totals = useMemo(() => months.map((p) => {
    const a = sumRows(rows.filter((r) => r.period === p))
    return { name: periodLabel(p), ordered: Math.round(a.ordered), billed: Math.round(a.billed), pct: a.ordered > 0 ? Number(((a.billed / a.ordered) * 100).toFixed(1)) : null }
  }), [rows, months])

  const stacked = useMemo(() => {
    const byPeriod = groupRows(rows, (r) => r.period)
    return months.map((p) => {
      const point: Record<string, string | number> = { name: periodLabel(p) }
      const byGroup = groupRows(byPeriod.get(p) ?? [], (r) => r.group)
      for (const g of GROUP_KEYS) {
        const a = sumRows(byGroup.get(g) ?? [])
        point[`ordered_${g}`] = Math.round(a.ordered)
        point[`billed_${g}`] = Math.round(a.billed)
      }
      return point
    })
  }, [rows, months])

  if (!months.length) {
    return <p className="text-xs font-mono text-inky/60 py-8 text-center">No data for the current filters.</p>
  }

  return (
    <div className="flex flex-col gap-4">
      <ChartCard title="Gallons Ordered vs Billed by Month" subtitle="Bars: gallons (left axis) · Line: billed % of ordered (right axis)">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={totals} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
            <XAxis dataKey="name" tick={axisTick} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
            <YAxis yAxisId="gal" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v: number) => num0(v)} width={64} />
            <YAxis yAxisId="pct" orientation="right" tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v: number) => `${v}%`} width={48} domain={[0, 'auto']} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number, name: string) => (name.includes('%') ? `${v}%` : num0(v))} />
            <Legend wrapperStyle={legendStyle} />
            <Bar yAxisId="gal" dataKey="ordered" name="Gallons Ordered" fill="#B7E0DE" radius={[3, 3, 0, 0]} />
            <Bar yAxisId="gal" dataKey="billed" name="Gallons Billed" fill="#E67E22" radius={[3, 3, 0, 0]} />
            <Line yAxisId="pct" type="monotone" dataKey="pct" name="Billed % of Ordered" stroke="#2ECC71" strokeWidth={2} dot={{ r: 3 }} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </ChartCard>

      <ChartCard title="Package Type Mix — Ordered vs Billed" subtitle="Each month: left stack = Ordered, right stack (lighter) = Billed">
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={stacked} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(242,241,230,0.1)" vertical={false} />
            <XAxis dataKey="name" tick={axisTick} axisLine={{ stroke: 'rgba(242,241,230,0.2)' }} tickLine={false} />
            <YAxis tick={axisTick} axisLine={false} tickLine={false} tickFormatter={(v: number) => num0(v)} width={64} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => num0(v)} />
            {GROUP_KEYS.map((g) => (
              <Bar key={`o-${g}`} dataKey={`ordered_${g}`} name={`Ordered · ${GROUP_LABELS[g]}`} stackId="ordered" fill={GROUP_COLORS[g]} />
            ))}
            {GROUP_KEYS.map((g) => (
              <Bar key={`b-${g}`} dataKey={`billed_${g}`} name={`Billed · ${GROUP_LABELS[g]}`} stackId="billed" fill={GROUP_COLORS[g]} fillOpacity={0.55} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <div className="flex items-center justify-center gap-4 mt-2 text-[11px] font-mono" style={{ color: TEXT }}>
          {GROUP_KEYS.map((g) => (
            <span key={g} className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-sm" style={{ background: GROUP_COLORS[g] }} />{GROUP_LABELS[g]}
            </span>
          ))}
        </div>
      </ChartCard>
    </div>
  )
}
