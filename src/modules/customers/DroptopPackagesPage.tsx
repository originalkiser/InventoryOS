// Droptop Packages — the configured package menu per shop, synced from
// get-packages. A matrix: one row per shop, one column per package, the
// per-shop price in each cell. Click a price to see everything that
// package includes for that shop (services + casual-item fees/surcharges).
// Column order + which columns show is a company-wide setting so "the most
// relevant packages first" sticks for everyone. See
// supabase/functions/droptop-sync-packages for the sync.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronUp, ChevronDown, Eye, EyeOff } from 'lucide-react'
import * as XLSX from 'xlsx'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useAppSetting } from '@/hooks/useAppSetting'
import { naturalCompare } from '@/lib/naturalSort'
import { Button, Card, CardBody, Modal, SbLoader } from '@/components/ui'
import { runDroptopPackageSync, probeDroptopPackages } from '@/services/droptopService'
import { useSyncTasksStore, DROPTOP_PACKAGES_TASK_ID } from '@/stores/syncTasksStore'

const sb = () => supabase as any
const COLS_SETTING_KEY = 'droptop_package_columns'

interface PkgRow {
  id: string
  location_id: string | null
  operation_id: string
  name: string | null
  internal_name: string | null
  description: string | null
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
  tax_exempt: boolean | null
  hidden_on_order: boolean | null
}
interface ColsConfig { order: string[]; hidden: string[] }

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename
  document.body.appendChild(a); a.click(); a.remove()
  URL.revokeObjectURL(url)
}
const fmt$ = (v: number | null | undefined) => (v == null ? '' : `$${Number(v).toFixed(2)}`)
const isMenuVariant = (p: PkgRow) => /^\s*\[m\]/i.test(p.internal_name ?? '')

function pricingSummary(pc: any): string {
  const badge = pc?.badge ?? ''
  let cfg = ''
  if (typeof pc?.config === 'string') cfg = pc.config
  else if (pc?.config && typeof pc.config === 'object') cfg = Object.entries(pc.config).map(([k, v]) => `${k} ${v}`).join(', ')
  const tag = pc?.tag_name ? ` · ${pc.tag_name}` : ''
  return `${badge}${cfg ? ` (${cfg})` : ''}${tag}`.trim()
}

