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
// (get_droptop_*_daily_coverage, migrations 20260930h/20260930i) returns
// one row per day with the distinct set of location_ids that had real data
// that day plus a total row count — small and cheap regardless of how large
// the underlying table gets, since it never returns more rows than days
// requested.
//
// Every day in range gets its own row in the Daily Detail table (shops with
// data / total records / a relative bar), matching the shops-with-orders
// artifact this feature was modeled on — not just a flagged-gaps list,
// which read as an unexplained bag of shop names with no context. Clicking
// any row expands a per-shop breakdown for that exact day.
//
// Gap detection ("flag specific shops with zero data on a day everyone else
// has data", the user's own framing) still runs to flag ROWS worth a second
// look, via a two-stage check specifically so a shop closed every Sunday
// never gets flagged: (1) a day only enters gap-checking at all if its shop
// count is close to that weekday's own median across the visible range (a
// company-wide light day — a real Sunday, or a sync still catching up —
// fails this gate, so nothing on it gets flagged); (2) within a day that
// passes, an individual shop is flagged only if it usually has data on that
// same weekday (>=60% of the other same-weekday days in range) but is
// missing on this one.
import { useEffect, useMemo, useState } from 'react'
import { format, subDays } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useLocations } from '@/hooks/useLocations'
import { Card, CardHeader, CardBody, SbLoader } from '@/components/ui'

const fieldCls = 'bg-cream border border-navy/30 rounded px-2 py-1.5 text-xs font-mono text-navy focus:outline-none focus:border-sky'

interface DayCoverage { day: string; ids: Set<string>; totalRows: number }
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
function shortDate(day: string): string {
  const [, m, d] = day.split('-')
  return `${m}/${d}`
}

async function fetchDailyCoverage(rpc: string, start: string, end: string): Promise<DayCoverage[]> {
  const sb = supabase as any
  const { data, error } = await sb.rpc(rpc, { p_start: start, p_end: end })
  if (error) throw new Error(error.message)
  const byDay = new Map<string, { ids: Set<string>; totalRows: number }>(
    (data ?? []).map((r: { day: string; location_ids: string[] | null; total_rows: number | string }) =>
      [r.day, { ids: new Set(r.location_ids ?? []), totalRows: Number(r.total_rows) || 0 }]),
  )
  const all: DayCoverage[] = []
  let cursor = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  while (cursor <= endDate) {
    const key = cursor.toISOString().slice(0, 10)
    const row = byDay.get(key)
    all.push({ day: key, ids: row?.ids ?? new Set(), totalRows: row?.totalRows ?? 0 })
    cursor = new Date(cursor.getTime() + 86400_000)
  }
  return all
}

// See this file's own header comment for the two-stage reasoning.
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
  return gaps
}

