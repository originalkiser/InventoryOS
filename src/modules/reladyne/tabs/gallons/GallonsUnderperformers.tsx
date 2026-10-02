// Callout of markets/shops with poor billed-% of ordered (direct ask
// 2026-10-02). Deliberately ignores the Market/Shop filters (it's the thing
// that finds which ones to look at) but respects period/product/package
// type. Click a row to filter the rest of the tab to that market/shop and
// jump to the By Month data behind it.
import { useMemo, useState } from 'react'
import { Select } from '@/components/ui'
import { periodLabel, num0, pct1, billedPct } from '../../mmrShared'
import { monthlyBreakdown, type GRow } from './gallonsData'

type Entity = 'market' | 'shop'

interface Props {
  rows: GRow[]
  threshold: number
  onThresholdChange: (v: number) => void
  minOrdered: number
  onMinOrderedChange: (v: number) => void
  onDrill: (entity: Entity, key: string) => void
}

function NumField({ label, value, onChange, suffix }: { label: string; value: number; onChange: (v: number) => void; suffix?: string }) {
  const [text, setText] = useState(String(value))
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-heading text-inky uppercase tracking-wide">{label}</span>
      <span className="flex items-center gap-1">
        <input type="text" inputMode="decimal" value={text}
          onChange={(e) => {
            const t = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1')
            setText(t)
            const n = Number(t)
            if (t !== '' && Number.isFinite(n)) onChange(n)
          }}
          className="w-24 bg-cream border border-navy/40 rounded px-3 py-2 text-sm font-body text-navy focus:outline-none focus:ring-2 focus:ring-sky" />
        {suffix && <span className="text-xs font-mono text-inky">{suffix}</span>}
      </span>
    </label>
  )
}

export function GallonsUnderperformers({ rows, threshold, onThresholdChange, minOrdered, onMinOrderedChange, onDrill }: Props) {
  const [entity, setEntity] = useState<Entity>('market')
  const months = useMemo(() => [...new Set(rows.map((r) => r.period))].sort(), [rows])

  const flagged = useMemo(() => {
    return monthlyBreakdown(rows, (r) => (entity === 'market' ? r.market : r.shop))
      .filter((r) => r.total.ordered >= minOrdered)
      .map((r) => {
        const overall = billedPct(r.total.ordered, r.total.billed)
        const below = months.filter((m) => {
          const a = r.byMonth.get(m)
          const p = a ? billedPct(a.ordered, a.billed) : null
          return p != null && a!.ordered > 0 && p < threshold
        }).length
        return { ...r, overall, below }
      })
      .filter((r) => r.overall != null && r.overall < threshold)
      .sort((a, b) => (a.overall ?? 0) - (b.overall ?? 0))
  }, [rows, entity, minOrdered, threshold, months])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-40">
          <Select label="Flag by" value={entity} onChange={(e) => setEntity(e.target.value as Entity)}
            options={[{ value: 'market', label: 'Market' }, { value: 'shop', label: 'Shop' }]} />
        </div>
        <NumField label="Billed % below" value={threshold} onChange={onThresholdChange} suffix="%" />
        <NumField label="Min gallons ordered" value={minOrdered} onChange={onMinOrderedChange} suffix="gal" />
        <p className="text-[10px] font-mono text-inky/60 pb-2 max-w-md">
          Flags a {entity} when its billed % of ordered for the selected period is under the threshold and it ordered at
          least the minimum gallons. Month cells in red are individually under the threshold. Market/Shop filters above
          don't narrow this list.
        </p>
      </div>

      <p className="text-xs font-mono text-navy">
        {flagged.length} {entity}{flagged.length === 1 ? '' : 's'} below {threshold}% billed of ordered
      </p>

      {flagged.length === 0 ? (
        <p className="text-xs font-mono text-inky/60 py-8 text-center">Nothing under the threshold for the current filters.</p>
      ) : (
        <div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10">
              <tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
                <th className="text-left px-3 py-2 sticky left-0 bg-cream z-20 whitespace-nowrap">{entity === 'market' ? 'Market' : 'Shop'}</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Ordered</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Billed</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Billed %</th>
                <th className="text-right px-3 py-2 whitespace-nowrap">Months Under</th>
                {months.map((m) => <th key={m} className="text-right px-3 py-2 whitespace-nowrap border-l border-navy/10 first:border-l-0">{periodLabel(m)}</th>)}
              </tr>
            </thead>
            <tbody>
              {flagged.map((r) => (
                <tr key={r.key} onClick={() => onDrill(entity, r.key)} title="Click to see this in the By Month view"
                  className="border-b border-navy/10 hover:bg-navy/5 cursor-pointer">
                  <td className="px-3 py-1.5 text-navy sticky left-0 bg-cream whitespace-nowrap">{r.key}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{num0(r.total.ordered)}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{num0(r.total.billed)}</td>
                  <td className="px-3 py-1.5 text-right text-[#C0392B] font-bold">{pct1(r.overall)}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{r.below} / {months.length}</td>
                  {months.map((m) => {
                    const a = r.byMonth.get(m)
                    const p = a ? billedPct(a.ordered, a.billed) : null
                    const low = p != null && p < threshold
                    return (
                      <td key={m} className={`px-3 py-1.5 text-right whitespace-nowrap ${low ? 'text-[#C0392B] font-bold' : 'text-inky'}`}
                        title={a ? `${num0(a.billed)} billed of ${num0(a.ordered)} ordered` : undefined}>
                        {pct1(p)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
