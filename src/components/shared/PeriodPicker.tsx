import { PERIOD_LABELS, PERIOD_ORDER, type DatePeriod } from '@/lib/datePeriods'

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

export function PeriodPicker({
  period, onPeriodChange, customStart, customEnd, onCustomStartChange, onCustomEndChange, earliestDate,
}: {
  period: DatePeriod
  onPeriodChange: (p: DatePeriod) => void
  customStart: string
  customEnd: string
  onCustomStartChange: (v: string) => void
  onCustomEndChange: (v: string) => void
  // Earliest order_finalized_at on record — null while still loading/unknown.
  earliestDate: string | null
}) {
  const today = new Date().toISOString().slice(0, 10)
  const tooEarly = period === 'custom' && !!earliestDate && customStart < earliestDate

  return (
    <div className="flex items-end gap-2 flex-wrap">
      <label className="flex flex-col gap-0.5">
        <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Period</span>
        <select value={period} onChange={(e) => onPeriodChange(e.target.value as DatePeriod)} className={fieldCls}>
          {PERIOD_ORDER.map((p) => <option key={p} value={p}>{PERIOD_LABELS[p]}</option>)}
        </select>
      </label>
      {period === 'custom' && (
        <>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Start</span>
            <input type="date" value={customStart} max={customEnd} min={earliestDate ?? undefined}
              onChange={(e) => onCustomStartChange(e.target.value)} className={fieldCls} />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">End</span>
            <input type="date" value={customEnd} min={customStart} max={today}
              onChange={(e) => onCustomEndChange(e.target.value)} className={fieldCls} />
          </label>
          {tooEarly && (
            <span className="text-[10px] font-mono text-[#E67E22] self-center pb-1.5">No data before {earliestDate}</span>
          )}
        </>
      )}
    </div>
  )
}
