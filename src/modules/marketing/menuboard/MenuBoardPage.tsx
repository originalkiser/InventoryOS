import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import QRCode from 'qrcode'
import { createColumnHelper, type VisibilityState } from '@tanstack/react-table'
import { Button, Card, CardBody, Combobox, Input, Modal, Tabs, TabsList, TabsTrigger, TabsContent, Toggle, SbLoader } from '@/components/ui'
import { DataTable } from '@/components/shared/DataTable'
import { useTable } from '@/hooks/useTable'
import { useColumnPrefs } from '@/hooks/useColumnPrefs'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { usePageRevisit } from '@/hooks/usePageActive'
import { ownerBucket } from '@/hooks/useLocationExclusions'
import { ColumnManagerModal, type ColItem } from '../../locations/ColumnManagerModal'
import { ConfigUpload } from '@/components/config/ConfigUpload'
import { requestImportConfirm } from '@/components/config/ImportPreviewHost'
import type { ImportMode } from '@/modules/config/useConfigTab'
import { mappedValue } from '@/lib/columnTransform'
import { useMenuBoardPackages, useMenuBoardQuartPricing, type MenuBoardPackage } from './useMenuBoard'
import { byNaturalLabel, naturalCompare } from '@/lib/naturalSort'
import { imagesToPdf } from '@/lib/imagesToPdf'
import type { Location, ColumnMapping } from '@/types'
import menuBoardArt from '@/assets/MenuBoard-01.png'
import menuBoardArt2 from '@/assets/MenuBoard-02.png'

const LAST_LOCATION_KEY = 'menu-board:last-location'
const money = (v: number | null | undefined) => (v == null ? null : Number(v))
const fmtPrice = (v: number | null) => (v == null ? '—' : v.toFixed(2))

// The stored price_font_size / quart_font_size and the patch dimensions
// derived from them were all sized against a 480px-wide board. The board's
// actual rendered width is measured (ResizeObserver) and everything scaled
// by width/480 so a phone-width board shrinks the patches proportionally
// instead of a fixed-px patch overflowing the printed card's border.
const BOARD_REF_WIDTH = 480

// The viewer (BoardViewer) lets the board grow well past the 480px design
// width on a wide screen and adds PDF-reader-style zoom. Everything inside
// Board is %-positioned and font sizes are re-scaled off the measured
// width, so any display width just works.
const MAX_BOARD_WIDTH = 1100
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

type BoardLayout = 'single' | 'stacked' | 'side-by-side'
const LAYOUT_KEY = 'menu-board:layout'

// The disclaimer line's asterisks ("* * * * * ALL OIL CHANGES ARE SUBJECT TO
// A SHOP SUPPLY AND/OR DISPOSAL FEE. * * * * *") sit at x ≈ 4.88%–94.84% of
// the native 2850px-wide art (pixel-scanned off MenuBoard-01.png) — in
// effect the board's real left/right content bounds, since the few percent
// outside them on both sides is just blank navy bezel, not printed content.
// "Fit to screen" sizes against this span rather than the raw image edges
// so it doesn't waste viewport width on that bezel or force horizontal
// scrolling to see it.
const BOARD_CONTENT_LEFT_PCT = 4.88
const BOARD_CONTENT_RIGHT_PCT = 94.84

// The numeric price columns on core.locations a package can be fed from —
// the Package Mapping "Source Column" dropdown. Kept as an explicit list
// (not derived from a location row's keys) so a null-valued column on the
// sample row can't drop out of the options, and so non-price numeric
// columns (royalty_rate, planned_2024, …) never appear.
const PRICE_COLUMN_OPTIONS: { value: string; label: string }[] = [
  { value: 'economy', label: 'economy' },
  { value: 'premium_hm', label: 'premium_hm' },
  { value: 'premium_full_synthetic', label: 'premium_full_synthetic' },
  { value: 'premium_full_synthetic_hm', label: 'premium_full_synthetic_hm' },
  { value: 'rp', label: 'rp (Restore & Protect)' },
  { value: 'diesel_syn_blend', label: 'diesel_syn_blend' },
  { value: 'diesel_full_syn', label: 'diesel_full_syn' },
  { value: 'european', label: 'european' },
  { value: 'supply_fee', label: 'supply_fee' },
  { value: 'disposal_fee', label: 'disposal_fee' },
  { value: 'oil_inflation_surcharge', label: 'oil_inflation_surcharge' },
]

// The real board art (src/assets/MenuBoard-01.png + -02.png) is the actual
// printed sign — everything on it (logos, package names, qualifiers,
// "PRICES INCLUDE UP TO 5 QUARTS", additional services, disclaimers, the
// staff reference sheet on page 2) is the genuine artwork. Page 1 is the
// BLANK-slate export: the shop's price and per-extra-quart line have been
// removed from each box, so we just draw the live text into the empty box
// (no background patch to hide anything). Native size is 2850×4950; the
// DB's price_pos_x/y / quart_pos_x/y (percentages, measured off the image,
// and draggable via "Edit layout") hold at any rendered width.
// The only per-package board fact not in the DB: whether the box is the
// cream "ULTIMATE" tier (rp only) — drives the live text colour (navy on
// cream, cream on navy). Any package_key not here has no spot on the art
// and is skipped.
const BOARD_SLOTS: Record<string, { cream: boolean }> = {
  valvoline_restore_protect: { cream: true },
  premium_full_synthetic_hm: { cream: false },
  premium_full_synthetic:    { cream: false },
  premium_hm:                { cream: false },
  economy:                   { cream: false },
}

// ── QR codes ─────────────────────────────────────────────────────────────
// One tiny helper reused everywhere a board link needs a scannable code: the
// board's own page-1 (web + PDF), and the Shop Links table. `qrcode` renders
// to a data URL for <img> use and straight onto a <canvas> for the PDF path
// (avoids loading a cross-origin image into the PDF canvas, which would
// taint it and break `toDataURL()`).
//
// margin is in QR "modules," not px — it's the required blank quiet zone a
// scanner uses to find the code's edges. Never drop this to 0: without it
// codes still look fine and scan eventually, but noticeably slower/flakier
// on real phone cameras, since the scanner has to work harder to locate the
// code's boundary against whatever's printed right up against it.
const QR_MARGIN = 2
async function qrDataUrl(text: string, pixelSize: number): Promise<string> {
  return QRCode.toDataURL(text, { margin: QR_MARGIN, width: pixelSize, color: { dark: '#002745', light: '#F2F1E6' } })
}

/**
 * Small QR `<img>` for a share URL — renders nothing while empty/unset.
 * Generates at ~2x the display `size` (crisp without being wasteful) — the
 * Shop Links table renders up to one of these per shop, so a fixed high-res
 * bitmap regardless of display size would add up fast on a 300+-shop table.
 */
function QrImage({ url, size = 56, className = '' }: { url: string; size?: number; className?: string }) {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!url) { setSrc(null); return }
    qrDataUrl(url, Math.max(96, size * 2)).then((d) => { if (!cancelled) setSrc(d) }).catch(() => { if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, size])
  if (!src) return null
  return <img src={src} alt="QR code to this menu board" width={size} height={size} className={className} />
}

/**
 * Menu Board — an on-screen recreation of the printed lobby/bay board,
 * priced live per shop. Package prices come straight from core.locations
 * (economy/premium_hm/premium_full_synthetic/premium_full_synthetic_hm/rp —
 * already synced from Monday.com, see the migration's own comment for how
 * that mapping was verified against a real board); price-per-extra-quart is
 * a company default with optional per-location overrides.
 */
