// The cards on the Home page. Each is self-contained: it loads its own (small) data, shows a loading / empty / error state, and links to the page
// it summarizes. Add a card by adding an entry to HOME_CARDS — the layout, the "Add card" menu and the saved layouts all key off its id.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { CheckCircle2 } from 'lucide-react'
import { format, formatDistanceToNowStrict } from 'date-fns'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useNavBadge, useNavBadgesStore } from '@/hooks/useNavBadges'
import { useInventoryAlertsStore } from '@/hooks/useInventoryAlerts'
import { useRecentPagesStore } from '@/stores/recentPagesStore'
import { useSidebarPrefs } from '@/hooks/useSidebarPrefs'
import { Button, Modal, SbLoader } from '@/components/ui'
import { useShopExceptions } from '@/modules/exceptions/shopExceptions/useShopExceptions'
import { ExceptionTile, SEV_LABEL, TYPE_META, TYPE_ORDER } from '@/modules/exceptions/shopExceptions/shopExceptionTypes'
import { ICONS, SECTION_ICONS } from '@/components/layout/navIcons'
import { usePinMenu } from '@/components/layout/PinContextMenu'
import { CONNECTION_META, CONNECTION_ORDER, statusColor } from '@/hooks/useDataConnectionRunner'
import { SECTION_ITEMS, UTILITY_ITEMS, sectionKeyOfItem } from '@/components/layout/navData'
import { NAV_META } from '@/components/layout/navMeta'
import { useNavModel } from '@/components/layout/useNavModel'
import { Big, CardEmpty, HomeCard } from './HomeCard'
import { GallonsOrderedCard, SoldVsOrderedCard, ZeroOnHandCard } from './homeCharts'

const sb = () => supabase as any
export interface HomeCardProps { edit: boolean; onRemove: () => void }

