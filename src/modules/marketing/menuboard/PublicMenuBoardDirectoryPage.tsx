// Public, no-login directory of every shop's menu board link — the
// Menu Board > Shop Links table, shared via a tokenized link
// (menu.sboc.app/directory/<token>) so the project management team can hand
// out board/PDF links as new shops come online. Data comes only from
// get_menu_board_directory (SECURITY DEFINER, explicit column whitelist;
// emails only when the link was created with them enabled). The RPC also
// mints links for newly active shops, so this list is always current.
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { SbLoader } from '@/components/ui'
import { naturalCompare } from '@/lib/naturalSort'
import { QrImage } from './MenuBoardPage'

interface DirectoryShop {
  name: string | null
  shop_city: string | null
  city: string | null
  state: string | null
  market: string | null
  owner: string | null
  regional_director: string | null
  area_manager: string | null
  store_email: string | null
  am_email: string | null
  monday_group: string | null
  date_opened: string | null
  acquisition_date: string | null
  // Package/fee prices from the location list — only sent for an 'upcoming' link.
  prices: Record<string, number | null> | null
  slug: string
  hide_page2: boolean
}

interface Directory {
  label: string | null
  scope: 'active' | 'upcoming'
  include_emails: boolean
  include_recent?: boolean
  shops: DirectoryShop[]
  // Upcoming links only, when created with the second table: opened/acquired in the last 90 days.
  recent_shops?: DirectoryShop[]
}

// Upcoming-shop pricing columns. The five core packages always show; the rest (diesel, European, fees)
// only appear once at least one shop has a value in them.
const PRICE_COLS: { key: string; label: string }[] = [
  { key: 'economy', label: 'Economy' },
  { key: 'premium_hm', label: 'Premium HM' },
  { key: 'premium_full_synthetic', label: 'Full Synthetic' },
  { key: 'premium_full_synthetic_hm', label: 'Full Synthetic HM' },
  { key: 'rp', label: 'Restore & Protect' },
  { key: 'diesel_syn_blend', label: 'Diesel Syn Blend' },
  { key: 'diesel_full_syn', label: 'Diesel Full Syn' },
  { key: 'european', label: 'European' },
  { key: 'supply_fee', label: 'Supply Fee' },
  { key: 'disposal_fee', label: 'Disposal Fee' },
  { key: 'oil_inflation_surcharge', label: 'Oil Inflation Surcharge' },
]
const FEE_KEYS = new Set(['supply_fee', 'disposal_fee', 'oil_inflation_surcharge'])
const CORE_PRICE_KEYS = new Set(['economy', 'premium_hm', 'premium_full_synthetic', 'premium_full_synthetic_hm', 'rp'])
const price = (v: number | null | undefined) => (v == null ? '—' : `$${Number(v).toFixed(2)}`)

// Static brand colors only (sb-*), never the theme tokens that flip in dark mode — this page has a fixed
// cream background, so a theme-colored label/select goes pale on it for anyone whose OS is in dark mode.
function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-heading font-bold text-sb-navy uppercase tracking-wide">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white border border-sb-navy/50 rounded px-2 py-2 text-sm font-body text-sb-navy focus:outline-none focus:ring-2 focus:ring-sb-sky">
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  )
}

