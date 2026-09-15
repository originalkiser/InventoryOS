import type { PeriodConfig } from './types'

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function monthLabel(colKey: string | null): string | null {
  if (!colKey) return null
  const m = colKey.match(/^(\d{4})-(\d{2})$/)
  if (!m) return colKey
  return `${MON[+m[2] - 1]}-${m[1].slice(2)}`
}

const ROWS: { key: 'usage' | 'contract'; label: string; hint: string }[] = [
  { key: 'usage', label: 'Usage Period', hint: 'The window this month’s pace is measured against' },
  { key: 'contract', label: 'Contract Period', hint: 'The full contract term and its end-of-term commitment' },
]

// Start/end month + an end-of-period target for the 3 purchase-tracking
// slides (RelaDyne/Valvoline/Mighty) — this is what drives the dashed
// target reference line on each chart, so spend-to-target is visible
// without re-deriving a pace ramp from the raw purchase data.
export function PeriodsPanel({ periods, onSave }: {
  periods: PeriodConfig[]
  onSave: (periodKey: 'usage' | 'contract', patch: { startColKey?: string | null; startLabel?: string | null; endColKey?: string | null; endLabel?: string | null; targetNum?: number | null }) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-mono text-inky uppercase tracking-wide">Tracking Periods</span>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="text-xs font-mono border-collapse w-full">
          <thead>
            <tr>
              <th className="px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream">Period</th>
              <th className="px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream">Start Month</th>
              <th className="px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream">End Month</th>
              <th className="px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream">End-of-Period Target</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row, idx) => {
              const p = periods.find((x) => x.period_key === row.key)
              const band = idx % 2 ? 'bg-[#ECEBD8] dark:bg-[#0D2035]' : 'bg-cream'
              return (
                <tr key={row.key} className={band}>
                  <td className="px-2 py-1.5 border-b border-navy/15 whitespace-nowrap text-navy font-semibold" title={row.hint}>{row.label}</td>
                  <td className="px-2 py-1 border-b border-navy/15">
                    <input type="month" defaultValue={p?.start_col_key ?? ''}
                      onBlur={(e) => { const v = e.target.value || null; if (v !== (p?.start_col_key ?? null)) onSave(row.key, { startColKey: v, startLabel: monthLabel(v) }) }}
                      className="bg-transparent border border-transparent hover:border-navy/30 focus:border-sky focus:bg-white rounded px-1 py-0.5 text-navy" />
                  </td>
                  <td className="px-2 py-1 border-b border-navy/15">
                    <input type="month" defaultValue={p?.end_col_key ?? ''}
                      onBlur={(e) => { const v = e.target.value || null; if (v !== (p?.end_col_key ?? null)) onSave(row.key, { endColKey: v, endLabel: monthLabel(v) }) }}
                      className="bg-transparent border border-transparent hover:border-navy/30 focus:border-sky focus:bg-white rounded px-1 py-0.5 text-navy" />
                  </td>
                  <td className="px-2 py-1 border-b border-navy/15">
                    <input type="number" defaultValue={p?.target_num ?? ''} placeholder="Not set"
                      onBlur={(e) => { const v = e.target.value.trim() === '' ? null : Number(e.target.value); if (v !== (p?.target_num ?? null)) onSave(row.key, { targetNum: v }) }}
                      className="w-32 bg-transparent border border-transparent hover:border-navy/30 focus:border-sky focus:bg-white rounded px-1 py-0.5 text-navy" />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
