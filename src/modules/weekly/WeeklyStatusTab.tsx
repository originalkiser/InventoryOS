// Weekly count status for one Sunday–Saturday week:
//   Complete      — a Weekly or Monthly count was completed that week.
//   Review        — no Weekly/Monthly count, but some other kind of count was (orange, grouped here so they can be reviewed
//                   quickly: count date, type, number of adjustments, dollars adjusted).
//   Not submitted — no count of any kind; a plain Shop / Area Manager list, sorted by area manager, to copy and paste.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { Button } from '@/components/ui'
import { WeeklyBulkUpload } from './WeeklyBulkUpload'
import type { Location } from '@/types'
import toast from 'react-hot-toast'

interface CountRow {
  location_id: string | null
  count_date: string
  count_type: string | null
  total_adjustments: number | null
  adjustment_value: number | null
  abs_adjustment_value: number | null
}

/** Counts that satisfy the week: exactly "Weekly" or "Monthly" ("Bi-Weekly" and the like do not). */
export const isCompletingType = (t: string | null | undefined) => ['weekly', 'monthly'].includes((t ?? '').trim().toLowerCase())

const money = (v: number | null | undefined) =>
  v == null ? '—' : Number(v).toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
const amOf = (l: Location) => String((l.metadata as any)?.area_manager ?? '').trim()
const cmpShop = (a: Location, b: Location) => (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true })

