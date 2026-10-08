// The period filter shared by the Droptop Orders-based reports: a trigger that opens the SB date range picker (cream ticket / night ticket, see
// DateRangePicker.tsx) with the named periods as quick ranges and a calendar for anything custom. Props are unchanged from the old
// dropdown + native date inputs, so every report using it picks the new picker up as-is.
import { useMemo } from 'react'
import { PERIOD_LABELS, PERIOD_ORDER, computeRange, formatPeriodOptionLabel, type DatePeriod } from '@/lib/datePeriods'
import { DateRangePicker, formatRangeEnd, localTodayKey, type RangePreset } from './DateRangePicker'

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
  const tooEarly = period === 'custom' && !!earliestDate && customStart < earliestDate

  const presets = useMemo<RangePreset[]>(
    () => PERIOD_ORDER.filter((p) => p !== 'custom').map((p) => ({ key: p, label: PERIOD_LABELS[p], range: () => computeRange(p) })),
    [],
  )
  const range = period === 'custom' ? { start: customStart, end: customEnd } : computeRange(period)
  const triggerText = period === 'custom' ? `${formatRangeEnd(customStart)} – ${formatRangeEnd(customEnd)}` : formatPeriodOptionLabel(period)

  return (
    <div className="flex items-end gap-2 flex-wrap">
      <DateRangePicker
        label="Period"
        triggerText={triggerText}
        start={range.start}
        end={range.end}
        selectedPreset={period === 'custom' ? null : period}
        presets={presets}
        maxDate={localTodayKey()}
        title="Report period"
        sub="SB Net"
        onApply={(s, e, preset) => {
          if (preset) { onPeriodChange(preset as DatePeriod); return }
          onCustomStartChange(s)
          onCustomEndChange(e)
          onPeriodChange('custom')
        }}
      />
      {tooEarly && (
        <span className="text-[10px] font-mono text-[#E67E22] self-center pb-1.5">No data before {earliestDate}</span>
      )}
    </div>
  )
}
