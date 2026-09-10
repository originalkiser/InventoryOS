// Droptop Packages — the configured package menu per shop, synced from
// get-packages. The point (vs. the order-line-item data the heatmap/orders
// pages already show) is the *configured* setup: which shops carry a given
// package, its per-shop price, and the casual_items (shop supply fee,
// credit-card fee, discount, oil inflation surcharge, …) that ride along
// with it. See supabase/functions/droptop-sync-packages for the sync.

import { useCallback, useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Button, Card, CardBody, Select, SbLoader } from '@/components/ui'
import { runDroptopPackageSync, probeDroptopPackages } from '@/services/droptopService'
import { useSyncTasksStore, DROPTOP_PACKAGES_TASK_ID } from '@/stores/syncTasksStore'

const sb = () => supabase as any

interface PkgRow {
  id: string
  location_id: string | null
  operation_id: string
  name: string | null
  internal_name: string | null
  price: number | null
  package_tax_exempt: boolean | null
  services: any[]
  last_synced_at: string
}
interface CasualRow {
  package_row_id: string
  location_id: string | null
  name: string | null
  amount: number | null
  quantity: number | null
  hidden_on_order: boolean | null
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
const fmt$ = (v: number | null | undefined) => (v == null ? '' : `$${Number(v).toFixed(2)}`)

export function DroptopPackagesPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const syncing = useSyncTasksStore((s) => s.tasks.find((t) => t.id === DROPTOP_PACKAGES_TASK_ID)?.status === 'running')