const ALL_ITEMS = [...Object.values(SECTION_ITEMS).flat(), ...UTILITY_ITEMS]
const itemByKey = new Map(ALL_ITEMS.map((i) => [i.key, i]))
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`)
const ago = (iso: string | number) => { try { return `${formatDistanceToNowStrict(new Date(iso))} ago` } catch { return '' } }

/** Small hook for the "load once, show loading / error" pattern the data cards share. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; loading: boolean; error: string | null }>({ data: null, loading: true, error: null })
  useEffect(() => {
    let live = true
    setState((s) => ({ ...s, loading: true, error: null }))
    load().then((data) => { if (live) setState({ data, loading: false, error: null }) })
      .catch((e) => { if (live) setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) }) })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return state
}
const Body = ({ s, children }: { s: { loading: boolean; error: string | null }; children: ReactNode }) =>
  s.loading ? <div className="py-4 flex justify-center"><SbLoader size={20} /></div> : s.error ? <CardEmpty>Couldn't load this: {s.error}</CardEmpty> : <>{children}</>

/** A modal over the Home page with a button that goes to the full page (the cards open these instead of navigating away). */
function HomeModal({ open, onClose, title, to, goLabel, children }: { open: boolean; onClose: () => void; title: string; to?: string; goLabel?: string; children: ReactNode }) {
  const navigate = useNavigate()
  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <div className="flex flex-col gap-3">
        <div className="max-h-[60vh] overflow-y-auto flex flex-col gap-1 pr-1">{children}</div>
        {to && <div className="flex justify-end"><Button size="sm" onClick={() => { onClose(); navigate(to) }}>{goLabel ?? 'Go to page'}</Button></div>}
      </div>
    </Modal>
  )
}

// ── Welcome ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function WelcomeCard({ edit, onRemove }: HomeCardProps) {
  const { profile } = useAuthStore()
  const { exceptions } = useShopExceptions()
  const tasks = useNavBadge('tasks')
  const alerts = useInventoryAlertsStore((s) => s.derivedCount)
  const hour = new Date().getHours()
  const first = (profile?.full_name ?? '').split(' ')[0] || 'there'
  const pending = exceptions.filter((e) => e.status === 'pending')
  const high = pending.filter((e) => e.severity === 3).length
  const chip = 'inline-flex items-center gap-1.5 rounded-full border border-sb-cream/25 bg-sb-cream/10 px-3 py-1 text-xs font-body'
  return (
    <HomeCard title="Today" edit={edit} onRemove={onRemove} dark>
      <div className="font-heading font-bold text-[26px] leading-tight uppercase tracking-wide">{hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {first}</div>
      <div className="text-xs font-body text-sky">{format(new Date(), 'EEEE, MMMM d, yyyy')}</div>
      <div className="flex flex-wrap gap-2 mt-auto">
        <Link to="/exception-reporting" className={chip}><b>{pending.length}</b> exceptions{high > 0 && <span className="text-[#ff8a80]">· {high} high</span>}</Link>
        <Link to="/tasks" className={chip}><b>{tasks}</b> tasks</Link>
        <Link to="/inventory-alerts" className={chip}><b>{alerts}</b> inventory alerts</Link>
      </div>
    </HomeCard>
  )
}

// ── Business pulse (from the Droptop Orders summary cache — one cheap read) ────────────────────────────────────────────
function PulseCard({ edit, onRemove }: HomeCardProps) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const s = useLoad(async () => {
    if (!companyId) return null
    const { data, error } = await sb().schema('inventory').from('droptop_orders_summary_cache')
      .select('computed_date, totals:payload->totals').eq('company_id', companyId).eq('period_key', 'last_7_days').order('computed_date', { ascending: false }).limit(1)
    if (error) throw new Error(error.message)
    return (data?.[0] ?? null) as { computed_date: string; totals: { count: number; revenue: number; avg_order_value: number; m5_pct: number } } | null
  }, [companyId])
  const t = s.data?.totals
  const Stat = ({ label, value }: { label: string; value: string }) => (
    <div className="flex flex-col gap-0.5"><span className="text-[11px] font-body text-inky uppercase tracking-wide">{label}</span><span className="font-heading font-bold text-2xl leading-none">{value}</span></div>
  )
  return (
    <HomeCard title="Last 7 days · company" to="/droptop-orders" action="Droptop Orders" edit={edit} onRemove={onRemove}>
      <Body s={s}>
        {t ? (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Stat label="Cars" value={Number(t.count).toLocaleString()} />
              <Stat label="Revenue" value={money(Number(t.revenue))} />
              <Stat label="Avg ticket" value={`$${Number(t.avg_order_value).toFixed(2)}`} />
              <Stat label="M5%" value={`${Number(t.m5_pct).toFixed(1)}%`} />
            </div>
            <span className="text-[11px] font-body text-inky mt-auto">As of {s.data!.computed_date}</span>
          </>
        ) : <CardEmpty>Not calculated yet today. Open Droptop Orders and pick Last 7 Days to build it.</CardEmpty>}
      </Body>
    </HomeCard>
  )
}

// ── Needs attention (the same counts the nav badges show) ─────────────────────────────────────────────────────────────
function AttentionCard({ edit, onRemove }: HomeCardProps) {
  useNavBadge('tasks') // makes sure the counts are loaded
  const counts = useNavBadgesStore((s) => s.counts)
  const alerts = useInventoryAlertsStore((s) => s.derivedCount)
  const { entries } = useNavModel()
  const [openKey, setOpenKey] = useState<string | null>(null)
  const allowed = useMemo(() => new Set(entries.map((e) => e.itemKey)), [entries])
  const rows = useMemo(() => {
    const merged: Record<string, number> = { ...counts, 'inventory-alerts': alerts }
    return Object.entries(merged).filter(([k, n]) => n > 0 && allowed.has(k) && itemByKey.get(k)?.to).sort((a, b) => b[1] - a[1]).slice(0, 9)
  }, [counts, alerts, allowed])
  const open = openKey ? itemByKey.get(openKey) : null
  return (
    <HomeCard title="Needs attention" edit={edit} onRemove={onRemove}>
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 text-xs font-body text-inky py-2"><CheckCircle2 className="w-4 h-4 text-[#27A860]" />Nothing waiting on you</div>
      ) : rows.map(([k, n]) => {
        const item = itemByKey.get(k)!
        return (
          <button key={k} type="button" onClick={() => setOpenKey(k)} className="flex items-center gap-2.5 rounded-[10px] px-2 py-1.5 text-left hover:bg-soft transition-colors">
            <span className="text-inky flex-shrink-0">{ICONS[k] ?? ICONS.dashboard}</span>
            <span className="flex-1 min-w-0"><span className="block text-[13px] font-body truncate">{item.label}</span>{NAV_META[k]?.desc && <span className="block text-[10.5px] font-body text-inky truncate">{NAV_META[k].desc}</span>}</span>
            <span className="flex-shrink-0 rounded-full bg-[#C0392B] text-sb-cream text-[11px] font-mono leading-none px-2 py-1 min-w-[22px] text-center">{n}</span>
          </button>
        )
      })}
      <HomeModal open={!!open} onClose={() => setOpenKey(null)} title={open ? `Needs attention · ${open.label}` : ''} to={open?.to ?? undefined} goLabel={open ? `Go to ${open.label}` : undefined}>
        {open && <AttentionDetail itemKey={open.key} count={counts[open.key] ?? (open.key === 'inventory-alerts' ? alerts : 0)} />}
      </HomeModal>
    </HomeCard>
  )
}

/** What's waiting behind one Needs-attention row. Inventory alerts list their groups; everything else shows the count and what the page is for. */
function AttentionDetail({ itemKey, count }: { itemKey: string; count: number }) {
  const rawGroups = useInventoryAlertsStore((s) => s.rawGroups)
  const desc = NAV_META[itemKey]?.desc
  return (
    <>
      <div className="flex items-center gap-3 rounded-lg bg-soft px-3 py-2">
        <span className="rounded-full bg-[#C0392B] text-sb-cream text-sm font-mono px-2.5 py-1">{count}</span>
        <span className="text-sm font-body">{desc ?? 'Items are waiting on this page.'}</span>
      </div>
      {itemKey === 'inventory-alerts' && rawGroups.filter((g) => g.shops.length > 0).map((g) => (
        <div key={g.key} className="rounded-lg border border-navy/15 px-3 py-2">
          <div className="flex items-center justify-between gap-2"><span className="text-[13px] font-body font-semibold">{g.title}</span><span className="text-[11px] font-mono text-inky">{g.shops.length} shops</span></div>
          <div className="text-[11px] font-body text-inky">{g.hint}</div>
        </div>
      ))}
    </>
  )
}

// ── Exceptions ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function SevChip({ sev }: { sev: number }) {
  const cls = sev >= 3 ? 'bg-[#C0392B]/15 text-[#C0392B]' : sev === 2 ? 'bg-[#E67E22]/20 text-[#E67E22]' : 'bg-soft text-inky border border-navy/15'
  return <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-body font-bold uppercase tracking-wide ${cls}`}>{SEV_LABEL[sev] ?? sev}</span>
}