const csv = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`
const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—'
  const [y, m, day] = String(d).slice(0, 10).split('-')
  return y && m && day ? `${Number(m)}/${Number(day)}/${y}` : String(d)
}

// Remembered per browser (these viewers aren't logged in): show/hide the market, regional director and area
// manager columns on a pre-opening share. Hidden by default.
const SHOW_MGMT_KEY = 'menuboard.directory.showManagement'
function loadShowMgmt(): boolean {
  try { return localStorage.getItem(SHOW_MGMT_KEY) === '1' } catch { return false }
}

const rowLabel = (s: DirectoryShop) => s.shop_city || s.name || s.slug

/** One table of shops — used for the main list and, when the link asks for it, the recently-opened list. */
function ShopsTable({ rows, origin, upcoming, priceCols, showMgmt, emails, showDates, emptyText, narrowGroup }: {
  /** Narrower Monday Group column (the recent table, which has extra date columns to make room for). */
  narrowGroup?: boolean
  rows: DirectoryShop[]
  origin: string
  upcoming: boolean
  priceCols: { key: string; label: string }[]
  showMgmt: boolean
  emails: boolean
  showDates: boolean
  emptyText: string
}) {
  const boardUrl = (s: DirectoryShop) => `${origin}/${s.slug}`
  const pdfUrl = (s: DirectoryShop) => `${origin}/${s.slug}/pdf`
  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy'))
  }
  const cols = 6 + (showMgmt ? 3 : 0) + (upcoming ? 1 + priceCols.length : 0) + (showDates ? 2 : 0) + (emails ? 2 : 0)
  return (
    <div className="overflow-auto rounded border border-sb-navy/30 bg-white max-h-[78vh]">
      <table className="w-full text-xs font-mono">
        <thead className="sticky top-0 z-10">
          <tr className="bg-sb-navy text-sb-cream uppercase tracking-wide">
            <th className="text-left px-2 py-2 whitespace-nowrap">Shop</th>
            <th className="text-left px-2 py-2 whitespace-nowrap">Owner</th>
            {showMgmt && <th className="text-left px-2 py-2 whitespace-nowrap">Market</th>}
            {showMgmt && <th className="text-left px-2 py-2 whitespace-nowrap">Regional Director</th>}
            {showMgmt && <th className="text-left px-2 py-2 whitespace-nowrap">Area Manager</th>}
            {upcoming && <th className="text-left px-2 py-2 whitespace-nowrap">Monday Group</th>}
            {showDates && <th className="text-left px-2 py-2 whitespace-nowrap">Opened</th>}
            {showDates && <th className="text-left px-2 py-2 whitespace-nowrap">Acquired</th>}
            {priceCols.map((c) => <th key={c.key} className="text-right px-1.5 py-2 leading-tight min-w-[4.5rem]">{c.label}</th>)}
            {emails && <th className="text-left px-2 py-2 whitespace-nowrap">Shop Email</th>}
            {emails && <th className="text-left px-2 py-2 whitespace-nowrap">Area Manager Email</th>}
            <th className="text-left px-2 py-2 whitespace-nowrap">Menu Board Link</th>
            <th className="text-left px-2 py-2 whitespace-nowrap">QR Code</th>
            <th className="text-left px-2 py-2 whitespace-nowrap">PDF</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={cols} className="px-3 py-8 text-center text-sb-navy">{emptyText}</td></tr>
          ) : rows.map((s) => (
            <tr key={s.slug} className="border-b border-sb-navy/10 hover:bg-sb-navy/5 align-middle">
              <td className="px-2 py-1.5 text-sb-navy whitespace-nowrap font-bold">{rowLabel(s)}</td>
              <td className="px-2 py-1.5 text-sb-navy">{s.owner || '—'}</td>
              {showMgmt && <td className="px-2 py-1.5 text-sb-navy whitespace-nowrap">{s.market || '—'}</td>}
              {showMgmt && <td className="px-2 py-1.5 text-sb-navy">{s.regional_director || '—'}</td>}
              {showMgmt && <td className="px-2 py-1.5 text-sb-navy">{s.area_manager || '—'}</td>}
              {/* Wide enough that the usual long group name ("Corporate Pre-Opening Queue (Four Weeks Out From
                  Projected Opening)") wraps onto two lines. */}
              {upcoming && <td className={`px-2 py-1.5 text-sb-navy ${narrowGroup ? 'min-w-[10rem] max-w-[12rem]' : 'min-w-[16rem] max-w-[18rem]'} break-words`}>{s.monday_group || '—'}</td>}
              {showDates && <td className="px-2 py-1.5 text-sb-navy whitespace-nowrap">{fmtDate(s.date_opened)}</td>}
              {showDates && <td className="px-2 py-1.5 text-sb-navy whitespace-nowrap">{fmtDate(s.acquisition_date)}</td>}
              {priceCols.map((c) => <td key={c.key} className={`px-1.5 py-1.5 text-right whitespace-nowrap ${s.prices?.[c.key] == null ? 'text-sb-navy/30' : 'text-sb-navy font-bold'}`}>{price(s.prices?.[c.key])}</td>)}
              {emails && <td className="px-2 py-1.5 text-sb-navy">{s.store_email || '—'}</td>}
              {emails && <td className="px-2 py-1.5 text-sb-navy">{s.am_email || '—'}</td>}
              <td className="px-2 py-1.5 whitespace-nowrap">
                <a href={boardUrl(s)} target="_blank" rel="noreferrer" className="text-sb-inky font-bold underline">{boardUrl(s).replace(/^https?:\/\//, '')}</a>
                <button onClick={() => copy(boardUrl(s))} className="ml-1.5 text-sb-navy/60 hover:text-sb-navy" title="Copy link">⧉</button>
              </td>
              <td className="px-2 py-1.5"><QrImage url={boardUrl(s)} size={40} /></td>
              <td className="px-2 py-1.5 whitespace-nowrap">
                <a href={pdfUrl(s)} target="_blank" rel="noreferrer" className="text-sb-inky font-bold underline">PDF</a>
                <button onClick={() => copy(pdfUrl(s))} className="ml-1.5 text-sb-navy/60 hover:text-sb-navy" title="Copy PDF link">⧉</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function PublicMenuBoardDirectoryPage() {
  const { token } = useParams<{ token: string }>()
  const [dir, setDir] = useState<Directory | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading')
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState('')
  const [owner, setOwner] = useState('')
  const [group, setGroup] = useState('')
  const [showMgmtPref, setShowMgmtPref] = useState(loadShowMgmt)
  function setShowMgmt(v: boolean) {
    setShowMgmtPref(v)
    if (!v) setMarket('') // the Market filter is hidden along with its column
    try { localStorage.setItem(SHOW_MGMT_KEY, v ? '1' : '0') } catch { /* ignore */ }
  }

  useEffect(() => {
    let cancelled = false
    async function run() {
      const { data, error } = await (supabase as any).rpc('get_menu_board_directory', { p_token: token })
      if (cancelled) return
      if (error) { setStatus('error'); return }
      if (!data || data.error) { setStatus('notfound'); return }
      setDir(data as Directory)
      setStatus('ready')
    }
    run().catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  }, [token])

  const origin = window.location.origin
  const bySort = (a: DirectoryShop, b: DirectoryShop) => naturalCompare(rowLabel(a), rowLabel(b))
  const shops = useMemo(() => [...(dir?.shops ?? [])].sort(bySort), [dir])
  // Newest first — it's a "what just opened" list.
  const recentShops = useMemo(() => dir?.recent_shops ?? [], [dir])
  const upcoming = dir?.scope === 'upcoming'
  // The market/director/area-manager columns (and the Market filter) are optional on a pre-opening share only.
  const showMgmt = !upcoming || showMgmtPref
  const allShops = useMemo(() => [...shops, ...recentShops], [shops, recentShops])
  // Columns are worked out per table so one table's extra prices don't widen the other: the five core packages
  // always show, diesel/European/fee columns only when that table's shops have a value, and the recent table
  // leaves the fee columns out entirely.
  const priceCols = useMemo(
    () => (upcoming ? PRICE_COLS.filter((c) => CORE_PRICE_KEYS.has(c.key) || shops.some((s) => s.prices?.[c.key] != null)) : []),
    [upcoming, shops],
  )
  const recentPriceCols = useMemo(
    () => PRICE_COLS.filter((c) => !FEE_KEYS.has(c.key) && (CORE_PRICE_KEYS.has(c.key) || recentShops.some((s) => s.prices?.[c.key] != null))),
    [recentShops],
  )
  const groups = useMemo(() => [...new Set(allShops.map((s) => s.monday_group).filter((g): g is string => !!g))].sort(naturalCompare), [allShops])
  const markets = useMemo(() => [...new Set(allShops.map((s) => s.market).filter((m): m is string => !!m))].sort(naturalCompare), [allShops])
  const applyFilters = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (list: DirectoryShop[]) => list.filter((s) => {
      if (market && s.market !== market) return false
      if (owner && s.owner !== owner) return false
      if (group && s.monday_group !== group) return false
      if (!q) return true
      return [rowLabel(s), s.city, s.state, ...(showMgmt ? [s.market, s.area_manager, s.regional_director] : []), s.store_email, s.am_email]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [query, market, owner, group, showMgmt])
  const filtered = useMemo(() => applyFilters(shops), [applyFilters, shops])
  const filteredRecent = useMemo(() => applyFilters(recentShops), [applyFilters, recentShops])

  function exportCsv() {
    const emails = !!dir?.include_emails
    const lines: string[] = []
    const section = (rows: DirectoryShop[], withDates: boolean, priceCols: { key: string; label: string }[]) => {
      const header = ['Shop', 'City', 'State', 'Owner', ...(showMgmt ? ['Market', 'Regional Director', 'Area Manager'] : []),
        ...(upcoming ? ['Monday Group'] : []), ...(withDates ? ['Opened', 'Acquired'] : []), ...priceCols.map((c) => c.label),
        ...(emails ? ['Shop Email', 'Area Manager Email'] : []), 'Menu Board Link', 'PDF Link']
      lines.push(header.map(csv).join(','))
      for (const s of rows) {
        lines.push([rowLabel(s), s.city, s.state, s.owner, ...(showMgmt ? [s.market, s.regional_director, s.area_manager] : []),
          ...(upcoming ? [s.monday_group] : []), ...(withDates ? [s.date_opened, s.acquisition_date] : []),
          ...priceCols.map((c) => (s.prices?.[c.key] != null ? String(s.prices[c.key]) : '')),
          ...(emails ? [s.store_email, s.am_email] : []), `${origin}/${s.slug}`, `${origin}/${s.slug}/pdf`].map(csv).join(','))
      }
    }
    section(filtered, false, priceCols)
    if (dir?.include_recent) {
      lines.push('', csv('Opened or acquired in the last 90 days'))
      section(filteredRecent, true, recentPriceCols)
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = upcoming ? 'Upcoming Shops.csv' : 'Menu Board Shop Links.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-sb-navy"><SbLoader size={36} /></div>
  }
  if (status !== 'ready' || !dir) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
        <p className="text-sm font-mono text-sb-cream/80 text-center">
          {status === 'notfound' ? 'This directory link is no longer active.' : "Couldn't load the shop directory. Try again in a moment."}
        </p>
      </div>
    )
  }

  const emails = dir.include_emails
  return (
    <div className="min-h-screen bg-sb-cream px-4 py-5">
      <div className="max-w-[1600px] mx-auto flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-heading font-bold text-sb-navy tracking-wide uppercase">{dir.label || (upcoming ? 'Upcoming Shops' : 'Menu Board Shop Links')}</h1>
          <p className="text-xs font-mono text-sb-navy mt-1 max-w-3xl">
            {upcoming
              ? "Shops that aren't open yet, listed once package pricing has been added for them. Prices, links and the PDF update as pricing is entered, and shops appear here automatically — nothing to re-share."
              : "One live menu board link and PDF per active shop. Both always show the shop's current prices, and new shops appear here automatically — nothing to regenerate or re-share."}
          </p>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-heading font-bold text-sb-navy uppercase tracking-wide">Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={showMgmt ? 'Shop, city, market, manager…' : 'Shop or city…'}
              className="w-64 bg-white border border-sb-navy/50 rounded px-2 py-2 text-sm font-body text-sb-navy placeholder-sb-navy/50 focus:outline-none focus:ring-2 focus:ring-sb-sky" />
          </label>
          {showMgmt && (
            <div className="w-48">
              <FilterSelect label="Market" value={market} onChange={setMarket}
                options={[{ value: '', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: m }))]} />
            </div>
          )}
          <div className="w-40">
            <FilterSelect label="Owner" value={owner} onChange={setOwner}
              options={[{ value: '', label: 'All' }, { value: 'Corporate', label: 'Corporate' }, { value: 'Franchise', label: 'Franchise' }]} />
          </div>
          {upcoming && groups.length > 0 && (
            <div className="w-60">
              <FilterSelect label="Monday Group" value={group} onChange={setGroup}
                options={[{ value: '', label: 'All groups' }, ...groups.map((g) => ({ value: g, label: g }))]} />
            </div>
          )}
          <button onClick={exportCsv}
            className="px-2 py-2 text-xs font-mono border border-sb-navy/50 rounded text-sb-navy font-bold hover:bg-sb-navy/10">
            Export CSV
          </button>
          <span className="text-xs font-mono text-sb-navy pb-2">{filtered.length} of {shops.length} shops</span>
        </div>

        {upcoming && (
          <div className="flex justify-end">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none text-xs font-mono text-sb-navy font-bold">
              Show market, regional director &amp; area manager
              <button type="button" role="switch" aria-checked={showMgmtPref} onClick={() => setShowMgmt(!showMgmtPref)}
                className={`relative inline-block w-9 h-5 rounded-full transition-colors ${showMgmtPref ? 'bg-sb-navy' : 'bg-sb-navy/30'}`}>
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${showMgmtPref ? 'translate-x-4' : ''}`} />
              </button>
            </label>
          </div>
        )}

        <ShopsTable rows={filtered} origin={origin} upcoming={upcoming} priceCols={priceCols} showMgmt={showMgmt} emails={emails} showDates={false}
          emptyText={upcoming && shops.length === 0 ? 'No upcoming shops have pricing yet.' : 'No shops match.'} />

        {dir.include_recent && (
          <>
            <div className="flex items-baseline gap-3 flex-wrap mt-3">
              <h2 className="text-base font-heading font-bold text-sb-navy tracking-wide uppercase">Opened or acquired in the last 90 days</h2>
              <span className="text-xs font-mono text-sb-navy">{filteredRecent.length} of {recentShops.length} shops</span>
            </div>
            <ShopsTable rows={filteredRecent} origin={origin} upcoming={upcoming} priceCols={recentPriceCols} showMgmt={showMgmt} emails={emails} showDates narrowGroup
              emptyText={recentShops.length === 0 ? 'No shops have opened or been acquired in the last 90 days.' : 'No shops match.'} />
          </>
        )}
      </div>
    </div>
  )
}
