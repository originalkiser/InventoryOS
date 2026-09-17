// Franchise Menu Board tab (2026-09-18 request) — a "+ New" button that
// swaps this tab into the creation form (FranchiseMenuForm) in place, and
// a list of every franchise link generated so far. Deliberately its own
// list, never merged into (or read from) the regular Shop Links tab/table
// — franchise links live in marketing.franchise_menu_shares, a completely
// separate table (see that migration's own header comment for why).
import { useCallback, useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import type { MenuBoardPackage } from './useMenuBoard'
import { FranchiseMenuForm } from './FranchiseMenuForm'
import { FZMENU_BASE_URL } from './franchiseMenu'

const sb = supabase as any

interface FranchiseShareRow {
  token: string
  location_id: string
  slug: string
  price_economy: number
  price_premium_hm: number
  price_premium_full_synthetic: number
  price_premium_full_synthetic_hm: number
  price_rp: number
  fees_included_in_pricing: boolean
  address: string | null
  created_at: string
}

export function FranchiseTab({ loc, packages, resolveQuart }: {
  loc: ReturnType<typeof useLocations>
  packages: MenuBoardPackage[]
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [showForm, setShowForm] = useState(false)
  const [rows, setRows] = useState<FranchiseShareRow[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    setLoading(true)
    const { data, error } = await sb.schema('marketing').from('franchise_menu_shares')
      .select('token, location_id, slug, price_economy, price_premium_hm, price_premium_full_synthetic, price_premium_full_synthetic_hm, price_rp, fees_included_in_pricing, address, created_at')
      .eq('company_id', companyId).eq('active', true).order('created_at', { ascending: false })
    if (error) toast.error(`Franchise links didn't load: ${error.message}`)
    else setRows((data ?? []) as FranchiseShareRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function revoke(token: string) {
    const { error } = await sb.schema('marketing').from('franchise_menu_shares').update({ active: false }).eq('token', token)
    if (error) { toast.error(error.message); return }
    setRows((r) => r.filter((x) => x.token !== token))
    toast.success('Link revoked')
  }

  function shopLabel(locationId: string): string {
    const l = loc.locations.find((x) => x.id === locationId)
    return l ? (l.shop_city || l.name) : locationId
  }

  if (showForm) {
    return (
      <FranchiseMenuForm
        loc={loc} packages={packages} resolveQuart={resolveQuart}
        onCancel={() => setShowForm(false)}
        onCreated={() => { setShowForm(false); load() }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <Card><CardBody className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-xs font-mono text-inky/70">
          Blank menu boards for franchise shops — the franchisee's own confirmed pricing, on its own <span className="text-navy">fzmenu.sboc.app</span> link. Never listed on the regular Shop Links tab.
        </p>
        <Button size="sm" onClick={() => setShowForm(true)}>+ New Franchise Menu Board</Button>
      </CardBody></Card>

      {loading ? (
        <div className="py-12 flex justify-center"><SbLoader size={36} /></div>
      ) : rows.length === 0 ? (
        <Card><CardBody><p className="text-xs font-mono text-inky/60 py-8 text-center">No franchise menu boards generated yet.</p></CardBody></Card>
      ) : (
        <div className="overflow-auto rounded border border-navy/30">
          <table className="w-full text-xs font-mono">
            <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
              <th className="text-left px-3 py-2">Shop</th>
              <th className="text-left px-3 py-2">Address</th>
              <th className="text-left px-3 py-2">Link</th>
              <th className="text-left px-3 py-2">Fees Included</th>
              <th className="text-left px-3 py-2">Created</th>
              <th className="px-3 py-2" />
            </tr></thead>
            <tbody>
              {rows.map((r) => {
                const url = `${FZMENU_BASE_URL}${r.slug}`
                return (
                  <tr key={r.token} className="border-b border-navy/10 hover:bg-navy/5">
                    <td className="px-3 py-2 text-navy">{shopLabel(r.location_id)}</td>
                    <td className="px-3 py-2 text-inky">{r.address || '—'}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => { navigator.clipboard.writeText(url); toast.success('Link copied') }}
                        className="text-navy underline hover:text-inky">{url}</button>
                    </td>
                    <td className="px-3 py-2 text-inky">{r.fees_included_in_pricing ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2 text-inky">{new Date(r.created_at).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-right">
                      <button onClick={() => { if (confirm('Revoke this franchise menu board link?')) revoke(r.token) }}
                        className="text-[#C0392B] hover:underline">Revoke</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
