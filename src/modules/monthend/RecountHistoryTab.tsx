// Recounts Tracking — how many times each shop has had a month-end recount
// requested, going back before SB Net existed (via historical CSV import)
// and forward automatically (every row RecountsTab/RecountLogicTab already
// writes to inventory.recount_requests counts here too — this tab is a
// reporting surface over that same table, not a second source of truth).
import { useCallback, useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button, Card, CardHeader, CardBody, SbLoader } from '@/components/ui'
import type { Location } from '@/types'
import toast from 'react-hot-toast'

interface HistoryRow {
  location_id: string
  count_month: string // 'YYYY-MM-01'
}

// Paginated fetch — inventory.recount_requests grows unbounded over years of
// history, and an un-ranged select silently truncates at PostgREST's
// 1000-row cap (the exact bug just fixed twice this session in Location
// Lookup — not repeating it here).
async function fetchAllRows(factory: (from: number, to: number) => any): Promise<any[]> {
  const PAGE = 1000
  const out: any[] = []
  let from = 0
  for (;;) {
    const { data, error } = await factory(from, from + PAGE - 1)
    if (error) break
    const batch = data ?? []
    out.push(...batch)
    if (batch.length < PAGE) break
    from += PAGE
  }
  return out
}

// Permissive month-header parser — accepts "2024-01", "Jan-24", "January 2024",
// "1/2024", etc. Returns 'YYYY-MM-01' or null if unparseable.
function parseMonthHeader(raw: string): string | null {
  const s = raw.trim()
  let m = s.match(/^(\d{4})-(\d{1,2})$/)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-01`
  m = s.match(/^(\d{1,2})\/(\d{4})$/)
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}-01`
  const MONTHS: Record<string, string> = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
  }
  m = s.match(/^([A-Za-z]{3,})[\s-]?'?(\d{2,4})$/)
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()]
    if (mon) {
      const year = m[2].length === 2 ? `20${m[2]}` : m[2]
      return `${year}-${mon}-01`
    }
  }
  return null
}

function monthLabel(monthStr: string): string {
  const [y, mo] = monthStr.split('-')
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${names[Number(mo) - 1]} '${y.slice(2)}`
}

const TRUTHY = new Set(['1', 'x', 'yes', 'y', 'true'])

