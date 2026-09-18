// Public, no-auth franchise menu board — the target of an fzmenu.sboc.app
// link. Always one specific shop (no picker, unlike the regular "open"
// menu board mode) and always hides page 2 — both fixed by the franchise
// flow itself, not a per-link choice. All data comes from the
// get_franchise_menu_share_by_slug RPC (SECURITY DEFINER, keyed by slug),
// which returns an already-confirmed pricing SNAPSHOT — this page never
// re-reads core.locations' own live prices, on purpose (see
// marketing.franchise_menu_shares' own migration comment).
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { SbLoader } from '@/components/ui'
import type { MenuBoardPackage } from '@/modules/marketing/menuboard/useMenuBoard'
import { BoardViewer } from '@/modules/marketing/menuboard/MenuBoardPage'
import { FRANCHISE_FOOTER_NOTE } from '@/modules/marketing/menuboard/franchiseMenu'

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

export function PublicFranchiseMenuBoardPage() {
  const { slug } = useParams<{ slug: string }>()
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound'>('loading')
  const [packages, setPackages] = useState<MenuBoardPackage[]>([])
  const [quartDefaults, setQuartDefaults] = useState<QuartRow[]>([])
  // Confirmed per-quart price overrides (2026-09-19 follow-up), package_key
  // -> price — only present when the setup link that generated this board
  // had "allow price-per-quart editing" on AND the franchisee actually
  // entered a value for that package. Empty object otherwise (the RPC
  // always returns '{}'::jsonb, never null).
  const [quartOverrides, setQuartOverrides] = useState<Record<string, number>>({})
  const [boardLocation, setBoardLocation] = useState<any>(null)
  const [address, setAddress] = useState('')
  const [shopName, setShopName] = useState('')
  const [footerNote, setFooterNote] = useState<string | null>(null)

  useEffect(() => {
    if (!slug) { setStatus('notfound'); return }
    sb.rpc('get_franchise_menu_share_by_slug', { p_slug: slug }).then(({ data, error }: any) => {
      if (error || !data || data.error) { setStatus('notfound'); return }
      setPackages(((data.packages ?? []) as any[]).map(normalizePackage))
      setQuartDefaults((data.quart_defaults ?? []) as QuartRow[])
      setQuartOverrides((data.quart_price_overrides ?? {}) as Record<string, number>)
      const fees = { shopSupplyFee: data.shop_supply_fee, disposalFee: data.disposal_fee, oilInflationSurcharge: data.oil_inflation_surcharge }
      const feesIncluded = !!data.fees_included_in_pricing
      const feeTotal = feesIncluded
        ? (num(fees.shopSupplyFee) + num(fees.disposalFee) + num(fees.oilInflationSurcharge))
        : 0
      const prices = data.prices ?? {}
      setBoardLocation({
        id: data.location_id,
        economy: prices.economy != null ? Number(prices.economy) + feeTotal : null,
        premium_hm: prices.premium_hm != null ? Number(prices.premium_hm) + feeTotal : null,
        premium_full_synthetic: prices.premium_full_synthetic != null ? Number(prices.premium_full_synthetic) + feeTotal : null,
        premium_full_synthetic_hm: prices.premium_full_synthetic_hm != null ? Number(prices.premium_full_synthetic_hm) + feeTotal : null,
        rp: prices.rp != null ? Number(prices.rp) + feeTotal : null,
      })
      setAddress(data.address ?? '')
      setShopName(data.shop_city || data.name || '')
      setFooterNote(feesIncluded ? FRANCHISE_FOOTER_NOTE : null)
      setStatus('ok')
    })
  }, [slug])

  const resolveQuart = useMemo(() => (_locationId: string, packageKey: string) => {
    const d = quartDefaults.find((r) => r.package_key === packageKey)
    const override = quartOverrides[packageKey]
    if (override != null) return { pricePerQuart: override, includedQuarts: d?.included_quarts ?? null, isCustom: true }
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [quartDefaults, quartOverrides])

  const activePackages = useMemo(
    () => packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order),
    [packages],
  )

  if (status === 'loading') {
    return <div className="min-h-screen flex items-center justify-center bg-sb-navy"><SbLoader size={44} /></div>
  }
  if (status === 'notfound') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
        <p className="text-sm font-mono text-sb-cream/80 text-center">This menu board link is no longer active.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-sb-navy py-6 px-3">
      <div className="max-w-[1600px] mx-auto flex flex-col gap-3">
        <BoardViewer
          location={boardLocation}
          packages={activePackages}
          resolveQuart={resolveQuart}
          address={address}
          shopName={shopName}
          hidePage2
          footerNote={footerNote}
        />
      </div>
    </div>
  )
}