function ExceptionsCard({ edit, onRemove }: HomeCardProps) {
  const { exceptions, loading } = useShopExceptions()
  const loc = useLocations()
  const [open, setOpen] = useState(false)
  const pending = exceptions.filter((e) => e.status === 'pending')
  const high = pending.filter((e) => e.severity === 3).length
  const sevOf = (t: string) => pending.filter((e) => e.type === t).reduce((m, e) => Math.max(m, e.severity), 0)
  return (
    <HomeCard title="Exceptions" action="Triage" onOpen={() => setOpen(true)} edit={edit} onRemove={onRemove}>
      {loading ? <div className="py-4 flex justify-center"><SbLoader size={20} /></div> : (
        <>
          <div className="flex items-end gap-3"><Big unit="pending">{pending.length}</Big>{high > 0 && <span className="rounded-full bg-[#C0392B]/15 text-[#C0392B] px-2.5 py-0.5 text-[11px] font-body font-bold uppercase tracking-wide">{high} {SEV_LABEL[3]}</span>}</div>
          <div className="flex flex-col gap-1.5">
            {TYPE_ORDER.map((t) => {
              const n = pending.filter((e) => e.type === t).length
              const sev = sevOf(t)
              return (
                <button key={t} type="button" onClick={() => setOpen(true)} className={`flex items-center gap-2.5 rounded-[10px] px-1.5 py-1 text-left hover:bg-soft transition-colors ${n ? '' : 'opacity-50'}`}>
                  <ExceptionTile type={t} size={26} />
                  <span className="flex-1 text-[12.5px] font-body truncate">{TYPE_META[t].label}</span>
                  {sev > 0 && <SevChip sev={sev} />}
                  <span className="font-mono text-sm tabular-nums w-7 text-right">{n || '—'}</span>
                </button>
              )
            })}
          </div>
        </>
      )}
      <HomeModal open={open} onClose={() => setOpen(false)} title={`Exceptions · ${pending.length} pending`} to="/exception-reporting" goLabel="Open Exception Reporting">
        {pending.length === 0 ? <CardEmpty>No pending exceptions.</CardEmpty> : [...pending].sort((a, b) => b.severity - a.severity || TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).slice(0, 150).map((e) => (
          <div key={e.id} className="flex items-center gap-2.5 rounded-[10px] px-1.5 py-1.5 hover:bg-soft">
            <ExceptionTile type={e.type} size={26} />
            <span className="flex-1 min-w-0 text-[12.5px] font-body truncate"><b>{loc.codeOf(e.location_id)}</b> <span className="text-inky">· {TYPE_META[e.type].label}</span></span>
            <span className="text-[10.5px] font-mono text-inky flex-shrink-0">{e.items.length} item{e.items.length === 1 ? '' : 's'}</span>
            <SevChip sev={e.severity} />
          </div>
        ))}
      </HomeModal>
    </HomeCard>
  )
}

