// Franchise Menu Board creation form (2026-09-18 request, extended
// 2026-09-18 with the public self-service setup flow) — picks an open,
// non-corporate shop, auto-populates the 5 canonical package base prices
// from core.locations (flagging which ones came from the list vs. still
// need entering), takes optional fees + an "include fees in pricing"
// toggle, and shows a live BoardViewer preview reflecting all of it in
// real time — the exact same board-rendering path every other menu board
// uses, just fed a location-shaped object with the confirmed prices
// swapped in for the real ones (see previewLocation below). Rendered from
// two places: FranchiseTab (an authenticated admin, `locations` from
// useLocations()) and PublicFranchiseSetupPage (an anonymous franchisee via
// a setup link, `locations` from the get_franchise_setup_context RPC) — the
// `setupToken` prop is what tells FranchiseConfirmModal which of those two
// contexts it's creating the share under.
import { useEffect, useMemo, useState } from 'react'
import { Button, Card, CardBody, Combobox, Toggle } from '@/components/ui'
import { ownerBucket } from '@/hooks/useLocationExclusions'
import { byNaturalLabel } from '@/lib/naturalSort'
import type { Location } from '@/types'
import type { MenuBoardPackage } from './useMenuBoard'
import { BoardViewer } from './MenuBoardPage'
import { FranchiseConfirmModal } from './FranchiseConfirmModal'
import {
  FRANCHISE_PACKAGE_KEYS, FRANCHISE_PACKAGE_LABELS, FRANCHISE_FOOTER_NOTE,
  effectivePackagePrice, type FranchisePackageKey, type FranchiseFees,
} from './franchiseMenu'

const EMPTY_PRICES: Record<FranchisePackageKey, string> = {
  economy: '', premium_hm: '', premium_full_synthetic: '', premium_full_synthetic_hm: '', rp: '',
}
const EMPTY_FLAGS: Record<FranchisePackageKey, boolean> = {
  economy: false, premium_hm: false, premium_full_synthetic: false, premium_full_synthetic_hm: false, rp: false,
}

