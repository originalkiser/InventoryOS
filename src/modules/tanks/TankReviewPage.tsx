// Shop Tools → Tank Count Review. Counts shops log from their Tank Calculator link:
//   Held     — outliers (a zero, a sudden change, a repeat, a sudden variance shift) wait here for Approve / Reject before they
//              count toward variance tracking.
//   Counts   — everything logged, with the monitor comparison and variance.
//   Tanks    — each tank's saved dimensions next to its tank monitor's setup, so mismatched setups stand out.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import toast from 'react-hot-toast'
import { Button, SbLoader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useLocations } from '@/hooks/useLocations'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { SHAPES, type TankShape, type TankDims } from './tankMath'
import { HOLD_REASON_LABEL, areaLabel } from './tankTypes'

const sb = () => supabase as any
const f1 = (v: number | null | undefined, d = 1) => (v == null ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }))

interface Tank { id: string; location_id: string; name: string; area: string; shape: TankShape | null; dims: TankDims; capacity_qts: number | null; monitor_serial: string | null; baseline_variance_qts: number | null }
interface Log {
  id: string; tank_id: string; location_id: string; logged_at: string; depth_in: number; volume_qts: number; monitor_qts: number | null; monitor_online: boolean | null
  sales_adjust_qts: number | null; variance_qts: number | null; status: string; hold_reasons: string[]; set_baseline: boolean
}
interface Mon { serial_rtu_id: string; total_capacity: number | null; height: number | null; on_hand: number | null; inventory_time: string | null }

interface LogRow extends Log { shop: string; tank: string }
interface TankRow extends Tank { shop: string; last: Log | null; mon: Mon | null }
const logCol = createColumnHelper<LogRow>()
const tankCol = createColumnHelper<TankRow>()

