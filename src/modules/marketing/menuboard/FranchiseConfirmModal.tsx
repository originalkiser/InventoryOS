// Franchise Menu Board confirm-and-generate modal (2026-09-18 request) —
// deliberately makes the confirm button unavailable for CONFIRM_DELAY_SECONDS
// so whoever's generating the link actually looks at the summary/preview
// first, rather than reflexively clicking through. No such "confirm after a
// countdown" pattern exists anywhere else in this codebase — built from
// scratch here, scoped to just this one flow.
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import type { Location } from '@/types'
import type { MenuBoardPackage } from './useMenuBoard'
import { Board, makeLockedShareSlug } from './MenuBoardPage'
import {
  FRANCHISE_PACKAGE_KEYS, FRANCHISE_PACKAGE_LABELS, FRANCHISE_FOOTER_NOTE, FZMENU_BASE_URL,
  effectivePackagePrice, type FranchisePackageKey, type FranchiseFees,
} from './franchiseMenu'

const sb = supabase as any
const CONFIRM_DELAY_SECONDS = 10

export function FranchiseConfirmModal({ location, address, packages, resolveQuart, prices, fees, feesIncluded, setupToken, onClose, onCreated }: {
  location: Location
  address: string
  packages: MenuBoardPackage[]
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  prices: Record<FranchisePackageKey, number>
  fees: FranchiseFees
  feesIncluded: boolean
  /** Set on the public, no-auth franchisee setup flow — creates the share
   *  via the token-scoped RPC (no session, no profile.company_id) instead
   *  of the direct insert the authenticated admin flow uses. */
  setupToken?: string
  onClose: () => void
  onCreated: (url: string) => void
}) {
  const { profile } = useAuthStore()
  const [secondsLeft, setSecondsLeft] = useState(CONFIRM_DELAY_SECONDS)
  const [submitting, setSubmitting] = useState(false)
  // Kicked to true a tick after mount so the width transition actually
  // animates from 0 -> 100% instead of snapping straight to 100% (a style
  // set in the same render as the transition class first applies has
  // nothing to transition FROM).
  const [barStarted, setBarStarted] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setBarStarted(true), 20)
    return () => clearTimeout(t)
  }, [])

  useEffect(() => {
    if (secondsLeft <= 0) return
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [secondsLeft])

  const previewLocation: Location = {
    ...location,
    ...Object.fromEntries(FRANCHISE_PACKAGE_KEYS.map((k) => [k, effectivePackagePrice(prices[k], fees, feesIncluded)])),
  }

  async function confirm() {
    if (!setupToken && !profile?.company_id) return
    setSubmitting(true)
    try {
      if (setupToken) {
        // Public setup-link flow — no session to satisfy franchise_menu_shares'
        // own RLS policy, so this goes through a SECURITY DEFINER RPC that
        // resolves the company from the token and does its own slug-retry
        // server-side (see that migration's own header comment).
        const { data, error } = await sb.rpc('create_franchise_menu_share_via_setup_link', {
          p_token: setupToken,
          p_location_id: location.id,
          p_price_economy: prices.economy,
          p_price_premium_hm: prices.premium_hm,
          p_price_premium_full_synthetic: prices.premium_full_synthetic,
          p_price_premium_full_synthetic_hm: prices.premium_full_synthetic_hm,
          p_price_rp: prices.rp,
          p_shop_supply_fee: fees.shopSupplyFee,
          p_disposal_fee: fees.disposalFee,
          p_oil_inflation_surcharge: fees.oilInflationSurcharge,
          p_fees_included: feesIncluded,
          p_address: address,
        })
        if (error || data?.error) {
          toast.error(error?.message ?? `Could not create the franchise menu board (${data?.error})`)
          return
        }
        const url = `${FZMENU_BASE_URL}${data.slug}`
        navigator.clipboard?.writeText(url).catch(() => {})
        toast.success(`Franchise menu board created — link copied: ${url}`, { duration: 8000 })
        onCreated(url)
        return
      }

      const base = {
        company_id: profile!.company_id,
        location_id: location.id,
        price_economy: prices.economy,
        price_premium_hm: prices.premium_hm,
        price_premium_full_synthetic: prices.premium_full_synthetic,
        price_premium_full_synthetic_hm: prices.premium_full_synthetic_hm,
        price_rp: prices.rp,
        shop_supply_fee: fees.shopSupplyFee,
        disposal_fee: fees.disposalFee,
        oil_inflation_surcharge: fees.oilInflationSurcharge,
        fees_included_in_pricing: feesIncluded,
        address,
        created_by: profile!.id ?? null,
      }
      // Same retry-on-slug-collision shape as ShareMenuBoardModal's own
      // create() — a fresh 4-char hash suffix on each attempt.
      let lastErrMessage: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        const slug = makeLockedShareSlug(location.name)
        const { error } = await sb.schema('marketing').from('franchise_menu_shares').insert({ ...base, slug })
        if (!error) {
          const url = `${FZMENU_BASE_URL}${slug}`
          navigator.clipboard?.writeText(url).catch(() => {})
          toast.success(`Franchise menu board created — link copied: ${url}`, { duration: 8000 })
          onCreated(url)
          return
        }
        lastErrMessage = error.message
        if (!/duplicate key|unique/i.test(error.message)) break
      }
      toast.error(lastErrMessage ?? 'Could not create the franchise menu board')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-cream rounded-lg border border-navy/30 shadow-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-3 border-b border-navy/10 flex-shrink-0">
          <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">Confirm &amp; Generate Franchise Menu Board</h3>
          <button onClick={onClose} className="text-inky/50 hover:text-navy">✕</button>
        </div>

        {/* Scrollable body — everything below stays reachable regardless of
            how tall the board preview renders; only this region scrolls. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono">
            <span className="text-inky/60">Shop</span><span className="text-navy">{location.shop_city || location.name}</span>
            <span className="text-inky/60">Address</span><span className="text-navy">{address || '—'}</span>
            <span className="text-inky/60">Fees folded into pricing</span><span className="text-navy">{feesIncluded ? 'Yes' : 'No'}</span>
          </div>

          <table className="w-full text-xs font-mono">
            <thead><tr className="text-inky/60 uppercase border-b border-navy/10">
              <th className="text-left py-1 font-normal">Package</th>
              <th className="text-right py-1 font-normal">Base</th>
              <th className="text-right py-1 font-normal">On Menu</th>
            </tr></thead>
            <tbody>
              {FRANCHISE_PACKAGE_KEYS.map((k) => (
                <tr key={k} className="border-b border-navy/5">
                  <td className="py-1 text-navy">{FRANCHISE_PACKAGE_LABELS[k]}</td>
                  <td className="text-right text-inky">${prices[k].toFixed(2)}</td>
                  <td className="text-right text-navy font-bold">${(effectivePackagePrice(prices[k], fees, feesIncluded) ?? 0).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(fees.shopSupplyFee != null || fees.disposalFee != null || fees.oilInflationSurcharge != null) && (
            <p className="text-[10px] font-mono text-inky/60 -mt-2">
              {[
                fees.shopSupplyFee != null ? `Shop Supply Fee $${fees.shopSupplyFee.toFixed(2)}` : null,
                fees.disposalFee != null ? `Disposal Fee $${fees.disposalFee.toFixed(2)}` : null,
                fees.oilInflationSurcharge != null ? `Oil Inflation Surcharge $${fees.oilInflationSurcharge.toFixed(2)}` : null,
              ].filter(Boolean).join(' · ')}
            </p>
          )}

          <Board
            location={previewLocation} packages={packages} resolveQuart={resolveQuart}
            address={address} hidePage2 footerNote={feesIncluded ? FRANCHISE_FOOTER_NOTE : null}
          />
        </div>

        {/* Frozen at the bottom of the modal regardless of scroll position —
            content above scrolls, this footer never moves. */}
        <div className="flex-shrink-0 border-t border-navy/10 px-5 py-3 flex flex-col gap-2 bg-cream rounded-b-lg">
          <div className="h-1.5 w-full rounded-full bg-navy/10 overflow-hidden">
            <div
              className="h-full bg-sky transition-[width] ease-linear"
              style={{ width: barStarted ? '100%' : '0%', transitionDuration: `${CONFIRM_DELAY_SECONDS}s` }}
            />
          </div>
          <button
            onClick={confirm}
            disabled={secondsLeft > 0 || submitting}
            className="w-full rounded py-2.5 text-sm font-heading font-bold uppercase tracking-wide bg-navy text-cream hover:bg-inky disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
            {submitting ? 'Generating…' : secondsLeft > 0 ? `Review the board above (${secondsLeft}s)` : 'Confirm & Generate Link'}
          </button>
        </div>
      </div>
    </div>
  )
}
