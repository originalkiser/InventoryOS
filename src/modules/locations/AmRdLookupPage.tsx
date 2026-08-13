import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Card, CardBody, Combobox, SbLoader, Badge } from '@/components/ui'
import type { Location } from '@/types'

interface ShopAgg {
  rdProducts: number
  valvProducts: number
  openIssues: number
  closedIssues: number
  comms: number
  tankVmi: number
  tankNonVmi: number
}
const EMPTY_AGG: ShopAgg = { rdProducts: 0, valvProducts: 0, openIssues: 0, closedIssues: 0, comms: 0, tankVmi: 0, tankNonVmi: 0 }

const metaOf = (l: Location, key: string): string => {
  const base = (l as any)[key]
  if (base != null && base !== '') return String(base)
  const m = (l.metadata as any)?.[key]
  return m == null ? '' : String(m)
}
const amOf = (l: Location) => metaOf(l, 'area_manager')
const rdOf = (l: Location) => metaOf(l, 'regional_director') || metaOf(l, 'director')
const shopText = (l: Location) => l.shop_city || l.name

const isOpen = (n: string) => { const s = n.toLowerCase(); return s.includes('pending') || s.includes('open') }
const isClosed = (n: string) => { const s = n.toLowerCase(); return s.includes('resolved') || s.includes('closed') || s.includes('complete') }