export function WeeklyStatusTab({ effectiveLocations, startISO, endExclusiveISO, label }: {
  effectiveLocations: Location[]
  startISO: string
  endExclusiveISO: string
  label: string
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [rows, setRows] = useState<CountRow[]>([])
  const [loading, setLoading] = useState(true)
  const [includeCity, setIncludeCity] = useState(false)
  const [showComplete, setShowComplete] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const sel = 'location_id, count_date, count_type, total_adjustments, adjustment_value, abs_adjustment_value'
    // Weekly/other counts live in weekly_counts; monthly counts in counts — either one can complete the week.
    const [w, m] = await Promise.all([
      sb.schema('inventory').from('weekly_counts').select(sel).eq('company_id', companyId).gte('count_date', startISO).lt('count_date', endExclusiveISO),
      sb.schema('inventory').from('counts').select(sel).eq('company_id', companyId).gte('count_date', startISO).lt('count_date', endExclusiveISO),
    ])
    setRows([...((w.data ?? []) as CountRow[]), ...((m.data ?? []) as CountRow[])])
    setLoading(false)
  }, [companyId, startISO, endExclusiveISO])
  useEffect(() => { void load() }, [load])

  const { complete, review, missing } = useMemo(() => {
    const byLoc = new Map<string, CountRow[]>()
    for (const r of rows) if (r.location_id) { const a = byLoc.get(r.location_id); if (a) a.push(r); else byLoc.set(r.location_id, [r]) }
    const complete: Location[] = [], review: { loc: Location; counts: CountRow[] }[] = [], missing: Location[] = []
    for (const l of effectiveLocations) {
      const cs = byLoc.get(l.id) ?? []
      if (cs.some((c) => isCompletingType(c.count_type))) complete.push(l)
      else if (cs.length > 0) review.push({ loc: l, counts: cs.sort((a, b) => a.count_date.localeCompare(b.count_date)) })
      else missing.push(l)
    }
    review.sort((a, b) => cmpShop(a.loc, b.loc))
    // Not submitted: sorted by area manager (blank last), then shop number.
    missing.sort((a, b) => {
      const x = amOf(a), y = amOf(b)
      if (x !== y) return !x ? 1 : !y ? -1 : x.localeCompare(y)
      return cmpShop(a, b)
    })
    return { complete: complete.sort(cmpShop), review, missing }
  }, [rows, effectiveLocations])

  const shopText = (l: Location) => (includeCity && l.shop_city ? `${l.name}-${l.shop_city}` : String(l.name))
  // Plain tab-separated values — the header shows the count, as in the sheet it gets pasted into.
  const tsv = useMemo(
    () => [`Shop (${missing.length} shops)\tArea Manager`, ...missing.map((l) => `${shopText(l)}\t${amOf(l)}`)].join('\n'),
    [missing, includeCity], // eslint-disable-line react-hooks/exhaustive-deps
  )
  async function copy() {
    try { await navigator.clipboard.writeText(tsv); toast.success(`Copied ${missing.length} shops`) }
    catch { toast.error('Could not copy — select the table text instead') }
  }

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
        <span className="rounded px-2 py-1 bg-[#2ECC71]/15 text-[#2ECC71] border border-[#2ECC71]/40">{complete.length} complete</span>
        <span className="rounded px-2 py-1 bg-[#E67E22]/15 text-[#E67E22] border border-[#E67E22]/40">{review.length} to review</span>
        <span className="rounded px-2 py-1 bg-[#C0392B]/15 text-[#C0392B] border border-[#C0392B]/40">{missing.length} not submitted</span>
        <span className="text-navy/75">{label} · Sunday–Saturday · a Weekly or Monthly count completes the week</span>
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => setUploadOpen((v) => !v)}>{uploadOpen ? 'Hide upload' : 'Upload counts'}</Button>
      </div>

      {uploadOpen && <WeeklyBulkUpload companyId={companyId} onImported={load} />}

      {loading ? <p className="text-xs font-mono text-navy/75 py-6">Loading…</p> : (
        <>
          {/* Orange: some other kind of count happened — review before treating as complete. */}
          <section className="rounded border border-[#E67E22]/50 bg-[#E67E22]/[0.07]">
            <h3 className="px-3 py-2 text-xs font-mono uppercase tracking-wide text-[#E67E22] font-bold">
              Review — counted, but not a Weekly or Monthly count ({review.length})
            </h3>
            {review.length === 0 ? <p className="px-3 pb-3 text-xs font-mono text-navy/75">None this week.</p> : (
              <div className="overflow-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-left text-navy/75 uppercase tracking-wide">
                      <th className="px-3 py-1.5">Shop</th><th className="px-3 py-1.5">Count date</th><th className="px-3 py-1.5">Type</th>
                      <th className="px-3 py-1.5 text-right">Adjustments</th><th className="px-3 py-1.5 text-right">$ adjusted</th>
                    </tr>
                  </thead>
                  <tbody>
                    {review.flatMap(({ loc, counts }) => counts.map((c, i) => (
                      <tr key={`${loc.id}-${i}`} className="border-t border-[#E67E22]/25">
                        <td className="px-3 py-1 text-navy">{i === 0 ? `${loc.name}${loc.shop_city ? ` — ${loc.shop_city}` : ''}` : ''}</td>
                        <td className="px-3 py-1 text-navy">{format(new Date(c.count_date), 'MMM d, yyyy')}</td>
                        <td className="px-3 py-1 text-navy">{c.count_type ?? '—'}</td>
                        <td className="px-3 py-1 text-right text-navy">{c.total_adjustments ?? '—'}</td>
                        <td className="px-3 py-1 text-right text-navy">{money(c.adjustment_value)}</td>
                      </tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Plain values, built to be copied straight into the follow-up sheet. */}
          <section className="rounded border border-navy/25">
            <div className="flex items-center justify-between gap-2 flex-wrap px-3 py-2 border-b border-navy/15">
              <h3 className="text-xs font-mono uppercase tracking-wide text-navy font-bold">Not submitted ({missing.length})</h3>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-[11px] font-mono text-navy cursor-pointer">
                  <input type="checkbox" className="accent-inky" checked={includeCity} onChange={(e) => setIncludeCity(e.target.checked)} />
                  Include shop name
                </label>
                <Button size="sm" onClick={() => void copy()} disabled={missing.length === 0}>Copy list</Button>
              </div>
            </div>
            <div className="overflow-auto max-h-[28rem]">
              <table className="w-full text-xs font-mono">
                <thead className="sticky top-0 bg-cream dark:bg-[#0A1826]">
                  <tr className="text-left text-navy font-bold">
                    <th className="px-3 py-1.5">Shop ({missing.length} shops)</th><th className="px-3 py-1.5">Area Manager</th>
                  </tr>
                </thead>
                <tbody>
                  {missing.map((l) => (
                    <tr key={l.id} className="border-t border-navy/10">
                      <td className="px-3 py-1 text-navy">{shopText(l)}</td>
                      <td className="px-3 py-1 text-navy">{amOf(l)}</td>
                    </tr>
                  ))}
                  {missing.length === 0 && <tr><td colSpan={2} className="px-3 py-3 text-navy/75">Every shop has a count this week.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded border border-navy/25">
            <button type="button" onClick={() => setShowComplete((v) => !v)} className="w-full text-left px-3 py-2 text-xs font-mono uppercase tracking-wide text-navy font-bold">
              {showComplete ? '▾' : '▸'} Complete ({complete.length})
            </button>
            {showComplete && (
              <p className="px-3 pb-3 text-xs font-mono text-navy/75 leading-relaxed">{complete.map((l) => l.name).join(', ') || 'None yet.'}</p>
            )}
          </section>
        </>
      )}
    </div>
  )
}
