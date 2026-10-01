// Monthly rollup chart for the Products Ordered tab (direct ask 2026-10-01)
// — one stacked bar chart per vendor, by month. Stacked by product (default)
// or, via the toggle, by UOM. The stack's total height is always gallons
// ordered (converted via quarts_per_unit, the same field useDraftAggregates/
// useOrderHistory's own totalGallons already use), never raw qty — qty alone
// mixes incompatible units (cases, totes, drums, gallons) across products.
import { useMemo, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card, CardBody, Select, Toggle } from '@/components/ui'
import type { OrderHistoryLineRow } from './useOrderHistory'
import { useVendors } from './useLookups'
import { num } from './shared'
import { uomDisplayLabel } from './types'

const MONTHS_BACK_OPTIONS = [
  { value: '3', label: 'Last 3 Months' },
  { value: '6', label: 'Last 6 Months' },
  { value: '12', label: 'Last 12 Months' },
  { value: 'all', label: 'All Time' },
]

// Brand-neutral data-series palette, same precedent as the RelaDyne MMR Item
// Fill Trend chart and the Procurement Deck's own chart cards — a chart
// series is a data highlight, not app chrome, so the Tailwind-token-only
// rule doesn't apply here.
const PALETTE = [
  '#405166', '#c8791f', '#3f7d5c', '#b5432b', '#7a5c9e',
  '#2f8f8c', '#a3762f', '#5b6f45', '#c0574e', '#3c6e8f',
]
const OTHER_COLOR = '#8a8a8a'
const TOP_N = 8

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(key: string): string {
  const [y, m] = key.split('-')
  const idx = Number(m) - 1
  return idx >= 0 && idx < 12 ? `${MONTH_SHORT[idx]} ${y}` : key
}

interface VendorChartData {
  vendorId: string
  vendorName: string
  months: string[]
  series: string[]
  data: Array<Record<string, string | number>>
}

function buildVendorCharts(
  rows: OrderHistoryLineRow[],
  monthsBack: number | 'all',
  mode: 'product' | 'uom',
  vendorName: (id: string | null) => string,
): VendorChartData[] {
  // Only lines with a known quarts_per_unit can be expressed in gallons —
  // same filtering convention as useOrderHistory's own totalGallons.
  const gallonRows = rows
    .filter((r) => r.quarts_per_unit && r.order_date)
    .map((r) => ({ ...r, month: r.order_date.slice(0, 7), gal: (Number(r.qty) * Number(r.quarts_per_unit)) / 4 }))

  const distinctMonths = [...new Set(gallonRows.map((r) => r.month))].sort()
  const months = monthsBack === 'all' ? distinctMonths : distinctMonths.slice(-monthsBack)
  const monthSet = new Set(months)
  const inRange = gallonRows.filter((r) => monthSet.has(r.month))

  const byVendor = new Map<string, typeof inRange>()
  for (const r of inRange) {
    const key = r.vendor_id ?? '—'
    const arr = byVendor.get(key) ?? []
    arr.push(r)
    byVendor.set(key, arr)
  }

  return [...byVendor.entries()].map(([vendorId, vRows]) => {
    const keyOf = (r: (typeof vRows)[number]) => (mode === 'uom' ? uomDisplayLabel(r.uom) || '—' : r.product_id)

    // Top-N series by total gallons across the visible range, rest folded
    // into "Other" — a company can have dozens of products on one vendor,
    // which would otherwise make the stack/legend unreadable. UOM mode
    // naturally has few distinct values, so this rarely trims anything there.
    const totalsByKey = new Map<string, number>()
    for (const r of vRows) totalsByKey.set(keyOf(r), (totalsByKey.get(keyOf(r)) ?? 0) + r.gal)
    const ranked = [...totalsByKey.entries()].sort((a, b) => b[1] - a[1])
    const topKeys = new Set(ranked.slice(0, TOP_N).map(([k]) => k))
    const hasOther = ranked.length > TOP_N
    const series = [...ranked.slice(0, TOP_N).map(([k]) => k), ...(hasOther ? ['Other'] : [])]

    const byMonth = new Map<string, Record<string, number>>()
    for (const r of vRows) {
      const k = keyOf(r)
      const seriesKey = topKeys.has(k) ? k : 'Other'
      const bucket = byMonth.get(r.month) ?? {}
      bucket[seriesKey] = (bucket[seriesKey] ?? 0) + r.gal
      byMonth.set(r.month, bucket)
    }

    const data = months.map((m) => ({ month: monthLabel(m), ...(byMonth.get(m) ?? {}) }))
    return { vendorId, vendorName: vendorName(vendorId === '—' ? null : vendorId), months, series, data }
  }).sort((a, b) => a.vendorName.localeCompare(b.vendorName))
}

export function ProductsOrderedChart({ rows }: { rows: OrderHistoryLineRow[] }) {
  const vendors = useVendors()
  const [monthsBack, setMonthsBack] = useState<number | 'all'>(6)
  const [byUom, setByUom] = useState(false)

  const charts = useMemo(
    () => buildVendorCharts(rows, monthsBack, byUom ? 'uom' : 'product', (id) => vendors.byId(id)?.name ?? '—'),
    [rows, monthsBack, byUom, vendors],
  )

  const colorFor = (series: string[], key: string) => {
    if (key === 'Other') return OTHER_COLOR
    const i = series.indexOf(key)
    return PALETTE[i % PALETTE.length]
  }

  if (charts.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Toggle checked={byUom} onChange={setByUom} label={byUom ? 'Stacked by UOM' : 'Stacked by Product'} size="sm" color="green" />
        <div className="w-40">
          <Select value={String(monthsBack)} onChange={(e) => setMonthsBack(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            options={MONTHS_BACK_OPTIONS} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {charts.map((c) => (
          <Card key={c.vendorId}><CardBody>
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2 block">{c.vendorName}</span>
            <div style={{ width: '100%', height: 260 }}>
              <ResponsiveContainer>
                <BarChart data={c.data}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#4F748933" />
                  <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: number) => `${num(v, 0)} gal`} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  {c.series.map((s) => (
                    <Bar key={s} dataKey={s} stackId="gallons" fill={colorFor(c.series, s)} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardBody></Card>
        ))}
      </div>
      <p className="text-[10px] font-mono text-inky/50">
        Gallons ordered (not raw quantity) — lines with no known quarts-per-unit conversion aren't included.
        {!byUom && ' Top 8 products by volume per vendor; everything else is grouped into "Other".'}
      </p>
    </div>
  )
}
