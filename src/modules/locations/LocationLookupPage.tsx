import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Badge, Card, CardBody, Combobox, SbLoader } from '@/components/ui'
import { orderDayFromDelivery } from '@/lib/orderDay'
import type { Location } from '@/types'
import { format } from 'date-fns'

interface TankRow {
  id: string; product_id: string | null; value: number | null; unit: string | null
  on_hand: number | null; keep_fill: boolean | null; reading_date: string | null; inventory_time: string | null
}
interface ConfigRow {
  id: string; vendor_id: string | null; product_id: string | null
  capacity: number | null; order_trigger: number | null; order_limit: number | null
  metadata: Record<string, unknown> | null
}
interface IssueRow {
  id: string; title: string | null; status_id: string | null; issue_notes: string | null
  start_date: string | null; target_resolution_date: string | null; resolved_date: string | null
}

const num = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }))
const dateShort = (d: string | null | undefined) => { if (!d) return '—'; try { return format(new Date(d), 'MMM d, yyyy') } catch { return d } }

// Read a location field: base column first, then metadata fallback.
function locVal(loc: Location | undefined, key: string): string {
  if (!loc) return ''
  const base = (loc as any)[key]
  if (base != null && base !== '') return String(base)
  const meta = (loc.metadata as any)?.[key]
  return meta == null ? '' : String(meta)
}

