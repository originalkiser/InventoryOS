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
import type { Location } from '@/types'
import type { MenuBoardPackage } from './useMenuBoard'
import { FranchiseMenuForm } from './FranchiseMenuForm'
import { FZMENU_BASE_URL, FRANCHISE_SETUP_BASE_URL } from './franchiseMenu'

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

interface SetupLinkRow {
  token: string
  label: string | null
  created_at: string
}

export function FranchiseTab({ locations, packages, resolveQuart }: {
  locations: Location[]
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
    const l = locations.find((x) => x.id === locationId)
    return l ? (l.shop_city || l.name) : locationId
  }

  // Franchisee self-service setup links (2026-09-18 follow-up) — a
  // completely separate table/list from the generated board links above.
  // One of these is handed directly to a franchisee; opening it (see
  // PublicFranchiseSetupPage) lets them build their OWN shop's board
  // through this same form, and the result shows up in the list above just
  // like one an admin created directly.
  const [setupLinks, setSetupLinks] = useState<SetupLinkRow[]>([])
  const [setupLoading, setSetupLoading] = useState(true)
  const [creatingSetupLink, setCreatingSetupLink] = useState(false)

  const loadSetupLinks = useCallback(async () => {
    if (!companyId) { setSetupLoading(false); return }
    setSetupLoading(true)
    const { data, error } = await sb.schema('marketing').from('franchise_setup_links')
      .select('token, label, created_at')
      .eq('company_id', companyId).eq('active', true).order('created_at', { ascending: false })
    if (error) toast.error(`Setup links didn't load: ${error.message}`)
    else setSetupLinks((data ?? []) as SetupLinkRow[])
    setSetupLoading(false)
  }, [companyId])
  useEffect(() => { loadSetupLinks() }, [loadSetupLinks])

  async function createSetupLink() {
    if (!companyId) return
    setCreatingSetupLink(true)
    const { data, error } = await sb.schema('marketing').from('franchise_setup_links')
      .insert({ company_id: companyId, created_by: profile?.id ?? null })
      .select('token, label, created_at').single()
    setCreatingSetupLink(false)
    if (error) { toast.error(error.message); return }
    setSetupLinks((r) => [data as SetupLinkRow, ...r])
    const url = `${FRANCHISE_SETUP_BASE_URL}${data.token}`
    navigator.clipboard?.writeText(url).catch(() => {})
    toast.success(`Setup link created — link copied: ${url}`, { duration: 8000 })
  }

  async function revokeSetupLink(token: string) {
    const { error } = await sb.schema('marketing').from('franchise_setup_links').update({ active: false }).eq('token', token)
    if (error) { toast.error(error.message); return }
    setSetupLinks((r) => r.filter((x) => x.token !== token))
    toast.success('Setup link revoked')
  }

  if (showForm) {
    return (
      <FranchiseMenuForm
        locations={locations} packages={packages} resolveQuart={resolveQuart}
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

      <Card><CardBody className="flex flex-col gap-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h4 className="text-xs font-heading font-bold text-navy uppercase tracking-wide">Franchisee Setup Links</h4>
            <p className="text-[11px] font-mono text-inky/60 mt-0.5">
              Hand one of these directly to a franchisee — no SB Net login needed. They pick their own shop and build their board through this exact same form; the result shows up in the list below just like one you create yourself.
            </p>
          </div>
          <Button size="sm" onClick={createSetupLink} disabled={creatingSetupLink}>
            {creatingSetupLink ? 'Creating…' : '+ New Setup Link'}
          </Button>
        </div>

        {setupLoading ? (
          <div className="py-6 flex justify-center"><SbLoader size={28} /></div>
        ) : setupLinks.length === 0 ? (
          <p className="text-xs font-mono text-inky/60 py-3 text-center">No setup links yet.</p>
        ) : (
          <div className="overflow-auto rounded border border-navy/20 mt-1">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/20">
                <th className="text-left px-3 py-2">Link</th>
                <th className="text-left px-3 py-2">Created</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {setupLinks.map((r) => {
                  const url = `${FRANCHISE_SETUP_BASE_URL}${r.token}`
                  return (
                    <tr key={r.token} className="border-b border-navy/10 hover:bg-navy/5">
                      <td className="px-3 py-2">
                        <button onClick={() => { navigator.clipboard.writeText(url); toast.success('Link copied') }}
                          className="text-navy underline hover:text-inky">{url}</button>
                      </td>
                      <td className="px-3 py-2 text-inky">{new Date(r.created_at).toLocaleDateString()}</td>
                      <td className="px-3 py-2 text-right">
                        <button onClick={() => { if (confirm('Revoke this setup link? The franchisee will no longer be able to use it.')) revokeSetupLink(r.token) }}
                          className="text-[#C0392B] hover:underline shrink-0">Revoke</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
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
