// Shop Tools → Tank Calculator Links: one shareable no-login link per shop (like Menu Board shop links), with a QR code
// for each. Shops open their link, add their tanks and log counts; the Tank Count Review page is where the counts land.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createColumnHelper } from '@tanstack/react-table'
import QRCode from 'qrcode'
import toast from 'react-hot-toast'
import { Button, Modal, SbLoader } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useLocations } from '@/hooks/useLocations'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'

const sb = () => supabase as any
/** Deployed on the main domain (no subdomain setup needed): sboc.app/tanks/<slug>. */
const TANK_BASE_URL = 'https://sboc.app/tanks/'

interface LinkRow { id: string; location_id: string; slug: string; label: string | null; active: boolean }
interface Row {
  id: string; shop: string; name: string; address: string
  slug: string | null; linkId: string | null; tanks: number; lastCount: string | null
}

const randSlugPart = () => Math.random().toString(36).slice(2, 6)
const slugFor = (shop: string) => `${String(shop).toLowerCase().replace(/[^a-z0-9]+/g, '')}-${randSlugPart()}`
const col = createColumnHelper<Row>()

export function TankLinksPage() {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const loc = useLocations()
  const [links, setLinks] = useState<LinkRow[]>([])
  const [tankCounts, setTankCounts] = useState<Map<string, number>>(new Map())
  const [lastCounts, setLastCounts] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState<{ title: string; url: string; dataUrl: string } | null>(null)

  const load = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    const [l, t, g] = await Promise.all([
      sb().schema('inventory').from('shop_tank_links').select('id, location_id, slug, label, active').eq('company_id', companyId).eq('active', true),
      sb().schema('inventory').from('shop_tanks').select('location_id').eq('company_id', companyId).eq('active', true),
      sb().schema('inventory').from('shop_tank_logs').select('location_id, logged_at').eq('company_id', companyId).order('logged_at', { ascending: false }).limit(5000),
    ])
    setLinks((l.data ?? []) as LinkRow[])
    const tc = new Map<string, number>()
    for (const r of (t.data ?? []) as any[]) tc.set(r.location_id, (tc.get(r.location_id) ?? 0) + 1)
    setTankCounts(tc)
    const lc = new Map<string, string>()
    for (const r of (g.data ?? []) as any[]) if (!lc.has(r.location_id)) lc.set(r.location_id, r.logged_at)
    setLastCounts(lc)
    setLoading(false)
  }, [companyId])
  useEffect(() => { void load() }, [load])

  const linkByLoc = useMemo(() => new Map(links.map((x) => [x.location_id, x])), [links])
  const rows: Row[] = useMemo(() => loc.locations
    .filter((l) => l.active)
    .map((l) => ({
      id: l.id, shop: String(l.name ?? ''), name: String(l.shop_city ?? '').replace(/^\d+-/, ''),
      address: [l.address, [l.city, l.state].filter(Boolean).join(', ')].filter(Boolean).join(', '),
      slug: linkByLoc.get(l.id)?.slug ?? null, linkId: linkByLoc.get(l.id)?.id ?? null,
      tanks: tankCounts.get(l.id) ?? 0, lastCount: lastCounts.get(l.id) ?? null,
    }))
    .sort((a, b) => a.shop.localeCompare(b.shop, undefined, { numeric: true })), [loc.locations, linkByLoc, tankCounts, lastCounts])

  async function createLink(locationId: string, shop: string) {
    const { error } = await sb().schema('inventory').from('shop_tank_links').insert({ company_id: companyId, location_id: locationId, slug: slugFor(shop), created_by: profile?.id ?? null })
    if (error) { toast.error(error.message); return false }
    return true
  }
  async function createAllMissing() {
    const missing = rows.filter((r) => !r.slug)
    if (!missing.length) { toast('Every shop already has a link'); return }
    setBusy(true)
    let made = 0
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50).map((r) => ({ company_id: companyId, location_id: r.id, slug: slugFor(r.shop), created_by: profile?.id ?? null }))
      const { error } = await sb().schema('inventory').from('shop_tank_links').insert(chunk)
      if (error) { toast.error(error.message); break }
      made += chunk.length
    }
    setBusy(false)
    if (made) toast.success(`Created ${made} link${made === 1 ? '' : 's'}`)
    void load()
  }
  async function revoke(linkId: string) {
    if (!window.confirm('Turn this link off? The shop will no longer be able to open it (their saved tanks stay on record).')) return
    const { error } = await sb().schema('inventory').from('shop_tank_links').update({ active: false }).eq('id', linkId)
    if (error) { toast.error(error.message); return }
    void load()
  }
  async function showQr(r: Row) {
    if (!r.slug) return
    const url = TANK_BASE_URL + r.slug
    const dataUrl = await QRCode.toDataURL(url, { width: 640, margin: 2, errorCorrectionLevel: 'M' })
    setQr({ title: `Shop ${r.shop}${r.name ? ` — ${r.name}` : ''}`, url, dataUrl })
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); toast.success('Link copied') } catch { toast.error('Could not copy') } }

  const columns = useMemo(() => [
    col.accessor('shop', { header: 'Shop', size: 80 }),
    col.accessor('name', { header: 'Name', size: 170 }),
    col.accessor('address', { header: 'Address', size: 260 }),
    col.accessor('tanks', { header: 'Tanks', size: 70, meta: { numeric: true }, cell: (i) => <span className="block text-right">{i.getValue()}</span> }),
    col.accessor((r) => r.lastCount ?? '', { id: 'last', header: 'Last count', size: 130, cell: (i) => (i.getValue() ? new Date(String(i.getValue())).toLocaleDateString() : '—') }),
    col.accessor((r) => r.slug ?? '', {
      id: 'link', header: 'Link', size: 340, enableSorting: false,
      cell: (i) => {
        const r = i.row.original
        return r.slug ? (
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[11px] truncate text-navy">{TANK_BASE_URL}{r.slug}</span>
            <Button size="sm" variant="secondary" onClick={() => void copy(TANK_BASE_URL + r.slug)}>Copy</Button>
          </div>
        ) : <span className="text-navy/60">—</span>
      },
    }),
    col.display({
      id: 'actions', header: '', size: 200, enableSorting: false,
      cell: (i) => {
        const r = i.row.original
        return r.slug ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => void showQr(r)}>QR code</Button>
            <button type="button" onClick={() => r.linkId && void revoke(r.linkId)} className="text-[11px] font-mono text-[#C0392B] hover:underline">Turn off</button>
          </div>
        ) : <Button size="sm" onClick={async () => { if (await createLink(r.id, r.shop)) void load() }}>Create link</Button>
      },
    }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [companyId])

  const { table, globalFilter, setGlobalFilter } = useTable(rows, columns, { persistKey: 'tank-links', initialPageSize: 100 })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Tank Calculator Links</h1>
          <p className="text-xs text-inky mt-0.5">One no-login link per shop. Shops enter their tanks once, then just type the filled depth and log the count.</p>
        </div>
        <Button size="sm" loading={busy} onClick={() => void createAllMissing()}>Create all missing links</Button>
      </div>
      {loading ? <div className="py-12 flex justify-center"><SbLoader size={36} /></div> : (
        <DataTable table={table} globalFilter={globalFilter} onGlobalFilterChange={setGlobalFilter} exportFilename="Tank calculator links" />
      )}
      <Modal open={!!qr} onClose={() => setQr(null)} title={qr?.title ?? ''} size="sm">
        {qr && (
          <div className="flex flex-col items-center gap-3">
            <img src={qr.dataUrl} alt="QR code" className="w-64 h-64 bg-white p-2 rounded" />
            <p className="text-[11px] font-mono text-navy break-all text-center">{qr.url}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => void copy(qr.url)}>Copy link</Button>
              <a href={qr.dataUrl} download={`tank-calculator-${qr.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`}><Button size="sm">Download QR</Button></a>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
