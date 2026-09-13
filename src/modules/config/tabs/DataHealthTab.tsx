// Data Connections -> Data Health: day-by-day "which shops actually have
// data" coverage for the Droptop connections that are genuine per-location
// daily feeds (Orders, Staff Time Clock, Usage, Purchase Orders), plus a
// month-completeness card for On Hand (a monthly snapshot, not a daily
// feed — see get_droptop_on_hand_month_coverage's own migration comment).
//
// Built after a real incident (2026-09-13) where droptop_orders/
// droptop_time_clock silently only synced 60 of 279 locations a day for
// weeks — this page exists so that kind of gap is visible without having to
// hand-write a SQL query every time. Each daily-coverage RPC
// (get_droptop_*_daily_coverage, migration
// 20260930h_data_health_coverage_rpcs.sql) returns one row per day with the
// distinct set of location_ids that had real data that day — small and
// cheap regardless of how large the underlying table gets, since it never
// returns more rows than days requested.
//
// Gap detection ("flag specific shops with zero data on a day everyone else
// has data", the user's own framing): a day only enters gap-checking at all
// if its shop count is close to that weekday's own median (so a
// company-wide light day — most shops closed, like a real Sunday, or a
// still-in-progress partial sync — never gets treated as "normal" and
// doesn't spam gaps for every shop). Within a day that DOES look normal for
// its weekday, an individual shop is flagged only if it usually has data on
// that same weekday (>=60% of the other same-weekday days in range) but is
// missing on this one — this is what keeps a shop that's legitimately
// closed every Sunday from ever being flagged, while still catching one
// that's normally open Tuesdays but silently missed a specific Tuesday.
import { useEffect, useMemo, useState } from 'react'
import { format, subDays } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { Card, CardHeader, CardBody, SbLoader } from '@/components/ui'

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

interface DayCoverage { day: string; ids: Set<string> }
interface Gap { day: string; locationId: string }

interface DailyConnectionConfig {
  key: string
  label: string
  rpc: string
  color: string
  description: string
}

const DAILY_CONNECTIONS: DailyConnectionConfig[] = [
  {
    key: 'orders', label: 'Droptop — Orders', rpc: 'get_droptop_orders_daily_coverage', color: '#002745',
    description: 'Shops with at least one Finalized order that day.',
  },
  {
    key: 'time_clock', label: 'Droptop — Staff Time Clock', rpc: 'get_droptop_time_clock_daily_coverage', color: '#4F7489',
    description: 'Shops with at least one clock-in that day.',
  },
  {
    key: 'usage', label: 'Droptop — Usage', rpc: 'get_droptop_usage_daily_coverage', color: '#0E7C86',
    description: 'Shops with a sales/adjustment ledger entry that day.',
  },
  {
    key: 'purchase_orders', label: 'Droptop — Purchase Orders', rpc: 'get_droptop_po_daily_coverage', color: '#8A6D3B',
    description: 'Shops with a purchase order created that day (naturally sparser than the others — POs aren\'t a daily-per-shop event, so light counts here are normal).',
  },
]

function weekdayOf(day: string): number {
  return new Date(`${day}T12:00:00Z`).getUTCDay()
}
function weekdayLabel(day: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weekdayOf(day)]
}

// See this file's own header comment for the two-stage reasoning
// (day-level "does this weekday look normal" gate, then per-shop history).
function computeGaps(days: DayCoverage[], eligibleIds: string[]): Gap[] {
  const byWeekday = new Map<number, number[]>()
  days.forEach((d, i) => {
    const wd = weekdayOf(d.day)
    if (!byWeekday.has(wd)) byWeekday.set(wd, [])
    byWeekday.get(wd)!.push(i)
  })

  const gaps: Gap[] = []
  for (const idxs of byWeekday.values()) {
    if (idxs.length < 3) continue // not enough same-weekday history yet to judge
    const counts = idxs.map((i) => days[i].ids.size).sort((a, b) => a - b)
    const median = counts[Math.floor(counts.length / 2)]
    if (median === 0) continue
    for (const i of idxs) {
      const d = days[i]
      if (d.ids.size < median * 0.7) continue // this whole day looks light for its weekday — don't spam every shop
      const otherIdxs = idxs.filter((j) => j !== i)
      if (!otherIdxs.length) continue
      for (const locId of eligibleIds) {
        if (d.ids.has(locId)) continue
        const presentCount = otherIdxs.filter((j) => days[j].ids.has(locId)).length
        if (presentCount / otherIdxs.length >= 0.6) gaps.push({ day: d.day, locationId: locId })
      }
    }
  }
  return gaps.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0))
}