// ── Orders in progress ───────────────────────────────────────────────────────────────────────────────────────────────────
function OrdersCard({ edit, onRemove }: HomeCardProps) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const s = useLoad(async () => {
    if (!companyId) return { drafts: [], placed: 0 }
    const since = new Date(Date.now() - 7 * 86400000).toISOString()
    const [d, v, p] = await Promise.all([
      sb().schema('inventory').from('ov2_order_drafts').select('id, vendor_id, status, order_date, updated_at').eq('company_id', companyId).is('deleted_at', null).in('status', ['generating', 'review', 'final_review']).order('updated_at', { ascending: false }).limit(50),
      sb().schema('inventory').from('vendors').select('id, name').eq('company_id', companyId),
      sb().schema('inventory').from('ov2_order_drafts').select('id', { count: 'exact', head: true }).eq('company_id', companyId).is('deleted_at', null).eq('status', 'exported').gte('updated_at', since),
    ])
    if (d.error) throw new Error(d.error.message)
    const names = new Map<string, string>(((v.data ?? []) as { id: string; name: string }[]).map((x) => [x.id, x.name]))
    return { drafts: ((d.data ?? []) as { id: string; vendor_id: string | null; status: string; order_date: string; updated_at: string }[]).map((x) => ({ ...x, vendor: names.get(x.vendor_id ?? '') ?? 'Order' })), placed: p.count ?? 0 }
  }, [companyId])
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()
  const drafts = s.data?.drafts ?? []
  const label: Record<string, string> = { generating: 'Generating', review: 'In review', final_review: 'Final review' }
  return (
    <HomeCard title="Orders" action="In progress" onOpen={() => setOpen(true)} edit={edit} onRemove={onRemove}>
      <Body s={s}>
        <div className="flex items-end gap-3"><Big unit="in progress">{drafts.length}</Big><span className="text-[11px] font-body text-inky pb-1">{s.data?.placed ?? 0} placed this week</span></div>
        {drafts.length === 0 ? <CardEmpty>No orders in progress.</CardEmpty> : drafts.slice(0, 5).map((d) => (
          <button key={d.id} type="button" onClick={() => setOpen(true)} className="flex items-center gap-2 rounded-[10px] px-1.5 py-1 text-left hover:bg-soft transition-colors">
            <span className="flex-1 min-w-0 text-[13px] font-body truncate"><b>{d.vendor}</b> <span className="text-inky">· {d.order_date}</span></span>
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-body ${d.status === 'final_review' ? 'bg-[#E67E22]/25 text-[#E67E22]' : 'bg-soft border border-navy/15'}`}>{label[d.status] ?? d.status}</span>
          </button>
        ))}
      </Body>
      <HomeModal open={open} onClose={() => setOpen(false)} title={`Orders in progress · ${drafts.length}`} to="/orders-v2" goLabel="Open Orders v2">
        {drafts.length === 0 ? <CardEmpty>No orders in progress.</CardEmpty> : drafts.map((d) => (
          <button key={d.id} type="button" onClick={() => { setOpen(false); navigate(d.status === 'final_review' ? `/orders-v2/draft/${d.id}/final` : `/orders-v2/draft/${d.id}`) }}
            className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-left hover:bg-soft transition-colors">
            <span className="flex-1 min-w-0 text-[13px] font-body truncate"><b>{d.vendor}</b> <span className="text-inky">· {d.order_date} · edited {ago(d.updated_at)}</span></span>
            <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-body ${d.status === 'final_review' ? 'bg-[#E67E22]/25 text-[#E67E22]' : 'bg-soft border border-navy/15'}`}>{label[d.status] ?? d.status}</span>
          </button>
        ))}
      </HomeModal>
    </HomeCard>
  )
}

