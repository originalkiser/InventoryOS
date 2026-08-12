import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { Button, SbLoader } from '@/components/ui'
import { LocationCommsModal } from './LocationCommsModal'
import type { LocationComm } from './comms'
import { format } from 'date-fns'
import toast from 'react-hot-toast'

const dShort = (d: string | null) => { if (!d) return '—'; try { return format(new Date(d + 'T00:00:00'), 'MMM d, yyyy') } catch { return d } }

export function LocationCommsPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()

  const [rows, setRows] = useState<LocationComm[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState('All')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Partial<LocationComm> | null>(null)

  const shopLabel = (id: string | null) => loc.fieldValue(id, 'shop_city') || (id ? loc.codeOf(id) : '') || '—'

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true); setError(null)
    const { data, error: e } = await (supabase as any).schema('inventory').from('location_comms')
      .select('*').eq('company_id', companyId).order('comm_date', { ascending: false, nullsFirst: false })
    if (e) setError(e.message)
    else setRows((data ?? []) as LocationComm[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function deleteComm(id: string) {
    const { error: e } = await (supabase as any).schema('inventory').from('location_comms').delete().eq('id', id)
    if (e) { toast.error('Failed to delete'); return }
    toast.success('Deleted'); load()
  }

  const types = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of rows) { const t = r.comm_type || 'Other'; counts.set(t, (counts.get(t) ?? 0) + 1) }
    return [{ key: 'All', count: rows.length }, ...[...counts.entries()].map(([key, count]) => ({ key, count }))]
  }, [rows])

  const shown = typeFilter === 'All' ? rows : rows.filter((r) => (r.comm_type || 'Other') === typeFilter)

  if (!companyId) return <div className="text-xs font-mono text-inky py-8">No workspace loaded.</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Location Comms</h1>
          <p className="text-xs text-inky mt-0.5">Log of shop/AM communications — product requests, exception reporting, and more.</p>
        </div>
        <Button size="sm" onClick={() => { setEditing(null); setModalOpen(true) }}>+ Add</Button>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        {types.map((t) => (
          <button key={t.key} onClick={() => setTypeFilter(t.key)}
            className={['px-2.5 py-1 rounded-full text-[11px] font-mono border transition-colors', typeFilter === t.key ? 'bg-navy text-cream border-navy' : 'bg-cream text-inky border-navy/30 hover:border-navy'].join(' ')}>
            {t.key} <span className="opacity-70">{t.count}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
      ) : error ? (
        <div className="text-xs font-mono text-red-400 border border-red-500/30 bg-red-500/5 rounded px-3 py-2">{error}</div>
      ) : shown.length === 0 ? (
        <p className="text-xs font-mono text-inky/50 py-8">No communications logged yet.</p>
      ) : (
        <div className="overflow-x-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="px-2 py-2 w-8"></th>
              <th className="text-left px-2 py-2">Date</th>
              <th className="text-left px-2 py-2">Shop</th>
              <th className="text-left px-2 py-2">Type</th>
              <th className="text-left px-2 py-2">Method</th>
              <th className="text-left px-2 py-2">Who</th>
              <th className="text-left px-2 py-2">Products</th>
              <th className="text-left px-2 py-2">Status</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-navy/15 hover:bg-navy/[0.02]">
                  <td className="px-2 py-1"><button onClick={() => { setEditing(r); setModalOpen(true) }} className="text-inky hover:text-navy"><Pencil className="w-3.5 h-3.5" /></button></td>
                  <td className="px-2 py-1 text-navy whitespace-nowrap">{dShort(r.comm_date)}</td>
                  <td className="px-2 py-1 text-navy">{shopLabel(r.location_id)}</td>
                  <td className="px-2 py-1 text-navy">{r.comm_type || '—'}</td>
                  <td className="px-2 py-1 text-navy">{r.contact_method || '—'}</td>
                  <td className="px-2 py-1 text-navy">{r.who_contacted || '—'}</td>
                  <td className="px-2 py-1 text-navy max-w-[16rem] truncate" title={(r.products ?? []).map((p) => p.product_id).join(', ')}>
                    {(r.products ?? []).length ? (r.products ?? []).map((p) => p.product_id).join(', ') : '—'}
                  </td>
                  <td className="px-2 py-1 text-navy whitespace-nowrap">{r.status || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <LocationCommsModal open={modalOpen} onClose={() => setModalOpen(false)} existing={editing}
        onSaved={load} onDelete={deleteComm} />
    </div>
  )
}
