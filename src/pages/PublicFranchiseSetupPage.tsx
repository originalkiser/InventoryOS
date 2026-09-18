// Public, no-auth franchisee self-service setup page (2026-09-18 follow-up
// request) — the target of an fzmenu.sboc.app/setup/:token link, handed
// directly to a franchisee so they can build their OWN shop's franchise
// menu board without an SB Net login. Renders the exact same
// FranchiseMenuForm/FranchiseConfirmModal an admin uses internally
// (FranchiseTab), just fed data from the get_franchise_setup_context RPC
// instead of the authenticated useLocations()/useMenuBoard() hooks, and
// passes setupToken through so the confirm step creates the share via the
// token-scoped create_franchise_menu_share_via_setup_link RPC instead of a
// direct table insert under a logged-in session (see that migration's own
// header comment for why an anonymous visitor needs a different path).
//
// Open, not locked to one shop — the franchisee picks their own shop from
// a dropdown of the company's open/non-corporate/active shops, same
// eligibility rule FranchiseMenuForm already applies. Reusable: this page
// stays live and generates a fresh franchise_menu_shares snapshot on every
// "Confirm & Generate" click, so the same link works for a franchisee with
// more than one shop, or for a later price update — a short in-page list
// below just tracks what THIS visit has created so a multi-shop franchisee
// doesn't lose track of an earlier link before copying it.
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SbLoader } from '@/components/ui'
import type { Location } from '@/types'
import type { MenuBoardPackage } from '@/modules/marketing/menuboard/useMenuBoard'
import { FranchiseMenuForm } from '@/modules/marketing/menuboard/FranchiseMenuForm'

const sb = supabase as any

interface QuartRow { package_key: string; price_per_quart: number | null; included_quarts: number | null }

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function normalizePackage(raw: any): MenuBoardPackage {
  return {
    id: String(raw.id),
    package_key: raw.package_key,
    display_name: raw.display_name,
    qualifier: raw.qualifier ?? null,
    price_column: raw.price_column ?? null,
    sort_order: num(raw.sort_order),
    active: !!raw.active,
    price_pos_x: num(raw.price_pos_x),
    price_pos_y: num(raw.price_pos_y),
    price_font_size: num(raw.price_font_size),
    quart_pos_x: num(raw.quart_pos_x),
    quart_pos_y: num(raw.quart_pos_y),
    quart_font_size: num(raw.quart_font_size),
  }
}

export function PublicFranchiseSetupPage() {
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound'>('loading')
  const [locations, setLocations] = useState<Location[]>([])
  const [packages, setPackages] = useState<MenuBoardPackage[]>([])
  const [quartDefaults, setQuartDefaults] = useState<QuartRow[]>([])
  const [allowQuartPricing, setAllowQuartPricing] = useState(false)
  const [created, setCreated] = useState<string[]>([])
  const [formKey, setFormKey] = useState(0)

  useEffect(() => {
    if (!token) { setStatus('notfound'); return }
    sb.rpc('get_franchise_setup_context', { p_token: token }).then(({ data, error }: any) => {
      if (error || !data || data.error) { setStatus('notfound'); return }
      // The RPC returns only the fields this form actually needs (see its
      // own header comment) — not a full core.locations row, so this is
      // cast rather than built out to satisfy every Location field, same
      // as PublicFranchiseMenuBoardPage's own synthetic boardLocation.
      setLocations((data.shops ?? []) as any as Location[])
      setPackages(((data.packages ?? []) as any[]).map(normalizePackage))
      setQuartDefaults((data.quart_defaults ?? []) as QuartRow[])
      setAllowQuartPricing(!!data.allow_quart_pricing)
      setStatus('ok')
    })
  }, [token])

  const resolveQuart = useMemo(() => (_locationId: string, packageKey: string) => {
    const d = quartDefaults.find((r) => r.package_key === packageKey)
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [quartDefaults])

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-cream"><SbLoader size={44} /></div>
  }
  if (status === 'notfound') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-cream px-6">
        <p className="text-sm font-mono text-inky text-center">This setup link is no longer active. Contact Strickland Brothers for a new one.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream py-6 px-3">
      <div className="max-w-[1000px] mx-auto flex flex-col gap-4">
        <div>
          <h1 className="text-lg font-heading font-bold text-navy uppercase tracking-wide">Franchise Menu Board Setup</h1>
          <p className="text-xs font-mono text-inky mt-1">
            Pick your shop, confirm your pricing, and generate your menu board link below. You can come back to this same page anytime — for another shop, or to update your pricing later.
          </p>
        </div>

        {created.length > 0 && (
          <div className="rounded border border-sky bg-sky/10 px-3 py-2 flex flex-col gap-1.5">
            <p className="text-[10px] font-mono uppercase tracking-wide text-navy">
              {created.length === 1 ? 'Menu board created' : 'Menu boards created this visit'}
            </p>
            {created.map((url) => (
              <div key={url} className="flex items-center gap-2 text-xs font-mono">
                <button onClick={() => { navigator.clipboard?.writeText(url).catch(() => {}) }}
                  className="text-navy underline hover:text-inky break-all text-left">{url}</button>
              </div>
            ))}
          </div>
        )}

        <FranchiseMenuForm
          key={formKey}
          locations={locations} packages={packages} resolveQuart={resolveQuart}
          setupToken={token} allowQuartPricing={allowQuartPricing}
          onCreated={(url) => { setCreated((c) => [url, ...c]); setFormKey((k) => k + 1) }}
        />
      </div>
    </div>
  )
}