export function LocationLookupPage() {
  const { profile } = useAuthStore()
  const navigate = useNavigate()
  const loc = useLocations()
  const companyId = profile?.company_id ?? null

  const [shopId, setShopId] = useState('')
  const [tanks, setTanks] = useState<TankRow[]>([])
  const [configs, setConfigs] = useState<ConfigRow[]>([])
  const [vendorNames, setVendorNames] = useState<Record<string, string>>({})
  const [issues, setIssues] = useState<IssueRow[]>([])
  const [statusNames, setStatusNames] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const location = loc.byId(shopId)

  const load = useCallback(async () => {
    if (!companyId || !shopId) return
    setLoading(true); setError(null)
    const sb = supabase as any
    try {
      const [tankRes, cfgRes, vendRes, issRes, statRes] = await Promise.all([
        sb.schema('inventory').from('tank_monitors').select('*').eq('company_id', companyId).eq('location_id', shopId).order('product_id'),
        sb.schema('inventory').from('location_order_config').select('*').eq('company_id', companyId).eq('location_id', shopId),
        sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
        sb.schema('platform').from('issues').select('id, title, status_id, issue_notes, start_date, target_resolution_date, resolved_date').eq('company_id', companyId).eq('location_id', shopId).is('deleted_at', null).order('created_at', { ascending: false }),
        sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
      ])
      setTanks((tankRes.data ?? []) as TankRow[])
      setConfigs((cfgRes.data ?? []) as ConfigRow[])
      setVendorNames(Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, v.name])))
      setIssues((issRes.data ?? []) as IssueRow[])
      setStatusNames(Object.fromEntries(((statRes.data ?? []) as any[]).map((s) => [s.id, s.name])))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load location detail')
    } finally {
      setLoading(false)
    }
  }, [companyId, shopId])

  useEffect(() => { load() }, [load])

  // Group order configs by vendor name (RelaDyne / Valvoline surface automatically).
  const configsByVendor = useMemo(() => {
    const groups = new Map<string, ConfigRow[]>()
    for (const c of configs) {
      const name = c.vendor_id ? (vendorNames[c.vendor_id] ?? 'Unassigned Vendor') : 'Unassigned Vendor'
      if (!groups.has(name)) groups.set(name, [])
      groups.get(name)!.push(c)
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [configs, vendorNames])

  const isPending = (s: string) => { const n = s.toLowerCase(); return n.includes('pending') || n.includes('open') }
  const isResolved = (s: string) => { const n = s.toLowerCase(); return n.includes('resolved') || n.includes('closed') || n.includes('complete') }
  const pendingIssues = issues.filter((i) => isPending(statusNames[i.status_id ?? ''] ?? ''))
  const resolvedIssues = issues.filter((i) => isResolved(statusNames[i.status_id ?? ''] ?? ''))

  // Sidebar field list — label + resolved value.
  const sidebar: { label: string; value: string }[] = location ? [
    { label: 'Shop #', value: locVal(location, 'name') },
    { label: 'Shop / City', value: locVal(location, 'shop_city') },
    { label: 'Area Manager', value: locVal(location, 'area_manager') },
    { label: 'AM Cell', value: locVal(location, 'am_phone') },
    { label: 'RDO', value: locVal(location, 'director') },
    { label: 'RD Delivery Day', value: locVal(location, 'reladyne_delivery_day') },
    { label: 'RD Order Day', value: orderDayFromDelivery(location.reladyne_delivery_day) },
    { label: 'Custom Delivery Notes', value: locVal(location, 'custom_delivery_notes') },
    { label: 'Address', value: [locVal(location, 'address'), locVal(location, 'city'), locVal(location, 'state'), locVal(location, 'zip')].filter(Boolean).join(', ') },
    { label: 'Shop Phone', value: locVal(location, 'store_phone') },
    { label: 'RD Distributor', value: locVal(location, 'rd_distributor') },
    { label: 'Former FZ #', value: locVal(location, 'former_fz_store_num') },
    { label: 'Acquisition Date', value: locVal(location, 'acquisition_date') },
    { label: 'NC Inspection Station', value: locVal(location, 'inspection_station_id') },
    { label: 'Mighty PO Uploadable', value: locVal(location, 'mighty_po_upload') },
    { label: 'Droptop Op ID', value: locVal(location, 'droptop_operation_id') },
    { label: 'AZ Account Pin - Type', value: locVal(location, 'az_account_pin') },
  ].filter((f) => f.value) : []

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Inventory Location Lookup</h1>
          <p className="text-xs text-inky mt-0.5">Pick a shop to see its tanks, order configuration, and issues.</p>
        </div>
        <div className="w-80">
          <Combobox options={loc.options} value={shopId} onChange={setShopId} placeholder="Search a shop…" />
        </div>
      </div>

      {!shopId ? (
        <p className="text-xs font-mono text-inky/60 py-8">Select a shop above to begin.</p>
      ) : loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={40} /></div>
      ) : error ? (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
          {/* Sidebar */}
          <div className="flex flex-col gap-3">
            <Card>
              <CardBody className="flex flex-col gap-1.5">
                <span className="text-sm font-heading font-bold text-navy">{loc.labelOf(shopId)}</span>
                <dl className="flex flex-col gap-1 mt-1">
                  {sidebar.map((f) => (
                    <div key={f.label} className="flex flex-col">
                      <dt className="text-[10px] font-mono uppercase tracking-wide text-inky/50">{f.label}</dt>
                      <dd className="text-xs font-body text-navy break-words">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardBody>
            </Card>

            {/* Issues callouts */}
            <div className={['rounded-lg border px-4 py-3', pendingIssues.length ? 'border-[#E67E22]/50 bg-[#E67E22]/10' : 'border-navy/20 bg-cream'].join(' ')}>
              <button onClick={() => navigate(`/issues?tab=pending`)} className="w-full text-left">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Pending Issues</span>
                  <span className={['text-lg font-heading font-bold', pendingIssues.length ? 'text-[#E67E22]' : 'text-navy'].join(' ')}>{pendingIssues.length}</span>
                </div>
                {pendingIssues.slice(0, 4).map((i) => (
                  <div key={i.id} className="text-xs font-body text-navy truncate mt-0.5">• {i.title}</div>
                ))}
                <span className="text-[10px] font-mono text-sky mt-1 inline-block">Open Issues →</span>
              </button>
            </div>

            <div className="rounded-lg border border-navy/20 bg-cream px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Last Resolved</span>
                <span className="text-lg font-heading font-bold text-[#2ECC71]">{resolvedIssues.length}</span>
              </div>
              {resolvedIssues.slice(0, 4).map((i) => (
                <div key={i.id} className="text-xs font-body text-inky/70 truncate mt-0.5">✓ {i.title} <span className="text-inky/40">{dateShort(i.resolved_date)}</span></div>
              ))}
              {resolvedIssues.length === 0 && <div className="text-xs font-body text-inky/40 mt-0.5">None</div>}
            </div>
          </div>

          {/* Main */}
          <div className="flex flex-col gap-4">
            {/* Tank monitors */}
            <Card>
              <CardBody className="flex flex-col gap-2">
                <span className="text-xs font-mono text-navy uppercase tracking-wide">Tank Monitors ({tanks.length})</span>
                {tanks.length === 0 ? (
                  <p className="text-xs font-mono text-inky/60">No tank monitor readings for this shop.</p>
                ) : (
                  <div className="overflow-auto rounded border border-navy/30">
                    <table className="w-full text-xs font-mono">
                      <thead>
                        <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                          <th className="px-3 py-2 text-left">Product</th>
                          <th className="px-3 py-2 text-right">Current Level</th>
                          <th className="px-3 py-2 text-right">On Hand</th>
                          <th className="px-3 py-2 text-center">Keepfill</th>
                          <th className="px-3 py-2 text-left">Last Update</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tanks.map((t) => (
                          <tr key={t.id} className="border-b border-navy/20">
                            <td className="px-3 py-1.5 text-navy">{t.product_id ?? '—'}</td>
                            <td className="px-3 py-1.5 text-right text-navy">{num(t.value)} {t.unit ?? ''}</td>
                            <td className="px-3 py-1.5 text-right text-inky">{num(t.on_hand)}</td>
                            <td className="px-3 py-1.5 text-center">{t.keep_fill ? <Badge color="green">yes</Badge> : <span className="text-inky/40">—</span>}</td>
                            <td className="px-3 py-1.5 text-inky/70">{dateShort(t.inventory_time ?? t.reading_date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>

            {/* Order configs per vendor */}
            {configsByVendor.length === 0 ? (
              <Card><CardBody><p className="text-xs font-mono text-inky/60">No order configuration for this shop.</p></CardBody></Card>
            ) : configsByVendor.map(([vendor, rows]) => (
              <OrderConfigBlock key={vendor} vendor={vendor} rows={rows} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function OrderConfigBlock({ vendor, rows }: { vendor: string; rows: ConfigRow[] }) {
  // Extra metadata columns (beyond uom/vmi) shown dynamically so whatever is
  // configured surfaces — matching the per-vendor tank config sheets.
  const metaKeys = useMemo(() => {
    const keys = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.metadata ?? {})) if (k !== 'vmi' && k !== 'uom') keys.add(k)
    return [...keys].sort()
  }, [rows])
  const label = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <Card>
      <CardBody className="flex flex-col gap-2">
        <span className="text-xs font-mono text-navy uppercase tracking-wide">{vendor} Order Config ({rows.length})</span>
        <div className="overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-navy/30 bg-cream text-inky uppercase tracking-wide">
                <th className="px-3 py-2 text-left">Part</th>
                <th className="px-3 py-2 text-left">UOM</th>
                <th className="px-3 py-2 text-right">Capacity</th>
                <th className="px-3 py-2 text-right">Trigger</th>
                <th className="px-3 py-2 text-right">Max</th>
                {metaKeys.map((k) => <th key={k} className="px-3 py-2 text-left">{label(k)}</th>)}
                <th className="px-3 py-2 text-center">VMI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-navy/20">
                  <td className="px-3 py-1.5 text-navy">{r.product_id ?? '—'}</td>
                  <td className="px-3 py-1.5 text-inky">{String((r.metadata as any)?.uom ?? '—')}</td>
                  <td className="px-3 py-1.5 text-right text-navy">{num(r.capacity)}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{num(r.order_trigger)}</td>
                  <td className="px-3 py-1.5 text-right text-inky">{num(r.order_limit)}</td>
                  {metaKeys.map((k) => <td key={k} className="px-3 py-1.5 text-inky">{String((r.metadata as any)?.[k] ?? '—')}</td>)}
                  <td className="px-3 py-1.5 text-center">
                    {String((r.metadata as any)?.vmi ?? '').trim().toLowerCase() === 'yes' ? <Badge color="amber">VMI</Badge> : <span className="text-inky/40">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}
