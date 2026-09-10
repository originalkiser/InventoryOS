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
  const { token } = useParams<{ token: string }>()
  const [status, setStatus] = useState<'loading' | 'ok' | 'notfound'>('loading')
  const [mode, setMode] = useState<'locked' | 'open'>('locked')
  const [packages, setPackages] = useState<MenuBoardPackage[]>([])
  const [quartDefaults, setQuartDefaults] = useState<QuartRow[]>([])
  const [shops, setShops] = useState<ShareShop[]>([])
  const [shopId, setShopId] = useState('')

  const [shop, setShop] = useState<{ id: string; prices: Record<string, number | null>; address: string } | null>(null)
  const [quartOverrides, setQuartOverrides] = useState<QuartRow[]>([])
  const [shopLoading, setShopLoading] = useState(false)

  // Share config
  useEffect(() => {
    if (!token) { setStatus('notfound'); return }
    sb().rpc('get_menu_board_share', { p_token: token }).then(({ data, error }: any) => {
      if (error || !data || data.error) { setStatus('notfound'); return }
      setMode(data.mode)
      setPackages(((data.packages ?? []) as any[]).map(normalizePackage))
      setQuartDefaults((data.quart_defaults ?? []) as QuartRow[])
      setShops((data.shops ?? []) as ShareShop[])
      if (data.mode === 'locked' && data.locked_location_id) setShopId(data.locked_location_id)
      setStatus('ok')
    })
  }, [token])

  const shopOptions = useMemo(() => shops.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name || l.id) }
  }).sort(byNaturalLabel), [shops])

  // Selected shop's prices
  const loadShop = useCallback(async (id: string) => {
    if (!token || !id) { setShop(null); return }
    setShopLoading(true)
    const { data, error } = await sb().rpc('get_menu_board_shop', { p_token: token, p_location_id: id })
    setShopLoading(false)
    if (error || !data || data.error) { setShop(null); return }
    const prices: Record<string, number | null> = {}
    for (const [k, v] of Object.entries(data.prices ?? {})) prices[k] = v == null ? null : Number(v)
    setShop({ id: data.id, prices, address: [data.address, data.city, data.state, data.zip].filter(Boolean).join(', ') })
    setQuartOverrides((data.quart_overrides ?? []) as QuartRow[])
  }, [token])
  useEffect(() => { if (shopId) loadShop(shopId) }, [shopId, loadShop])

  const resolveQuart = useCallback((_locationId: string, packageKey: string) => {
    const o = quartOverrides.find((r) => r.package_key === packageKey)
    if (o) return { pricePerQuart: o.price_per_quart, includedQuarts: o.included_quarts, isCustom: true }
    const d = quartDefaults.find((r) => r.package_key === packageKey)
    return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
  }, [quartOverrides, quartDefaults])

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
      <div className="max-w-[960px] mx-auto flex flex-col gap-3">
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
          />
        )}
      </div>
    </div>
  )
}
