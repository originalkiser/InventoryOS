import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Filter } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Button, SbLoader } from '@/components/ui'
import { EditDate, EditSelect, CappedTextarea } from '@/components/shared/InlineCells'
import { LocationCommsModal } from './LocationCommsModal'
import { useCommsConfig } from './useCommsConfig'
import type { LocationComm } from './comms'
import { EXCEPTION_STATUSES } from '@/modules/exceptions/exceptions'
import { refreshNavBadges } from '@/hooks/useNavBadges'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

interface ColDef { id: string; label: string; filter: boolean; sticky?: 'status' | 'shop' }
const COLS: ColDef[] = [
  { id: 'status', label: 'Status', filter: true, sticky: 'status' },
  { id: 'shop', label: 'Shop', filter: true, sticky: 'shop' },
  { id: 'date', label: 'Date', filter: true },
  { id: 'type', label: 'Type', filter: true },
  { id: 'method', label: 'Method', filter: true },
  { id: 'who', label: 'Who', filter: true },
  { id: 'products', label: 'Products', filter: true },
  { id: 'action', label: 'Action Taken', filter: true },
  { id: 'notes', label: 'Notes', filter: true },
]

export function LocationCommsPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const { config } = useCommsConfig()

  const [rowsAll, setRowsAll] = useState<LocationComm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState('All')
  const [filtersOn, setFiltersOn] = useState(false)
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<LocationComm> | null>(null)

  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    const { data, error: e } = await (supabase as any).schema('inventory').from('location_comms')
      .select('*').eq('company_id', companyId).order('comm_date', { ascending: false, nullsFirst: false })
    if (e) setError(e.message)
    else setRowsAll((data ?? []) as LocationComm[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  // Optimistic local patch + silent direct write (no reload).
  function silentUpdate(id: string, patch: Partial<LocationComm>) {
    setRowsAll((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    ;(supabase as any).schema('inventory').from('location_comms')
      .update({ ...patch, updated_by: profile?.id ?? null, last_change_source: 'manual', updated_at: new Date().toISOString() })
      .eq('id', id).then(({ error: e }: any) => { if (e) toast.error(e.message) })
    if ('status' in patch) refreshNavBadges()
  }
  const set = (r: LocationComm, patch: Partial<LocationComm>) => silentUpdate(r.id, patch)

  async function deleteComm(id: string) {
    const { error: e } = await (supabase as any).schema('inventory').from('location_comms').delete().eq('id', id)
    if (e) { toast.error('Failed to delete'); return }
    toast.success('Deleted'); load(); refreshNavBadges()
  }

  const statusChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rowsAll) { const s = r.status || 'No Status'; counts.set(s, (counts.get(s) ?? 0) + 1) }
    const present = [...counts.keys()].sort((a, b) => EXCEPTION_STATUSES.indexOf(a as any) - EXCEPTION_STATUSES.indexOf(b as any))
    return [{ key: 'All', count: rowsAll.length }, ...present.map((s) => ({ key: s, count: counts.get(s)! }))]
  }, [rowsAll])

  const cellText = (r: LocationComm, col: string): string => {
    switch (col) {
      case 'status': return r.status ?? ''
      case 'shop': return shopLabel(r.location_id)
      case 'date': return dShort(r.comm_date)
      case 'type': return r.comm_type ?? ''
      case 'method': return r.contact_method ?? ''
      case 'who': return r.who_contacted ?? ''
      case 'products': return (r.products ?? []).map((p) => p.product_id).join(' ')
      case 'action': return r.action_taken ?? ''
      case 'notes': return r.notes ?? ''
      default: return ''
    }
  }

  const rows = useMemo(() => {
    const byStatus = statusFilter === 'All' ? rowsAll : rowsAll.filter((r) => (r.status || 'No Status') === statusFilter)
    return byStatus.filter((r) => Object.entries(filters).every(([c, val]) => !val || cellText(r, c).toLowerCase().includes(val.toLowerCase())))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsAll, statusFilter, filters, loc])

  const thBase = 'px-2 py-2 text-left font-mono uppercase tracking-wide text-inky whitespace-nowrap border-b border-navy/30 bg-cream sticky top-0 z-20'
  const tdBase = 'px-2 py-1 align-top border-b border-navy/15 whitespace-nowrap'
  const thClass = (c: ColDef) => c.sticky === 'status' ? `${thBase} left-0 z-30 w-[200px] min-w-[200px]` : c.sticky === 'shop' ? `${thBase} left-[200px] z-30` : thBase

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-40 bg-cream pt-1 pb-2">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Location Comms</h1>
            <p className="text-xs text-inky mt-0.5">Log of shop/AM communications — product requests, exception reporting, and more. Cells are editable inline.</p>
          </div>
          <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true) }}>+ New Communication</Button>
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-2 mb-3 mt-2">
        <div className="flex items-center gap-1 flex-wrap">
          {statusChips.map((c) => (
            <button key={c.key} onClick={() => setStatusFilter(c.key)}
              className={['px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors', statusFilter === c.key ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
              {c.key} <span className="opacity-70">{c.count}</span>
            </button>
          ))}
        </div>
        <button onClick={() => setFiltersOn((o) => !o)}
          className={['inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono border transition-colors', filtersOn ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
          <Filter className="w-3 h-3" /> {filtersOn ? 'Hide Filters' : 'Filter Columns'}
        </button>
      </div>

      {loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
      ) : error ? (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
      ) : rowsAll.length === 0 ? (
        <p className="text-xs font-mono text-inky/50 py-8">No communications logged yet.</p>
      ) : (
        <div className="overflow-auto max-h-[calc(100vh-16rem)] rounded border border-navy/30">
          <table className="text-xs font-mono border-collapse">
            <thead>
              <tr>
                {COLS.map((c) => (
                  <th key={c.id} className={thClass(c)}>
                    <div className="flex flex-col gap-1">
                      <span>{c.label}</span>
                      {filtersOn && c.filter && (
                        <input value={filters[c.id] ?? ''} onChange={(e) => setFilters((f) => ({ ...f, [c.id]: e.target.value }))} placeholder="filter…"
                          className="bg-cream border border-navy/30 rounded px-1 py-0.5 text-[10px] font-mono text-navy font-normal normal-case tracking-normal w-full focus:outline-none focus:ring-1 focus:ring-sky" />
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={COLS.length} className="px-2 py-6 text-center text-inky/50">No rows match the filters.</td></tr>
              ) : rows.map((r, idx) => {
                const band = idx % 2 ? 'bg-navy/[0.04]' : 'bg-cream'
                return (
                  <tr key={r.id} className={band}>
                    <td className={`${tdBase} sticky left-0 z-10 bg-cream w-[200px] min-w-[200px]`}>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditing(r); setModalOpen(true) }} title="Full edit" className="text-inky hover:text-navy flex-shrink-0"><Pencil className="w-3.5 h-3.5" /></button>
                        <EditSelect value={r.status} options={EXCEPTION_STATUSES as unknown as string[]} placeholder="—" onSave={(v) => set(r, { status: v })} className="min-w-[150px]" />
                      </div>
                    </td>
                    <td className={`${tdBase} sticky left-[200px] z-10 bg-cream text-navy`} title={shopLabel(r.location_id)}>{shopLabel(r.location_id)}</td>
                    <td className={tdBase}><EditDate value={r.comm_date} onSave={(v) => set(r, { comm_date: v })} /></td>
                    <td className={tdBase}><EditSelect value={r.comm_type} options={config.commTypes} placeholder="—" allowCurrent onSave={(v) => set(r, { comm_type: v })} /></td>
                    <td className={tdBase}><EditSelect value={r.contact_method} options={config.contactMethods} placeholder="—" allowCurrent onSave={(v) => set(r, { contact_method: v })} /></td>
                    <td className={tdBase}><EditSelect value={r.who_contacted} options={config.whoContacted} placeholder="—" allowCurrent onSave={(v) => set(r, { who_contacted: v })} /></td>
                    <td className={`${tdBase} max-w-[16rem] truncate text-navy`} title={(r.products ?? []).map((p) => p.product_id).join(', ')}>
                      {(r.products ?? []).length ? (r.products ?? []).map((p) => p.product_id).join(', ') : '—'}
                    </td>
                    <td className={tdBase}><EditSelect value={r.action_taken} options={config.actionTaken} placeholder="—" allowCurrent onSave={(v) => set(r, { action_taken: v })} /></td>
                    <td className={`${tdBase} whitespace-normal`}><CappedTextarea value={r.notes ?? ''} onSave={(v) => set(r, { notes: v })} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <LocationCommsModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSaved={() => { load(); refreshNavBadges() }} onDelete={deleteComm} />
    </div>
  )
}