// ── Late POs (the "not received" list) ───────────────────────────────────────────────────────────────────────────────────
function LatePoCard({ edit, onRemove }: HomeCardProps) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const s = useLoad(async () => {
    if (!companyId) return []
    const { data, error } = await sb().schema('inventory').from('po_receipt_alerts').select('id, location_id, po_id, custom_po_id, supplier_name, days_late, status, excluded').eq('company_id', companyId).order('days_late', { ascending: false }).limit(300)
    if (error) throw new Error(error.message)
    return ((data ?? []) as { id: string; location_id: string | null; po_id: string; custom_po_id: string | null; supplier_name: string | null; days_late: number | null; status: string; excluded?: boolean }[])
      .filter((r) => !r.excluded && !(r.status ?? '').toLowerCase().includes('closed'))
  }, [companyId])
  const [open, setOpen] = useState(false)
  const rows = s.data ?? []
  return (
    <HomeCard title="Late POs · not received" action="Open list" onOpen={() => setOpen(true)} edit={edit} onRemove={onRemove}>
      <Body s={s}>
        <div className="flex items-end gap-3"><Big unit="open">{rows.length}</Big>{rows[0]?.days_late != null && <span className="text-[11px] font-body text-inky pb-1">oldest {rows[0].days_late} days late</span>}</div>
        {rows.length === 0 ? <CardEmpty>Nothing late.</CardEmpty> : rows.slice(0, 4).map((r) => (
          <div key={r.id} className="flex items-center gap-2 px-1.5 text-[12.5px] font-body">
            <span className="flex-1 min-w-0 truncate"><b>{r.custom_po_id || r.po_id}</b> <span className="text-inky">{r.location_id ? `· ${loc.codeOf(r.location_id)}` : ''} {r.supplier_name ? `· ${r.supplier_name}` : ''}</span></span>
            <span className="flex-shrink-0 rounded-full bg-[#C0392B]/15 text-[#C0392B] px-2 py-0.5 text-[10.5px]">{r.days_late ?? '?'}d</span>
          </div>
        ))}
      </Body>
      <HomeModal open={open} onClose={() => setOpen(false)} title={`Late POs · ${rows.length} open`} to="/exception-reporting" goLabel="Open the Late POs list">
        {rows.length === 0 ? <CardEmpty>Nothing late.</CardEmpty> : rows.slice(0, 200).map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-[10px] px-2 py-1.5 text-[12.5px] font-body hover:bg-soft">
            <span className="flex-1 min-w-0 truncate"><b>{r.custom_po_id || r.po_id}</b> <span className="text-inky">{r.location_id ? `· ${loc.codeOf(r.location_id)}` : ''} {r.supplier_name ? `· ${r.supplier_name}` : ''}</span></span>
            <span className="flex-shrink-0 rounded-full bg-[#C0392B]/15 text-[#C0392B] px-2 py-0.5 text-[10.5px]">{r.days_late ?? '?'}d late</span>
          </div>
        ))}
      </HomeModal>
    </HomeCard>
  )
}