export function MenuBoardPage() {
  const loc = useLocations()
  const { packages, loading: packagesLoading, update: updatePackage, reload: reloadPackages } = useMenuBoardPackages()
  const quartPricing = useMenuBoardQuartPricing()

  // This tab is one of the pages KeepAlivePages keeps mounted in the
  // background rather than unmounting on navigation (see its own comment),
  // so its data doesn't naturally refetch just because you've navigated
  // back to it. A price edited on the Locations page — or another admin's
  // package/quart-pricing change — would otherwise keep showing here until
  // a hard refresh. usePageRevisit re-loads everything as soon as this tab
  // is looked at again (revisited or refocused), rate-limited so rapid
  // tab-switching can't spam it.
  usePageRevisit(() => { loc.reload(); reloadPackages(); quartPricing.reload() })

  const [locationId, setLocationId] = useState(() => {
    try { return localStorage.getItem(LAST_LOCATION_KEY) ?? '' } catch { return '' }
  })
  useEffect(() => {
    try { if (locationId) localStorage.setItem(LAST_LOCATION_KEY, locationId) } catch { /* ignore */ }
  }, [locationId])

  // Combobox's own filter only matches substrings of `label` — folding
  // address/city/state into the label text (not just the shop number/city)
  // is what makes "search by name, address, or city" actually work.
  const shopOptions = useMemo(() => loc.locations.map((l) => {
    const addr = [l.address, l.city, l.state].filter(Boolean).join(', ')
    return { value: l.id, label: addr ? `${l.shop_city || l.name} — ${addr}` : (l.shop_city || l.name) }
  }).sort(byNaturalLabel), [loc.locations])
  const location = loc.byId(locationId || null)

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-bold text-navy tracking-wide uppercase">Menu Board</h1>
        <p className="text-xs text-inky mt-0.5">Live per-shop pricing board, pulled from each location's own configured prices.</p>
      </div>

      <Tabs defaultValue="board">
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="mapping">Package Mapping</TabsTrigger>
          <TabsTrigger value="quarts">Quart Pricing</TabsTrigger>
          <TabsTrigger value="custom">Custom Pricing ({quartPricing.overrides.length})</TabsTrigger>
          <TabsTrigger value="links">Shop Links</TabsTrigger>
        </TabsList>

        <TabsContent value="board">
          <BoardTab
            shopOptions={shopOptions} locationId={locationId} onLocationChange={setLocationId} location={location}
            packages={packages} packagesLoading={packagesLoading} updatePackage={updatePackage}
            resolveQuart={quartPricing.resolve}
          />
        </TabsContent>

        <TabsContent value="mapping">
          <PackageMappingTab packages={packages} loading={packagesLoading} updatePackage={updatePackage} />
        </TabsContent>

        <TabsContent value="quarts">
          <QuartDefaultsTab packages={packages} quartPricing={quartPricing} />
        </TabsContent>

        <TabsContent value="custom">
          <CustomPricingTab packages={packages} quartPricing={quartPricing} loc={loc} />
        </TabsContent>

        <TabsContent value="links">
          <ShopLinksTab loc={loc} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Board ────────────────────────────────────────────────────────────────

function BoardTab({ shopOptions, locationId, onLocationChange, location, packages, packagesLoading, updatePackage, resolveQuart }: {
  shopOptions: { value: string; label: string }[]
  locationId: string
  onLocationChange: (id: string) => void
  location: Location | undefined
  packages: MenuBoardPackage[]
  packagesLoading: boolean
  updatePackage: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean>
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
}) {
  const [editMode, setEditMode] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const address = location ? [location.address, location.city, location.state, location.zip].filter(Boolean).join(', ') : ''
  const activePackages = useMemo(() => packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order), [packages])

  return (
    <div className="flex flex-col gap-3">
      <Card><CardBody className="flex items-end gap-3 flex-wrap">
        <div className="w-full sm:w-[460px]">
          <Combobox label="Shop" options={shopOptions} value={locationId} onChange={onLocationChange}
            placeholder="Search by name, address, or city…" />
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShareOpen(true)}>Share link</Button>
        <div className="ml-auto">
          <Toggle checked={editMode} onChange={setEditMode} color="cyan" size="sm" label="Edit layout" />
        </div>
      </CardBody></Card>

      {shareOpen && (
        <ShareMenuBoardModal
          currentLocationId={locationId}
          currentLabel={shopOptions.find((o) => o.value === locationId)?.label ?? ''}
          currentShopNumber={location?.name ?? ''}
          onClose={() => setShareOpen(false)}
        />
      )}

      {!locationId ? (
        <Card><CardBody><p className="text-xs font-mono text-inky/60 py-8 text-center">Search for a shop above to show its board.</p></CardBody></Card>
      ) : packagesLoading ? (
        <div className="py-16 flex justify-center"><SbLoader size={36} /></div>
      ) : (
        <Card><CardBody>
          <BoardViewer
            location={location} packages={activePackages} editMode={editMode} updatePackage={updatePackage}
            resolveQuart={resolveQuart} address={address}
            shopName={(location as any)?.shop_city || location?.name || ''}
          />
        </CardBody></Card>
      )}
    </div>
  )
}

/**
 * The board itself — each package's price/quart text absolutely positioned
 * by percentage over the page-1 art, then the page-2 reference sheet and a
 * shop-address bar. Draggable in edit mode (admin only): pointer-drag
 * updates position live, committed to the DB on release. Reused read-only
 * by the public share page (no editMode, no updatePackage).
 */
export function Board({ location, packages, editMode = false, updatePackage, resolveQuart, address, width, layout = 'stacked', page = 1, shareUrl, hidePage2 }: {
  location: Location | undefined
  packages: MenuBoardPackage[]
  editMode?: boolean
  updatePackage?: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean> | void
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  address: string
  /** Per-page display width in px (from BoardViewer's zoom). Falls back to
   *  100% capped at the 480px design width when omitted. */
  width?: number
  /** 'single' shows one page at a time (see `page`); 'stacked' = page 1
   *  above page 2; 'side-by-side' = page 1 left, page 2 right. */
  layout?: BoardLayout
  page?: 1 | 2
  /** When set, a QR code linking here is drawn under page 1's address bar. */
  shareUrl?: string
  /** Share-level toggle to omit the page-2 staff reference sheet entirely. */
  hidePage2?: boolean
}) {
  const boardRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<{ id: string; field: 'price' | 'quart' } | null>(null)
  // Measured board width — every patch dimension is scaled by boardW/480
  // (the width the stored px sizes were designed against) so a phone-width
  // board shrinks the patches to match instead of overflowing the card.
  const [boardW, setBoardW] = useState(BOARD_REF_WIDTH)
  useEffect(() => {
    const el = boardRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBoardW(el.clientWidth || BOARD_REF_WIDTH))
    ro.observe(el)
    setBoardW(el.clientWidth || BOARD_REF_WIDTH)
    return () => ro.disconnect()
  }, [])
  const scale = boardW / BOARD_REF_WIDTH

  function startDrag(e: React.PointerEvent, pkg: MenuBoardPackage, field: 'price' | 'quart') {
    if (!editMode) return
    e.preventDefault()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    setDragging({ id: pkg.id, field })
  }

  function onMove(e: React.PointerEvent) {
    if (!dragging || !boardRef.current) return
    const rect = boardRef.current.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((e.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((e.clientY - rect.top) / rect.height) * 100))
    const key = dragging.field === 'price' ? { price_pos_x: x, price_pos_y: y } : { quart_pos_x: x, quart_pos_y: y }
    updatePackage?.(dragging.id, key)
  }

  function endDrag() { setDragging(null) }

  const showP1 = layout !== 'single' || page === 1
  const showP2 = !hidePage2 && (layout !== 'single' || page === 2)
  const boxStyle = { width: width ?? '100%', maxWidth: width ?? BOARD_REF_WIDTH } as const

  const page1 = (
    <div key="p1" className="rounded-lg overflow-hidden bg-sb-navy" style={boxStyle}>
      {/* The priced board through Additional Services. Rendered as an <img>
          (not a fixed aspect-ratio background) so nothing at the bottom is
          ever clipped. Overlay text is scaled by `scale` (measured width ÷
          480) so it tracks the printed card at any board width. */}
      <div data-mb-page="1">
        <div
          ref={boardRef}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          className="relative w-full select-none"
        >
          <img src={menuBoardArt} alt="Menu board" className="block w-full" draggable={false} />
          {packages.map((p) => {
            const slot = BOARD_SLOTS[p.package_key]
            if (!slot) return null // no known spot on the art (e.g. Dexos)
            const priceCol = p.price_column
            const price = priceCol ? money((location as any)?.[priceCol]) : null
            const quart = resolveQuart(location?.id ?? '', p.package_key)
            const patchText = slot.cream ? 'text-sb-navy' : 'text-sb-cream'
            const fs = p.price_font_size * scale
            return (
              <div key={p.id}>
                {/* Price + per-quart line, each centred on its DB point. */}
                <div
                  onPointerDown={(e) => startDrag(e, p, 'price')}
                  className={`absolute flex items-center justify-center font-heading font-bold leading-none ${patchText} ${editMode ? 'cursor-move ring-1 ring-sb-sky/60' : ''}`}
                  style={{
                    left: `${p.price_pos_x}%`, top: `${p.price_pos_y}%`, transform: 'translate(-50%, -50%)',
                  }}
                >
                  {price == null ? (
                    <span style={{ fontSize: fs, lineHeight: 1 }}>—</span>
                  ) : (
                    <PriceComposite price={price} fs={fs} />
                  )}
                </div>
                <div
                  onPointerDown={(e) => startDrag(e, p, 'quart')}
                  className={`absolute flex items-center justify-center whitespace-nowrap font-mono leading-none ${patchText} ${editMode ? 'cursor-move ring-1 ring-sb-sky/60' : ''}`}
                  style={{
                    left: `${p.quart_pos_x}%`, top: `${p.quart_pos_y}%`, transform: 'translate(-50%, -50%)',
                    fontSize: p.quart_font_size * scale,
                  }}
                >
                  {quart.pricePerQuart == null ? '—' : `$${fmtPrice(quart.pricePerQuart)} per extra quart`}
                </div>
              </div>
            )
          })}
        </div>

        {/* The real art is a generic template with no shop-specific address
            printed on it — shown as its own bar below the board instead of
            guessed onto the image. */}
        <div className="bg-sb-navy text-sb-cream/80 text-center px-3 py-1.5">
          <span className="text-[10px] font-mono">{address || (location ? '' : 'Select a shop above')}</span>
        </div>

        {shareUrl && (
          <div className="bg-sb-navy flex flex-col items-center gap-1 px-3 pb-3 pt-1">
            <QrImage url={shareUrl} size={Math.round(72 * scale)} />
            <span className="text-[9px] font-mono text-sb-cream/50 text-center">Scan for the live board</span>
          </div>
        )}
      </div>
    </div>
  )

  const page2 = (
    <div key="p2" className="rounded-lg overflow-hidden bg-sb-navy" style={boxStyle}>
      {/* The staff reference sheet (recommendations, top-off policy, the SB
          Experience checklist). Static, no overlays. */}
      <div data-mb-page="2">
        <img src={menuBoardArt2} alt="Menu board — recommendations & procedures" className="block w-full" draggable={false} />
      </div>
    </div>
  )

  return (
    <>
      {/* w-max + min-w-full: the row/column is exactly as wide as its content
          but never narrower than the viewport — so a zoomed-in board scrolls
          from its left edge inside BoardViewer's overflow-auto instead of
          being centre-clipped on both sides. */}
      <div className={`w-max min-w-full mx-auto ${layout === 'side-by-side' ? 'flex flex-row items-start justify-center gap-3' : 'flex flex-col items-center gap-3'}`}>
        {showP1 && page1}
        {showP2 && page2}
      </div>
      {editMode && (
        <p className="text-[11px] font-mono text-inky/60 mt-2 text-center">
          Drag a price or per-quart patch to reposition it. Use Package Mapping to adjust font size.
        </p>
      )}
    </>
  )
}