export function DroptopPackagesPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const syncing = useSyncTasksStore((s) => s.tasks.find((t) => t.id === DROPTOP_PACKAGES_TASK_ID)?.status === 'running')

  const [packages, setPackages] = useState<PkgRow[]>([])
  const [casual, setCasual] = useState<CasualRow[]>([])
  const [loading, setLoading] = useState(true)
  const [probeOut, setProbeOut] = useState<string | null>(null)
  const [probing, setProbing] = useState(false)
  const [colsOpen, setColsOpen] = useState(false)
  const [detail, setDetail] = useState<{ shopLabel: string; pkgName: string; variants: PkgRow[] } | null>(null)
  const [cols, saveCols] = useAppSetting<ColsConfig>(COLS_SETTING_KEY, { order: [], hidden: [] })

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const [p, c] = await Promise.all([
      sb().schema('inventory').from('droptop_packages')
        .select('id, location_id, operation_id, name, internal_name, description, price, package_tax_exempt, services, last_synced_at')
        .eq('company_id', companyId).order('name'),
      sb().schema('inventory').from('droptop_package_casual_items')
        .select('package_row_id, location_id, name, amount, quantity, tax_exempt, hidden_on_order')
        .eq('company_id', companyId),
    ])
    if (p.error || c.error) toast.error(`Packages didn't load: ${(p.error || c.error)!.message}`)
    setPackages((p.data ?? []) as PkgRow[])
    setCasual((c.data ?? []) as CasualRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  const casualByPkg = useMemo(() => {
    const m = new Map<string, CasualRow[]>()
    for (const ci of casual) {
      if (!m.has(ci.package_row_id)) m.set(ci.package_row_id, [])
      m.get(ci.package_row_id)!.push(ci)
    }
    return m
  }, [casual])

  // Shop id (or a synthetic key for an unmapped operation) → label + its packages.
  const shops = useMemo(() => {
    const m = new Map<string, { key: string; label: string; sortKey: string; pkgs: PkgRow[] }>()
    for (const p of packages) {
      const key = p.location_id ?? `op:${p.operation_id}`
      const label = p.location_id && loc.labelOf(p.location_id) !== '—' ? loc.labelOf(p.location_id) : `(op ${p.operation_id})`
      if (!m.has(key)) m.set(key, { key, label, sortKey: label, pkgs: [] })
      m.get(key)!.pkgs.push(p)
    }
    return [...m.values()].sort((a, b) => naturalCompare(a.sortKey, b.sortKey))
  }, [packages, loc])

  // Every distinct package name, with the max price seen anywhere (drives the default column order).
  const allPackageNames = useMemo(() => {
    const maxPrice = new Map<string, number>()
    for (const p of packages) {
      if (!p.name) continue
      maxPrice.set(p.name, Math.max(maxPrice.get(p.name) ?? 0, Number(p.price) || 0))
    }
    return [...maxPrice.entries()]
      .sort((a, b) => b[1] - a[1] || naturalCompare(a[0], b[0]))
      .map(([name]) => name)
  }, [packages])

  // Visible columns, in the saved order, with any brand-new package names appended.
  const visibleCols = useMemo(() => {
    const hidden = new Set(cols.hidden)
    const ordered = cols.order.filter((n) => allPackageNames.includes(n))
    const missing = allPackageNames.filter((n) => !cols.order.includes(n))
    return [...ordered, ...missing].filter((n) => !hidden.has(n))
  }, [cols, allPackageNames])

  // (shopKey, packageName) → the "primary" package row (the [M] menu-board
  // variant if there is one, else the priciest) plus every variant.
  const cellFor = useCallback((shopPkgs: PkgRow[], pkgName: string): { primary: PkgRow | null; variants: PkgRow[] } => {
    const variants = shopPkgs.filter((p) => p.name === pkgName)
    if (!variants.length) return { primary: null, variants: [] }
    const menu = variants.find(isMenuVariant)
    const primary = menu ?? [...variants].sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0))[0]
    return { primary, variants }
  }, [])

  function move(name: string, dir: -1 | 1) {
    const order = visibleCols.slice()
    const i = order.indexOf(name)
    const j = i + dir
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    // Persist the full order (visible + hidden), hidden kept where they were.
    const hiddenInPlace = allPackageNames.filter((n) => cols.hidden.includes(n))
    saveCols({ order: [...order, ...hiddenInPlace], hidden: cols.hidden })
  }
  function toggleHidden(name: string) {
    const hidden = cols.hidden.includes(name) ? cols.hidden.filter((n) => n !== name) : [...cols.hidden, name]
    const order = cols.order.length ? cols.order : allPackageNames
    saveCols({ order, hidden })
  }

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
      setProbeOut(JSON.stringify(await probeDroptopPackages(), null, 2))
    } catch (e) {
      setProbeOut(`Error: ${e instanceof Error ? e.message : String(e)}`)
    }
    setProbing(false)
  }

  function exportMatrix(kind: 'csv' | 'xlsx') {
    const header = ['Shop', 'Operation', ...visibleCols]
    const body = shops.map((s) => [
      s.label,
      s.pkgs[0]?.operation_id ?? '',
      ...visibleCols.map((n) => cellFor(s.pkgs, n).primary?.price ?? ''),
    ])
    if (kind === 'csv') {
      const csv = [header, ...body].map((row) => row.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
      triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), 'droptop-packages.csv')
    } else {
      const ws = XLSX.utils.aoa_to_sheet([header, ...body])
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Packages')
      triggerDownload(new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'droptop-packages.xlsx')
    }
  }

  const lastSynced = packages.length ? packages.reduce((m, p) => (p.last_synced_at > m ? p.last_synced_at : m), packages[0].last_synced_at) : null

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Droptop Packages</h1>
        <p className="text-xs text-inky mt-0.5">
          One row per shop, one column per package, the per-shop price in each cell. Click a price to see the
          services and fees that package includes for that shop.
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
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-mono text-navy uppercase tracking-wide">{shops.length} shops · {visibleCols.length}/{allPackageNames.length} package columns</span>
            <Button size="sm" variant="secondary" onClick={() => setColsOpen((o) => !o)}>{colsOpen ? 'Done' : 'Columns'}</Button>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => exportMatrix('csv')}>CSV</Button>
              <Button size="sm" variant="secondary" onClick={() => exportMatrix('xlsx')}>XLSX</Button>
            </div>
          </div>

          {colsOpen && (
            <div className="rounded border border-navy/20 p-3 flex flex-col gap-1 max-h-72 overflow-auto">
              <p className="text-[11px] font-mono text-inky/60 mb-1">Order (top = leftmost column) and show/hide. Saved for everyone.</p>
              {[...visibleCols, ...allPackageNames.filter((n) => cols.hidden.includes(n))].map((name) => {
                const hidden = cols.hidden.includes(name)
                return (
                  <div key={name} className={`flex items-center gap-2 text-xs font-mono ${hidden ? 'text-inky/40' : 'text-navy'}`}>
                    <button onClick={() => move(name, -1)} disabled={hidden} className="disabled:opacity-20 hover:text-sky"><ChevronUp className="w-3.5 h-3.5" /></button>
                    <button onClick={() => move(name, 1)} disabled={hidden} className="disabled:opacity-20 hover:text-sky"><ChevronDown className="w-3.5 h-3.5" /></button>
                    <span className="flex-1">{name}</span>
                    <button onClick={() => toggleHidden(name)} className="hover:text-sky" title={hidden ? 'Show' : 'Hide'}>
                      {hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          <div className="overflow-auto rounded border border-navy/30 max-h-[70vh]">
            <table className="text-xs font-mono border-separate border-spacing-0">
              <thead>
                <tr className="bg-cream text-inky uppercase tracking-wide">
                  <th className="sticky left-0 top-0 z-20 bg-cream px-3 py-2 text-left whitespace-nowrap border-b border-r border-navy/30">Shop</th>
                  {visibleCols.map((n) => (
                    <th key={n} className="sticky top-0 z-10 bg-cream px-3 py-2 text-right whitespace-nowrap border-b border-navy/30" title={n}>
                      {n.length > 22 ? n.slice(0, 21) + '…' : n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <tr key={s.key} className="hover:bg-sky/5">
                    <td className="sticky left-0 z-10 bg-cream px-3 py-1.5 text-navy whitespace-nowrap border-b border-r border-navy/20">{s.label}</td>
                    {visibleCols.map((n) => {
                      const { primary, variants } = cellFor(s.pkgs, n)
                      return (
                        <td key={n} className="px-3 py-1.5 text-right whitespace-nowrap border-b border-navy/10">
                          {primary == null ? (
                            <span className="text-inky/20">—</span>
                          ) : (
                            <button
                              onClick={() => setDetail({ shopLabel: s.label, pkgName: n, variants })}
                              className="text-navy hover:text-sky hover:underline"
                            >
                              {fmt$(primary.price)}
                              {variants.length > 1 && <span className="ml-1 text-inky/40">▸{variants.length}</span>}
                            </button>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardBody></Card>
      )}

      {detail && (
        <PackageDetailModal
          shopLabel={detail.shopLabel} pkgName={detail.pkgName} variants={detail.variants}
          casualByPkg={casualByPkg} onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}

function PackageDetailModal({ shopLabel, pkgName, variants, casualByPkg, onClose }: {
  shopLabel: string
  pkgName: string
  variants: PkgRow[]
  casualByPkg: Map<string, CasualRow[]>
  onClose: () => void
}) {
  return (
    <Modal open onClose={onClose} title={`${pkgName} — ${shopLabel}`} size="lg">
      <div className="flex flex-col gap-4">
        {variants.map((p) => {
          const casual = casualByPkg.get(p.id) ?? []
          return (
            <div key={p.id} className="rounded border border-navy/20 p-3 flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-mono font-bold text-navy">
                  {fmt$(p.price) || '$0.00'}
                  {isMenuVariant(p) && <span className="ml-2 text-[10px] font-mono text-sky uppercase">menu board</span>}
                </span>
                <span className="text-[10px] font-mono text-inky/60">
                  {p.internal_name || '—'}{p.package_tax_exempt ? ' · tax exempt' : ''}
                </span>
              </div>
              {p.description && <p className="text-[11px] font-mono text-inky/70">{p.description}</p>}

              <div>
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Services</span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {(p.services ?? []).map((sv: any, i: number) => (
                    <li key={i} className="text-[11px] font-mono text-navy">
                      {sv.service_name}
                      {(sv.pricing_configs ?? []).length > 0 && (
                        <span className="text-inky/60"> — {sv.pricing_configs.map(pricingSummary).filter(Boolean).join(' · ')}</span>
                      )}
                    </li>
                  ))}
                  {(p.services ?? []).length === 0 && <li className="text-[11px] font-mono text-inky/40 italic">none</li>}
                </ul>
              </div>

              <div>
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Casual items (fees / surcharges / discounts)</span>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {casual.map((ci, i) => (
                    <li key={i} className="text-[11px] font-mono text-navy flex justify-between gap-3">
                      <span>
                        {ci.name}
                        {ci.quantity != null && Number(ci.quantity) !== 1 ? ` ×${ci.quantity}` : ''}
                        {ci.tax_exempt ? ' · tax exempt' : ''}
                        {ci.hidden_on_order ? ' · hidden on order' : ''}
                      </span>
                      <span className={Number(ci.amount) < 0 ? 'text-[#C0392B]' : ''}>{fmt$(ci.amount)}</span>
                    </li>
                  ))}
                  {casual.length === 0 && <li className="text-[11px] font-mono text-inky/40 italic">none</li>}
                </ul>
              </div>
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
