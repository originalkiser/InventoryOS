import { useMemo, useState } from 'react'
import { Modal, Button } from '@/components/ui'
import { useInventory, type InventoryRow } from '@/hooks/useInventory'
import { FLAG_HEX, type FlagColor, type FlagConfig } from '@/lib/flagScale'

function dosText(d: number | null, onHands: number | null): string {
  if (d == null) return onHands != null && onHands > 0 ? '∞' : '—'
  return d.toFixed(1)
}

type SortKey = 'location_label' | 'product_id' | 'days_of_supply'

// Shared inventory table — sortable, filterable, flag-colored. Used by the
// left panel and the dashboard tile.
export function InventoryView({ maxHeight = '60vh', withScaleEditor = true }: { maxHeight?: string; withScaleEditor?: boolean }) {
  const { rows, flagConfig, setFlagConfig, loading } = useInventory()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'days_of_supply', dir: 'asc' })
  const [editorOpen, setEditorOpen] = useState(false)

  const view = useMemo(() => {
    const q = search.trim().toLowerCase()
    let r = q ? rows.filter((x) => x.product_id.toLowerCase().includes(q) || x.location_label.toLowerCase().includes(q)) : rows
    const { key, dir } = sort
    r = [...r].sort((a, b) => {
      if (key === 'days_of_supply') {
        const av = a.days_of_supply ?? Infinity, bv = b.days_of_supply ?? Infinity
        return dir === 'asc' ? av - bv : bv - av
      }
      const av = String(a[key] ?? ''), bv = String(b[key] ?? '')
      return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av)
    })
    return r
  }, [rows, search, sort])

  const lowCount = rows.filter((r) => r.low).length

  function th(label: string, key: SortKey) {
    const active = sort.key === key
    return (
      <th onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))}
        className="cursor-pointer px-2 py-1.5 text-left hover:text-navy">{label}{active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter products / locations…"
          className="flex-1 rounded border border-navy/30 bg-cream px-2 py-1 text-xs font-mono text-navy placeholder-inky/50 focus:border-[#00e5ff] focus:outline-none" />
        {lowCount > 0 && <span className="text-xs font-mono" style={{ color: FLAG_HEX.red }}>{lowCount} below {flagConfig.slider_days}d</span>}
        {withScaleEditor && <button onClick={() => setEditorOpen(true)} className="rounded border border-navy/30 px-2 py-1 text-xs font-mono text-inky hover:text-navy" title="Flag scale">⚙ Scale</button>}
      </div>

      <div className="overflow-auto rounded border border-navy/30" style={{ maxHeight }}>
        <table className="w-full text-xs font-mono">
          <thead className="sticky top-0 bg-navy text-inky uppercase tracking-wide">
            <tr>{th('Location', 'location_label')}{th('Product', 'product_id')}<th className="px-2 py-1.5 text-right">On Hand</th><th className="px-2 py-1.5 text-right">Usage/day</th>{th('Days', 'days_of_supply')}</tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-inky/70">Loading…</td></tr>
            ) : view.length === 0 ? (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-inky/70">No product usage data</td></tr>
            ) : view.map((r: InventoryRow) => (
              <tr key={r.id} className="border-t border-navy/30/50" style={r.flag ? { borderLeft: `3px solid ${FLAG_HEX[r.flag]}` } : undefined}>
                <td className="px-2 py-1 text-navy">{r.location_label}</td>
                <td className="px-2 py-1 text-navy">{r.product_id}</td>
                <td className="px-2 py-1 text-right text-inky">{r.on_hands ?? '—'}</td>
                <td className="px-2 py-1 text-right text-inky">{r.daily_usage ?? '—'}</td>
                <td className="px-2 py-1 text-right font-semibold" style={{ color: r.flag ? FLAG_HEX[r.flag] : '#9ca3af' }}>{dosText(r.days_of_supply, r.on_hands)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={editorOpen} onClose={() => setEditorOpen(false)} title="Days-of-Supply Flag Scale" size="lg">
        <FlagScaleEditor config={flagConfig} onChange={setFlagConfig} onClose={() => setEditorOpen(false)} />
      </Modal>
    </div>
  )
}

export function FlagScaleEditor({ config, onChange, onClose }: { config: FlagConfig; onChange: (c: FlagConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<FlagConfig>(config)
  function setBandRange(color: FlagColor, i: number, patch: Partial<{ min: number | null; max: number | null }>) {
    setDraft((d) => ({ ...d, bands: d.bands.map((b) => b.color === color ? { ...b, ranges: b.ranges.map((r, j) => j === i ? { ...r, ...patch } : r) } : b) }))
  }
  function addRange(color: FlagColor) {
    setDraft((d) => ({ ...d, bands: d.bands.map((b) => b.color === color ? { ...b, ranges: [...b.ranges, { min: null, max: null }] } : b) }))
  }
  function removeRange(color: FlagColor, i: number) {
    setDraft((d) => ({ ...d, bands: d.bands.map((b) => b.color === color ? { ...b, ranges: b.ranges.filter((_, j) => j !== i) } : b) }))
  }
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="text-xs font-mono text-inky">Low threshold (days): <span className="text-inky">{draft.slider_days}</span></label>
        <input type="range" min={1} max={60} value={draft.slider_days} onChange={(e) => setDraft((d) => ({ ...d, slider_days: Number(e.target.value) }))} className="flex-1 accent-inky" />
      </div>
      {draft.bands.map((b) => (
        <div key={b.color} className="rounded border border-navy/30 p-2">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full" style={{ background: FLAG_HEX[b.color] }} />
            <span className="text-xs font-mono uppercase text-navy">{b.color}</span>
            <button onClick={() => addRange(b.color)} className="ml-auto text-xs font-mono text-inky hover:underline">+ range</button>
          </div>
          {b.ranges.map((r, i) => (
            <div key={i} className="mb-1 flex items-center gap-2 text-xs font-mono text-inky">
              <input type="number" placeholder="min" value={r.min ?? ''} onChange={(e) => setBandRange(b.color, i, { min: numOrNull(e.target.value) })}
                className="w-20 rounded border border-navy/30 bg-cream px-2 py-1 text-navy" />
              <span>≤ days &lt;</span>
              <input type="number" placeholder="max" value={r.max ?? ''} onChange={(e) => setBandRange(b.color, i, { max: numOrNull(e.target.value) })}
                className="w-20 rounded border border-navy/30 bg-cream px-2 py-1 text-navy" />
              <button onClick={() => removeRange(b.color, i)} className="text-inky/70 hover:text-red-400">×</button>
            </div>
          ))}
          <p className="text-[10px] text-inky/70">Blank min/max = unbounded. Multiple ranges = OR (e.g. too-low or too-high).</p>
        </div>
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" onClick={() => { onChange(draft); onClose() }}>Save Scale</Button>
      </div>
    </div>
  )
}