/**
 * Download filename, e.g. `1-Thomasville_SB-Menu-Board_09.10.2026.pdf`.
 * Shop name is slugified (spaces/punctuation → single dashes); the date is
 * today's, MM.DD.YYYY. Falls back to `SB-Menu-Board_<date>.pdf` with no
 * shop when one isn't known.
 */
export function menuBoardPdfName(shopName?: string): string {
  const d = new Date()
  const date = `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}.${d.getFullYear()}`
  const slug = (shopName ?? '').trim().replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return `${slug ? `${slug}_` : ''}SB-Menu-Board_${date}.pdf`
}

// ── PDF export ─────────────────────────────────────────────────────────
//
// The PDF is drawn straight onto a <canvas> (art image + fillText for every
// price / quart line) rather than screenshotting the live DOM — html2canvas
// 1.4.1 can't reproduce the price composite's fine layout (vertical-align,
// the PLUS-TAX stack, the centred overlays) and always misaligned it. Here
// every glyph position is under our control, so the PDF matches the board.

const PDF_W = 1600 // page-1/2 canvas width in px (height follows each art's ratio)

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => resolve(im)
    im.onerror = reject
    im.src = src
  })
}

/** Draw one "$·big·⁹⁹ / PLUS TAX" composite centred on (cx, cy). */
function drawPriceComposite(ctx: CanvasRenderingContext2D, cx: number, cy: number, fs: number, price: number, color: string) {
  const whole = String(Math.floor(price))
  const cents = Math.round((price - Math.floor(price)) * 100).toString().padStart(2, '0')
  const smallFs = fs * 0.46
  const ptFs = fs * 0.115
  const bigFont = `700 ${fs}px "Chakra Petch", sans-serif`
  const smallFont = `700 ${smallFs}px "Chakra Petch", sans-serif`
  const ptFont = `700 ${ptFs}px "Chakra Petch", sans-serif`

  ctx.fillStyle = color
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'

  ctx.font = bigFont
  const mBig = ctx.measureText(whole)
  const bigCap = mBig.actualBoundingBoxAscent || fs * 0.72
  const wWhole = mBig.width
  ctx.font = smallFont
  const wDollar = ctx.measureText('$').width
  const wCents = ctx.measureText(cents).width
  const smallCap = ctx.measureText(cents).actualBoundingBoxAscent || smallFs * 0.72
  ctx.font = ptFont
  const wPT = ctx.measureText('PLUS TAX').width

  const gap = fs * 0.04
  const colW = Math.max(wCents, wPT)
  const totalW = wDollar + wWhole + gap + colW

  // Big digits' baseline so their cap is centred a touch above cy (PLUS TAX
  // hangs below, so nudge the block up slightly to keep it visually centred).
  const bigBaseline = cy + bigCap / 2 - fs * 0.09
  const capTop = bigBaseline - bigCap
  // "$" and cents sit with their tops just below the big cap top (matching
  // the on-screen composite, where they're not quite flush with the very top).
  const smallBaseline = capTop + smallCap + fs * 0.04

  let x = cx - totalW / 2
  ctx.font = smallFont
  ctx.fillText('$', x, smallBaseline)
  x += wDollar
  ctx.font = bigFont
  ctx.fillText(whole, x, bigBaseline)
  x += wWhole + gap
  ctx.font = smallFont
  ctx.fillText(cents, x + (colW - wCents) / 2, smallBaseline)
  ctx.font = ptFont
  ctx.fillText('PLUS TAX', x + (colW - wPT) / 2, smallBaseline + ptFs + fs * 0.02)
}

export async function buildMenuBoardPdf({ packages, location, resolveQuart, address, shareUrl, hidePage2 }: {
  packages: MenuBoardPackage[]
  location: Location | undefined
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  address: string
  /** When set, a QR code linking here is drawn under page 1's address bar. */
  shareUrl?: string
  /** Omit the page-2 staff reference sheet — a single-page PDF. */
  hidePage2?: boolean
}): Promise<Blob> {
  await Promise.all([
    document.fonts.load('700 100px "Chakra Petch"'),
    document.fonts.load('16px "DM Mono"'),
  ]).catch(() => {})

  const art1 = await loadImage(menuBoardArt)
  const scale = PDF_W / BOARD_REF_WIDTH

  // ── Page 1: board + priced overlays + address bar (+ QR, if shared) ─
  const h1Art = Math.round(PDF_W * (art1.naturalHeight / art1.naturalWidth))
  const addrH = Math.round(PDF_W * 0.032)
  const qrSize = Math.round(PDF_W * 0.11)
  const qrPad = Math.round(PDF_W * 0.02)
  const qrCaptionH = Math.round(PDF_W * 0.022)
  const qrBlockH = shareUrl ? qrPad * 2 + qrSize + qrCaptionH : 0
  const c1 = document.createElement('canvas')
  c1.width = PDF_W
  c1.height = h1Art + addrH + qrBlockH
  const ctx1 = c1.getContext('2d')!
  ctx1.drawImage(art1, 0, 0, PDF_W, h1Art)

  const active = packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order)
  for (const p of active) {
    const slot = BOARD_SLOTS[p.package_key]
    if (!slot) continue
    const color = slot.cream ? '#002745' : '#F2F1E6'
    const price = p.price_column ? Number((location as any)?.[p.price_column]) : NaN
    if (Number.isFinite(price)) {
      drawPriceComposite(ctx1, (p.price_pos_x / 100) * PDF_W, (p.price_pos_y / 100) * h1Art, p.price_font_size * scale, price, color)
    }
    const q = resolveQuart(location?.id ?? '', p.package_key)
    if (q.pricePerQuart != null) {
      ctx1.fillStyle = color
      ctx1.font = `${p.quart_font_size * scale}px "DM Mono", monospace`
      ctx1.textAlign = 'center'
      ctx1.textBaseline = 'middle'
      ctx1.fillText(`$${q.pricePerQuart.toFixed(2)} per extra quart`, (p.quart_pos_x / 100) * PDF_W, (p.quart_pos_y / 100) * h1Art)
    }
  }

  ctx1.fillStyle = '#002745'
  ctx1.fillRect(0, h1Art, PDF_W, addrH + qrBlockH)
  if (address) {
    ctx1.fillStyle = 'rgba(242,241,230,0.8)'
    ctx1.font = `${addrH * 0.4}px "DM Mono", monospace`
    ctx1.textAlign = 'center'
    ctx1.textBaseline = 'middle'
    ctx1.fillText(address, PDF_W / 2, h1Art + addrH / 2)
  }

  if (shareUrl) {
    const qrCanvas = document.createElement('canvas')
    await QRCode.toCanvas(qrCanvas, shareUrl, { margin: QR_MARGIN, width: qrSize, color: { dark: '#002745', light: '#F2F1E6' } })
    const qrX = (PDF_W - qrSize) / 2
    const qrY = h1Art + addrH + qrPad
    ctx1.drawImage(qrCanvas, qrX, qrY, qrSize, qrSize)
    ctx1.fillStyle = 'rgba(242,241,230,0.5)'
    ctx1.font = `${qrCaptionH * 0.8}px "DM Mono", monospace`
    ctx1.textAlign = 'center'
    ctx1.textBaseline = 'middle'
    ctx1.fillText('Scan for the live board', PDF_W / 2, qrY + qrSize + qrCaptionH / 2)
  }

  const pages = [{ jpegDataUrl: c1.toDataURL('image/jpeg', 0.92) }]

  // ── Page 2: the static reference sheet (skipped when hidePage2) ────
  if (!hidePage2) {
    const art2 = await loadImage(menuBoardArt2)
    const h2 = Math.round(PDF_W * (art2.naturalHeight / art2.naturalWidth))
    const c2 = document.createElement('canvas')
    c2.width = PDF_W
    c2.height = h2
    c2.getContext('2d')!.drawImage(art2, 0, 0, PDF_W, h2)
    pages.push({ jpegDataUrl: c2.toDataURL('image/jpeg', 0.92) })
  }

  // fit: 'image' → each PDF page is the menu's own shape, image edge-to-edge,
  // no white margin.
  return imagesToPdf(pages, { fit: 'image' })
}