export function TankReviewPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [tanks, setTanks] = useState<Tank[]>([])
  const [logs, setLogs] = useState<Log[]>([])
  const [mons, setMons] = useState<Map<string, Mon>>(new Map())
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [t, g] = await Promise.all([
      sb().schema('inventory').from('shop_tanks').select('id, location_id, name, area, shape, dims, capacity_qts, monitor_serial, baseline_variance_qts').eq('company_id', companyId).eq('active', true),
      sb().schema('inventory').from('shop_tank_logs').select('*').eq('company_id', companyId).order('logged_at', { ascending: false }).limit(1500),
    ])
    const tk = (t.data ?? []) as Tank[]
    setTanks(tk); setLogs((g.data ?? []) as Log[])
    const serials = [...new Set(tk.map((x) => (x.monitor_serial ?? '').trim()).filter(Boolean))]
    const m = new Map<string, Mon>()
    for (let i = 0; i < serials.length; i += 100) {
      const { data } = await sb().schema('inventory').from('tank_monitors').select('serial_rtu_id, total_capacity, height, on_hand, inventory_time').eq('company_id', companyId).in('serial_rtu_id', serials.slice(i, i + 100))
      for (const r of (data ?? []) as Mon[]) { const prev = m.get(r.serial_rtu_id); if (!prev || (r.inventory_time ?? '') > (prev.inventory_time ?? '')) m.set(r.serial_rtu_id, r) }
    }
    setMons(m)
    setLoading(false)
  }, [companyId])
  useEffect(() => { void load() }, [load])

  const shopOf = useCallback((id: string) => String(loc.locations.find((l) => l.id === id)?.name ?? '—'), [loc.locations])
  const tankById = useMemo(() => new Map(tanks.map((t) => [t.id, t])), [tanks])
  const logRows: LogRow[] = useMemo(() => logs.map((l) => ({ ...l, shop: shopOf(l.location_id), tank: tankById.get(l.tank_id)?.name ?? '—' })), [logs, shopOf, tankById])
  const held = useMemo(() => logRows.filter((l) => l.status === 'held'), [logRows])
  const tankRows: TankRow[] = useMemo(() => {
    const lastBy = new Map<string, Log>()
    for (const l of logs) if (l.status !== 'rejected' && !lastBy.has(l.tank_id)) lastBy.set(l.tank_id, l)
    return tanks.map((t) => ({ ...t, shop: shopOf(t.location_id), last: lastBy.get(t.id) ?? null, mon: t.monitor_serial ? mons.get(t.monitor_serial.trim()) ?? null : null }))
      .sort((a, b) => a.shop.localeCompare(b.shop, undefined, { numeric: true }) || a.name.localeCompare(b.name))
  }, [tanks, logs, mons, shopOf])

  async function review(id: string, status: 'ok' | 'rejected') {
    const { error } = await sb().schema('inventory').from('shop_tank_logs').update({ status, reviewed_by: profile?.id ?? null, reviewed_at: new Date().toISOString() }).eq('id', id)
    if (error) { toast.error(error.message); return }
    toast.success(status === 'ok' ? 'Approved' : 'Rejected'); void load()
  }

  const logColumns = useMemo(() => (withActions: boolean) => [
    logCol.accessor('shop', { header: 'Shop', size: 70 }),
    logCol.accessor('tank', { header: 'Tank', size: 140 }),
    logCol.accessor('logged_at', { header: 'Logged', size: 150, cell: (i) => new Date(i.getValue()).toLocaleString() }),
    logCol.accessor('depth_in', { header: 'Depth (in)', size: 90, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    logCol.accessor('volume_qts', { header: 'Measured (qts)', size: 110, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    logCol.accessor('monitor_qts', { header: 'Monitor (qts)', size: 110, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    logCol.accessor('sales_adjust_qts', { header: 'Sold since (qts)', size: 110, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    logCol.accessor('variance_qts', { header: 'Variance (qts)', size: 110, meta: { numeric: true },
      cell: (i) => <span className={`block text-right ${Math.abs(i.getValue() ?? 0) > 50 ? 'font-bold text-[#C0392B]' : ''}`}>{f1(i.getValue())}</span> }),
    logCol.accessor('status', { header: 'Status', size: 80 }),
    logCol.accessor((l) => (l.hold_reasons ?? []).map((r) => HOLD_REASON_LABEL[r] ?? r).join('; '), { id: 'reasons', header: 'Held because', size: 280 }),
    ...(withActions ? [logCol.display({
      id: 'actions', header: '', size: 170, enableSorting: false,
      cell: (i) => (
        <div className="flex gap-1.5">
          <Button size="sm" onClick={() => void review(i.row.original.id, 'ok')}>Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => void review(i.row.original.id, 'rejected')}>Reject</Button>
        </div>
      ),
    })] : []),
  ], []) // eslint-disable-line react-hooks/exhaustive-deps

  const heldTable = useTable(held, useMemo(() => logColumns(true), [logColumns]), { persistKey: 'tank-review-held', initialPageSize: 100 })
  const allTable = useTable(logRows, useMemo(() => logColumns(false), [logColumns]), { persistKey: 'tank-review-all', initialPageSize: 100 })

  const tankColumns = useMemo(() => [
    tankCol.accessor('shop', { header: 'Shop', size: 70 }),
    tankCol.accessor('name', { header: 'Tank', size: 140 }),
    tankCol.accessor((t) => areaLabel(t.area), { id: 'area', header: 'Where', size: 100 }),
    tankCol.accessor((t) => (t.shape ? SHAPES[t.shape]?.label ?? t.shape : 'Not set up yet'), { id: 'shape', header: 'Shape', size: 170 }),
    tankCol.accessor((t) => (t.shape ? SHAPES[t.shape]?.dims.map((d) => f1(t.dims[d.key])).join(' × ') + ' in' : '—'), { id: 'dims', header: 'Dimensions', size: 170 }),
    tankCol.accessor((t) => (t.capacity_qts == null ? null : t.capacity_qts / 4), { id: 'cap', header: 'Our capacity (gal)', size: 130, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    tankCol.accessor('monitor_serial', { header: 'Monitor serial', size: 120, cell: (i) => i.getValue() ?? '—' }),
    tankCol.accessor((t) => (t.mon?.total_capacity == null ? null : Number(t.mon.total_capacity)), { id: 'mcap', header: 'Monitor capacity (gal)', size: 150, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    tankCol.accessor((t) => {
      const ours = t.capacity_qts == null ? null : t.capacity_qts / 4
      const theirs = t.mon?.total_capacity == null ? null : Number(t.mon.total_capacity)
      return ours != null && theirs ? Math.round(((ours - theirs) / theirs) * 1000) / 10 : null
    }, { id: 'capdiff', header: 'Capacity diff %', size: 120, meta: { numeric: true },
      cell: (i) => <span className={`block text-right ${Math.abs(i.getValue() ?? 0) > 10 ? 'font-bold text-[#E67E22]' : ''}`}>{i.getValue() == null ? '—' : `${i.getValue()}%`}</span> }),
    tankCol.accessor((t) => (t.mon?.height == null ? null : Number(t.mon.height)), { id: 'mheight', header: 'Monitor height (in)', size: 140, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    tankCol.accessor('baseline_variance_qts', { header: 'Baseline variance (qts)', size: 150, meta: { numeric: true }, cell: (i) => <span className="block text-right">{f1(i.getValue())}</span> }),
    tankCol.accessor((t) => t.last?.logged_at ?? '', { id: 'last', header: 'Last count', size: 130, cell: (i) => (i.getValue() ? new Date(String(i.getValue())).toLocaleDateString() : '—') }),
  ], [])
  const tanksTable = useTable(tankRows, tankColumns, { persistKey: 'tank-review-tanks', initialPageSize: 100 })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Tank Count Review</h1>
        <p className="text-xs text-inky mt-0.5">Counts shops log from their Tank Calculator link. Held counts don't feed variance tracking until you approve them.</p>
      </div>
      {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div> : (
        <Tabs defaultValue="held">
          <TabsList>
            <TabsTrigger value="held">Held ({held.length})</TabsTrigger>
            <TabsTrigger value="counts">All counts</TabsTrigger>
            <TabsTrigger value="tanks">Tanks &amp; monitor setups ({tankRows.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="held">
            {held.length === 0 ? <p className="text-xs font-mono text-navy/75 py-6">Nothing is waiting for review.</p>
              : <DataTable table={heldTable.table} globalFilter={heldTable.globalFilter} onGlobalFilterChange={heldTable.setGlobalFilter} exportFilename="Held tank counts" />}
          </TabsContent>
          <TabsContent value="counts">
            <DataTable table={allTable.table} globalFilter={allTable.globalFilter} onGlobalFilterChange={allTable.setGlobalFilter} exportFilename="Tank counts" />
          </TabsContent>
          <TabsContent value="tanks">
            <DataTable table={tanksTable.table} globalFilter={tanksTable.globalFilter} onGlobalFilterChange={tanksTable.setGlobalFilter} exportFilename="Tank setups" />
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