// ── Quick links (pinned pages, or sensible defaults) ─────────────────────────────────────────────────────────────────────
const DEFAULT_LINKS = ['orders-v2', 'location-lookup', 'exception-reporting', 'po-status', 'tank-monitors', 'monthend', 'droptop-orders', 'tasks']
function QuickLinksCard({ edit, onRemove }: HomeCardProps) {
  const { favorites } = useSidebarPrefs()
  const { entries } = useNavModel()
  const pin = usePinMenu()
  const allowed = useMemo(() => new Set(entries.map((e) => e.itemKey)), [entries])
  const keys = (favorites.length ? favorites : DEFAULT_LINKS).filter((k) => allowed.has(k) && itemByKey.get(k)?.to).slice(0, 12)
  return (
    <HomeCard title={favorites.length ? 'Your pinned pages' : 'Jump to'} edit={edit} onRemove={onRemove}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {keys.map((k) => {
          const item = itemByKey.get(k)!
          const section = sectionKeyOfItem(k)
          return (
            <NavLink key={k} to={item.to!} onContextMenu={pin.onContextMenu(k, item.label)} title="Right-click to pin or unpin"
              className="flex items-center gap-2 rounded-xl border border-navy/20 bg-soft/60 px-3 py-2.5 text-[12.5px] font-body hover:border-inky hover:bg-soft transition-colors">
              <span className="flex-shrink-0 text-inky">{ICONS[k] ?? ICONS.dashboard}</span><span className="flex-1 truncate">{item.label}</span>
              {section && <span className="flex-shrink-0 opacity-70 [&_svg]:w-3.5 [&_svg]:h-3.5 [&_img]:w-3.5 [&_img]:h-3.5" title={section}>{section === 'shortcuts' ? ICONS.calendar : SECTION_ICONS[section]}</span>}
            </NavLink>
          )
        })}
      </div>
      {favorites.length === 0 && <span className="text-[10.5px] font-body text-inky mt-auto">Right-click any page in the sidebar or the mega menu and pick Pin to put it here.</span>}
      {pin.element}
    </HomeCard>
  )
}

