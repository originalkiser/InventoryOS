import { useRef } from 'react'
import { BarChart, Bar, LineChart, Line, ComposedChart, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import type { GridCell } from './types'
import { formatValue, type ValueFormat } from './formatting'

// Brand tokens only (see CLAUDE.md's palette + the 3 allowed exception
// colors) -- cycled across series so a 6-row grid (e.g. Valvoline's Corp/
// FZ/Cumulative/3 targets) still gets a distinct color per line without a
// new hex value. Dark-variant order puts sky/cream first (they read well
// against navy); light-variant puts navy/inky first instead since pale sky
// is nearly invisible on a white/cream background.
const PALETTE_DARK = ['#B7E0DE', '#4F7489', '#2ECC71', '#E67E22', '#C0392B', '#F2F1E6']
const PALETTE_LIGHT = ['#002745', '#4F7489', '#2ECC71', '#E67E22', '#C0392B', '#B7E0DE']

const THEME = {
  dark: {
    cardClass: 'bg-sb-navy',
    text: '#F2F1E6',
    grid: 'rgba(242,241,230,0.1)',
    axisLine: 'rgba(242,241,230,0.2)',
    tooltipBg: '#002745',
    tooltipBorder: 'rgba(183,224,222,0.3)',
    palette: PALETTE_DARK,
    captureBg: '#002745',
  },
  light: {
    cardClass: 'bg-sb-cream',
    text: '#002745',
    grid: 'rgba(0,39,69,0.12)',
    axisLine: 'rgba(0,39,69,0.3)',
    tooltipBg: '#F2F1E6',
    tooltipBorder: 'rgba(0,39,69,0.3)',
    palette: PALETTE_LIGHT,
    captureBg: '#F2F1E6',
  },
} as const

export interface DeckChartProps {
  title: string
  cells: GridCell[]
  rows: string[]           // row_labels to plot, in series order
  stacked?: boolean
  lineRows?: string[]      // subset of `rows` rendered as a Line instead of a Bar (combo charts)
  format: ValueFormat
  height?: number
  referenceLines?: { label: string; value: number }[]  // e.g. period end-of-period targets
}

function ChartBody({ title, cells, rows, stacked, lineRows, format, height = 280, referenceLines, variant }: DeckChartProps & { variant: 'dark' | 'light' }) {
  const theme = THEME[variant]
  const cols = [...new Map(cells.map((c) => [c.col_key, { key: c.col_key, label: c.col_label, sort: c.col_sort }])).values()]
    .sort((a, b) => a.sort - b.sort)
  if (cols.length === 0) {
    return (
      <div className={`rounded-lg ${theme.cardClass} px-6 py-10 text-center`}>
        <p className="text-xs font-mono" style={{ color: `${theme.text}99` }}>No data yet — add rows below or upload a file to see this chart.</p>
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
  const axisTickProps = { fill: theme.text, fontSize: 10, fontFamily: '"DM Mono", monospace' }
  const legendStyle = { fontFamily: '"DM Mono", monospace', fontSize: '11px', color: theme.text }
  const tooltipStyle = { background: theme.tooltipBg, border: `1px solid ${theme.tooltipBorder}`, borderRadius: '4px', fontFamily: '"DM Mono", monospace', fontSize: '11px', color: theme.text }
  const lineSet = new Set(lineRows ?? [])
  const hasCombo = lineSet.size > 0 && lineSet.size < rows.length
  const refLines = (referenceLines ?? []).map((rl, i) => (
    <ReferenceLine key={i} y={rl.value} stroke={theme.palette[4]} strokeDasharray="6 3" strokeWidth={1.5}
      label={{ value: `${rl.label}: ${fmt(rl.value)}`, position: 'insideTopRight', fill: theme.text, fontSize: 10, fontFamily: '"DM Mono", monospace' }} />
  ))

  return (
    <div className={`rounded-lg ${theme.cardClass} px-4 py-4`}>
      <div className="text-center text-sm font-heading mb-2" style={{ color: theme.text }}>{title}</div>
      <ResponsiveContainer width="100%" height={height}>
        {hasCombo ? (
          <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: theme.axisLine }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.filter((r) => !lineSet.has(r)).map((r, i) => <Bar key={r} dataKey={r} stackId={stacked ? 'a' : undefined} fill={theme.palette[i % theme.palette.length]} radius={stacked ? 0 : [3, 3, 0, 0]} />)}
            {rows.filter((r) => lineSet.has(r)).map((r, i) => <Line key={r} type="monotone" dataKey={r} stroke={theme.palette[(i + 3) % theme.palette.length]} strokeWidth={2} dot={{ r: 3 }} strokeDasharray={r.toLowerCase().includes('target') ? '5 4' : undefined} />)}
            {refLines}
          </ComposedChart>
        ) : lineRows && lineRows.length === rows.length ? (
          <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: theme.axisLine }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.map((r, i) => <Line key={r} type="monotone" dataKey={r} stroke={theme.palette[i % theme.palette.length]} strokeWidth={2} dot={{ r: 3 }} />)}
            {refLines}
          </LineChart>
        ) : (
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={theme.grid} vertical={false} />
            <XAxis dataKey="name" tick={axisTickProps} axisLine={{ stroke: theme.axisLine }} tickLine={false} />
            <YAxis tick={axisTickProps} axisLine={false} tickLine={false} tickFormatter={fmt} width={format === 'percent' ? 48 : 60} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => fmt(v)} />
            <Legend wrapperStyle={legendStyle} />
            {rows.map((r, i) => <Bar key={r} dataKey={r} stackId={stacked ? 'a' : undefined} fill={theme.palette[i % theme.palette.length]} radius={stacked ? 0 : [3, 3, 0, 0]} />)}
            {refLines}
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

// Screenshots a chart card via html2canvas and puts it on the clipboard as
// a real image, for pasting straight into a PowerPoint slide — dark (the
// on-screen deck look) or light (a white-slide-friendly recolor), captured
// from a permanently-mounted-but-off-screen clone rather than by toggling
// the visible chart's own theme (recharts needs a real reflow before
// html2canvas can shoot it, and swapping the visible one would flash).
async function copyChartImage(node: HTMLElement | null, bg: string) {
  if (!node) { toast.error('Chart not ready to copy'); return }
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) {
    toast.error('This browser doesn’t support copying images')
    return
  }
  // Must call clipboard.write() synchronously within the click's user-
  // activation window — passing a pending Promise<Blob> (not an awaited
  // one) is the documented way to let the actual capture happen async
  // without missing that window (same fix already applied to the
  // Customer Heatmap's own copy button).
  const buildBlob = (async () => {
    const html2canvas = (await import('html2canvas')).default
    const canvas = await html2canvas(node, { backgroundColor: bg, useCORS: true, logging: false, scale: 2 })
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ?? new Blob()
  })()
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': buildBlob })])
    toast.success('Chart copied — paste into PowerPoint')
  } catch {
    toast.error('Copy failed')
  }
}

