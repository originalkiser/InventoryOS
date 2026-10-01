// Volume Commitment vs Actual (from the MMR workbook's own embedded target
// table) plus a by-customer breakdown of real delivered gallons (derived
// live from reladyne_volume_data — see migration 20260930by's own header
// comment on why this isn't also stored as a separate pivot table).
import { useMemo, useState } from 'react'
import { ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card, CardBody, Select, SbLoader } from '@/components/ui'
import { useReladyneVolumeData, useReladyneVolumeCommitment } from '../useMmrData'
import { MONTHS_BACK_OPTIONS, trailingPeriods, num0, money } from '../mmrShared'

export function VolumeTab() {
  const commitment = useReladyneVolumeCommitment()
  const volume = useReladyneVolumeData()
  const [monthsBack, setMonthsBack] = useState<number | 'all'>(12)

  const periods = useMemo(() => trailingPeriods(commitment.rows.map((r) => r.period), monthsBack), [commitment.rows, monthsBack])
  const chartData = useMemo(
    () => commitment.rows.filter((r) => periods.has(r.period))
      .map((r) => ({ period: r.period, Commitment: r.volume_commitment_gal, Actual: r.volume_actual_gal, 'Attainment %': r.pct })),
    [commitment.rows, periods],
  )

  const byCustomer = useMemo(() => {
    const scoped = volume.rows.filter((r) => periods.size === 0 || periods.has(r.period))
    const m = new Map<string, { gallonsBilled: number; revenue: number }>()
    for (const r of scoped) {
      const key = r.customer_name ?? r.customer_no
      const cur = m.get(key) ?? { gallonsBilled: 0, revenue: 0 }
      cur.gallonsBilled += Number(r.gallons_billed ?? 0)
      cur.revenue += Number(r.revenue ?? 0)
      m.set(key, cur)
    }
    return [...m.entries()].map(([customer, v]) => ({ customer, ...v })).sort((a, b) => b.gallonsBilled - a.gallonsBilled).slice(0, 20)
  }, [volume.rows, periods])

  const loading = commitment.loading || volume.loading

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
        <>
          <Card><CardBody>
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2 block">Volume Commitment vs Actual (Gal)</span>
            <div style={{ width: '100%', height: 300 }}>
              <ResponsiveContainer>
                <ComposedChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#4F748933" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="gal" tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => num0(v)} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="gal" dataKey="Actual" fill="#B7E0DE" />
                  <Line yAxisId="gal" type="monotone" dataKey="Commitment" stroke="#E67E22" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </CardBody></Card>

          <Card><CardBody>
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60 mb-2 block">Top 20 Customers by Gallons Billed</span>
            <div className="max-h-96 overflow-auto rounded border border-navy/10">
              <table className="w-full text-[11px] font-mono">
                <thead className="sticky top-0 bg-cream">
                  <tr className="text-inky/60 uppercase border-b border-navy/15">
                    <th className="text-left px-2 py-1">Customer</th>
                    <th className="text-right px-2 py-1">Gallons Billed</th>
                    <th className="text-right px-2 py-1">Revenue</th>
                  </tr>
                </thead>
                <tbody>
                  {byCustomer.map((r) => (
                    <tr key={r.customer} className="border-b border-navy/5">
                      <td className="px-2 py-1 text-navy">{r.customer}</td>
                      <td className="px-2 py-1 text-right text-navy">{num0(r.gallonsBilled)}</td>
                      <td className="px-2 py-1 text-right text-navy">{money(r.revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardBody></Card>
        </>
      )}
    </div>
  )
}
