// Public, no-auth "direct download" link for one shop's menu board PDF —
// the target of the Shop Links table's "Download PDF" column. Unlike a
// static file, this rebuilds the PDF from the shop's live core.locations
// prices on every visit (same canvas draw the board itself uses), so a
// price change in the OSL shows up the very next time this link is opened
// or re-downloaded — nothing to regenerate.

import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { Button, SbLoader } from '@/components/ui'
import { buildMenuBoardPdf, menuBoardPdfName } from './MenuBoardPage'
import type { MenuBoardPackage } from './useMenuBoard'

const sb = () => supabase as any
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

export function MenuBoardPdfPage() {
  const { slug } = useParams<{ slug: string }>()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'notfound'>('loading')
  const [shopName, setShopName] = useState('')
  const triggeredRef = useRef(false)
  const blobUrlRef = useRef<string | null>(null)
  const filenameRef = useRef('menu-board.pdf')

  useEffect(() => {
    let cancelled = false

    async function run() {
      if (!slug) { setStatus('notfound'); return }

      const { data: share, error: shareErr } = await sb().rpc('get_menu_board_share_by_slug', { p_slug: slug })
      if (cancelled) return
      // This route only serves shop-locked links — the Shop Links table
      // never mints an open ("viewer picks") one, so there's no shop to
      // download without a picker here.
      if (shareErr || !share || share.error || share.mode !== 'locked' || !share.locked_location_id) {
        setStatus('notfound')
        return
      }

      const { data: shopData, error: shopErr } = await sb()
        .rpc('get_menu_board_shop_by_slug', { p_slug: slug, p_location_id: share.locked_location_id })
      if (cancelled) return
      if (shopErr || !shopData || shopData.error) { setStatus('notfound'); return }

      const packages = ((share.packages ?? []) as any[])
        .map(normalizePackage)
        .filter((p) => p.active)
        .sort((a, b) => a.sort_order - b.sort_order)
      const quartDefaults = (share.quart_defaults ?? []) as { package_key: string; price_per_quart: number | null; included_quarts: number | null }[]
      // This shop's custom per-package prices — a package absent here just
      // uses the company default.
      const customPrices: Record<string, number> = {}
      for (const [pk, v] of Object.entries(shopData.custom_prices ?? {})) if (v != null) customPrices[pk] = Number(v)
      const resolveQuart = (_locationId: string, packageKey: string) => {
        const d = quartDefaults.find((r) => r.package_key === packageKey)
        const customPrice = customPrices[packageKey]
        if (customPrice != null) return { pricePerQuart: customPrice, includedQuarts: d?.included_quarts ?? null, isCustom: true }
        return { pricePerQuart: d?.price_per_quart ?? null, includedQuarts: d?.included_quarts ?? null, isCustom: false }
      }

      const prices: Record<string, number | null> = {}
      for (const [pk, v] of Object.entries(shopData.prices ?? {})) prices[pk] = v == null ? null : Number(v)
      const location = { id: shopData.id, ...prices } as any
      const address = [shopData.address, shopData.city, shopData.state, shopData.zip].filter(Boolean).join(', ')
      const shopRow = ((share.shops ?? []) as any[]).find((s) => s.id === share.locked_location_id)
      const name = shopRow?.shop_city || shopRow?.name || ''
      if (cancelled) return
      setShopName(name)

      // This page is served from the menu.sboc.app subdomain itself (see
      // App.tsx's MenuBoardApp), so window.location.origin is already the
      // right base — just swap the /pdf suffix for the plain board URL.
      const shareUrl = `${window.location.origin}/${slug}`

      try {
        const blob = await buildMenuBoardPdf({ packages, location, resolveQuart, address, shareUrl, hidePage2: !!share.hide_page2 })
        if (cancelled) return
        const url = URL.createObjectURL(blob)
        blobUrlRef.current = url
        filenameRef.current = menuBoardPdfName(name)
        setStatus('ready')
        if (!triggeredRef.current) {
          triggeredRef.current = true
          const a = document.createElement('a')
          a.href = url
          a.download = filenameRef.current
          document.body.appendChild(a)
          a.click()
          a.remove()
        }
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    run()
    return () => { cancelled = true }
  }, [slug])

  // Release the blob URL when this page is left.
  useEffect(() => () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current) }, [])

  function downloadAgain() {
    if (!blobUrlRef.current) return
    const a = document.createElement('a')
    a.href = blobUrlRef.current
    a.download = filenameRef.current
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-sb-navy px-6">
      <div className="max-w-sm text-center flex flex-col items-center gap-4">
        {status === 'loading' && (
          <>
            <SbLoader size={40} />
            <p className="text-sm font-mono text-sb-cream/80">Building the menu board PDF…</p>
          </>
        )}
        {status === 'ready' && (
          <>
            <p className="text-sm font-mono text-sb-cream">
              Your download of {shopName ? `${shopName}'s` : "this shop's"} menu board should have started.
            </p>
            <Button size="sm" onClick={downloadAgain}>Download again</Button>
          </>
        )}
        {status === 'notfound' && (
          <p className="text-sm font-mono text-sb-cream/80">This menu board download link is no longer active.</p>
        )}
        {status === 'error' && (
          <p className="text-sm font-mono text-sb-cream/80">Could not build the PDF — try this link again in a moment.</p>
        )}
      </div>
    </div>
  )
}