export function RecountHistoryTab() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const myName = profile?.full_name ?? 'Someone'

  const [locations, setLocations] = useState<Location[]>([])
  const [history, setHistory] = useState<HistoryRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortByTotal, setSortByTotal] = useState(true)

  const [pendingImport, setPendingImport] = useState<{
    matched: { location_id: string; location_name: string; count_month: string }[]
    unmatched: string[]
  } | null>(null)
  const [importing, setImporting] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const [locRes, historyRows] = await Promise.all([
      sb.schema('core').from('locations').select('id, name').eq('company_id', companyId).order('name'),
      fetchAllRows((from, to) =>
        sb.schema('inventory').from('recount_requests')
          .select('location_id, recount_fields')
          .eq('company_id', companyId)
          .not('location_id', 'is', null)
          .order('id').range(from, to)
      ),
    ])
    setLocations((locRes.data ?? []) as Location[])
    const rows: HistoryRow[] = historyRows
      .map((r: any) => ({ location_id: r.location_id, count_month: r.recount_fields?.count_month }))
      .filter((r: HistoryRow) => !!r.count_month)
    setHistory(rows)
    setLoading(false)
  }, [companyId])

  useEffect(() => { load() }, [load])

  // location_id -> label, for matching CSV location names case/trim-insensitively.
  const locationByName = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of locations) m.set(l.name.trim().toLowerCase(), l.id)
    return m
  }, [locations])
  const locationLabel = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of locations) m.set(l.id, l.name)
    return m
  }, [locations])

  // location_id -> month -> count, and the sorted list of months actually present.
  const { matrix, months, totals } = useMemo(() => {
    const matrix = new Map<string, Map<string, number>>()
    const monthSet = new Set<string>()
    for (const r of history ?? []) {
      monthSet.add(r.count_month)
      if (!matrix.has(r.location_id)) matrix.set(r.location_id, new Map())
      const byMonth = matrix.get(r.location_id)!
      byMonth.set(r.count_month, (byMonth.get(r.count_month) ?? 0) + 1)
    }
    const months = [...monthSet].sort()
    const totals = new Map<string, number>()
    for (const [locId, byMonth] of matrix) totals.set(locId, [...byMonth.values()].reduce((a, b) => a + b, 0))
    return { matrix, months, totals }
  }, [history])

  const rowLocationIds = useMemo(() => {
    const ids = [...matrix.keys()]
    return sortByTotal
      ? ids.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
      : ids.sort((a, b) => (locationLabel.get(a) ?? '').localeCompare(locationLabel.get(b) ?? ''))
  }, [matrix, totals, sortByTotal, locationLabel])

  function handleFile(file: File) {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const fields = results.meta.fields ?? []
        if (fields.length < 2) { toast.error('File needs a location column plus one column per month'); return }
        const [locationCol, ...monthCols] = fields
        const monthByCol = new Map<string, string>()
        for (const col of monthCols) {
          const parsed = parseMonthHeader(col)
          if (parsed) monthByCol.set(col, parsed)
        }
        if (monthByCol.size === 0) {
          toast.error('No month columns could be parsed — expected headers like "2024-01" or "Jan 2024"')
          return
        }

        const matched: { location_id: string; location_name: string; count_month: string }[] = []
        const unmatchedSet = new Set<string>()
        for (const row of results.data) {
          const rawName = (row[locationCol] ?? '').trim()
          if (!rawName) continue
          const locId = locationByName.get(rawName.toLowerCase())
          for (const [col, month] of monthByCol) {
            const cell = (row[col] ?? '').trim().toLowerCase()
            if (!TRUTHY.has(cell)) continue
            if (!locId) { unmatchedSet.add(rawName); continue }
            matched.push({ location_id: locId, location_name: rawName, count_month: month })
          }
        }
        setPendingImport({ matched, unmatched: [...unmatchedSet] })
      },
      error: (err) => toast.error(`Failed to read file: ${err.message}`),
    })
  }

  async function confirmImport() {
    if (!pendingImport || !companyId) return
    setImporting(true)
    const sb = supabase as any

    // Skip cells that already have a recount_requests row for that
    // (location, month) — re-uploading the same file (or an updated one)
    // shouldn't create duplicates.
    const existingKey = new Set((history ?? []).map((h) => `${h.location_id}|${h.count_month}`))
    const toInsert = pendingImport.matched
      .filter((m) => !existingKey.has(`${m.location_id}|${m.count_month}`))
      .map((m) => ({
        company_id: companyId,
        location_id: m.location_id,
        recount_type: null,
        requested_products: [],
        request_date: null,
        completed_flags: [true],
        completed_dates: [null],
        recount_status: 'complete' as const,
        recount_fields: {
          count_month: m.count_month,
          source: 'historical_import',
          imported_at: new Date().toISOString(),
          imported_by: myName,
        },
      }))

    if (toInsert.length === 0) {
      toast('Nothing new to import — every cell already has a matching record', { icon: 'ℹ️' })
      setImporting(false)
      setPendingImport(null)
      return
    }

    const BATCH = 500
    let inserted = 0
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const { error } = await sb.schema('inventory').from('recount_requests').insert(toInsert.slice(i, i + BATCH))
      if (error) { toast.error(`Import failed partway: ${error.message}`); break }
      inserted += toInsert.slice(i, i + BATCH).length
    }
    setImporting(false)
    setPendingImport(null)
    if (inserted > 0) { toast.success(`Imported ${inserted} historical recount record${inserted === 1 ? '' : 's'}`); load() }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader><span className="text-xs font-mono text-navy uppercase tracking-wide">Import Historical Recount History</span></CardHeader>
        <CardBody className="flex flex-col gap-3">
          <p className="text-[11px] font-mono text-inky/60">
            CSV with a location column, then one column per month (headers like <code>2024-01</code> or <code>Jan 2024</code>).
            Mark a cell <code>1</code> where that shop had a recount that month, leave it blank otherwise.
          </p>
          <input
            type="file" accept=".csv"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = '' }}
            className="text-xs font-mono text-inky file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-navy/30 file:bg-cream file:text-navy file:text-xs file:font-mono hover:file:border-navy/60"
          />

          {pendingImport && (
            <div className="flex flex-col gap-2 border border-sky/40 rounded p-3 bg-sky/5">
              <p className="text-xs font-mono text-navy">
                <span className="font-bold text-navy">{pendingImport.matched.length}</span> cell{pendingImport.matched.length === 1 ? '' : 's'} matched to a location and ready to import.
              </p>
              {pendingImport.unmatched.length > 0 && (
                <p className="text-[11px] font-mono text-[#C0392B]">
                  {pendingImport.unmatched.length} location name{pendingImport.unmatched.length === 1 ? '' : 's'} couldn't be matched and will be skipped: {pendingImport.unmatched.join(', ')}
                </p>
              )}
              <div className="flex gap-2">
                <Button size="sm" loading={importing} onClick={confirmImport} disabled={pendingImport.matched.length === 0}>
                  Confirm Import
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingImport(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <span className="text-xs font-mono text-navy uppercase tracking-wide">Recount Frequency</span>
          <button
            onClick={() => setSortByTotal((v) => !v)}
            className="text-[10px] font-mono text-inky/60 hover:text-navy underline"
          >
            Sort: {sortByTotal ? 'Most recounts first' : 'A–Z'}
          </button>
        </CardHeader>
        <CardBody>
          {loading ? (
            <div className="py-8"><SbLoader /></div>
          ) : months.length === 0 ? (
            <p className="text-xs font-mono text-inky/60">No recount history yet — import historical data above, or recounts logged going forward will show up here automatically.</p>
          ) : (
            <div className="overflow-x-auto rounded border border-navy/30">
              <table className="text-xs font-mono w-full">
                <thead className="sticky top-0 bg-cream">
                  <tr className="border-b border-navy/30 text-inky uppercase tracking-wide">
                    <th className="px-3 py-2 text-left sticky left-0 bg-cream">Location</th>
                    <th className="px-3 py-2 text-right font-bold">Total</th>
                    {months.map((m) => <th key={m} className="px-2 py-2 text-right whitespace-nowrap">{monthLabel(m)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rowLocationIds.map((locId) => {
                    const byMonth = matrix.get(locId)!
                    const total = totals.get(locId) ?? 0
                    return (
                      <tr key={locId} className="border-b border-navy/15">
                        <td className="px-3 py-1.5 text-navy sticky left-0 bg-cream whitespace-nowrap">{locationLabel.get(locId) ?? locId}</td>
                        <td className="px-3 py-1.5 text-right font-bold text-navy">{total}</td>
                        {months.map((m) => {
                          const c = byMonth.get(m) ?? 0
                          return (
                            <td key={m} className={`px-2 py-1.5 text-right ${c > 0 ? 'text-[#C0392B] font-semibold' : 'text-inky/25'}`}>
                              {c > 0 ? c : '—'}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