export function FranchiseMenuForm({ locations, packages, resolveQuart, setupToken, allowQuartPricing, onCancel, onCreated }: {
  locations: Location[]
  packages: MenuBoardPackage[]
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  /** Set when rendered from the public, no-auth franchisee setup page (see
   *  PublicFranchiseSetupPage) — forwarded to FranchiseConfirmModal so it
   *  creates the share via the token-scoped RPC instead of a direct insert
   *  under the logged-in admin's own session. */
  setupToken?: string
  /** From the setup link's own allow_quart_pricing flag (2026-09-19 follow-up)
   *  — when set, an editable "price per extra quart" field appears next to
   *  each base package price, auto-filled from `resolveQuart` (the same
   *  source the board's own quart-price display already reads from) and
   *  flagged orange like the base prices. Never set from the internal admin
   *  flow — this is a setup-link-only feature per the request. */
  allowQuartPricing?: boolean
  /** Omitted on the public setup page — there's no internal list to cancel
   *  back to, so the "✕" button simply isn't rendered. */
  onCancel?: () => void
  onCreated: (url: string) => void
}) {
  // "Open, non-corporate" = active AND owner isn't literally 'Corporate' —
  // ownerBucket() is the existing app-wide Corporate/Franchise split
  // (useLocationExclusions.ts), reused here rather than re-deriving it. The
  // public setup page's own get_franchise_setup_context RPC already applies
  // this same rule server-side before the shop list ever reaches here, so
  // this filter is a no-op there — kept anyway so this component's own
  // behavior doesn't depend on which caller already filtered.
  const franchiseShopOptions = useMemo(
    () => locations
      .filter((l) => l.active && ownerBucket(l.owner ?? '') !== 'Corporate')
      .map((l) => ({ value: l.id, label: l.shop_city || l.name }))
      .sort(byNaturalLabel),
    [locations],
  )

  const [locationId, setLocationId] = useState('')
  const location = locations.find((l) => l.id === locationId)

  // FRANCHISE_PACKAGE_KEYS are core.locations COLUMN names (economy,
  // premium_hm, ...), which is exactly right for base pricing — but
  // resolveQuart() is keyed by marketing.menu_board_packages' own
  // package_key, which for Restore & Protect is "valvoline_restore_protect",
  // not "rp". The other 4 packages' package_key happens to equal their own
  // price_column by coincidence, so only RP ever exposed this: its quart
  // price silently never auto-filled. Bridge through the real packages
  // array (matched by price_column) instead of assuming the names line up.
  const packageKeyByPriceColumn = useMemo(
    () => new Map(packages.map((p) => [p.price_column, p.package_key] as const)),
    [packages],
  )

  const [priceInputs, setPriceInputs] = useState<Record<FranchisePackageKey, string>>(EMPTY_PRICES)
  // Tracks "this value came from the location list and hasn't been
  // touched yet" — cleared the instant the field is edited, independent of
  // whether the new value happens to match. Drives the orange "imported"
  // vs. plain styling; a blank field is always red "pricing needed"
  // regardless of this flag.
  const [autoFilled, setAutoFilled] = useState<Record<FranchisePackageKey, boolean>>(EMPTY_FLAGS)

  // Same shape as priceInputs/autoFilled above, for the optional
  // price-per-quart fields (allowQuartPricing) — auto-filled from
  // resolveQuart instead of the location row directly.
  const [quartPriceInputs, setQuartPriceInputs] = useState<Record<FranchisePackageKey, string>>(EMPTY_PRICES)
  const [quartAutoFilled, setQuartAutoFilled] = useState<Record<FranchisePackageKey, boolean>>(EMPTY_FLAGS)

  useEffect(() => {
    if (!location) {
      setPriceInputs(EMPTY_PRICES); setAutoFilled(EMPTY_FLAGS)
      setQuartPriceInputs(EMPTY_PRICES); setQuartAutoFilled(EMPTY_FLAGS)
      return
    }
    const next: Record<FranchisePackageKey, string> = { ...EMPTY_PRICES }
    const nextAuto: Record<FranchisePackageKey, boolean> = { ...EMPTY_FLAGS }
    for (const key of FRANCHISE_PACKAGE_KEYS) {
      const v = (location as any)[key] as number | null
      if (v != null) { next[key] = String(v); nextAuto[key] = true }
    }
    setPriceInputs(next)
    setAutoFilled(nextAuto)

    if (allowQuartPricing) {
      const nextQuart: Record<FranchisePackageKey, string> = { ...EMPTY_PRICES }
      const nextQuartAuto: Record<FranchisePackageKey, boolean> = { ...EMPTY_FLAGS }
      for (const key of FRANCHISE_PACKAGE_KEYS) {
        const realPackageKey = packageKeyByPriceColumn.get(key)
        const q = realPackageKey ? resolveQuart(location.id, realPackageKey).pricePerQuart : null
        if (q != null) { nextQuart[key] = String(q); nextQuartAuto[key] = true }
      }
      setQuartPriceInputs(nextQuart)
      setQuartAutoFilled(nextQuartAuto)
    }
    // Only re-seed when the SHOP changes, not on every location list
    // refresh/re-render — an in-progress manual edit shouldn't get
    // silently overwritten by a background reload of the same location.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  function setPrice(key: FranchisePackageKey, value: string) {
    setPriceInputs((p) => ({ ...p, [key]: value }))
    setAutoFilled((p) => ({ ...p, [key]: false }))
  }

  function setQuartPrice(key: FranchisePackageKey, value: string) {
    setQuartPriceInputs((p) => ({ ...p, [key]: value }))
    setQuartAutoFilled((p) => ({ ...p, [key]: false }))
  }

  const [shopSupplyFee, setShopSupplyFee] = useState('')
  const [disposalFee, setDisposalFee] = useState('')
  const [oilInflationSurcharge, setOilInflationSurcharge] = useState('')
  const [feesIncluded, setFeesIncluded] = useState(false)

  const fees: FranchiseFees = {
    shopSupplyFee: shopSupplyFee.trim() === '' ? null : Number(shopSupplyFee),
    disposalFee: disposalFee.trim() === '' ? null : Number(disposalFee),
    oilInflationSurcharge: oilInflationSurcharge.trim() === '' ? null : Number(oilInflationSurcharge),
  }

  const parsedPrices = useMemo(() => {
    const out = {} as Record<FranchisePackageKey, number | null>
    for (const key of FRANCHISE_PACKAGE_KEYS) {
      const raw = priceInputs[key].trim()
      const n = raw === '' ? null : Number(raw)
      out[key] = n != null && Number.isFinite(n) ? n : null
    }
    return out
  }, [priceInputs])

  const missingPrice = FRANCHISE_PACKAGE_KEYS.some((k) => parsedPrices[k] == null)
  const canGenerate = !!location && !missingPrice

  // Quart pricing is always optional (unlike base pricing) — a blank field
  // just means no override for that package, never blocks generation.
  const parsedQuartPrices = useMemo(() => {
    const out = {} as Record<FranchisePackageKey, number | null>
    for (const key of FRANCHISE_PACKAGE_KEYS) {
      const raw = quartPriceInputs[key].trim()
      const n = raw === '' ? null : Number(raw)
      out[key] = n != null && Number.isFinite(n) ? n : null
    }
    return out
  }, [quartPriceInputs])

  // Feeds the live preview (and, via the same shape, FranchiseConfirmModal's
  // own preview) whatever the franchisee has typed into the quart fields so
  // far, falling back to the real resolveQuart (SB Net's own pricing) for
  // any package they haven't touched. Only wraps resolveQuart at all when
  // allowQuartPricing is on — otherwise behaves exactly as before. Board
  // calls this with each package's own REAL package_key, so the override
  // lookup has to go through the same price_column bridge the auto-fill
  // above uses, not index parsedQuartPrices (keyed by price_column) with
  // the real package_key directly.
  const previewResolveQuart = useMemo(() => {
    if (!allowQuartPricing) return resolveQuart
    return (locId: string, packageKey: string) => {
      const base = resolveQuart(locId, packageKey)
      const priceColumn = packages.find((p) => p.package_key === packageKey)?.price_column as FranchisePackageKey | null | undefined
      const override = priceColumn ? parsedQuartPrices[priceColumn] : null
      return override == null ? base : { pricePerQuart: override, includedQuarts: base.includedQuarts, isCustom: true }
    }
  }, [allowQuartPricing, resolveQuart, parsedQuartPrices, packages])

  const address = location ? [location.address, location.city, location.state, location.zip].filter(Boolean).join(', ') : ''
  const previewLocation: Location | undefined = location ? {
    ...location,
    ...Object.fromEntries(FRANCHISE_PACKAGE_KEYS.map((k) => [k, effectivePackagePrice(parsedPrices[k], fees, feesIncluded)])),
  } : undefined

  const [confirmOpen, setConfirmOpen] = useState(false)
  const activePackages = useMemo(() => packages.filter((p) => p.active), [packages])
  const moneyInputCls = 'w-24 rounded border px-2 py-1 text-xs font-mono text-right focus:outline-none focus:border-sky'
  const quartMoneyInputCls = 'w-16 rounded border px-1.5 py-1 text-xs font-mono text-right focus:outline-none focus:border-sky'

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="lg:w-[440px] flex-shrink-0">
        <Card><CardBody className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-heading font-bold text-navy uppercase tracking-wide">New Franchise Menu Board</h3>
            {onCancel && <button onClick={onCancel} className="text-inky hover:text-navy text-sm" title="Cancel">✕</button>}
          </div>

          <Combobox label="Shop (franchise, open only)" options={franchiseShopOptions} value={locationId} onChange={setLocationId} placeholder="Search…" />

          <div>
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Pricing</label>
            <p className="text-[10px] font-mono text-inky mb-2">Pricing before taxes, fees, etc.</p>
            {allowQuartPricing && (
              <div className="flex items-center justify-end gap-1 px-2 pb-1">
                <span className="w-24 text-[9px] font-mono text-inky/70 uppercase tracking-wide text-center">Base Package</span>
                <span className="w-16 text-[9px] font-mono text-inky/70 uppercase tracking-wide text-center">Per Quart</span>
              </div>
            )}
            <div className="flex flex-col gap-1.5 rounded border border-navy/10 divide-y divide-navy/10">
              {FRANCHISE_PACKAGE_KEYS.map((key) => {
                const raw = priceInputs[key]
                const needsPrice = raw.trim() === ''
                const isImported = autoFilled[key] && !needsPrice
                const qRaw = quartPriceInputs[key]
                const qIsImported = quartAutoFilled[key] && qRaw.trim() !== ''
                return (
                  <div key={key} className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="text-xs font-mono text-navy">{FRANCHISE_PACKAGE_LABELS[key]}</span>
                    <div className="flex items-center gap-1">
                      <input type="number" step="0.01" value={raw} onChange={(e) => setPrice(key, e.target.value)}
                        disabled={!locationId} title="Base price"
                        className={[
                          moneyInputCls,
                          needsPrice ? 'border-[#C0392B] bg-[#C0392B]/10 text-[#C0392B]'
                            : isImported ? 'border-[#E67E22] bg-[#E67E22]/10 text-navy'
                            : 'border-navy/30 bg-cream text-navy',
                        ].join(' ')} />
                      {allowQuartPricing && (
                        <input type="number" step="0.01" value={qRaw} onChange={(e) => setQuartPrice(key, e.target.value)}
                          disabled={!locationId} placeholder="qt" title="Price per extra quart"
                          className={[
                            quartMoneyInputCls,
                            qIsImported ? 'border-[#E67E22] bg-[#E67E22]/10 text-navy' : 'border-navy/30 bg-cream text-navy',
                          ].join(' ')} />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
            {allowQuartPricing && (
              <p className="text-[10px] font-mono text-inky mt-1">Second box is price per extra quart (optional).</p>
            )}
            {locationId && FRANCHISE_PACKAGE_KEYS.some((k) => autoFilled[k] && priceInputs[k].trim() !== '') && (
              <p className="text-[10px] font-mono text-[#E67E22] mt-1">Pricing imported from list, edit if needed.</p>
            )}
            {locationId && allowQuartPricing && FRANCHISE_PACKAGE_KEYS.some((k) => quartAutoFilled[k] && quartPriceInputs[k].trim() !== '') && (
              <p className="text-[10px] font-mono text-[#E67E22] mt-1">Quart pricing imported from SB Net, edit if needed.</p>
            )}
            {locationId && missingPrice && (
              <p className="text-[10px] font-mono text-[#C0392B] mt-1">Pricing needed — every package needs a price before generating.</p>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
            <label className="text-[10px] font-mono text-inky uppercase tracking-wide">Fees (optional)</label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs font-mono text-navy">Shop Supply Fee</span>
              <input type="number" step="0.01" value={shopSupplyFee} onChange={(e) => setShopSupplyFee(e.target.value)}
                className={`${moneyInputCls} border-navy/30 bg-cream text-navy`} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs font-mono text-navy">Disposal Fee</span>
              <input type="number" step="0.01" value={disposalFee} onChange={(e) => setDisposalFee(e.target.value)}
                className={`${moneyInputCls} border-navy/30 bg-cream text-navy`} />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-xs font-mono text-navy">Oil Inflation Surcharge</span>
              <input type="number" step="0.01" value={oilInflationSurcharge} onChange={(e) => setOilInflationSurcharge(e.target.value)}
                className={`${moneyInputCls} border-navy/30 bg-cream text-navy`} />
            </label>
          </div>

          <div className="flex flex-col gap-1 border-t border-navy/10 pt-3">
            <Toggle checked={feesIncluded} onChange={setFeesIncluded} color="cyan" size="sm"
              label="Include supply fee, disposal fee, and/or oil inflation surcharge in pricing" />
            <p className="text-[10px] font-mono text-inky">
              {feesIncluded ? 'Pricing on Menu will be after fees, still before taxes.' : 'Pricing on Menu will be the base price.'}
            </p>
          </div>

          <Button size="sm" disabled={!canGenerate} onClick={() => setConfirmOpen(true)} className="mt-1">
            Confirm Data and Generate Menu Board
          </Button>
        </CardBody></Card>
      </div>

      <div className="flex-1 min-w-0">
        <Card><CardBody>
          {!location ? (
            <p className="text-xs font-mono text-inky py-16 text-center">Select a shop to preview its franchise menu board.</p>
          ) : (
            <BoardViewer
              location={previewLocation} packages={activePackages} resolveQuart={previewResolveQuart}
              address={address} hidePage2 hideDownload shopName={location.shop_city || location.name}
              footerNote={feesIncluded ? FRANCHISE_FOOTER_NOTE : null}
            />
          )}
        </CardBody></Card>
      </div>

      {confirmOpen && location && (
        <FranchiseConfirmModal
          location={location} address={address} packages={activePackages} resolveQuart={previewResolveQuart}
          prices={parsedPrices as Record<FranchisePackageKey, number>} fees={fees} feesIncluded={feesIncluded}
          setupToken={setupToken} quartPrices={allowQuartPricing ? parsedQuartPrices : undefined}
          onClose={() => setConfirmOpen(false)}
          onCreated={(url) => { setConfirmOpen(false); onCreated(url) }}
        />
      )}
    </div>
  )
}