export function AmRdLookupPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()

  const [role, setRole] = useState<'am' | 'rd'>('am')
  const [person, setPerson] = useState('')
  const [sortBy, setSortBy] = useState<'shop' | 'am'>('shop')
  const [agg, setAgg] = useState<Record<string, ShopAgg>>({})
  const [loading, setLoading] = useState(false)

  const roleVal = useCallback((l: Location) => (role === 'am' ? amOf(l) : rdOf(l)), [role])

  // Distinct people for the selected role.
  const people = useMemo(() => {
    const s = new Set<string>()
    for (const l of loc.locations) { const v = roleVal(l); if (v) s.add(v) }
    return [...s].sort((a, b) => a.localeCompare(b))
  }, [loc.locations, roleVal])

  const shops = useMemo(
    () => (person ? loc.locations.filter((l) => l.active && roleVal(l) === person) : []),
    [loc.locations, person, roleVal],
  )
  const shopIds = useMemo(() => shops.map((l) => l.id), [shops])
  const shopKey = shopIds.join(',')

  const load = useCallback(async () => {
    if (!companyId || shopIds.length === 0) { setAgg({}); return }
    setLoading(true)
    const sb = supabase as any
    try {
      const [cfgRes, vendRes, issRes, statRes, commRes, tankRes] = await Promise.all([
        sb.schema('inventory').from('location_order_config').select('location_id, vendor_id').in('location_id', shopIds),
        sb.schema('core').from('vendors').select('id, name').eq('company_id', companyId),
        sb.schema('platform').from('issues').select('location_id, status_id').in('location_id', shopIds).is('deleted_at', null),
        sb.schema('inventory').from('issue_statuses').select('id, name').eq('company_id', companyId),
        sb.schema('inventory').from('location_comms').select('location_id').in('location_id', shopIds),
        sb.schema('inventory').from('tank_monitors').select('location_id, keep_fill').in('location_id', shopIds),
      ])
      const vendorName: Record<string, string> = Object.fromEntries(((vendRes.data ?? []) as any[]).map((v) => [v.id, String(v.name ?? '').toLowerCase()]))
      const statusName: Record<string, string> = Object.fromEntries(((statRes.data ?? []) as any[]).map((s) => [s.id, s.name]))
      const map: Record<string, ShopAgg> = {}
      const get = (id: string) => (map[id] ??= { ...EMPTY_AGG })
      for (const c of (cfgRes.data ?? []) as any[]) {
        if (!c.location_id) continue
        const vn = c.vendor_id ? (vendorName[c.vendor_id] ?? '') : ''
        if (vn.includes('reladyne')) get(c.location_id).rdProducts++
        else if (vn.includes('valvoline')) get(c.location_id).valvProducts++
      }
      for (const i of (issRes.data ?? []) as any[]) {
        if (!i.location_id) continue
        const n = statusName[i.status_id ?? ''] ?? ''
        if (isOpen(n)) get(i.location_id).openIssues++
        else if (isClosed(n)) get(i.location_id).closedIssues++
      }
      for (const c of (commRes.data ?? []) as any[]) if (c.location_id) get(c.location_id).comms++
      for (const t of (tankRes.data ?? []) as any[]) {
        if (!t.location_id) continue
        if (t.keep_fill) get(t.location_id).tankVmi++
        else get(t.location_id).tankNonVmi++
      }
      setAgg(map)
    } finally {
      setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, shopKey])
  useEffect(() => { load() }, [load])

  // Reset selection when switching role.
  useEffect(() => { setPerson('') }, [role])

  const rdForAm = useMemo(() => {
    if (role !== 'am') return ''
    return [...new Set(shops.map((l) => rdOf(l)).filter(Boolean))].join(', ')
  }, [shops, role])

  const sortedShops = useMemo(() => {
    const arr = [...shops]
    if (sortBy === 'am') arr.sort((a, b) => amOf(a).localeCompare(amOf(b)) || shopText(a).localeCompare(shopText(b), undefined, { numeric: true }))
    else arr.sort((a, b) => shopText(a).localeCompare(shopText(b), undefined, { numeric: true }))
    return arr
  }, [shops, sortBy])

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  const th = 'px-3 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30'
  const td = 'px-3 py-1.5 border-b border-navy/15 whitespace-nowrap'
  const showAmCol = role === 'rd'

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">AM / RD Lookup</h1>
        <p className="text-xs text-inky mt-0.5">Pick an area manager or regional director to see their shops and per-shop rollups.</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-navy/20 overflow-hidden text-xs font-mono">
          {(['am', 'rd'] as const).map((r) => (
            <button key={r} onClick={() => setRole(r)}
              className={['px-3 py-1.5 uppercase tracking-wide transition-colors', role === r ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
              {r === 'am' ? 'Area Manager' : 'Regional Director'}
            </button>
          ))}
        </div>
        <div className="w-72"><Combobox options={people.map((p) => ({ value: p, label: p }))} value={person} onChange={setPerson} placeholder={`Select ${role === 'am' ? 'area manager' : 'regional director'}…`} /></div>
        <div className="inline-flex rounded-lg border border-navy/20 overflow-hidden text-[11px] font-mono">
          <span className="px-2 py-1.5 text-inky/60 uppercase tracking-wide">Sort</span>
          {(['shop', 'am'] as const).map((s) => (
            <button key={s} onClick={() => setSortBy(s)}
              className={['px-2.5 py-1.5 uppercase tracking-wide transition-colors', sortBy === s ? 'bg-navy text-cream' : 'bg-cream text-inky hover:bg-navy/10'].join(' ')}>
              {s === 'shop' ? 'Shop #' : 'Area Manager'}
            </button>
          ))}
        </div>
      </div>

      {!person ? (
        <p className="text-xs font-mono text-inky/60 py-8">Select a {role === 'am' ? 'area manager' : 'regional director'} above to begin.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs font-body text-navy">
            <span className="font-heading font-bold uppercase tracking-wide">{person}</span>
            <Badge color="navy">{shops.length} shops</Badge>
            {role === 'am' && rdForAm && <span className="text-inky">Regional Director: <span className="text-navy font-semibold">{rdForAm}</span></span>}
          </div>

          <div className="overflow-x-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead>
                <tr className="bg-cream">
                  <th className={th}>Shop</th>
                  {showAmCol && <th className={th}>Area Manager</th>}
                  <th className={th}>RD Products</th>
                  <th className={th}>Valvoline Products</th>
                  <th className={th}>Open Issues</th>
                  <th className={th}>Closed Issues</th>
                  <th className={th}>Comms</th>
                  <th className={th}>Tanks (VMI / Non)</th>
                  <th className={th}>Mighty PO Upload</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={showAmCol ? 9 : 8} className="py-10 text-center"><SbLoader size={32} /></td></tr>
                ) : sortedShops.map((l, idx) => {
                  const a = agg[l.id] ?? EMPTY_AGG
                  return (
                    <tr key={l.id} className={idx % 2 ? 'bg-navy/[0.03]' : ''}>
                      <td className={`${td} text-navy font-semibold`}>{shopText(l)}</td>
                      {showAmCol && <td className={`${td} text-navy`}>{amOf(l) || '—'}</td>}
                      <td className={`${td} text-right text-navy`}>{a.rdProducts}</td>
                      <td className={`${td} text-right text-navy`}>{a.valvProducts}</td>
                      <td className={`${td} text-right`}><span className={a.openIssues ? 'text-[#E67E22] font-bold' : 'text-inky/40'}>{a.openIssues}</span></td>
                      <td className={`${td} text-right`}><span className={a.closedIssues ? 'text-[#2ECC71]' : 'text-inky/40'}>{a.closedIssues}</span></td>
                      <td className={`${td} text-right text-navy`}>{a.comms}</td>
                      <td className={`${td} text-right text-navy`}>{a.tankVmi} / {a.tankNonVmi}</td>
                      <td className={td}><span className="text-[10px] font-mono text-inky/40 border border-navy/15 rounded px-1.5 py-0.5">Coming soon</span></td>
                    </tr>
                  )
                })}
                {!loading && sortedShops.length === 0 && (
                  <tr><td colSpan={showAmCol ? 9 : 8} className="py-8 text-center text-inky/50">No shops for this selection.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