// ── Data health (latest run of each data connection) ─────────────────────────────────────────────────────────────────────
interface HealthRow { key: string; label: string; status: string | null; at: string | null; message: string | null; critical: boolean }
function DataHealthCard({ edit, onRemove }: HomeCardProps) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [open, setOpen] = useState(false)
  // Same source as the top-bar sync widget (data_connection_schedules, scheduled or manual run — whichever is newer), so a failed connection
  // can't be missed here: every connection is listed, failures first.
  const s = useLoad(async () => {
    if (!companyId) return [] as HealthRow[]
    const { data, error } = await sb().schema('inventory').from('data_connection_schedules')
      .select('connection_key, is_critical, last_run_at, last_run_status, last_run_message, last_manual_run_at, last_manual_run_status, last_manual_run_message').eq('company_id', companyId)
    if (error) throw new Error(error.message)
    return ((data ?? []) as Record<string, any>[]).map((r): HealthRow => {
      const manual = !!r.last_manual_run_at && (!r.last_run_at || new Date(r.last_manual_run_at) > new Date(r.last_run_at))
      return {
        key: r.connection_key, label: CONNECTION_META[r.connection_key]?.label ?? r.connection_key,
        status: manual ? r.last_manual_run_status : r.last_run_status, at: manual ? r.last_manual_run_at : r.last_run_at,
        message: manual ? r.last_manual_run_message : r.last_run_message, critical: !!r.is_critical,
      }
    })
  }, [companyId])
  const rank = (r: HealthRow) => (statusColor(r.status) === 'red' ? 0 : statusColor(r.status) === 'orange' ? 1 : statusColor(r.status) === 'gray' ? 2 : 3)
  const rows = [...(s.data ?? [])].sort((a, b) => rank(a) - rank(b) || (CONNECTION_ORDER.indexOf(a.key) - CONNECTION_ORDER.indexOf(b.key)))
  const failed = rows.filter((r) => statusColor(r.status) === 'red')
  const partial = rows.filter((r) => statusColor(r.status) === 'orange')
  const dot = (st: string | null) => ({ green: 'bg-[#2ECC71]', orange: 'bg-[#E67E22]', red: 'bg-[#C0392B]', gray: 'bg-inky/40' }[statusColor(st)])
  const line = (r: HealthRow) => (
    <div key={r.key} className="flex items-center gap-2 px-1 text-[12.5px] font-body" title={r.message ?? undefined}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot(r.status)}`} />
      <span className="flex-1 min-w-0 truncate">{r.label}{r.critical && <span className="ml-1.5 text-[9px] uppercase tracking-wide text-[#C0392B]">critical</span>}</span>
      <span className="text-[10.5px] text-inky flex-shrink-0">{r.at ? ago(r.at) : 'never run'}</span>
    </div>
  )
  return (
    <HomeCard title="Data health" action="All connections" onOpen={() => setOpen(true)} edit={edit} onRemove={onRemove}>
      <Body s={s}>
        <div className={`text-xs font-body ${failed.length ? 'text-[#C0392B] font-semibold' : 'text-inky'}`}>
          {rows.length === 0 ? 'No connections set up yet.' : failed.length ? `${failed.length} failed their last run${partial.length ? `, ${partial.length} partial` : ''}.` : partial.length ? `${partial.length} partial, the rest succeeded.` : 'Every connection’s last run succeeded.'}
        </div>
        {rows.slice(0, 8).map(line)}
        {rows.length > 8 && <button type="button" onClick={() => setOpen(true)} className="text-left px-1 text-[11px] font-body text-inky hover:underline">+ {rows.length - 8} more…</button>}
      </Body>
      <HomeModal open={open} onClose={() => setOpen(false)} title={`Data health · ${rows.length} connections`} to="/data-connections" goLabel="Open Data Connections">
        {rows.map((r) => (
          <div key={r.key} className="rounded-[10px] px-2 py-1.5 hover:bg-soft">
            {line(r)}
            {r.message && statusColor(r.status) !== 'green' && <div className="pl-5 text-[11px] font-mono text-[#C0392B] break-words">{r.message}</div>}
          </div>
        ))}
      </HomeModal>
    </HomeCard>
  )
}

// ── Jump back in ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function RecentCard({ edit, onRemove }: HomeCardProps) {
  const recent = useRecentPagesStore((s) => s.recentPages)
  return (
    <HomeCard title="Jump back in" edit={edit} onRemove={onRemove}>
      {recent.length === 0 ? <CardEmpty>Pages you visit show up here.</CardEmpty> : recent.map((p) => (
        <Link key={p.path} to={p.path} className="flex items-center gap-2 rounded-[10px] px-1.5 py-1.5 hover:bg-soft transition-colors">
          <span className="flex-1 min-w-0 text-[13px] font-body truncate">{p.label}</span>
          <span className="text-[10.5px] font-body text-inky flex-shrink-0">{ago(p.visitedAt)}</span>
        </Link>
      ))}
    </HomeCard>
  )
}

export interface HomeCardDef {
  id: string
  title: string
  blurb: string
  /** Default grid box (12 columns, rows of 56px). */
  w: number; h: number; minW: number; minH: number
  Component: (p: HomeCardProps) => JSX.Element
}
export const HOME_CARDS: HomeCardDef[] = [
  { id: 'welcome', title: 'Today', blurb: 'Greeting, date and the three numbers to start with', w: 6, h: 3, minW: 3, minH: 2, Component: WelcomeCard },
  { id: 'pulse', title: 'Last 7 days', blurb: 'Cars, revenue, average ticket and M5% for the company', w: 6, h: 3, minW: 3, minH: 2, Component: PulseCard },
  { id: 'attention', title: 'Needs attention', blurb: 'The pages with something waiting, biggest first', w: 4, h: 6, minW: 3, minH: 3, Component: AttentionCard },
  { id: 'exceptions', title: 'Exceptions', blurb: 'Pending exceptions by type', w: 4, h: 6, minW: 3, minH: 4, Component: ExceptionsCard },
  { id: 'orders', title: 'Orders', blurb: 'Orders in progress and what was placed this week', w: 4, h: 3, minW: 3, minH: 3, Component: OrdersCard },
  { id: 'latepo', title: 'Late POs', blurb: 'POs not received after the cutoff', w: 4, h: 3, minW: 3, minH: 3, Component: LatePoCard },
  { id: 'links', title: 'Quick links', blurb: 'Your pinned pages, or the usual suspects', w: 6, h: 4, minW: 3, minH: 3, Component: QuickLinksCard },
  { id: 'health', title: 'Data health', blurb: 'Latest run of each data connection', w: 3, h: 4, minW: 3, minH: 3, Component: DataHealthCard },
  { id: 'zeroonhand', title: 'Configured products at zero', blurb: 'Chart: shops at zero on hand, by configured product', w: 4, h: 6, minW: 3, minH: 3, Component: ZeroOnHandCard },
  { id: 'soldordered', title: 'Sold vs ordered (MTD)', blurb: 'Chart: gallons sold vs ordered per product this month, highest sold first', w: 8, h: 8, minW: 4, minH: 3, Component: SoldVsOrderedCard },
  { id: 'gallons', title: 'Gallons ordered', blurb: 'Chart: gallons ordered per product (Orders v2)', w: 6, h: 6, minW: 3, minH: 3, Component: GallonsOrderedCard },
  { id: 'recent', title: 'Jump back in', blurb: 'The pages you were just on', w: 3, h: 4, minW: 2, minH: 2, Component: RecentCard },
]