/**
 * Board + a PDF-reader-style toolbar: zoom out / zoom % / zoom in / reset /
 * fit-to-screen, layout, and a "Download PDF" button. The toolbar sits
 * BELOW the board (not above it) so the initial view is as much board as
 * possible — most people zoom with their own browser/device rather than
 * this control, which stays reachable by scrolling past the board rather
 * than competing with it for the top of the viewport. Used by the admin
 * Board tab and the public share page so both get the same viewing controls.
 */
export function BoardViewer({ shopName, shareUrl, hidePage2, ...props }: React.ComponentProps<typeof Board> & { shopName?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [fitW, setFitW] = useState(BOARD_REF_WIDTH)
  const [zoom, setZoom] = useState(1)
  const [pdfBusy, setPdfBusy] = useState(false)
  const [layoutPref, setLayoutPref] = useState<BoardLayout>(() => {
    try { return (localStorage.getItem(LAYOUT_KEY) as BoardLayout) || 'single' } catch { return 'single' }
  })
  const [pagePref, setPagePref] = useState<1 | 2>(1)
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, layoutPref) } catch { /* ignore */ } }, [layoutPref])
  // True right after "Fit to screen" — centers the board and clips (instead
  // of scrolling) the ~5% bezel the width-fit intentionally lets run past
  // the viewport edge (see fitToScreen below). Any manual zoom/layout/page
  // change clears it, going back to normal left-anchored scrolling.
  const [fitMode, setFitMode] = useState(false)

  // A share with page 2 hidden has nothing to stack/side-by-side/page
  // through — force single-page-1 for rendering without touching the user's
  // stored layout preference (it should still apply normally on a share
  // that DOES have page 2).
  const layout: BoardLayout = hidePage2 ? 'single' : layoutPref
  const page: 1 | 2 = hidePage2 ? 1 : pagePref

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFitW(el.clientWidth || BOARD_REF_WIDTH))
    ro.observe(el)
    setFitW(el.clientWidth || BOARD_REF_WIDTH)
    return () => ro.disconnect()
  }, [])

  // Per-page width. Side-by-side fits two pages in the viewport at zoom 1;
  // zooming past that just scrolls (PDF-reader style).
  const fitPerPage = layout === 'side-by-side' ? (fitW - 12) / 2 : fitW
  const baseW = Math.min(fitPerPage, MAX_BOARD_WIDTH)
  const displayW = Math.max(240, Math.round(baseW * zoom))
  const setZoomClamped = (z: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100)))
  // Manual zoom/layout/page controls drop back to normal scrolling —
  // fitMode's centered-and-clipped width fit only applies right after
  // "Fit to screen" itself.
  function manualZoom(z: number) { setFitMode(false); setZoomClamped(z) }
  function chooseLayout(l: BoardLayout) { setFitMode(false); setLayoutPref(l) }
  function choosePage(p: 1 | 2) { setFitMode(false); setPagePref(p) }

  // Picks whichever zoom is more restrictive — height (top-to-bottom of the
  // page(s) aligns with the viewport) or width (the board's real content,
  // per BOARD_CONTENT_LEFT/RIGHT_PCT, spans the viewport) — so neither
  // dimension ever overflows. When width is the binding constraint the full
  // board (content + bezel) ends up very slightly wider than the viewport;
  // fitMode centers and clips that sliver instead of leaving it scrollable,
  // since it's just blank background, not printed content.
  function fitToScreen() {
    const wrap = wrapRef.current
    const content = contentRef.current
    if (!wrap || !content) return
    const top = wrap.getBoundingClientRect().top
    const availableH = window.innerHeight - top - 16
    const availableW = wrap.clientWidth
    const rect = content.getBoundingClientRect()
    if (rect.height <= 0 || rect.width <= 0 || availableW <= 0) return
    const naturalH = rect.height / zoom
    const naturalW = rect.width / zoom
    const contentFrac = (BOARD_CONTENT_RIGHT_PCT - BOARD_CONTENT_LEFT_PCT) / 100
    const widthZoom = availableW / (naturalW * contentFrac)
    const heightZoom = availableH / naturalH
    setFitMode(true)
    setZoomClamped(Math.min(widthZoom, heightZoom))
  }

  async function downloadPdf() {
    setPdfBusy(true)
    try {
      const blob = await buildMenuBoardPdf({
        packages: props.packages,
        location: props.location,
        resolveQuart: props.resolveQuart,
        address: props.address,
        shareUrl,
        hidePage2,
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = menuBoardPdfName(shopName)
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch {
      toast.error('Could not build the PDF')
    } finally {
      setPdfBusy(false)
    }
  }

  const zBtn = 'w-7 h-7 grid place-items-center rounded bg-sb-cream/10 hover:bg-sb-cream/20 disabled:opacity-30 disabled:hover:bg-sb-cream/10 text-sb-cream font-mono text-base leading-none'
  const segBtn = (on: boolean) =>
    `px-2 h-7 rounded font-mono text-[11px] ${on ? 'bg-sb-sky text-sb-navy font-bold' : 'bg-sb-cream/10 text-sb-cream hover:bg-sb-cream/20'}`

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={wrapRef}
        className={`pb-1 overflow-y-auto ${fitMode ? 'overflow-x-hidden flex justify-center' : 'overflow-x-auto'}`}
      >
        <div ref={contentRef}>
          <Board {...props} width={displayW} layout={layout} page={page} shareUrl={shareUrl} hidePage2={hidePage2} />
        </div>
      </div>

      {/* Fixed sb-* tokens (not the theme-flipping ones) so the toolbar
          reads the same on the cream admin card and the navy public page. */}
      <div className="flex items-center gap-1 rounded-md bg-sb-navy px-2 py-1.5 flex-wrap">
        <button type="button" className={zBtn} onClick={() => manualZoom(zoom - ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
        <span className="w-12 text-center text-[11px] font-mono tabular-nums text-sb-cream">{Math.round(zoom * 100)}%</span>
        <button type="button" className={zBtn} onClick={() => manualZoom(zoom + ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
        <button type="button" className="ml-1 px-2 h-7 rounded bg-sb-cream/10 hover:bg-sb-cream/20 disabled:opacity-30 text-sb-cream font-mono text-[11px]" onClick={() => manualZoom(1)} disabled={zoom === 1 && !fitMode}>Reset</button>
        <button type="button" className={segBtn(fitMode)} onClick={fitToScreen}>Fit&nbsp;to&nbsp;screen</button>

        {!hidePage2 && (
          <>
            <span className="w-px h-5 bg-sb-cream/20 mx-1" />
            {/* Layout: one page at a time / stacked / side-by-side */}
            <button type="button" className={segBtn(layout === 'single')} onClick={() => chooseLayout('single')}>Single</button>
            <button type="button" className={segBtn(layout === 'stacked')} onClick={() => chooseLayout('stacked')}>Stacked</button>
            <button type="button" className={segBtn(layout === 'side-by-side')} onClick={() => chooseLayout('side-by-side')}>Side&nbsp;by&nbsp;side</button>

            {layout === 'single' && (
              <>
                <span className="w-px h-5 bg-sb-cream/20 mx-1" />
                <button type="button" className={segBtn(page === 1)} onClick={() => choosePage(1)}>Page&nbsp;1</button>
                <button type="button" className={segBtn(page === 2)} onClick={() => choosePage(2)}>Page&nbsp;2</button>
              </>
            )}
          </>
        )}

        <button type="button" onClick={downloadPdf} disabled={pdfBusy}
          className="ml-auto px-3 h-7 rounded bg-sb-sky hover:brightness-95 disabled:opacity-50 text-sb-navy font-mono font-bold text-[11px] uppercase tracking-wide">
          {pdfBusy ? 'Building…' : 'Download PDF'}
        </button>
      </div>
    </div>
  )
}

/**
 * The printed-board price treatment: a smaller "$", big whole dollars, a
 * cents pair, and "PLUS TAX" tucked directly under the cents. `fs` is the
 * big-digit size in px (already width-scaled); everything else is a
 * fraction of it. The "$" and the cents/PLUS-TAX column are raised with
 * `vertical-align` (a px length) so their tops line up with the top of the
 * big digits. The Download-PDF path does NOT screenshot this — it redraws
 * the same composite onto a canvas (`drawPriceComposite`) — so the two
 * must be kept visually in sync.
 */
function PriceComposite({ price, fs }: { price: number; fs: number }) {
  const whole = Math.floor(price)
  const cents = Math.round((price - whole) * 100).toString().padStart(2, '0')
  const SMALL = fs * 0.46
  return (
    <span className="font-heading font-bold" style={{ fontSize: fs, lineHeight: 1, whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: SMALL, verticalAlign: `${fs * 0.38}px` }}>$</span>
      <span>{whole}</span>
      {/* cents over "PLUS TAX" — centred as one column, its top level with
          the big digits' top, PLUS TAX tucked just under and no wider. */}
      <span
        style={{
          display: 'inline-block', textAlign: 'center', verticalAlign: `${fs * 0.13}px`,
          marginLeft: fs * 0.04,
        }}
      >
        <span style={{ fontSize: SMALL, display: 'block', lineHeight: 1 }}>{cents}</span>
        <span style={{ fontSize: fs * 0.115, display: 'block', lineHeight: 1, marginTop: fs * 0.008, letterSpacing: '-0.01em' }}>PLUS TAX</span>
      </span>
    </span>
  )
}

// ── Share link ─────────────────────────────────────────────────────────

interface ShareRow { token: string; slug: string | null; location_id: string | null; label: string | null; hide_page2: boolean; created_at: string }
const sb = () => supabase as any
// The public menu board lives on its own subdomain (see App.tsx's
// isMenuBoardHost/MenuBoardApp) rather than under a path on this admin app's
// own domain — hardcoded rather than derived from window.location.origin,
// since that'd be wrong whenever this admin UI itself is loaded from
// anywhere else (GitHub Pages during the Cloudflare cutover, localhost in
// dev) — the share destination is always the same regardless of where the
// link was generated from.
const MENU_BOARD_BASE_URL = 'https://menu.sboc.app/'
// A locked link gets the pretty /<slug> URL; anything without a slug (older
// links, "any shop" links) keeps the /m/<token> URL.
const shareUrlFor = (r: Pick<ShareRow, 'token' | 'slug'>) =>
  r.slug ? `${MENU_BOARD_BASE_URL}${r.slug}` : `${MENU_BOARD_BASE_URL}m/${r.token}`
const slugSuffix = () => Math.random().toString(36).replace(/[^a-z0-9]/g, '').slice(0, 4).padEnd(4, '0')
/**
 * Slug for a shop-locked share link: `<shop number>-<4-char hash>`, e.g.
 * `4-a3f9`. The hash keeps the URL from being guessable/enumerable while
 * still reading as "shop 4". Empty shopNumber → empty slug (caller falls
 * back to a plain /m/<token> link). Exported so the bulk "Shop Links" tab
 * mints the same shape of slug as the one-off Share link modal.
 */
export function makeLockedShareSlug(shopNumber: string): string {
  const base = String(shopNumber ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return base ? `${base}-${slugSuffix()}` : ''
}

/**
 * Create / revoke public menu-board links. A link is either locked to one
 * shop (viewer sees just that board) or open (viewer picks the shop from a
 * dropdown). Either way the recipient gets only the board — no SB Net.
 */
function ShareMenuBoardModal({ currentLocationId, currentLabel, currentShopNumber, onClose }: {
  currentLocationId: string
  currentLabel: string
  currentShopNumber: string
  onClose: () => void
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [mode, setMode] = useState<'locked' | 'open'>(currentLocationId ? 'locked' : 'open')
  const [hidePage2, setHidePage2] = useState(false)
  const [rows, setRows] = useState<ShareRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const { data } = await sb().schema('marketing').from('menu_board_shares')
      .select('token, slug, location_id, label, hide_page2, created_at').eq('company_id', companyId).eq('active', true)
      .order('created_at', { ascending: false })
    setRows((data ?? []) as ShareRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function create() {
    if (!companyId) return
    setCreating(true)
    // Locked links get menu.sboc.app/<shop>-<hash>. Retry once on the
    // (rare) slug collision with a fresh hash.
    let lastErr: string | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = {
        company_id: companyId,
        location_id: mode === 'locked' ? currentLocationId : null,
        label: mode === 'locked' ? currentLabel : 'Any shop (viewer picks)',
        slug: mode === 'locked' ? makeLockedShareSlug(currentShopNumber) || null : null,
        hide_page2: hidePage2,
        created_by: profile?.id ?? null,
      }
      const { data, error } = await sb().schema('marketing').from('menu_board_shares').insert(row).select('token, slug').single()
      if (!error) {
        setCreating(false)
        await navigator.clipboard.writeText(shareUrlFor(data)).catch(() => {})
        toast.success('Link created and copied')
        load()
        return
      }
      lastErr = error.message
      if (!/duplicate key|unique/i.test(error.message)) break
    }
    setCreating(false)
    toast.error(lastErr ?? 'Could not create link')
  }

  async function revoke(token: string) {
    const { error } = await sb().schema('marketing').from('menu_board_shares').update({ active: false }).eq('token', token)
    if (error) { toast.error(error.message); return }
    setRows((r) => r.filter((x) => x.token !== token))
  }

  return (
    <Modal open onClose={onClose} title="Share menu board" size="md">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">New link</span>
          <label className={`flex items-start gap-2 text-xs font-mono rounded border p-2 cursor-pointer ${mode === 'locked' ? 'border-sky bg-sky/5' : 'border-navy/20'} ${!currentLocationId ? 'opacity-40' : ''}`}>
            <input type="radio" checked={mode === 'locked'} disabled={!currentLocationId}
              onChange={() => setMode('locked')} className="mt-0.5 accent-sky" />
            <span>
              <span className="text-navy font-bold">Lock to {currentLabel || 'the selected shop'}</span>
              <span className="block text-inky/60">Viewer sees only this shop's board — no shop picker.</span>
            </span>
          </label>
          <label className={`flex items-start gap-2 text-xs font-mono rounded border p-2 cursor-pointer ${mode === 'open' ? 'border-sky bg-sky/5' : 'border-navy/20'}`}>
            <input type="radio" checked={mode === 'open'} onChange={() => setMode('open')} className="mt-0.5 accent-sky" />
            <span>
              <span className="text-navy font-bold">Let the viewer choose the shop</span>
              <span className="block text-inky/60">Viewer gets a shop dropdown above the board.</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-xs font-mono text-inky cursor-pointer">
            <Toggle checked={hidePage2} onChange={setHidePage2} size="sm" />
            Hide page 2 (staff reference sheet)
          </label>
          <Button size="sm" onClick={create} disabled={creating || (mode === 'locked' && !currentLocationId)}>
            {creating ? 'Creating…' : 'Create link'}
          </Button>
        </div>

        <div className="flex flex-col gap-2 border-t border-navy/10 pt-3">
          <span className="text-[10px] font-mono uppercase tracking-widest text-inky/60">Active links</span>
          {loading ? (
            <div className="py-3 flex justify-center"><SbLoader size={22} /></div>
          ) : rows.length === 0 ? (
            <span className="text-xs font-mono text-inky/40 italic">None yet.</span>
          ) : rows.map((r) => (
            <div key={r.token} className="flex items-center gap-2 rounded border border-navy/15 px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-mono text-navy truncate">
                  {r.label || (r.location_id ? 'Locked shop' : 'Any shop')}
                  {r.hide_page2 && <span className="ml-1.5 text-inky/40">(page 2 hidden)</span>}
                </div>
                <div className="text-[10px] font-mono text-inky/50 truncate">{shareUrlFor(r)}</div>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(shareUrlFor(r)); toast.success('Copied') }}
                className="text-[10px] font-mono text-sky hover:underline shrink-0">copy</button>
              <button onClick={() => revoke(r.token)} className="text-[10px] font-mono text-[#C0392B] hover:underline shrink-0">revoke</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ── Shop Links (every shop's locked link + direct PDF download) ─────────

interface ShopShareInfo { token: string; slug: string | null; hidePage2: boolean }
interface ShopLinkRow {
  id: string
  name: string
  owner: string
  regionalDirector: string
  market: string
  areaManager: string
  storeEmail: string | null
  amEmail: string | null
  link: string | null
  pdfLink: string | null
  token: string | null
  hidePage2: boolean
}

const shopLinkCol = createColumnHelper<ShopLinkRow>()

/**
 * Ensures every active shop has its own locked share link (creating any
 * that are missing, and backfilling a slug onto any older share that
 * predates pretty-URL support — that's what was leaving some rows with a
 * board link but no PDF link, since the PDF route only understands slugs),
 * then lists shop / owner / regional director / market / area manager /
 * emails / the live board link / a direct PDF-download link. Both links
 * stay "live": the board link always reads the shop's current
 * core.locations prices (see get_menu_board_share_by_slug), and the PDF
 * link (MenuBoardPdfPage, route menu.sboc.app/<slug>/pdf) rebuilds the PDF
 * from scratch on every visit — nothing is ever a stale cached file, so a
 * price change in the OSL shows up the next time either link is opened,
 * with no "regenerate" step for anyone to remember. Table is the standard
 * useTable/DataTable combo, which gives every column sort + an Excel-style
 * multi-select filter and the whole thing a CSV/XLSX export for free.
 */
function ShopLinksTab({ loc }: { loc: ReturnType<typeof useLocations> }) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [shareByLocation, setShareByLocation] = useState<Record<string, ShopShareInfo>>({})
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const ranRef = useRef(false)

  const activeLocations = useMemo(() => loc.locations.filter((l) => l.active), [loc.locations])

  useEffect(() => {
    if (ranRef.current || !companyId || activeLocations.length === 0) return
    ranRef.current = true
    let cancelled = false

    const fetchShares = async () => {
      // Ordered newest-first so a shop with more than one active share (rare —
      // e.g. someone made a second one by hand) resolves to its most recent.
      const { data } = await sb().schema('marketing').from('menu_board_shares')
        .select('token, slug, location_id, hide_page2').eq('company_id', companyId).eq('active', true).not('location_id', 'is', null)
        .order('created_at', { ascending: false })
      const map: Record<string, ShopShareInfo> = {}
      for (const r of (data ?? []) as any[]) if (r.location_id && !map[r.location_id]) map[r.location_id] = { token: r.token, slug: r.slug, hidePage2: !!r.hide_page2 }
      return map
    }

    async function run() {
      let map = await fetchShares()

      const missing = activeLocations.filter((l) => !map[l.id])
      const CHUNK = 100
      for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK)
        const rowFor = (l: Location) => ({
          company_id: companyId, location_id: l.id, label: l.shop_city || l.name,
          slug: makeLockedShareSlug(l.name) || null, created_by: profile?.id ?? null,
        })
        const { error } = await sb().schema('marketing').from('menu_board_shares').insert(chunk.map(rowFor))
        if (error) {
          // Rare slug collision inside this chunk — retry once with fresh
          // hashes, then fall back to one row at a time so a single bad row
          // can't block the rest of the chunk from getting a link.
          const { error: err2 } = await sb().schema('marketing').from('menu_board_shares').insert(chunk.map(rowFor))
          if (err2) {
            for (const l of chunk) await sb().schema('marketing').from('menu_board_shares').insert(rowFor(l))
          }
        }
      }

      // Self-heal: a share created before pretty-URL support (e.g. via the
      // one-off Share modal before this app version) has slug = null — its
      // board link still works (falls back to /m/<token>) but it has no
      // /pdf route, since that only understands slugs. Back-fill one now.
      const needsSlug = activeLocations.filter((l) => map[l.id] && !map[l.id].slug)
      await Promise.all(needsSlug.map(async (l) => {
        const info = map[l.id]
        const slug = makeLockedShareSlug(l.name)
        if (!slug) return
        const { error } = await sb().schema('marketing').from('menu_board_shares').update({ slug }).eq('token', info.token)
        if (!error) { map[l.id] = { ...info, slug }; return }
        // Unlikely collision — one retry with a fresh hash.
        const slug2 = makeLockedShareSlug(l.name)
        const { error: err2 } = await sb().schema('marketing').from('menu_board_shares').update({ slug: slug2 }).eq('token', info.token)
        if (!err2) map[l.id] = { ...info, slug: slug2 }
      }))

      if (missing.length) map = { ...map, ...(await fetchShares()) }
      if (!cancelled) { setShareByLocation(map); setStatus('ready') }
    }

    run().catch(() => { if (!cancelled) setStatus('error') })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, activeLocations.length])

  const rows = useMemo<ShopLinkRow[]>(() => activeLocations.map((l) => {
    const share = shareByLocation[l.id]
    return {
      id: l.id,
      name: l.shop_city || l.name,
      owner: ownerBucket(l.owner ?? ''),
      regionalDirector: l.director ?? '',
      market: l.market ?? '',
      areaManager: l.area_manager ?? '',
      storeEmail: l.store_email,
      amEmail: l.am_email,
      link: share ? shareUrlFor(share) : null,
      pdfLink: share?.slug ? `${MENU_BOARD_BASE_URL}${share.slug}/pdf` : null,
      token: share?.token ?? null,
      hidePage2: share?.hidePage2 ?? false,
    }
  }).sort((a, b) => naturalCompare(a.name, b.name)), [activeLocations, shareByLocation])

  // Optimistic toggle, reverted on a failed save — same shape as
  // useMenuBoardPackages().update's optimistic pattern above.
  async function toggleHidePage2(locationId: string, token: string | null, next: boolean) {
    if (!token) return
    setShareByLocation((prev) => (prev[locationId] ? { ...prev, [locationId]: { ...prev[locationId], hidePage2: next } } : prev))
    const { error } = await sb().schema('marketing').from('menu_board_shares').update({ hide_page2: next }).eq('token', token)
    if (error) {
      toast.error(`Couldn't save: ${error.message}`)
      setShareByLocation((prev) => (prev[locationId] ? { ...prev, [locationId]: { ...prev[locationId], hidePage2: !next } } : prev))
    }
  }

  const shopLinkColumns = useMemo(() => [
    shopLinkCol.accessor('name', { header: 'Shop', cell: (i) => <span className="whitespace-nowrap">{i.getValue()}</span> }),
    shopLinkCol.accessor('owner', { header: 'Owner', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('regionalDirector', { header: 'Regional Director', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('market', { header: 'Market', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('areaManager', { header: 'Area Manager', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('storeEmail', { header: 'Shop Email', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('amEmail', { header: 'Area Manager Email', cell: (i) => i.getValue() || '—' }),
    shopLinkCol.accessor('link', {
      header: 'Menu Board Link',
      cell: (i) => {
        const link = i.getValue()
        if (!link) return '—'
        return (
          <span className="inline-flex items-center gap-1.5">
            <a href={link} target="_blank" rel="noreferrer" className="text-sky hover:underline truncate max-w-[240px] inline-block align-middle">
              {link.replace(/^https?:\/\//, '')}
            </a>
            <button onClick={() => { navigator.clipboard.writeText(link).catch(() => {}); toast.success('Copied') }}
              className="text-inky/40 hover:text-navy shrink-0" title="Copy link">⧉</button>
          </span>
        )
      },
    }),
    {
      id: 'qr', header: 'QR Code', enableSorting: false, enableColumnFilter: false,
      cell: (i: any) => {
        const link = i.row.original.link as string | null
        return link ? <QrImage url={link} size={40} /> : '—'
      },
    },
    shopLinkCol.accessor('pdfLink', {
      header: 'Download PDF',
      cell: (i) => {
        const link = i.getValue()
        if (!link) return '—'
        return (
          <span className="inline-flex items-center gap-1.5">
            <a href={link} target="_blank" rel="noreferrer" className="text-sky hover:underline whitespace-nowrap">Download PDF</a>
            <button onClick={() => { navigator.clipboard.writeText(link).catch(() => {}); toast.success('Copied') }}
              className="text-inky/40 hover:text-navy shrink-0" title="Copy link">⧉</button>
          </span>
        )
      },
    }),
    shopLinkCol.accessor('hidePage2', {
      header: 'Hide Page 2',
      enableColumnFilter: false,
      cell: (i) => {
        const r = i.row.original
        return r.token ? <Toggle checked={r.hidePage2} onChange={(v) => toggleHidePage2(r.id, r.token, v)} size="sm" /> : '—'
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  const { table, globalFilter, setGlobalFilter, columnVisibility, columnOrder, setColumnOrder } =
    useTable(rows, shopLinkColumns, { persistKey: 'menu-board:shop-links' })
  useColumnPrefs('marketing.menu_board_shop_links', table, columnVisibility, columnOrder, setColumnOrder)

  // Modal-based column manager (drag to reorder, click to hide/show) — the
  // hover dropdown DataTable normally renders for this closes as soon as the
  // pointer leaves the button on the way to its own checkbox list, so it
  // can't be scrolled. Same pattern as LocationsPage.tsx's Manage Columns.
  const [colsOpen, setColsOpen] = useState(false)
  const colLabel = (c: ReturnType<typeof table.getAllLeafColumns>[number]) =>
    typeof c.columnDef.header === 'string' ? c.columnDef.header : c.id

  const allColItems = useMemo<ColItem[]>(
    () => table.getAllLeafColumns().map((c) => ({ id: c.id, label: colLabel(c) })),
    [table, columnVisibility], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const shownOrder = useMemo(() => {
    const visible = table.getAllLeafColumns().filter((c) => c.getIsVisible()).map((c) => c.id)
    if (!columnOrder.length) return visible
    const rank = (id: string) => { const i = columnOrder.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i }
    return [...visible].sort((a, b) => rank(a) - rank(b))
  }, [table, columnOrder, columnVisibility]) // eslint-disable-line react-hooks/exhaustive-deps

  function applyShownColumns(shown: string[]) {
    const shownSet = new Set(shown)
    const hidden = allColItems.map((c) => c.id).filter((id) => !shownSet.has(id))
    setColumnOrder([...shown, ...hidden])
    const vis: VisibilityState = {}
    for (const c of allColItems) vis[c.id] = shownSet.has(c.id)
    table.setColumnVisibility(vis)
  }

  function resetColumnsToDefault() {
    setColumnOrder([])
    table.setColumnVisibility({})
  }

  return (
    <Card><CardBody className="flex flex-col gap-3">
      <p className="text-[11px] font-mono text-inky/60 max-w-2xl">
        One locked link per shop, generated automatically. Both the board link and the PDF link always reflect that
        shop's current prices — nothing to regenerate when the OSL changes. Click a column header's filter icon to
        narrow by owner, regional director, market, or area manager, or use Manage Columns to hide/reorder columns.
      </p>

      {status === 'loading' ? (
        <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
      ) : status === 'error' ? (
        <p className="text-xs font-mono text-[#C0392B] py-4">Could not load shop links — try reloading the page.</p>
      ) : (
        <DataTable
          table={table}
          globalFilter={globalFilter}
          onGlobalFilterChange={setGlobalFilter}
          exportFilename="Menu Board Shop Links"
          hideColumnControl
          actions={
            <button
              onClick={() => setColsOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono border border-navy/30 rounded hover:border-navy/60 text-inky transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
              </svg>
              Columns
            </button>
          }
        />
      )}

      <ColumnManagerModal
        open={colsOpen}
        onClose={() => setColsOpen(false)}
        all={allColItems}
        shown={shownOrder}
        onChange={applyShownColumns}
        onReset={resetColumnsToDefault}
      />
    </CardBody></Card>
  )
}

// ── Package Mapping ─────────────────────────────────────────────────────

function PackageMappingTab({ packages, loading, updatePackage }: {
  packages: MenuBoardPackage[]
  loading: boolean
  updatePackage: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean>
}) {
  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={32} /></div>
  return (
    <Card><CardBody className="flex flex-col gap-2">
      <p className="text-[11px] font-mono text-inky/60">
        Which core.locations column feeds each package's price, whether it shows on the board, and its price text's
        font size. A package with no column mapped yet (e.g. a new package before pricing is set up) can't go active.
      </p>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="px-3 py-2 text-left">Package</th>
            <th className="px-3 py-2 text-left">Source Column</th>
            <th className="px-3 py-2 text-right">Price Font Size</th>
            <th className="px-3 py-2 text-right">Quart Font Size</th>
            <th className="px-3 py-2 text-center">Active</th>
          </tr></thead>
          <tbody>
            {packages.map((p) => (
              <tr key={p.id} className="border-b border-navy/15">
                <td className="px-3 py-1.5 text-navy">{p.display_name}</td>
                <td className="px-3 py-1.5">
                  <select value={p.price_column ?? ''}
                    onChange={(e) => { const v = e.target.value || null; if (v !== p.price_column) updatePackage(p.id, { price_column: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-56">
                    <option value="">— not mapped —</option>
                    {PRICE_COLUMN_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    {/* Preserve an already-saved column that isn't in the list (e.g. added later). */}
                    {p.price_column && !PRICE_COLUMN_OPTIONS.some((o) => o.value === p.price_column) && (
                      <option value={p.price_column}>{p.price_column}</option>
                    )}
                  </select>
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" defaultValue={p.price_font_size}
                    onBlur={(e) => { const v = Number(e.target.value) || p.price_font_size; if (v !== p.price_font_size) updatePackage(p.id, { price_font_size: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <input type="number" defaultValue={p.quart_font_size}
                    onBlur={(e) => { const v = Number(e.target.value) || p.quart_font_size; if (v !== p.quart_font_size) updatePackage(p.id, { quart_font_size: v }) }}
                    className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                </td>
                <td className="px-3 py-1.5 text-center">
                  <Toggle checked={p.active} color="green" size="sm" onChange={(v) => {
                    // Toggle.tsx has no disabled prop — guarded here instead:
                    // a package with no source column mapped yet can't go
                    // active, it would just show "—" on the board.
                    if (v && !p.price_column) { toast.error('Set a Source Column before activating this package'); return }
                    updatePackage(p.id, { active: v })
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CardBody></Card>
  )
}

// ── Quart Pricing (company defaults) ────────────────────────────────────

function QuartDefaultsTab({ packages, quartPricing }: {
  packages: MenuBoardPackage[]
  quartPricing: ReturnType<typeof useMenuBoardQuartPricing>
}) {
  const { defaults, loading, saveDefault } = quartPricing
  const [drafts, setDrafts] = useState<Record<string, { price: string; quarts: string }>>({})

  if (loading) return <div className="py-12 flex justify-center"><SbLoader size={32} /></div>

  function draftFor(packageKey: string) {
    if (drafts[packageKey]) return drafts[packageKey]
    const d = defaults.find((r) => r.package_key === packageKey)
    return { price: d?.price_per_quart?.toString() ?? '', quarts: d?.included_quarts?.toString() ?? '' }
  }

  async function save(packageKey: string) {
    const draft = draftFor(packageKey)
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    await saveDefault(packageKey, { price_per_quart: num(draft.price), included_quarts: num(draft.quarts) })
  }

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <p className="text-[11px] font-mono text-inky/60">
        Company-wide default price per additional quart, and how many quarts are already included in the base
        price — per package. A shop can be set to something different under Custom Pricing.
      </p>
      <div className="overflow-auto rounded border border-navy/30">
        <table className="w-full text-xs font-mono">
          <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
            <th className="px-3 py-2 text-left">Package</th>
            <th className="px-3 py-2 text-right">Price / Extra Quart</th>
            <th className="px-3 py-2 text-right">Included Quarts</th>
            <th className="px-3 py-2" />
          </tr></thead>
          <tbody>
            {packages.filter((p) => p.active).map((p) => {
              const draft = draftFor(p.package_key)
              return (
                <tr key={p.id} className="border-b border-navy/15">
                  <td className="px-3 py-1.5 text-navy">{p.display_name}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input value={draft.price} placeholder="0.00"
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.package_key]: { ...draftFor(p.package_key), price: e.target.value } }))}
                      className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-24 text-right" />
                  </td>
                  <td className="px-3 py-1.5 text-right">
                    <input value={draft.quarts} placeholder="5"
                      onChange={(e) => setDrafts((d) => ({ ...d, [p.package_key]: { ...draftFor(p.package_key), quarts: e.target.value } }))}
                      className="bg-cream border border-navy/30 rounded px-2 py-1 text-xs font-mono text-navy w-16 text-right" />
                  </td>
                  <td className="px-3 py-1.5">
                    <Button size="sm" variant="secondary" onClick={() => save(p.package_key)}>Save</Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </CardBody></Card>
  )
}

// ── Custom Pricing (per-location overrides) ─────────────────────────────

// One override row per shop, holding a price per PACKAGE (not one price for
// everything) — a shop can customize any subset of its packages. Included
// quarts is never shop-customizable (stays a company-wide constant per
// package on the Quart Pricing tab), which is why there's no Included
// Quarts column here.
function CustomPricingTab({ packages, quartPricing, loc }: {
  packages: MenuBoardPackage[]
  quartPricing: ReturnType<typeof useMenuBoardQuartPricing>
  loc: ReturnType<typeof useLocations>
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const { overrides, loading, saveOverride, removeOverride, reload } = quartPricing
  const activePackages = useMemo(() => packages.filter((p) => p.active).sort((a, b) => a.sort_order - b.sort_order), [packages])
  const [addOpen, setAddOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [locationId, setLocationId] = useState('')
  // Keyed by package_key — one input per active package.
  const [priceInputs, setPriceInputs] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [importing, setImporting] = useState(false)

  const shopOptions = useMemo(() => loc.locations.map((l) => ({ value: l.id, label: l.shop_city || l.name })), [loc.locations])
  const shopLabel = (id: string) => loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id

  // Picking a shop that already has custom pricing loads its current
  // per-package prices into the form instead of starting blank — editing
  // just one package's price this way can't accidentally wipe the others
  // (Save always writes the full set of 5 inputs, so they need to reflect
  // what's already there before anything gets changed).
  function selectShop(id: string) {
    setLocationId(id)
    const existing = overrides.find((o) => o.location_id === id)
    const next: Record<string, string> = {}
    for (const p of activePackages) {
      const v = existing?.prices?.[p.package_key]
      next[p.package_key] = v != null ? String(v) : ''
    }
    setPriceInputs(next)
    setNotes(existing?.notes ?? '')
  }

  async function onAdd() {
    if (!locationId) return
    setSaving(true)
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const prices: Record<string, number | null> = {}
    for (const p of activePackages) prices[p.package_key] = num(priceInputs[p.package_key] ?? '')
    const ok = await saveOverride({ location_id: locationId, prices, notes: notes.trim() || null })
    setSaving(false)
    if (ok) { setAddOpen(false); setLocationId(''); setPriceInputs({}); setNotes('') }
  }

  // One upload field per active package — the file maps a column to each
  // package by name, so "which price goes with which package" is set once
  // in the mapping step, not typed per row.
  const uploadFields = useMemo(() => [
    { name: 'shop', label: 'Shop Number', required: true },
    ...activePackages.map((p) => ({ name: p.package_key, label: p.display_name })),
  ], [activePackages])

  // Same review-before-write flow as Order Config's upload: parse → diff
  // against what's already on this page (by shop, matching the table's own
  // unique constraint) → confirm via the shared Review Import modal →
  // single batched upsert. A shop's un-mapped packages (columns not
  // included in this file at all) are left untouched — only mapped columns
  // overwrite that shop's existing custom prices, and a mapped-but-blank
  // cell clears that one package back to the company default.
  async function handleImport(rowsIn: Record<string, string>[], maps: ColumnMapping[], _mode: ImportMode) {
    const numVal = (v: string) => { const t = v.trim(); if (!t) return null; const n = Number(t.replace(/[$,]/g, '')); return isNaN(n) ? null : n }
    const mappedPackageKeys = maps.filter((m) => m.fieldName !== 'shop').map((m) => m.fieldName)

    let unresolved = 0
    const parsed = rowsIn.map((row) => {
      let locationId: string | null = null
      const rowPrices: Record<string, number | null> = {}
      for (const m of maps) {
        const raw = mappedValue(row, m, maps)
        if (m.fieldName === 'shop') locationId = loc.resolveId(raw)
        else rowPrices[m.fieldName] = numVal(raw)
      }
      return { location_id: locationId, rowPrices }
    }).filter((r) => {
      const ok = !!r.location_id
      if (!ok) unresolved++
      return ok
    }) as { location_id: string; rowPrices: Record<string, number | null> }[]

    if (unresolved > 0) toast.error(`${unresolved} row${unresolved !== 1 ? 's' : ''} skipped — shop not recognized`)
    if (parsed.length === 0) return

    const existingByLocation = new Map(overrides.map((o) => [o.location_id, o]))
    let matched = 0
    const newLabels: string[] = []
    const payload = parsed.map((r) => {
      const existing = existingByLocation.get(r.location_id)
      if (existing) matched++
      else newLabels.push(shopLabel(r.location_id))
      const merged: Record<string, number> = { ...(existing?.prices ?? {}) }
      for (const key of mappedPackageKeys) {
        const v = r.rowPrices[key]
        if (v == null) delete merged[key]
        else merged[key] = v
      }
      return { location_id: r.location_id, prices: merged }
    })

    const proceed = await requestImportConfirm({
      mode: 'merge', total: payload.length, updates: matched, creates: payload.length - matched, deletes: 0, newRows: newLabels,
    })
    if (!proceed) return

    if (!companyId) { toast.error('No workspace linked yet — try refreshing the page'); return }
    setImporting(true)
    // notes is intentionally left out of the payload — omitting a column
    // from a PostgREST upsert leaves it untouched on conflict, so a
    // manually-entered note survives a bulk price re-upload instead of
    // being blanked by a file that never carries notes at all.
    const { error } = await sb().schema('marketing').from('menu_board_quart_overrides').upsert(
      payload.map((r) => ({ ...r, company_id: companyId, updated_by: profile?.id ?? null, updated_at: new Date().toISOString() })),
      { onConflict: 'company_id,location_id' },
    )
    setImporting(false)
    if (error) { toast.error(error.message); return }
    toast.success(`Imported — ${matched} updated, ${payload.length - matched} added`)
    setUploadOpen(false)
    reload()
  }

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-[11px] font-mono text-inky/60">
          Shops set to a different price-per-extra-quart than the company default, per package.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setUploadOpen((o) => !o)}>{uploadOpen ? 'Cancel' : 'Upload File'}</Button>
          <Button size="sm" onClick={() => setAddOpen((o) => !o)}>{addOpen ? 'Cancel' : '+ Add Custom Pricing'}</Button>
        </div>
      </div>

      {uploadOpen && (
        <div className="rounded border border-navy/20 p-3">
          <ConfigUpload requiredFields={uploadFields} onImport={handleImport} importing={importing} allowReplace={false} />
        </div>
      )}

      {addOpen && (
        <div className="rounded border border-navy/20 p-3 flex flex-col gap-2">
          <Combobox label="Shop" options={shopOptions} value={locationId} onChange={selectShop} placeholder="Select shop…" />
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
            {activePackages.map((p) => (
              <Input
                key={p.package_key} label={p.display_name} type="number" step={0.01}
                value={priceInputs[p.package_key] ?? ''}
                onChange={(e) => setPriceInputs((prev) => ({ ...prev, [p.package_key]: e.target.value }))}
                placeholder="Company default"
              />
            ))}
          </div>
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" loading={saving} disabled={!locationId} onClick={onAdd}>Save</Button>
          </div>
        </div>
      )}

      {loading ? <div className="py-8 flex justify-center"><SbLoader size={32} /></div>
        : overrides.length === 0 ? <p className="text-xs font-mono text-inky/60 py-4">No custom pricing set — every shop uses the company defaults.</p>
        : (
          <div className="overflow-auto rounded border border-navy/30">
            <table className="w-full text-xs font-mono">
              <thead><tr className="bg-cream text-inky uppercase tracking-wide border-b border-navy/30">
                <th className="px-3 py-2 text-left">Shop</th>
                {activePackages.map((p) => (
                  <th key={p.package_key} className="px-3 py-2 text-right whitespace-nowrap">{p.display_name}</th>
                ))}
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {overrides.map((r) => (
                  <tr key={r.id} className="border-b border-navy/15">
                    <td className="px-3 py-1.5 text-navy whitespace-nowrap">{shopLabel(r.location_id)}</td>
                    {activePackages.map((p) => {
                      const v = r.prices?.[p.package_key]
                      return <td key={p.package_key} className="px-3 py-1.5 text-right text-navy">{v != null ? `$${fmtPrice(v)}` : '—'}</td>
                    })}
                    <td className="px-3 py-1.5 text-inky/70">{r.notes || '—'}</td>
                    <td className="px-3 py-1.5">
                      <button onClick={() => removeOverride(r.id)} className="text-inky/40 hover:text-[#C0392B]" title="Remove custom pricing">×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </CardBody></Card>
  )
}
