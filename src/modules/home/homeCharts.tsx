// Chart cards for the Home page (horizontal bars via recharts). Bars use the theme tokens (navy / inky flip with dark mode), so they read on both.
import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { format, startOfMonth, subDays } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { SbLoader } from '@/components/ui'
import { CardEmpty, HomeCard } from './HomeCard'

const sb = () => supabase as any
export interface ChartCardProps { edit: boolean; onRemove: () => void }

const NAVY = 'rgb(var(--color-navy))'
const INKY = 'rgb(var(--color-inky))'
const ORANGE = '#E67E22' // sb-orange
const AXIS = { fontSize: 10, fontFamily: 'DM Mono, monospace', fill: 'rgb(var(--color-inky))' }
const TIP = { background: 'rgb(var(--color-pop))', border: '1px solid rgb(var(--color-navy) / 0.2)', borderRadius: 8, fontSize: 11, fontFamily: 'DM Mono, monospace', color: 'rgb(var(--color-navy))' }
const n0 = (v: number) => Math.round(v).toLocaleString()

function useRpc<T>(fn: string, args: Record<string, unknown> | undefined, deps: unknown[]) {
  const [state, setState] = useState<{ data: T[] | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.resolve().then(() => sb().schema('inventory').rpc(fn, args ?? {})).then(({ data, error }: { data: T[] | null; error: { message: string } | null }) => {
      if (!live) return
      setState(error ? { data: null, loading: false, error: error.message } : { data: data ?? [], loading: false, error: null })
    }).catch((e: unknown) => { if (live) setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
const Status = ({ s }: { s: { loading: boolean; error: string | null } }) =>
  s.loading ? <div className="py-6 flex justify-center"><SbLoader size={20} /></div> : s.error ? <CardEmpty>Couldn't load this: {s.error}</CardEmpty> : null

const today = () => new Date()
const iso = (d: Date) => format(d, 'yyyy-MM-dd')

// ── Configured products sitting at zero on hand ──────────────────────────────────────────────────────────────────────────
export function ZeroOnHandCard({ edit, onRemove }: ChartCardProps) {
  const s = useRpc<{ product_id: string; shops_at_zero: number; shops_configured: number }>('get_home_zero_on_hand_by_product', undefined, [])
  const rows = (s.data ?? []).filter((r) => r.shops_at_zero > 0)
  const total = rows.reduce((n, r) => n + r.shops_at_zero, 0)
  const top = rows.slice(0, 10)
  return (
    <HomeCard title="Configured products at zero on hand" to="/on-hand" action="On Hand" edit={edit} onRemove={onRemove}>
      <Status s={s} />
      {!s.loading && !s.error && (rows.length === 0 ? <CardEmpty>No configured product is at zero on hand.</CardEmpty> : (
        <>
          <div className="text-xs font-body text-inky"><b className="text-navy text-base font-heading">{total.toLocaleString()}</b> shop/product pairs at zero across {rows.length} products</div>
          <ResponsiveContainer width="100%" height={top.length * 26 + 24}>
            <BarChart data={top} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke="rgb(var(--color-navy) / 0.1)" />
              <XAxis type="number" tick={AXIS} allowDecimals={false} />
              <YAxis type="category" dataKey="product_id" width={118} tick={AXIS} />
              <Tooltip contentStyle={TIP} cursor={{ fill: 'rgb(var(--color-navy) / 0.06)' }} formatter={(v: number, _n, p) => [`${v} of ${(p.payload as { shops_configured: number }).shops_configured} shops`, 'At zero']} />
              <Bar dataKey="shops_at_zero" name="Shops at zero" fill={ORANGE} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      ))}
    </HomeCard>
  )
}

// ── Product sold vs ordered, month to date ───────────────────────────────────────────────────────────────────────────────
export function SoldVsOrderedCard({ edit, onRemove }: ChartCardProps) {
  const start = iso(startOfMonth(today())), end = iso(today())
  const s = useRpc<{ product_id: string; sold_gal: number; ordered_gal: number }>('get_home_sold_vs_ordered', { p_start: start, p_end: end }, [start, end])
  const rows = (s.data ?? []).map((r) => ({ ...r, sold_gal: Number(r.sold_gal), ordered_gal: Number(r.ordered_gal) })).filter((r) => r.sold_gal > 0 || r.ordered_gal > 0).slice(0, 10)
  return (
    <HomeCard title="Sold vs ordered · month to date" to="/orders-v2" action="Orders v2" edit={edit} onRemove={onRemove}>
      <Status s={s} />
      {!s.loading && !s.error && (rows.length === 0 ? <CardEmpty>Nothing sold or ordered yet this month.</CardEmpty> : (
        <>
          <span className="text-[11px] font-body text-inky">Gallons, highest sold first. Sold = Droptop usage ledger; ordered = the RelaDyne open order report (orders dated this month that are still open).</span>
          <ResponsiveContainer width="100%" height={rows.length * 44 + 36}>
            <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 0 }} barGap={2}>
              <CartesianGrid horizontal={false} stroke="rgb(var(--color-navy) / 0.1)" />
              <XAxis type="number" tick={AXIS} tickFormatter={n0} />
              <YAxis type="category" dataKey="product_id" width={118} tick={AXIS} />
              <Tooltip contentStyle={TIP} cursor={{ fill: 'rgb(var(--color-navy) / 0.06)' }} formatter={(v: number) => `${n0(v)} gal`} />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: 'DM Mono, monospace' }} />
              <Bar dataKey="sold_gal" name="Sold" fill={NAVY} radius={[0, 4, 4, 0]} />
              <Bar dataKey="ordered_gal" name="Ordered (open orders)" fill={INKY} radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </>
      ))}
    </HomeCard>
  )
}

