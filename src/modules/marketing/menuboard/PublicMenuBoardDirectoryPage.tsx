// Public, no-login directory of every active shop's menu board link — the
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
import { Select, SbLoader } from '@/components/ui'
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
  slug: string
  hide_page2: boolean
}

interface Directory { label: string | null; include_emails: boolean; shops: DirectoryShop[] }

const csv = (v: string | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`

export function PublicMenuBoardDirectoryPage() {
  const { token } = useParams<{ token: string }>()
  const [dir, setDir] = useState<Directory | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'notfound' | 'error'>('loading')
  const [query, setQuery] = useState('')
  const [market, setMarket] = useState('')
  const [owner, setOwner] = useState('')

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
  const boardUrl = (s: DirectoryShop) => `${origin}/${s.slug}`
  const pdfUrl = (s: DirectoryShop) => `${origin}/${s.slug}/pdf`
  const label = (s: DirectoryShop) => s.shop_city || s.name || s.slug

  const shops = useMemo(() => [...(dir?.shops ?? [])].sort((a, b) => naturalCompare(label(a), label(b))), [dir])
  const markets = useMemo(() => [...new Set(shops.map((s) => s.market).filter((m): m is string => !!m))].sort(naturalCompare), [shops])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return shops.filter((s) => {
      if (market && s.market !== market) return false
      if (owner && s.owner !== owner) return false
      if (!q) return true
      return [label(s), s.city, s.state, s.market, s.area_manager, s.regional_director, s.store_email, s.am_email]
        .some((v) => (v ?? '').toLowerCase().includes(q))
    })
  }, [shops, query, market, owner])

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(() => toast.success('Copied')).catch(() => toast.error('Could not copy'))
  }

  function exportCsv() {
    const emails = !!dir?.include_emails
    const header = ['Shop', 'City', 'State', 'Owner', 'Market', 'Regional Director', 'Area Manager', ...(emails ? ['Shop Email', 'Area Manager Email'] : []), 'Menu Board Link', 'PDF Link']
    const lines = [header.map(csv).join(',')]
    for (const s of filtered) {
      lines.push([label(s), s.city, s.state, s.owner, s.market, s.regional_director, s.area_manager,
        ...(emails ? [s.store_email, s.am_email] : []), boardUrl(s), pdfUrl(s)].map(csv).join(','))
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url; a.download = 'Menu Board Shop Links.csv'; a.click()
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
      <div className="max-w-[1400px] mx-auto flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-heading font-bold text-sb-navy tracking-wide uppercase">{dir.label || 'Menu Board Shop Links'}</h1>
          <p className="text-xs font-mono text-sb-navy/60 mt-0.5 max-w-3xl">
            One live menu board link and PDF per active shop. Both always show the shop's current prices, and new shops
            appear here automatically — nothing to regenerate or re-share.
          </p>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-heading text-sb-navy/70 uppercase tracking-wide">Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Shop, city, market, manager…"
              className="w-64 bg-white border border-sb-navy/40 rounded px-3 py-2 text-sm font-body text-sb-navy focus:outline-none focus:ring-2 focus:ring-sky" />
          </label>
          <div className="w-48">
            <Select label="Market" value={market} onChange={(e) => setMarket(e.target.value)}
              options={[{ value: '', label: 'All markets' }, ...markets.map((m) => ({ value: m, label: m }))]} />
          </div>
          <div className="w-40">
            <Select label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}
              options={[{ value: '', label: 'All' }, { value: 'Corporate', label: 'Corporate' }, { value: 'Franchise', label: 'Franchise' }]} />
          </div>
          <button onClick={exportCsv}
            className="px-3 py-2 text-xs font-mono border border-sb-navy/40 rounded text-sb-navy hover:bg-sb-navy/5">
            Export CSV
          </button>
          <span className="text-xs font-mono text-sb-navy/60 pb-2">{filtered.length} of {shops.length} shops</span>
        </div>

        <div className="overflow-auto rounded border border-sb-navy/30 bg-white max-h-[78vh]">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 z-10">
              <tr className="bg-sb-navy text-sb-cream uppercase tracking-wide">
                <th className="text-left px-3 py-2 whitespace-nowrap">Shop</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Owner</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Market</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Regional Director</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">Area Manager</th>
                {emails && <th className="text-left px-3 py-2 whitespace-nowrap">Shop Email</th>}
                {emails && <th className="text-left px-3 py-2 whitespace-nowrap">Area Manager Email</th>}
                <th className="text-left px-3 py-2 whitespace-nowrap">Menu Board Link</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">QR Code</th>
                <th className="text-left px-3 py-2 whitespace-nowrap">PDF</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={emails ? 10 : 8} className="px-3 py-8 text-center text-sb-navy/50">No shops match.</td></tr>
              ) : filtered.map((s) => (
                <tr key={s.slug} className="border-b border-sb-navy/10 hover:bg-sb-navy/5 align-middle">
                  <td className="px-3 py-1.5 text-sb-navy whitespace-nowrap font-bold">{label(s)}</td>
                  <td className="px-3 py-1.5 text-sb-navy/80">{s.owner || '—'}</td>
                  <td className="px-3 py-1.5 text-sb-navy/80 whitespace-nowrap">{s.market || '—'}</td>
                  <td className="px-3 py-1.5 text-sb-navy/80 whitespace-nowrap">{s.regional_director || '—'}</td>
                  <td className="px-3 py-1.5 text-sb-navy/80 whitespace-nowrap">{s.area_manager || '—'}</td>
                  {emails && <td className="px-3 py-1.5 text-sb-navy/80">{s.store_email || '—'}</td>}
                  {emails && <td className="px-3 py-1.5 text-sb-navy/80">{s.am_email || '—'}</td>}
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <a href={boardUrl(s)} target="_blank" rel="noreferrer" className="text-inky underline">{boardUrl(s).replace(/^https?:\/\//, '')}</a>
                    <button onClick={() => copy(boardUrl(s))} className="ml-1.5 text-sb-navy/40 hover:text-sb-navy" title="Copy link">⧉</button>
                  </td>
                  <td className="px-3 py-1.5"><QrImage url={boardUrl(s)} size={40} /></td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    <a href={pdfUrl(s)} target="_blank" rel="noreferrer" className="text-inky underline">Download PDF</a>
                    <button onClick={() => copy(pdfUrl(s))} className="ml-1.5 text-sb-navy/40 hover:text-sb-navy" title="Copy PDF link">⧉</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
