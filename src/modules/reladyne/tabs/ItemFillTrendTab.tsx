// Item Fill % trend by product — recreates the reference HTML's own UX
// (search/Top-N product picker + multi-line chart) as a real page tab
// reading from reladyne_item_fill_stats instead of a static snapshot.
import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card, CardBody, Input, SbLoader } from '@/components/ui'
import { useReladyneItemFillStats } from '../useMmrData'
import { periodLabel, pct1 } from '../mmrShared'

const PALETTE = [
  '#c8791f', '#405166', '#3f7d5c', '#b5432b', '#7a5c9e',
  '#2f8f8c', '#a3762f', '#5b6f45', '#c0574e', '#3c6e8f',
  '#8a6d3b', '#6b4f8a', '#4c7a3f', '#9c4a6a', '#2e6b6b',
]

export function ItemFillTrendTab() {
  const { rows, loading } = useReladyneItemFillStats()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [seeded, setSeeded] = useState(false)

  const products = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.product_desc, (m.get(r.product_desc) ?? 0) + Number(r.order_count ?? 0))
    return [...m.entries()].map(([name, totalOrders]) => ({ name, totalOrders })).sort((a, b) => b.totalOrders - a.totalOrders)
  }, [rows])

  // Default to Top 5 by volume once data loads, same default the reference
  // HTML uses — only seeded once so the user's own picks afterward stick.
  useEffect(() => {
    if (seeded || products.length === 0) return
    setSelected(new Set(products.slice(0, 5).map((p) => p.name)))
    setSeeded(true)
  }, [seeded, products])

  const colorFor = useMemo(() => {
    const m = new Map<string, string>()
    products.forEach((p, i) => m.set(p.name, PALETTE[i % PALETTE.length]))
    return m
  }, [products])

  const periods = useMemo(() => [...new Set(rows.map((r) => r.period))].sort(), [rows])
  const chartData = useMemo(() => {
    const byPeriodProduct = new Map<string, number | null>()
    for (const r of rows) byPeriodProduct.set(`${r.period}|${r.product_desc}`, r.item_fill_pct)
    return periods.map((period) => {
      const row: Record<string, string | number | null> = { period: periodLabel(period) }
      for (const name of selected) row[name] = byPeriodProduct.get(`${period}|${name}`) ?? null
      return row
    })
  }, [periods, rows, selected])

  const filteredProducts = useMemo(() => {
    const f = search.trim().toLowerCase()
    return f ? products.filter((p) => p.name.toLowerCase().includes(f)) : products
  }, [products, search])

  function toggle(name: string) {
    setSelected((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n })
  }

  if (loading) return <div className="py-10 flex justify-center"><SbLoader size={28} /></div>

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
      <Card><CardBody className="flex flex-col gap-2 max-h-[560px]">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Products (by volume)</span>
        <Input placeholder="Search product…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-1.5 flex-wrap">
          <button onClick={() => setSelected(new Set(products.slice(0, 5).map((p) => p.name)))}
            className="text-[10px] font-mono text-navy border border-navy/30 rounded px-2 py-1 hover:border-navy">Top 5</button>
          <button onClick={() => setSelected(new Set(products.slice(0, 10).map((p) => p.name)))}
            className="text-[10px] font-mono text-navy border border-navy/30 rounded px-2 py-1 hover:border-navy">Top 10</button>
          <button onClick={() => setSelected(new Set(products.map((p) => p.name)))}
            className="text-[10px] font-mono text-navy border border-navy/30 rounded px-2 py-1 hover:border-navy">All</button>
          <button onClick={() => setSelected(new Set())}
            className="text-[10px] font-mono text-navy border border-navy/30 rounded px-2 py-1 hover:border-navy">Clear</button>
        </div>
        <div className="flex-1 overflow-auto border-t border-navy/10 pt-1.5">
          {filteredProducts.map((p) => (
            <label key={p.name} className="flex items-center gap-2 px-1 py-1 text-[11px] font-mono hover:bg-navy/5 rounded cursor-pointer">
              <input type="checkbox" checked={selected.has(p.name)} onChange={() => toggle(p.name)} />
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: colorFor.get(p.name) }} />
              <span className="flex-1 text-navy truncate">{p.name}</span>
              <span className="text-inky/50 flex-shrink-0">{p.totalOrders}</span>
            </label>
          ))}
        </div>
        <div className="text-[10px] font-mono text-inky/50 border-t border-navy/10 pt-1.5">{selected.size} selected</div>
      </CardBody></Card>

      <Card><CardBody>
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2 block">Item Fill % Trend</span>
        {selected.size === 0 ? (
          <div className="py-24 flex flex-col items-center justify-center text-center gap-1">
            <span className="text-sm font-heading font-bold text-navy">Nothing selected</span>
            <span className="text-[11px] font-mono text-inky/60">Check a product at left, or click "Top 5" to get started.</span>
          </div>
        ) : (
          <div style={{ width: '100%', height: 420 }}>
            <ResponsiveContainer>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#4F748933" />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} domain={[0, 100]} />
                <Tooltip formatter={(v: number) => pct1(v)} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {[...selected].map((name) => (
                  <Line key={name} type="monotone" dataKey={name} stroke={colorFor.get(name)} strokeWidth={2}
                    dot={{ r: 3 }} connectNulls={false} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-[10px] font-mono text-inky/50 mt-2">
          Item Fill % = Fill Count ÷ Order Count for that month. A break in a line means that product had no orders that month.
        </p>
      </CardBody></Card>
    </div>
  )
}
