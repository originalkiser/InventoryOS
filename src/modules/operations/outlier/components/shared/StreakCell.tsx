import { Flame } from 'lucide-react'
import { useState } from 'react'
import { ReportEntry, Week, ColumnDef } from '../../types'
import { computeStreak, formatStreakDate } from '../../lib/streakCalc'
import SlideOver from './SlideOver'

interface Props {
  rowKey: string
  currentWeekId: string
  allEntries: ReportEntry[]
  allWeeks: Week[]
  columns: ColumnDef[]
}

export default function StreakCell({ rowKey, currentWeekId, allEntries, allWeeks, columns }: Props) {
  const [slideEntry, setSlideEntry] = useState<ReportEntry | null>(null)
  const [slideWeek, setSlideWeek] = useState<Week | null>(null)

  const result = computeStreak(rowKey, currentWeekId, allEntries, allWeeks)

  function openSlide(weekId: string) {
    const entry = allEntries.find(e => e.row_key === rowKey && e.week_id === weekId) ?? null
    const week = allWeeks.find(w => w.id === weekId) ?? null
    setSlideEntry(entry)
    setSlideWeek(week)
  }

  if (result.type === 'never') {
    return <span className="font-mono text-[12px] text-sb-cream/30">—</span>
  }

  if (result.type === 'streak' && result.lastWeekId) {
    return (
      <>
        <button
          onClick={() => openSlide(result.lastWeekId!)}
          className="inline-flex items-center gap-1 text-sb-red font-mono text-[12px] font-medium hover:brightness-110 transition"
        >
          <Flame size={12} className="shrink-0" />
          {result.count} {result.count === 1 ? 'Week' : 'Weeks'}
        </button>
        <SlideOver
          entry={slideEntry}
          week={slideWeek}
          columns={columns}
          onClose={() => { setSlideEntry(null); setSlideWeek(null) }}
        />
      </>
    )
  }

  if (result.type === 'last_seen' && result.lastWeekId) {
    return (
      <>
        <button
          onClick={() => openSlide(result.lastWeekId!)}
          className="font-mono text-[12px] text-sb-inky hover:text-sb-sky transition underline underline-offset-2"
        >
          {formatStreakDate(result.lastDate!)}
        </button>
        <SlideOver
          entry={slideEntry}
          week={slideWeek}
          columns={columns}
          onClose={() => { setSlideEntry(null); setSlideWeek(null) }}
        />
      </>
    )
  }

  return <span className="font-mono text-[12px] text-sb-cream/30">—</span>
}