  const [packages, setPackages] = useState<PkgRow[]>([])
  const [casual, setCasual] = useState<CasualRow[]>([])
  const [loading, setLoading] = useState(true)
  const [pkgFilter, setPkgFilter] = useState('')
  const [probeOut, setProbeOut] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [p, c] = await Promise.all([
      sb().schema('inventory').from('droptop_packages')
        .select('id, location_id, operation_id, name, internal_name, price, package_tax_exempt, services, last_synced_at')
        .eq('company_id', companyId).order('name'),
      sb().schema('inventory').from('droptop_package_casual_items')
        .select('package_row_id, location_id, name, amount, quantity, hidden_on_order')
        .eq('company_id', companyId),
    ])
    setPackages((p.data ?? []) as PkgRow[])
    setCasual((c.data ?? []) as CasualRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const packageNames = useMemo(
    () => [...new Set(packages.map((p) => p.name).filter(Boolean) as string[])].sort(),
    [packages],
  )
  useEffect(() => {
    if (!pkgFilter && packageNames.length) setPkgFilter(packageNames[0])
  }, [packageNames, pkgFilter])

  const casualByPkg = useMemo(() => {
    const m = new Map<string, CasualRow[]>()
    for (const ci of casual) {
      if (!m.has(ci.package_row_id)) m.set(ci.package_row_id, [])
      m.get(ci.package_row_id)!.push(ci)
    }
    return m
  }, [casual])

  // Rows for the selected package name — one per shop that carries it.
  const rows = useMemo(() => packages
    .filter((p) => p.name === pkgFilter)
    .map((p) => ({
      pkg: p,
      shop: loc.labelOf(p.location_id) === '—' ? `(op ${p.operation_id})` : loc.labelOf(p.location_id),
      casual: casualByPkg.get(p.id) ?? [],
    }))
    .sort((a, b) => a.shop.localeCompare(b.shop, undefined, { numeric: true })),
  [packages, pkgFilter, casualByPkg, loc])

  // Distinct casual-item names across the selected package = the pivot columns.
  const casualCols = useMemo(() => {
    const names = new Set<string>()
    for (const r of rows) for (const ci of r.casual) if (ci.name) names.add(ci.name)
    return [...names].sort()
  }, [rows])

  async function syncNow() {
    if (syncing || !companyId) return
    const store = useSyncTasksStore.getState()
    store.start(DROPTOP_PACKAGES_TASK_ID, 'Droptop — Packages')
    try {
      const r = await runDroptopPackageSync(companyId, {}, (p) => store.setProgress(DROPTOP_PACKAGES_TASK_ID, p.batch, p.totalBatches))
      const summary = `${r.locations_synced} shops, ${r.packages_upserted} packages, ${r.casual_items_written} casual items`
      store.finish(DROPTOP_PACKAGES_TASK_ID, r.warnings?.length ? 'partial' : 'success', r.warnings?.length ? r.warnings[0] : summary)
      if (r.warnings?.length) toast.error(r.warnings[0], { duration: 12000 })
      else toast.success(summary)
      await load()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Sync failed'
      store.finish(DROPTOP_PACKAGES_TASK_ID, 'error', message)
      toast.error(message, { duration: 12000 })
    }
  }

  async function probe() {
    setProbing(true)
    setProbeOut(null)
    try {
      const data = await probeDroptopPackages()
      setProbeOut(JSON.stringify(data, null, 2))
    } catch (e) {
      setProbeOut(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
    setProbing(false)
  }

  function exportRows(kind: 'csv' | 'xlsx') {
    const header = ['Shop', 'Operation', 'Price', 'Tax Exempt', ...casualCols, 'Services']
    const body = rows.map((r) => [
      r.shop, r.pkg.operation_id, r.pkg.price ?? '', r.pkg.package_tax_exempt ? 'yes' : '',
      ...casualCols.map((cn) => {
        const ci = r.casual.find((x) => x.name === cn)
        return ci?.amount ?? ''
      }),
      (r.pkg.services ?? []).map((s: any) => s.service_name).filter(Boolean).join('; '),
    ])
    const fileBase = `droptop-packages-${(pkgFilter || 'all').replace(/\W+/g, '-').toLowerCase()}`
    if (kind === 'csv') {
      const csv = [header, ...body].map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
      triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `${fileBase}.csv`)
    } else {
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Packages')
      const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
      triggerDownload(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileBase}.xlsx`)
    }
  }

  const lastSynced = packages.length ? packages.reduce((m, p) => (p.last_synced_at > m ? p.last_synced_at : m), packages[0].last_synced_at) : null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Droptop Packages</h1>
        <p className="text-xs text-inky mt-0.5">
          The configured package menu per shop — which shops carry a package, its per-shop price, and the casual
          items (fees, surcharges, discounts) attached to it.
        </p>
      </div>

      <Card><CardBody className="flex items-center gap-3 flex-wrap">
        <Button size="sm" onClick={syncNow} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Packages'}</Button>
        <Button size="sm" variant="secondary" onClick={probe} disabled={probing}>{probing ? 'Probing…' : 'Probe one shop'}</Button>
        {lastSynced && <span className="text-[11px] font-mono text-inky/60">Last synced {new Date(lastSynced).toLocaleString()}</span>}
      </CardBody></Card>

      {probeOut != null && (
        <Card><CardBody className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Raw get-packages response (one shop, nothing written)</span>
            <button onClick={() => setProbeOut(null)} className="text-[10px] font-mono text-inky hover:text-navy">close</button>
          </div>
          <pre className="text-[10px] font-mono text-navy bg-cream border border-navy/20 rounded p-3 overflow-auto max-h-[420px] whitespace-pre-wrap">{probeOut}</pre>
        </CardBody></Card>
      )}

      {loading ? (
        <div className="py-16 flex justify-center"><SbLoader size={40} /></div>
      ) : packages.length === 0 ? (
        <Card><CardBody><p className="text-xs font-mono text-inky/60 py-6 text-center">No packages synced yet — hit Sync Packages.</p></CardBody></Card>
      ) : (
        <Card><CardBody className="flex flex-col gap-3">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="w-64">
              <Select label="Package" value={pkgFilter} onChange={(e) => setPkgFilter(e.target.value)}
                options={packageNames.map((n) => ({ value: n, label: n }))} />
            </div>
            <span className="text-[11px] font-mono text-inky/60">{rows.length} shop{rows.length !== 1 ? 's' : ''} carry this package</span>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => exportRows('csv')}>CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => exportRows('xlsx')}>XLSX</Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded border border-navy/30">
            <table className="text-xs font-mono">
              <thead>
                <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                  <th className="px-3 py-2 text-left whitespace-nowrap">Shop</th>
                  <th className="px-3 py-2 text-right whitespace-nowrap">Price</th>
                  {casualCols.map((cn) => <th key={cn} className="px-3 py-2 text-right whitespace-nowrap">{cn}</th>)}
                  <th className="px-3 py-2 text-left whitespace-nowrap">Services</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.pkg.id} className="border-b border-navy/20">
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{r.shop}</td>
                    <td className="px-3 py-1.5 text-navy text-right whitespace-nowrap">{fmt$(r.pkg.price)}</td>
                    {casualCols.map((cn) => {
                      const ci = r.casual.find((x) => x.name === cn)
                      return (
                        <td key={cn} className="px-3 py-1.5 text-navy text-right whitespace-nowrap">
                          {ci ? fmt$(ci.amount) : <span className="text-inky/25">—</span>}
                          {ci?.hidden_on_order && <span className="ml-1 text-inky/40" title="Hidden on order">·h</span>}
                        </td>
                      )
                    })}
                    <td className="px-3 py-1.5 text-navy/70 max-w-[320px] truncate" title={(r.pkg.services ?? []).map((s: any) => s.service_name).filter(Boolean).join(', ')}>
                      {(r.pkg.services ?? []).map((s: any) => s.service_name).filter(Boolean).join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}
    </div>
  )
}
