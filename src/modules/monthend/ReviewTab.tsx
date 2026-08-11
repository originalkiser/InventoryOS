import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useMonthEndStore } from '@/stores/monthEndStore'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { Button, Badge, Card, CardBody, SbLoader } from '@/components/ui'
import { TANK_VARIANCE_KEY, UNLISTED_LIMIT_KEY, DEFAULT_TANK_VARIANCE } from '@/modules/config/tabs/CategoryExpectationsTab'
import { format, parseISO } from 'date-fns'
import toast from 'react-hot-toast'

interface SnapRow {
  run_id: string
  run_at: string
  location_id: string | null
  product_id: string
  category: string | null
  on_hand: number | null
  expected_limit: number | null
  basis: string | null
  reason: string | null
}

const show = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const keyOf = (r: { location_id: string | null; product_id: string }) => `${r.location_id ?? ''}|${r.product_id}`

export function ReviewTab() {
  const { profile } = useAuthStore()
  const { getCountMonth } = useMonthEndStore()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null
  const countMonth = getCountMonth()

  const [tankVariance] = useAppSetting<number>(TANK_VARIANCE_KEY, DEFAULT_TANK_VARIANCE)
  const [unlistedLimit] = useAppSetting<number | null>(UNLISTED_LIMIT_KEY, null)

  const [rows, setRows] = useState<SnapRow[]>([])
  const [completeShops, setCompleteShops] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [capturing, setCapturing] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const sb = supabase as any
    const { data } = await sb.schema('inventory').from('recount_product_snapshots')
      .select('*').eq('company_id', companyId).eq('count_month', countMonth)
      .order('run_at', { ascending: false })
    setRows((data ?? []) as SnapRow[])

    const { data: rc } = await sb.schema('inventory').from('recount_requests')
      .select('location_id, completed_flags').eq('company_id', companyId)
      .filter('recount_fields->>count_month', 'eq', countMonth)
    const done = new Set<string>()
    for (const r of (rc ?? []) as any[]) if ((r.completed_flags ?? [])[0] && r.location_id) done.add(r.location_id)
    setCompleteShops(done)
    setLoading(false)
  }, [companyId, countMonth])

  useEffect(() => { load() }, [load])

  async function capture() {
    if (!companyId) return
    setCapturing(true)
    const sb = supabase as any
    const { data: exc, error } = await sb.rpc('get_product_expectation_exceptions', {
      p_company_id: companyId, p_count_month: countMonth,
      p_tank_variance: tankVariance ?? DEFAULT_TANK_VARIANCE, p_unlisted_limit: unlistedLimit ?? null,
    })
    if (error) { setCapturing(false); toast.error('Analysis failed'); return }
    const list = (exc ?? []) as any[]
    if (list.length === 0) { setCapturing(false); toast('No products flagged — nothing to snapshot', { icon: 'ℹ️' }); return }
    const runId = crypto.randomUUID()
    const runAt = new Date().toISOString()
    const snap = list.map((e) => ({
      company_id: companyId, count_month: countMonth, run_id: runId, run_at: runAt,
      location_id: e.location_id, product_id: e.product_id, category: e.category,
      on_hand: e.on_hand, expected_limit: e.expected_limit, basis: e.basis, reason: e.reason,
    }))
    const { error: insErr } = await sb.schema('inventory').from('recount_product_snapshots').insert(snap)
    setCapturing(false)
    if (insErr) { toast.error(insErr.message); return }
    toast.success(`Snapshot captured — ${snap.length} flagged products`)
    load()
  }

  // Two most recent runs → latest + previous for the diff.
  const { latest, prev, runList } = useMemo(() => {
    const runs: { run_id: string; run_at: string }[] = []
    const seen = new Set<string>()
    for (const r of rows) if (!seen.has(r.run_id)) { seen.add(r.run_id); runs.push({ run_id: r.run_id, run_at: r.run_at }) }
    return { latest: runs[0] ?? null, prev: runs[1] ?? null, runList: runs }
  }, [rows])

  const view = useMemo(() => {
    if (!latest) return null
    const latestRows = rows.filter((r) => r.run_id === latest.run_id)
    const prevRows = prev ? rows.filter((r) => r.run_id === prev.run_id) : []
    const prevKeys = new Set(prevRows.map(keyOf))
    const latestKeys = new Set(latestRows.map(keyOf))

    // Group latest by shop, flag NEW (absent from previous run)
    const byShop = new Map<string, { rows: (SnapRow & { isNew: boolean })[]; cleared: SnapRow[] }>()
    for (const r of latestRows) {
      const k = r.location_id ?? '__none'
      if (!byShop.has(k)) byShop.set(k, { rows: [], cleared: [] })
      byShop.get(k)!.rows.push({ ...r, isNew: prev ? !prevKeys.has(keyOf(r)) : false })
    }
    // Cleared: in previous run, gone from latest
    for (const r of prevRows) {
      if (latestKeys.has(keyOf(r))) continue
      const k = r.location_id ?? '__none'
      if (!byShop.has(k)) byShop.set(k, { rows: [], cleared: [] })
      byShop.get(k)!.cleared.push(r)
    }

    const shops = [...byShop.entries()]
      .map(([locId, v]) => ({ locId, label: locId === '__none' ? '(Unresolved shop)' : loc.labelOf(locId), complete: completeShops.has(locId), ...v }))
      .sort((a, b) => a.label.localeCompare(b.label))

    const active = shops.filter((s) => !s.complete && (s.rows.length || s.cleared.length))
    const completed = shops.filter((s) => s.complete && (s.rows.length || s.cleared.length))
    const newCount = latestRows.filter((r) => prev && !prevKeys.has(keyOf(r))).length
    const clearedCount = prevRows.filter((r) => !latestKeys.has(keyOf(r))).length
    return { latestRows, active, completed, newCount, clearedCount }
  }, [rows, latest, prev, completeShops, loc])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardBody className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">Recount Review — {format(parseISO(countMonth), 'MMMM yyyy')}</span>
            <span className="text-[11px] font-mono text-inky/70">
              {latest ? <>Latest snapshot {format(new Date(latest.run_at), 'MMM d, h:mm a')}{prev ? ` · vs ${format(new Date(prev.run_at), 'MMM d, h:mm a')}` : ' · first snapshot'}</> : 'No snapshots yet — capture one after each daily upload.'}
              {runList.length > 0 && ` · ${runList.length} total`}
            </span>
          </div>
          <Button loading={capturing} onClick={capture}>Capture Snapshot</Button>
        </CardBody>
      </Card>

      {loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
      ) : !view ? (
        <p className="text-xs font-mono text-inky/70">Capture a snapshot to record today's flagged recount products. Do it after each daily product-detail upload to track what comes off or gets added.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs font-mono text-inky">
            <span><span className="text-navy font-bold">{view.latestRows.length}</span> flagged products</span>
            {prev && <span className="text-[#2ECC71]">▲ {view.newCount} new since last</span>}
            {prev && <span className="text-[#C0392B]">▼ {view.clearedCount} cleared since last</span>}
          </div>

          {view.active.map((s) => <ShopBlock key={s.locId} shop={s} />)}
          {view.active.length === 0 && <p className="text-xs font-mono text-inky/60">No open shops flagging for recount. 🎉</p>}

          {view.completed.length > 0 && (
            <div className="flex flex-col gap-2 mt-2">
              <p className="text-[10px] font-mono uppercase tracking-widest text-inky/50">Recount marked complete — soft-ignored</p>
              {view.completed.map((s) => <ShopBlock key={s.locId} shop={s} dimmed />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ShopBlock({ shop, dimmed }: {
  shop: { label: string; complete: boolean; rows: (SnapRow & { isNew: boolean })[]; cleared: SnapRow[] }
  dimmed?: boolean
}) {
  return (
    <div className={['rounded border border-navy/20 bg-cream', dimmed ? 'opacity-55' : ''].join(' ')}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-navy/10">
        <span className="text-xs font-heading font-bold text-navy">{shop.label}</span>
        {shop.complete && <Badge color="green">recount complete</Badge>}
        <span className="text-[10px] font-mono text-inky/50 ml-auto">{shop.rows.length} flagged{shop.cleared.length ? ` · ${shop.cleared.length} cleared` : ''}</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-xs font-mono">
          <tbody>
            {shop.rows.map((r) => (
              <tr key={r.product_id} className="border-b border-navy/10">
                <td className="px-3 py-1.5 text-navy w-8">{r.isNew && <Badge color="amber">new</Badge>}</td>
                <td className="px-3 py-1.5 text-navy">{r.product_id}</td>
                <td className="px-3 py-1.5 text-inky">{r.category ?? '—'}</td>
                <td className="px-3 py-1.5 text-right text-navy font-bold">{show(r.on_hand)}</td>
                <td className="px-3 py-1.5 text-right text-inky">limit {show(r.expected_limit)}</td>
                <td className="px-3 py-1.5"><Badge color={r.basis === 'unlisted' ? 'gray' : 'red'}>{r.basis}</Badge></td>
              </tr>
            ))}
            {shop.cleared.map((r) => (
              <tr key={`cl-${r.product_id}`} className="border-b border-navy/10">
                <td className="px-3 py-1.5 w-8"><span className="text-[#2ECC71]">✓</span></td>
                <td className="px-3 py-1.5 text-inky/50 line-through" colSpan={5}>{r.product_id} — cleared</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
