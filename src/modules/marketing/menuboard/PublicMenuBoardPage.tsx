// Public, no-auth menu board — the target of a "Share link" token. Renders
// ONLY the board (no SB Net chrome). A "locked" token shows one shop with
// no picker; an "open" token shows a shop dropdown above the board. All
// data comes from the get_menu_board_share / get_menu_board_shop RPCs
// (SECURITY DEFINER, keyed by token) so nothing else is exposed to anon.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Combobox, SbLoader } from '@/components/ui'
import { byNaturalLabel } from '@/lib/naturalSort'
import type { MenuBoardPackage } from './useMenuBoard'
import { BoardViewer } from './MenuBoardPage'

const sb = () => supabase as any

// This page (a lobby/bay TV display, or just a browser tab someone leaves
// open) fetches once on load and otherwise has no reason to ever refetch on
// its own — unlike the admin app there's no navigation back to it to catch
// a price update. Re-check on this interval, and whenever the tab regains
// focus/visibility, so a price edited elsewhere shows up here without
// anyone needing to manually reload a screen nobody's actively watching.
const PRICE_REFRESH_MS = 5 * 60 * 1000

interface ShareShop { id: string; name: string | null; shop_city: string | null; address: string | null; city: string | null; state: string | null; zip: string | null }
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

export function PublicMenuBoardPage() {
  // Two URL shapes: the pretty /menu-board/<slug> and the legacy /m/<uuid>.
  const params = useParams<{ token?: string; slug?: string }>()
  const bySlug = !!params.slug
  const key = params.slug ?? params.token ?? ''
  const shareArgs = bySlug ? { p_slug: key } : { p_token: key }
  const shareFn = bySlug ? 'get_menu_board_share_by_slug' : 'get_menu_board_share'
  const shopFn = bySlug ? 'get_menu_board_shop_by_slug' : 'get_menu_board_shop'
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound'>('loading')
  const [mode, setMode] = useState<'locked' | 'open'>('locked')
  const [hidePage2, setHidePage2] = useState(false)
  const [packages, setPackages] = useState<MenuBoardPackage[]>([])
  const [quartDefaults, setQuartDefaults] = useState<QuartRow[]>([])
  const [shops, setShops] = useState<ShareShop[]>([])
  const [shopId, setShopId] = useState('')

  const [shop, setShop] = useState<{ id: string; prices: Record<string, number | null>; address: string } | null>(null)
  // This shop's custom per-package prices (package_key -> price) — a
  // package absent here just uses the company default.
  const [customPrices, setCustomPrices] = useState<Record<string, number>>({})
  const [shopLoading, setShopLoading] = useState(false)

  // Share config
  useEffect(() => {
    if (!key) { setStatus('notfound'); return }
    sb().rpc(shareFn, shareArgs).then(({ data, error }: any) => {
      if (error || !data || data.error) { setStatus('notfound'); return }
      setMode(data.mode)
      setHidePage2(!!data.hide_page2)
      setPackages(((data.packages ?? []) as any[]).map(normalizePackage))
      setQuartDefaults((data.quart_defaults ?? []) as QuartRow[])
      setShops((data.shops ?? []) as ShareShop[])
      if (data.mode === 'locked' && data.locked_location_id) setShopId(data.locked_location_id)
      setStatus('ok')
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bySlug])

  const shopOptions = useMemo(() => shops.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name || l.id) }
  }).sort(byNaturalLabel), [shops])

  // Selected shop's prices. `silent` skips the loading spinner for a
  // background re-check (see PRICE_REFRESH_MS below) — a kiosk display
  // shouldn't flash a spinner every few minutes, only on the real first load.
  const loadShop = useCallback(async (id: string, silent = false) => {
    if (!key || !id) { setShop(null); return }
    if (!silent) setShopLoading(true)
    const { data, error } = await sb().rpc(shopFn, { ...shareArgs, p_location_id: id })
    if (!silent) setShopLoading(false)
    if (error || !data || data.error) { if (!silent) setShop(null); return }
    const prices: Record<string, number | null> = {}
    for (const [pk, v] of Object.entries(data.prices ?? {})) prices[pk] = v == null ? null : Number(v)
    setShop({ id: data.id, prices, address: [data.address, data.city, data.state, data.zip].filter(Boolean).join(', ') })
    const custom: Record<string, number> = {}
    for (const [pk, v] of Object.entries(data.custom_prices ?? {})) if (v != null) custom[pk] = Number(v)
    setCustomPrices(custom)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bySlug])
  useEffect(() => { if (shopId) loadShop(shopId) }, [shopId, loadShop])

  // Keep a long-lived tab (or a display that never loses focus) from ever
  // going stale: re-check on an interval, and immediately on refocus rather
  // than waiting out the rest of the interval.
  useEffect(() => {
    if (!shopId) return
    const interval = window.setInterval(() => loadShop(shopId, true), PRICE_REFRESH_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') loadShop(shopId, true) }
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [shopId, loadShop])

  const resolveQuart = useCallback((_locationId: string, packageKey: string) => {
    const d = quartDefaults.find((r) => r.package_key === packageKey)
    const customPrice = customPrices[packageKey]
    if (customPrice != null) return { pricePerQuart: customPrice, includedQuarts: d?.included_quarts ?? null, isCustom: true }
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [customPrices, quartDefaults])

  const activePackages = useMemo(
    () => packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order),
    [packages],
  )
  const boardLocation = shop ? ({ id: shop.id, ...shop.prices } as any) : undefined
  const selectedShop = shops.find((s) => s.id === shopId)
  const shopName = selectedShop?.shop_city || selectedShop?.name || ''

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
        {mode === 'open' && (
          <div className="max-w-[480px]">
            <Combobox
              options={shopOptions} value={shopId} onChange={setShopId}
              placeholder="Choose a shop to see its prices…"
            />
          </div>
        )}
        {!shopId ? (
          <p className="text-xs font-mono text-sb-cream/60 py-10 text-center">Pick a shop above.</p>
        ) : shopLoading && !shop ? (
          <div className="py-16 flex justify-center"><SbLoader size={36} /></div>
        ) : (
          <BoardViewer
            location={boardLocation}
            packages={activePackages}
            resolveQuart={resolveQuart}
            address={shop?.address ?? ''}
            shopName={shopName}
            shareUrl={window.location.href}
            hidePage2={hidePage2}
          />
        )}
      </div>
    </div>
  )
}
