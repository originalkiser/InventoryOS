import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import { Button, Card, CardBody, Combobox, Input, Modal, Select, Tabs, TabsList, TabsTrigger, TabsContent, Toggle, SbLoader } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/authStore'
import { useLocations } from '@/hooks/useLocations'
import { useMenuBoardPackages, useMenuBoardQuartPricing, type MenuBoardPackage } from './useMenuBoard'
import { byNaturalLabel } from '@/lib/naturalSort'
import { imagesToPdf } from '@/lib/imagesToPdf'
import type { Location } from '@/types'
import menuBoardArt from '@/assets/Menu-Board-Page-1.png'
import menuBoardArt2 from '@/assets/Menu-Board-Page-2.png'

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
const MAX_BOARD_WIDTH = 900
const ZOOM_MIN = 0.5
const ZOOM_MAX = 3
const ZOOM_STEP = 0.25

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

// The real board art (src/assets/Menu-Board-Page-1.png + -2.png) is the
// actual printed sign — everything on it (logos, package names, qualifiers,
// "PRICES INCLUDE UP TO 5 QUARTS", additional services, disclaimers, the
// staff reference sheet on page 2) is the genuine artwork. Page 1 is the
// BLANK-slate export: the shop's price and per-extra-quart line have been
// removed from each box, so we just draw the live text into the empty box
// (no background patch to hide anything). Native size is 705×1218; the DB's
// price_pos_x/y / quart_pos_x/y (percentages, measured off the image, and
// draggable via "Edit layout") hold at any rendered width.
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
  const { packages, loading: packagesLoading, update: updatePackage } = useMenuBoardPackages()
  const quartPricing = useMenuBoardQuartPricing()

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
export function Board({ location, packages, editMode = false, updatePackage, resolveQuart, address, width }: {
  location: Location | undefined
  packages: MenuBoardPackage[]
  editMode?: boolean
  updatePackage?: (id: string, patch: Partial<MenuBoardPackage>) => Promise<boolean> | void
  resolveQuart: (locationId: string, packageKey: string) => { pricePerQuart: number | null; includedQuarts: number | null; isCustom: boolean }
  address: string
  /** Explicit display width in px (from BoardViewer's zoom). Falls back to
   *  100% capped at the 480px design width when omitted. */
  width?: number
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

  return (
    <>
      <div
        className="rounded-lg overflow-hidden bg-sb-navy"
        style={{ width: width ?? '100%', maxWidth: width ?? BOARD_REF_WIDTH, margin: '0 auto' }}
      >
        {/* Page 1 of the PDF — the priced board through Additional Services.
            Rendered as an <img> (not a fixed aspect-ratio background) so
            nothing at the bottom is ever clipped. Overlay text is scaled by
            `scale` (measured width ÷ 480) so it tracks the printed card at
            any board width. */}
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
                  {/* Price — the composite the printed board uses: small "$",
                      big whole-dollars, superscript cents, "PLUS TAX" tucked
                      under the cents. The box on the art is blank, so this is
                      just the text, centred on the DB point — no background,
                      nothing to clip past the box border. */}
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
                  {/* Per-extra-quart line — also blank on the art, drawn as
                      plain text centred on its own DB point. */}
                  <div
                    onPointerDown={(e) => startDrag(e, p, 'quart')}
                    className={`absolute flex items-center justify-center whitespace-nowrap font-mono leading-none ${patchText} ${editMode ? 'cursor-move ring-1 ring-sb-sky/60' : ''}`}
                    style={{
                      left: `${p.quart_pos_x}%`, top: `${p.quart_pos_y}%`, transform: 'translate(-50%, -50%)',
                      fontSize: p.quart_font_size * scale,
                    }}
                  >
                    {quart.pricePerQuart == null ? '—' : `$${fmtPrice(quart.pricePerQuart)} per extra quart`}
                    {quart.isCustom && <span className="ml-1 text-sb-orange">*</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* The real art is a generic template with no shop-specific address
              printed on it — shown as its own bar below the board (still on
              PDF page 1) instead of guessed onto the image. */}
          <div className="bg-sb-navy text-sb-cream/80 text-center px-3 py-1.5">
            <span className="text-[10px] font-mono">{address || (location ? '' : 'Select a shop above')}</span>
          </div>
        </div>

        {/* Page 2 of the PDF — the staff reference sheet (recommendations,
            top-off policy, the SB Experience checklist). Static, no overlays. */}
        <div data-mb-page="2">
          <img src={menuBoardArt2} alt="Menu board — recommendations & procedures" className="block w-full" draggable={false} />
        </div>
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
 * Board + a PDF-reader-style toolbar: zoom out / zoom % / zoom in / reset,
 * and a "Download PDF" button (html2canvas snapshot of each board page →
 * a 2-page PDF, page 1 = the board through Additional Services, page 2 =
 * the reference sheet). Used by the admin Board tab and the public share
 * page so both get the same viewing controls.
 */
export function BoardViewer(props: React.ComponentProps<typeof Board>) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const captureRef = useRef<HTMLDivElement>(null)
  const [fitW, setFitW] = useState(BOARD_REF_WIDTH)
  const [zoom, setZoom] = useState(1)
  const [pdfBusy, setPdfBusy] = useState(false)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setFitW(el.clientWidth || BOARD_REF_WIDTH))
    ro.observe(el)
    setFitW(el.clientWidth || BOARD_REF_WIDTH)
    return () => ro.disconnect()
  }, [])

  const baseW = Math.min(fitW, MAX_BOARD_WIDTH)
  const displayW = Math.round(baseW * zoom)
  const setZoomClamped = (z: number) => setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100)))

  async function downloadPdf() {
    const root = captureRef.current
    if (!root) return
    setPdfBusy(true)
    try {
      const html2canvas = (await import('html2canvas')).default
      const pages = Array.from(root.querySelectorAll('[data-mb-page]')) as HTMLElement[]
      const shots: { jpegDataUrl: string }[] = []
      for (const el of pages) {
        const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#002745', useCORS: true, logging: false })
        shots.push({ jpegDataUrl: canvas.toDataURL('image/jpeg', 0.92) })
      }
      const blob = imagesToPdf(shots)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'strickland-brothers-menu-board.pdf'
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

  return (
    <div className="flex flex-col gap-2">
      {/* Fixed sb-* tokens (not the theme-flipping ones) so the toolbar
          reads the same on the cream admin card and the navy public page. */}
      <div className="flex items-center gap-1 rounded-md bg-sb-navy px-2 py-1.5">
        <button type="button" className={zBtn} onClick={() => setZoomClamped(zoom - ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">−</button>
        <span className="w-12 text-center text-[11px] font-mono tabular-nums text-sb-cream">{Math.round(zoom * 100)}%</span>
        <button type="button" className={zBtn} onClick={() => setZoomClamped(zoom + ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">+</button>
        <button type="button" className="ml-1 px-2 h-7 rounded bg-sb-cream/10 hover:bg-sb-cream/20 disabled:opacity-30 text-sb-cream font-mono text-[11px]" onClick={() => setZoom(1)} disabled={zoom === 1}>Reset</button>
        <button type="button" onClick={downloadPdf} disabled={pdfBusy}
          className="ml-auto px-3 h-7 rounded bg-sb-sky hover:brightness-95 disabled:opacity-50 text-sb-navy font-mono font-bold text-[11px] uppercase tracking-wide">
          {pdfBusy ? 'Building…' : 'Download PDF'}
        </button>
      </div>
      <div ref={wrapRef} className="overflow-auto">
        <div ref={captureRef} style={{ width: displayW, marginLeft: 'auto', marginRight: 'auto' }}>
          <Board {...props} width={displayW} />
        </div>
      </div>
    </div>
  )
}

/**
 * The printed-board price treatment: a smaller "$", big whole dollars, a
 * cents pair, and "PLUS TAX" tucked directly under the cents. `fs` is the
 * big-digit size in px (already width-scaled); everything else is a
 * fraction of it.
 *
 * The "$" and the cents/PLUS-TAX column are raised with `vertical-align:
 * text-top` (plus a small px nudge) so their tops line up with the top of
 * the big digits rather than floating above them. `vertical-align` +
 * `inline-block` is what html2canvas (the Download-PDF path) reproduces
 * faithfully — flex margins and CSS transforms it does not.
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
        <span style={{ fontSize: fs * 0.14, display: 'block', lineHeight: 1, marginTop: fs * 0.03, letterSpacing: '0.01em' }}>PLUS TAX</span>
      </span>
    </span>
  )
}

// ── Share link ─────────────────────────────────────────────────────────

interface ShareRow { token: string; location_id: string | null; label: string | null; created_at: string }
const sb = () => supabase as any
const shareUrlFor = (token: string) => `${window.location.origin}${import.meta.env.BASE_URL}m/${token}`

/**
 * Create / revoke public menu-board links. A link is either locked to one
 * shop (viewer sees just that board) or open (viewer picks the shop from a
 * dropdown). Either way the recipient gets only the board — no SB Net.
 */
function ShareMenuBoardModal({ currentLocationId, currentLabel, onClose }: {
  currentLocationId: string
  currentLabel: string
  onClose: () => void
}) {
  const { profile } = useAuthStore()
  const companyId = profile?.company_id ?? null
  const [mode, setMode] = useState<'locked' | 'open'>(currentLocationId ? 'locked' : 'open')
  const [rows, setRows] = useState<ShareRow[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    if (!companyId) { setLoading(false); return }
    const { data } = await sb().schema('marketing').from('menu_board_shares')
      .select('token, location_id, label, created_at').eq('company_id', companyId).eq('active', true)
      .order('created_at', { ascending: false })
    setRows((data ?? []) as ShareRow[])
    setLoading(false)
  }, [companyId])
  useEffect(() => { load() }, [load])

  async function create() {
    if (!companyId) return
    setCreating(true)
    const row = {
      company_id: companyId,
      location_id: mode === 'locked' ? currentLocationId : null,
      label: mode === 'locked' ? currentLabel : 'Any shop (viewer picks)',
      created_by: profile?.id ?? null,
    }
    const { data, error } = await sb().schema('marketing').from('menu_board_shares').insert(row).select('token').single()
    setCreating(false)
    if (error) { toast.error(error.message); return }
    await navigator.clipboard.writeText(shareUrlFor(data.token)).catch(() => {})
    toast.success('Link created and copied')
    load()
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
                <div className="text-[11px] font-mono text-navy truncate">{r.label || (r.location_id ? 'Locked shop' : 'Any shop')}</div>
                <div className="text-[10px] font-mono text-inky/50 truncate">{shareUrlFor(r.token)}</div>
              </div>
              <button onClick={() => { navigator.clipboard.writeText(shareUrlFor(r.token)); toast.success('Copied') }}
                className="text-[10px] font-mono text-sky hover:underline shrink-0">copy</button>
              <button onClick={() => revoke(r.token)} className="text-[10px] font-mono text-[#C0392B] hover:underline shrink-0">revoke</button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
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

function CustomPricingTab({ packages, quartPricing, loc }: {
  packages: MenuBoardPackage[]
  quartPricing: ReturnType<typeof useMenuBoardQuartPricing>
  loc: ReturnType<typeof useLocations>
}) {
  const { overrides, loading, saveOverride, removeOverride } = quartPricing
  const [addOpen, setAddOpen] = useState(false)
  const [locationId, setLocationId] = useState('')
  const [packageKey, setPackageKey] = useState('')
  const [price, setPrice] = useState('')
  const [quarts, setQuarts] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  const shopOptions = useMemo(() => loc.locations.map((l) => ({ value: l.id, label: l.shop_city || l.name })), [loc.locations])
  const packageOptions = useMemo(() => packages.filter((p) => p.active).map((p) => ({ value: p.package_key, label: p.display_name })), [packages])
  const shopLabel = (id: string) => loc.locations.find((l) => l.id === id)?.shop_city || loc.locations.find((l) => l.id === id)?.name || id
  const packageLabel = (key: string) => packages.find((p) => p.package_key === key)?.display_name ?? key

  async function onAdd() {
    if (!locationId || !packageKey) return
    setSaving(true)
    const num = (v: string) => (v.trim() === '' ? null : Number(v))
    const ok = await saveOverride({ location_id: locationId, package_key: packageKey, price_per_quart: num(price), included_quarts: num(quarts), notes: notes.trim() || null })
    setSaving(false)
    if (ok) { setAddOpen(false); setLocationId(''); setPackageKey(''); setPrice(''); setQuarts(''); setNotes('') }
  }

  return (
    <Card><CardBody className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-mono text-inky/60">
          Shops set to a different price-per-extra-quart (or included-quarts count) than the company default.
        </p>
        <Button size="sm" onClick={() => setAddOpen((o) => !o)}>{addOpen ? 'Cancel' : '+ Add Custom Pricing'}</Button>
      </div>

      {addOpen && (
        <div className="rounded border border-navy/20 p-3 grid grid-cols-1 md:grid-cols-5 gap-2 items-end">
          <Combobox label="Shop" options={shopOptions} value={locationId} onChange={setLocationId} placeholder="Select shop…" />
          <Select label="Package" value={packageKey} onChange={(e) => setPackageKey(e.target.value)}
            options={[{ value: '', label: 'Select…' }, ...packageOptions]} />
          <Input label="Price / Extra Quart" type="number" step={0.01} value={price} onChange={(e) => setPrice(e.target.value)} />
          <Input label="Included Quarts" type="number" value={quarts} onChange={(e) => setQuarts(e.target.value)} />
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="md:col-span-5 flex justify-end">
            <Button size="sm" loading={saving} disabled={!locationId || !packageKey} onClick={onAdd}>Save</Button>
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
                <th className="px-3 py-2 text-left">Package</th>
                <th className="px-3 py-2 text-right">Price / Extra Quart</th>
                <th className="px-3 py-2 text-right">Included Quarts</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2" />
              </tr></thead>
              <tbody>
                {overrides.map((r) => (
                  <tr key={r.id} className="border-b border-navy/15">
                    <td className="px-3 py-1.5 text-navy">{shopLabel(r.location_id)}</td>
                    <td className="px-3 py-1.5 text-navy">{packageLabel(r.package_key)}</td>
                    <td className="px-3 py-1.5 text-right text-navy">{r.price_per_quart != null ? `$${fmtPrice(r.price_per_quart)}` : '—'}</td>
                    <td className="px-3 py-1.5 text-right text-navy">{r.included_quarts ?? '—'}</td>
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