// ── Gallons ordered by product (Orders v2 history) ───────────────────────────────────────────────────────────────────────
export function GallonsOrderedCard({ edit, onRemove }: ChartCardProps) {
  const [range, setRange] = useState<'mtd' | '30'>('mtd')
  const start = range === 'mtd' ? iso(startOfMonth(today())) : iso(subDays(today(), 30)), end = iso(today())
  const s = useRpc<{ product_id: string; gallons: number }>('get_home_gallons_ordered', { p_start: start, p_end: end }, [start, end])
  const rows = (s.data ?? []).map((r) => ({ ...r, gallons: Number(r.gallons) })).slice(0, 12)
  const total = (s.data ?? []).reduce((n, r) => n + Number(r.gallons), 0)
  const tab = (id: 'mtd' | '30', label: string) => (
    <button type="button" onClick={() => setRange(id)} className={`rounded-full px-2.5 py-0.5 text-[11px] font-body border ${range === id ? 'bg-sb-navy text-sb-cream border-sb-navy' : 'border-navy/25 text-navy hover:bg-soft'}`}>{label}</button>
  )
  return (
    <HomeCard title="Gallons ordered by product" to="/orders-v2" action="Orders v2" edit={edit} onRemove={onRemove}>
      <div className="flex items-center gap-1.5">{tab('mtd', 'Month to date')}{tab('30', 'Last 30 days')}{!s.loading && <span className="ml-auto text-xs font-body text-inky"><b className="text-navy font-heading text-base">{n0(total)}</b> gal</span>}</div>
      <Status s={s} />
      {!s.loading && !s.error && (rows.length === 0 ? <CardEmpty>No orders placed in this range.</CardEmpty> : (
        <ResponsiveContainer width="100%" height={rows.length * 26 + 24}>
          <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 0 }}>
            <CartesianGrid horizontal={false} stroke="rgb(var(--color-navy) / 0.1)" />
            <XAxis type="number" tick={AXIS} tickFormatter={n0} />
            <YAxis type="category" dataKey="product_id" width={118} tick={AXIS} />
            <Tooltip contentStyle={TIP} cursor={{ fill: 'rgb(var(--color-navy) / 0.06)' }} formatter={(v: number) => `${n0(v)} gal`} />
            <Bar dataKey="gallons" name="Gallons" fill={NAVY} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ))}
    </HomeCard>
  )
}
