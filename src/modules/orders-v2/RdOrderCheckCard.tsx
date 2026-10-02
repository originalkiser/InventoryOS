// "Did yesterday's RelaDyne order make it?" — compares our own order lines for
// a date (default: previous business day) against the Open Sales Order report
// uploaded this morning, and lists anything that's NOT on it. From there one
// click builds a new draft with just those lines for a fresh export. Logic
// lives in rdOrderCheck.ts.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import toast from 'react-hot-toast'
import { Button } from '@/components/ui'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useVendors } from './useLookups'
import { isReladyne } from './useOrdersV2'
import { loadOrderCheck, createResendDraft, previousBusinessDay, type OrderCheckResult } from './rdOrderCheck'
import { dShort, dTime, num } from './shared'

const todayIso = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function RdOrderCheckCard({ refreshKey = 0 }: { refreshKey?: number }) {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const loc = useLocations()
  const vendors = useVendors()
  const [date, setDate] = useState(() => previousBusinessDay(todayIso()))
  const [result, setResult] = useState<OrderCheckResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [showAll, setShowAll] = useState(false)

  // Same shop-number rule Export uses for PO numbers (digits out of the
  // location's name) so the PO numbers rebuilt here match the ones sent.
  const shopNumberOf = useMemo(() => {
    const byId = new Map(loc.locations.map((l) => [l.id, (l.name || '').match(/\d+/)?.[0] ?? (l.name || '')]))
    return (id: string | null) => (id ? byId.get(id) ?? '' : '')
  }, [loc.locations])

  const rdVendorId = useMemo(() => vendors.vendors.find((v) => isReladyne(v.name))?.id ?? null, [vendors.vendors])

  const run = useCallback(async () => {
    if (!profile?.company_id || loc.loading) return
    setLoading(true)
    setError(null)
    try {
      setResult(await loadOrderCheck(profile.company_id, date, shopNumberOf))
    } catch (e: any) {
      setError(e?.message ?? 'Could not run the order check')
    } finally {
      setLoading(false)
    }
  }, [profile?.company_id, date, shopNumberOf, loc.loading])
  useEffect(() => { run() }, [run, refreshKey])

  const counts = useMemo(() => {
    const c = { found: 0, invoiced: 0, missing: 0, unmapped: 0 }
    for (const l of result?.lines ?? []) c[l.status]++
    return c
  }, [result])
  const missing = useMemo(() => (result?.lines ?? []).filter((l) => l.status === 'missing')
    .sort((a, b) => a.shop.localeCompare(b.shop, undefined, { numeric: true }) || a.product_id.localeCompare(b.product_id)), [result])
  const unmapped = useMemo(() => (result?.lines ?? []).filter((l) => l.status === 'unmapped'), [result])
  const staleReport = result != null && (result.openOrdersUploadedAt == null || result.openOrdersUploadedAt.slice(0, 10) < todayIso())

  async function exportMissing() {
    if (!profile?.company_id || !result || !missing.length) return
    setCreating(true)
    try {
      const id = await createResendDraft(profile.company_id, profile.id ?? null, rdVendorId, result.date, missing, result.sourceOrderDow)
      if (id) {
        toast.success(`Built a re-send with ${missing.length} missed line${missing.length === 1 ? '' : 's'}`)
        navigate(`/orders-v2/draft/${id}/export`)
      }
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not build the re-send')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className={`rounded border p-3 flex flex-col gap-2 ${missing.length ? 'border-[#C0392B]/40 bg-[#C0392B]/5' : 'border-navy/20'}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] font-mono uppercase tracking-widest text-navy">Order check — sent orders vs Open Sales Order report</span>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[10px] font-mono text-inky/70">
            Orders dated
            <input type="date" value={date} max={todayIso()} onChange={(e) => e.target.value && setDate(e.target.value)}
              className="bg-cream border border-navy/30 rounded px-1.5 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-sky" />
          </label>
          <Button size="sm" variant="secondary" loading={loading} onClick={run}>
            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Re-check
          </Button>
        </div>
      </div>

      {error && <p className="text-xs font-mono text-[#C0392B]">{error}</p>}

      {result && result.orderCount === 0 && !loading && (
        <p className="text-xs font-mono text-inky/60">No completed RelaDyne orders dated {dShort(date)} — nothing to check.</p>
      )}

      {result && result.orderCount > 0 && (
        <>
          {staleReport && (
            <p className="text-[11px] font-mono text-[#E67E22] font-bold">
              {result.openOrdersUploadedAt
                ? `The Open Sales Order report was last uploaded ${dTime(result.openOrdersUploadedAt)} — upload today's before trusting this.`
                : 'No Open Sales Order report has been uploaded yet.'}
            </p>
          )}
          <p className="text-xs font-mono text-navy">
            {result.orderCount} order{result.orderCount === 1 ? '' : 's'} dated {dShort(result.date)} · {result.lines.length} lines checked ·{' '}
            <span className="text-[#2ECC71] font-bold">{counts.found} on the report</span>
            {counts.invoiced > 0 && <> · {counts.invoiced} already invoiced</>}
            {counts.unmapped > 0 && <> · <span className="text-[#E67E22]">{counts.unmapped} can't be checked (no RelaDyne part number)</span></>}
            {' · '}
            <span className={counts.missing ? 'text-[#C0392B] font-bold' : 'text-navy'}>{counts.missing} missing</span>
          </p>

          {missing.length > 0 && (
            <>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-[11px] font-mono text-inky/70">
                  These lines are on the order in SB Net but not on RelaDyne's open sales orders — they may have been
                  missed in the export, or added after it went out.
                </p>
                <Button size="sm" loading={creating} onClick={exportMissing}>
                  Export {missing.length} missing line{missing.length === 1 ? '' : 's'}
                </Button>
              </div>
              <div className="overflow-auto max-h-64 rounded border border-[#C0392B]/30">
                <table className="w-full text-[11px] font-mono">
                  <thead className="sticky top-0 z-10"><tr className="bg-cream text-inky uppercase border-b border-navy/20">
                    <th className="text-left px-2 py-1">Shop</th><th className="text-left px-2 py-1">PO #</th>
                    <th className="text-left px-2 py-1">Product</th><th className="text-left px-2 py-1">RD Code</th>
                    <th className="text-right px-2 py-1">Qty</th>
                  </tr></thead>
                  <tbody>
                    {missing.map((l) => (
                      <tr key={l.key} className="border-b border-navy/10">
                        <td className="px-2 py-1 text-navy">{l.shop}</td>
                        <td className="px-2 py-1 text-navy">{l.po_number}</td>
                        <td className="px-2 py-1 text-navy">{l.product_id}</td>
                        <td className="px-2 py-1 text-inky/70">{l.product_code}</td>
                        <td className="px-2 py-1 text-right text-navy">{num(l.qty, 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {missing.length === 0 && counts.unmapped === 0 && (
            <p className="text-xs font-mono text-[#2ECC71] font-bold">Every line from these orders is on RelaDyne's open sales orders (or already invoiced).</p>
          )}

          {unmapped.length > 0 && (
            <div>
              <button className="text-[10px] font-mono text-inky/60 underline" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Hide' : 'Show'} {unmapped.length} line{unmapped.length === 1 ? '' : 's'} that couldn't be checked
              </button>
              {showAll && (
                <p className="text-[10px] font-mono text-inky/60 mt-1">
                  {[...new Set(unmapped.map((l) => l.product_id))].join(', ')} — add each one's RelaDyne part number under the vendor's parts list so it can be matched.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