export function DeckChart(props: DeckChartProps) {
  const darkRef = useRef<HTMLDivElement>(null)
  const lightRef = useRef<HTMLDivElement>(null)
  return (
    <div className="flex flex-col gap-1.5">
      <div ref={darkRef}><ChartBody {...props} variant="dark" /></div>
      <div className="flex justify-end gap-2">
        <button onClick={() => copyChartImage(darkRef.current, THEME.dark.captureBg)} title="Copy a dark-background image of this chart for PowerPoint"
          className="inline-flex items-center gap-1 text-[10px] font-mono text-inky border border-navy/30 rounded px-2 py-0.5 hover:border-navy">
          <Copy className="w-3 h-3" /> Copy (Dark)
        </button>
        <button onClick={() => copyChartImage(lightRef.current, THEME.light.captureBg)} title="Copy a light-background image of this chart for PowerPoint"
          className="inline-flex items-center gap-1 text-[10px] font-mono text-inky border border-navy/30 rounded px-2 py-0.5 hover:border-navy">
          <Copy className="w-3 h-3" /> Copy (Light)
        </button>
      </div>
      {/* Off-screen but genuinely laid out (not display:none) so html2canvas
          has real content to rasterize the moment Copy (Light) is clicked. */}
      <div style={{ position: 'fixed', top: 0, left: -99999, width: 760, pointerEvents: 'none' }} aria-hidden>
        <div ref={lightRef}><ChartBody {...props} variant="light" /></div>
      </div>
    </div>
  )
}