function DailyBarChart({ days, eligibleCount, color }: { days: DayCoverage[]; eligibleCount: number; color: string }) {
  const W = 900, H = 140, PAD = { top: 6, bottom: 18, left: 4, right: 4 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const n = Math.max(days.length, 1)
  const barW = Math.max(1, plotW / n - 1)
  const maxV = Math.max(eligibleCount, 1)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
      {days.map((d, i) => {
        const x = PAD.left + (i / n) * plotW
        const h = (d.ids.size / maxV) * plotH
        const y = PAD.top + plotH - h
        const isSun = weekdayOf(d.day) === 0
        return (
          <rect key={d.day} x={x} y={y} width={barW} height={Math.max(h, 1)}
            fill={isSun ? '#B7E0DE' : color} opacity={isSun ? 0.9 : 0.85}>
            <title>{d.day} ({weekdayLabel(d.day)}): {d.ids.size} shops</title>
          </rect>
        )
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="rgba(0,39,69,0.15)" />
    </svg>
  )
}

function DailyCoverageCard({
  config, start, end, eligibleIds, labelOf,
}: {
  config: DailyConnectionConfig
  start: string
  end: string
  eligibleIds: string[]
  labelOf: (id: string) => string
}) {
  const [days, setDays] = useState<DayCoverage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDays(null)
    setError(null)
    const sb = supabase as any
    sb.rpc(config.rpc, { p_start: start, p_end: end }).then(({ data, error: rpcErr }: any) => {
      if (cancelled) return
      if (rpcErr) { setError(rpcErr.message); return }
      const byDay = new Map<string, Set<string>>((data ?? []).map((r: { day: string; location_ids: string[] | null }) => [r.day, new Set(r.location_ids ?? [])]))
      const all: DayCoverage[] = []
      let cursor = new Date(`${start}T00:00:00Z`)
      const endDate = new Date(`${end}T00:00:00Z`)
      while (cursor <= endDate) {
        const key = cursor.toISOString().slice(0, 10)
        all.push({ day: key, ids: byDay.get(key) ?? new Set() })
        cursor = new Date(cursor.getTime() + 86400_000)
      }
      setDays(all)
    })
    return () => { cancelled = true }
  }, [config.rpc, start, end])

  const gaps = useMemo(() => (days ? computeGaps(days, eligibleIds) : []), [days, eligibleIds])
  const latest = days?.[days.length - 1]
  const avgNonSunday = days?.length
    ? Math.round(
        days.filter((d) => weekdayOf(d.day) !== 0).reduce((a, d) => a + d.ids.size, 0)
        / Math.max(1, days.filter((d) => weekdayOf(d.day) !== 0).length),
      )
    : 0

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">{config.label}</span>
        {days && (
          <span className="text-[10px] font-mono text-inky/60">
            avg {avgNonSunday}/{eligibleIds.length} shops (non-Sun) · latest day {latest?.ids.size ?? 0}
          </span>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">{config.description}</p>
        {error && <p className="text-xs font-mono text-[#C0392B]">{error}</p>}
        {!days && !error ? <div className="py-6"><SbLoader /></div> : days && (
          <>
            <DailyBarChart days={days} eligibleCount={eligibleIds.length} color={config.color} />
            <div className="flex items-center gap-3 text-[10px] font-mono text-inky/60">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: config.color, opacity: 0.85 }} />Weekday</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle bg-sky" />Sunday</span>
            </div>
            {gaps.length === 0 ? (
              <p className="text-[11px] font-mono text-[#2ECC71]">No individual-shop gaps detected in this range.</p>
            ) : (
              <div className="overflow-auto max-h-56 rounded border border-navy/20">
                <table className="w-full text-xs font-mono">
                  <thead className="sticky top-0 bg-cream">
                    <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                      <th className="px-2 py-1.5 text-left">Date</th>
                      <th className="px-2 py-1.5 text-left">Day</th>
                      <th className="px-2 py-1.5 text-left">Shop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g, i) => (
                      <tr key={`${g.day}-${g.locationId}`} className={i % 2 ? 'bg-[#C0392B]/[0.03]' : ''}>
                        <td className="px-2 py-1">{g.day}</td>
                        <td className="px-2 py-1">{weekdayLabel(g.day)}</td>
                        <td className="px-2 py-1 text-[#C0392B] font-bold">{labelOf(g.locationId)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  )
}

// On Hand is a monthly snapshot (inventory.count_products, replaced whole
// per location per count_month), not a daily feed — so "coverage" here is
// just "does this shop have a row for the tracked month at all", not a
// day-by-day chart. See get_droptop_on_hand_month_coverage's own comment.
function OnHandCoverageCard({ eligibleIds, labelOf }: { eligibleIds: string[]; labelOf: (id: string) => string }) {
  const [month, setMonth] = useState(() => format(new Date(), 'yyyy-MM-01'))
  const [covered, setCovered] = useState<Set<string> | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCovered(null)
    setError(null)
    const sb = supabase as any
    sb.rpc('get_droptop_on_hand_month_coverage', { p_month: month }).then(({ data, error: rpcErr }: any) => {
      if (cancelled) return
      if (rpcErr) { setError(rpcErr.message); return }
      setCovered(new Set((data ?? []) as string[]))
    })
    return () => { cancelled = true }
  }, [month])

  const missing = covered ? eligibleIds.filter((id) => !covered.has(id)) : []

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">Droptop — On Hand</span>
        {covered && (
          <span className="text-[10px] font-mono text-inky/60">{eligibleIds.length - missing.length}/{eligibleIds.length} shops covered</span>
        )}
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-[11px] font-mono text-inky/60">
          Snapshot data, not a daily feed — a shop either has this month's on-hand counts or doesn't, there's no
          per-day history to chart.
        </p>
        <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} className={`${fieldCls} w-40`} />
        {error && <p className="text-xs font-mono text-[#C0392B]">{error}</p>}
        {!covered && !error ? <div className="py-6"><SbLoader /></div> : covered && (
          missing.length === 0 ? (
            <p className="text-[11px] font-mono text-[#2ECC71]">Every eligible shop has an on-hand snapshot for {month.slice(0, 7)}.</p>
          ) : (
            <div className="overflow-auto max-h-56 rounded border border-navy/20">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-cream">
                  <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                    <th className="px-2 py-1.5 text-left">Shop missing {month.slice(0, 7)}</th>
                  </tr>
                </thead>
                <tbody>
                  {missing.map((id, i) => (
                    <tr key={id} className={i % 2 ? 'bg-[#C0392B]/[0.03]' : ''}>
                      <td className="px-2 py-1 text-[#C0392B] font-bold">{labelOf(id)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </CardBody>
    </Card>
  )
}

export function DataHealthTab({ companyId }: { companyId: string | null }) {
  const loc = useLocations('other')
  const [start, setStart] = useState(() => format(subDays(new Date(), 42), 'yyyy-MM-dd'))
  const [end, setEnd] = useState(() => format(subDays(new Date(), 1), 'yyyy-MM-dd'))

  const eligibleIds = useMemo(
    () => loc.locations.filter((l) => l.droptop_operation_id).map((l) => l.id),
    [loc.locations],
  )

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-sm font-bold text-navy uppercase tracking-wide">Data Health</h3>
          <p className="text-xs text-inky mt-0.5">
            Distinct shops with real data per day, per connection — so a silent gap (a schedule quietly only covering
            part of the company, or one shop failing every run) shows up as a dip or a flagged row instead of going
            unnoticed. {eligibleIds.length} shops have a Droptop Operation ID configured.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Start</span>
            <input type="date" value={start} max={end} onChange={(e) => e.target.value && setStart(e.target.value)} className={fieldCls} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">End</span>
            <input type="date" value={end} min={start} onChange={(e) => e.target.value && setEnd(e.target.value)} className={fieldCls} />
          </div>
        </div>
      </div>

      {DAILY_CONNECTIONS.map((config) => (
        <DailyCoverageCard key={config.key} config={config} start={start} end={end} eligibleIds={eligibleIds} labelOf={loc.labelOf} />
      ))}

      <OnHandCoverageCard eligibleIds={eligibleIds} labelOf={loc.labelOf} />
    </div>
  )
}
