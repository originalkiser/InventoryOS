// OTIF (On Time In Full) trend — one small chart per segment, matching the
// source MMR workbook's own 4 separate sheets (Corp/Fz x Bulk/Package).
import { useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card, CardBody, Select, SbLoader } from '@/components/ui'
import { useReladyneOtifStats } from '../useMmrData'
import { MONTHS_BACK_OPTIONS, trailingPeriods, periodLabel, pct1 } from '../mmrShared'
import type { OtifRow } from '../mmrParsers'

const SEGMENTS: { key: OtifRow['segment']; label: string }[] = [
  { key: 'corp_bulk', label: 'Corporate — Bulk' },
  { key: 'fz_bulk', label: 'Franchise — Bulk' },
  { key: 'corp_package', label: 'Corporate — Package' },
  { key: 'fz_package', label: 'Franchise — Package' },
]

export function OtifTab() {
  const { rows, loading } = useReladyneOtifStats()
  const [monthsBack, setMonthsBack] = useState<number | 'all'>(12)
  const periods = useMemo(() => trailingPeriods(rows.map((r) => r.period), monthsBack), [rows, monthsBack])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end gap-2">
        <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Show</span>
        <div className="w-36">
          <Select value={String(monthsBack)} onChange={(e) => setMonthsBack(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            options={MONTHS_BACK_OPTIONS} />
        </div>
      </div>

      {loading ? <div className="py-10 flex justify-center"><SbLoader size={28} /></div> : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {SEGMENTS.map((seg) => {
            const data = rows.filter((r) => r.segment === seg.key && periods.has(r.period))
              .sort((a, b) => a.period.localeCompare(b.period))
              .map((r) => ({ period: periodLabel(r.period), 'OTIF %': r.otif_pct, 'On Time %': r.on_time_pct, 'In Full %': r.in_full_pct }))
            return (
              <Card key={seg.key}><CardBody>
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2 block">{seg.label}</span>
                {data.length === 0 ? (
                  <p className="text-[11px] font-mono text-inky/40 py-8 text-center">No data uploaded yet.</p>
                ) : (
                  <div style={{ width: '100%', height: 220 }}>
                    <ResponsiveContainer>
                      <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#4F748933" />
                        <XAxis dataKey="period" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} domain={[0, 100]} />
                        <Tooltip formatter={(v: number) => pct1(v)} />
                        <Legend wrapperStyle={{ fontSize: 10 }} />
                        <Line type="monotone" dataKey="OTIF %" stroke="#002745" strokeWidth={2} dot={{ r: 3 }} />
                        <Line type="monotone" dataKey="On Time %" stroke="#4F7489" strokeWidth={1.5} dot={{ r: 2 }} />
                        <Line type="monotone" dataKey="In Full %" stroke="#E67E22" strokeWidth={1.5} dot={{ r: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardBody></Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