// ── Chart: dated, clickable bars ───────────────────────────────────────────
function DailyBarChart({
  days, eligibleCount, color, selectedDay, onSelect,
}: {
  days: DayCoverage[]; eligibleCount: number; color: string; selectedDay: string | null; onSelect: (day: string) => void
}) {
  const W = 900, H = 160, PAD = { top: 6, bottom: 20, left: 4, right: 4 }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const n = Math.max(days.length, 1)
  const barW = Math.max(1, plotW / n - 1)
  const maxV = Math.max(eligibleCount, 1)
  // Weekly-ish ticks, same idea as the shops-with-orders artifact: every 7th
  // day plus the last one, so the axis always ends on the most recent date.
  const tickEvery = Math.max(1, Math.round(n / 10))
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32">
      {days.map((d, i) => {
        const x = PAD.left + (i / n) * plotW
        const h = (d.ids.size / maxV) * plotH
        const y = PAD.top + plotH - h
        const isSun = weekdayOf(d.day) === 0
        const isSelected = d.day === selectedDay
        return (
          <rect key={d.day} x={x} y={y} width={barW} height={Math.max(h, 1)}
            fill={isSelected ? '#C0392B' : isSun ? '#B7E0DE' : color}
            opacity={isSelected ? 1 : isSun ? 0.9 : 0.85}
            className="cursor-pointer"
            onClick={() => onSelect(d.day)}>
            <title>{d.day} ({weekdayLabel(d.day)}): {d.ids.size}/{eligibleCount} shops, {d.totalRows.toLocaleString()} records</title>
          </rect>
        )
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="rgba(0,39,69,0.15)" />
      {days.map((d, i) => (
        (i % tickEvery === 0 || i === n - 1) && (
          <text key={d.day} x={PAD.left + (i / n) * plotW} y={H - 4} fontSize="10.5" textAnchor="middle" fill="rgba(0,39,69,0.55)">
            {shortDate(d.day)}
          </text>
        )
      ))}
    </svg>
  )
}

// ── Per-day drill-down: which specific shops did/didn't have data ─────────
function DayDrilldown({
  day, dayCoverage, eligibleIds, labelOf, onClose,
}: {
  day: string; dayCoverage: DayCoverage; eligibleIds: string[]; labelOf: (id: string) => string; onClose: () => void
}) {
  const [showPresent, setShowPresent] = useState(false)
  const missing = eligibleIds.filter((id) => !dayCoverage.ids.has(id)).sort((a, b) => labelOf(a).localeCompare(labelOf(b), undefined, { numeric: true }))
  const present = eligibleIds.filter((id) => dayCoverage.ids.has(id)).sort((a, b) => labelOf(a).localeCompare(labelOf(b), undefined, { numeric: true }))

  return (
    <div className="rounded border border-navy/30 bg-navy/[0.02] p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-navy font-bold">
          {day} ({weekdayLabel(day)}) — {present.length}/{eligibleIds.length} shops have data, {dayCoverage.totalRows.toLocaleString()} record(s)
        </span>
        <button onClick={onClose} className="text-xs font-mono text-inky/60 hover:text-navy">✕ close</button>
      </div>
      {missing.length === 0 ? (
        <p className="text-[11px] font-mono text-[#2ECC71]">Every eligible shop has data this day.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-inky/60 uppercase tracking-wide">Missing ({missing.length})</span>
          <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
            {missing.map((id) => (
              <span key={id} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[#C0392B]/10 text-[#C0392B]">{labelOf(id)}</span>
            ))}
          </div>
        </div>
      )}
      <button onClick={() => setShowPresent((v) => !v)} className="text-[11px] font-mono text-inky/60 hover:text-navy text-left">
        {showPresent ? '▾' : '▸'} {present.length} shop(s) with data
      </button>
      {showPresent && (
        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-auto">
          {present.map((id) => (
            <span key={id} className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-[#2ECC71]/10 text-[#1E8449]">{labelOf(id)}</span>
          ))}
        </div>
      )}
    </div>
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
  const [selectedDay, setSelectedDay] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDays(null)
    setError(null)
    setSelectedDay(null)
    fetchDailyCoverage(config.rpc, start, end)
      .then((rows) => { if (!cancelled) setDays(rows) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load coverage') })
    return () => { cancelled = true }
  }, [config.rpc, start, end])

  const gapDays = useMemo(() => new Set((days ? computeGaps(days, eligibleIds) : []).map((g) => g.day)), [days, eligibleIds])
  const latest = days?.[days.length - 1]
  const nonSunDays = days?.filter((d) => weekdayOf(d.day) !== 0) ?? []
  const avgNonSunday = nonSunDays.length ? Math.round(nonSunDays.reduce((a, d) => a + d.ids.size, 0) / nonSunDays.length) : 0
  const maxTotalRows = Math.max(1, ...(days ?? []).map((d) => d.totalRows))

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
        <p className="text-[11px] font-mono text-inky/60">{config.description} Click a bar or a row below to see exactly which shops did/didn't have data that day.</p>
        {error && <p className="text-xs font-mono text-[#C0392B]">{error}</p>}
        {!days && !error ? <div className="py-6"><SbLoader /></div> : days && (
          <>
            <DailyBarChart days={days} eligibleCount={eligibleIds.length} color={config.color} selectedDay={selectedDay} onSelect={setSelectedDay} />
            <div className="flex items-center gap-3 text-[10px] font-mono text-inky/60">
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle" style={{ background: config.color, opacity: 0.85 }} />Weekday</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle bg-sky" />Sunday</span>
              <span><span className="inline-block w-2.5 h-2.5 rounded-sm mr-1 align-middle bg-[#C0392B]" />Selected</span>
              {gapDays.size > 0 && <span className="text-[#C0392B]">{gapDays.size} day(s) with a flagged shop gap</span>}
            </div>

            {selectedDay && (() => {
              const dc = days.find((d) => d.day === selectedDay)
              return dc ? (
                <DayDrilldown day={selectedDay} dayCoverage={dc} eligibleIds={eligibleIds} labelOf={labelOf} onClose={() => setSelectedDay(null)} />
              ) : null
            })()}

            <div className="overflow-auto max-h-72 rounded border border-navy/20">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-cream">
                  <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                    <th className="px-2 py-1.5 text-left">Date</th>
                    <th className="px-2 py-1.5 text-left">Day</th>
                    <th className="px-2 py-1.5 text-right">Shops w/ Data</th>
                    <th className="px-2 py-1.5 text-right">Total Records</th>
                    <th className="px-2 py-1.5 text-left w-32">Relative</th>
                  </tr>
                </thead>
                <tbody>
                  {days.map((d, i) => {
                    const isFlagged = gapDays.has(d.day)
                    const isSelected = d.day === selectedDay
                    const pct = Math.max(2, Math.round((d.totalRows / maxTotalRows) * 100))
                    return (
                      <tr key={d.day}
                        onClick={() => setSelectedDay(isSelected ? null : d.day)}
                        className={[
                          'cursor-pointer hover:bg-sky/10',
                          isSelected ? 'bg-sky/20' : i % 2 ? 'bg-navy/[0.02]' : '',
                          weekdayOf(d.day) === 0 ? 'text-inky/70' : '',
                        ].join(' ')}
                      >
                        <td className="px-2 py-1">{d.day}</td>
                        <td className="px-2 py-1">{weekdayLabel(d.day)}</td>
                        <td className={`px-2 py-1 text-right font-bold ${isFlagged ? 'text-[#C0392B]' : ''}`}>
                          {d.ids.size}/{eligibleIds.length}{isFlagged ? ' ⚠' : ''}
                        </td>
                        <td className="px-2 py-1 text-right text-inky/70">{d.totalRows.toLocaleString()}</td>
                        <td className="px-2 py-1">
                          <div className="bg-navy/10 rounded h-2 overflow-hidden w-28">
                            <div className="h-full rounded" style={{ width: `${pct}%`, background: config.color, opacity: 0.7 }} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
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

// ── Reused by the Backfill tab: "is this range already covered?" ──────────
// Exported so DataConnectionsTab's Historical Orders/Staff-Time-Clock
// Backfill cards can show a live evaluation as soon as the date range or
// shop scope changes, using the exact same coverage RPCs — answers "will
// this backfill just re-do work we already have" without needing a
// separate endpoint.
export function useCoverageEvaluation(rpc: string, start: string, end: string, targetIds: string[] | null) {
  const [state, setState] = useState<{ loading: boolean; coveredShopDays: number; totalShopDays: number } | null>(null)
  const targetKey = targetIds?.join(',') ?? ''

  useEffect(() => {
    if (!targetIds || !targetIds.length || !start || !end) { setState(null); return }
    let cancelled = false
    setState({ loading: true, coveredShopDays: 0, totalShopDays: 0 })
    fetchDailyCoverage(rpc, start, end)
      .then((days) => {
        if (cancelled) return
        const targetSet = new Set(targetIds)
        let covered = 0
        for (const d of days) {
          for (const id of d.ids) if (targetSet.has(id)) covered++
        }
        setState({ loading: false, coveredShopDays: covered, totalShopDays: days.length * targetIds.length })
      })
      .catch(() => { if (!cancelled) setState(null) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, start, end, targetKey])

  return state
}

export function CoverageEvaluationNote({
  rpc, start, end, targetIds,
}: { rpc: string; start: string; end: string; targetIds: string[] | null }) {
  const state = useCoverageEvaluation(rpc, start, end, targetIds)
  if (!targetIds || !targetIds.length) return null
  if (!state) return null
  if (state.loading) {
    return (
      <span className="flex items-center gap-1.5 text-[11px] font-mono text-inky/60">
        <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Evaluating existing data for {targetIds.length} shop{targetIds.length === 1 ? '' : 's'} over this range…
      </span>
    )
  }
  if (state.totalShopDays === 0) return null
  const pct = Math.round((state.coveredShopDays / state.totalShopDays) * 100)
  return (
    <span className="text-[11px] font-mono text-inky/60">
      Existing coverage for this range: <span className="font-bold text-navy">{state.coveredShopDays.toLocaleString()}/{state.totalShopDays.toLocaleString()}</span> shop-days
      already have data ({pct}%) — running this backfill will refresh those and fill in the rest.
    </span>
  )
}
